/**
 * Wikipedia (español e inglés): extracto de la introducción, imagen principal y wikitexto de la introducción
 * (para leer la ficha del circuito) de varios artículos por request, con la API de acción.
 * Es el mismo extracto que da el resumen REST (page/summary), pero pedido de a 20 artículos: con el límite de
 * consultas de Wikimedia, artículo por artículo no alcanza.
 */
import type { Api } from './api.ts';

export type WikiLang = 'es' | 'en';

export interface WikiPage {
  title: string;
  /** Introducción en texto plano (puede traer varios párrafos). */
  extract?: string;
  /** Nombre del archivo de la imagen principal (solo imágenes libres). */
  image?: string;
  /** Wikitexto de la introducción (sección 0), donde está la ficha. */
  wikitext?: string;
}

/** La API devuelve hasta 20 extractos de introducción por request. */
const BATCH = 20;
const MAX_CONTINUES = 6;

interface RawPage {
  title?: string;
  missing?: boolean;
  extract?: string;
  pageimage?: string;
  revisions?: Array<{ slots?: { main?: { content?: string } } }>;
}

interface RawResponse {
  continue?: Record<string, string>;
  query?: {
    normalized?: Array<{ from: string; to: string }>;
    redirects?: Array<{ from: string; to: string }>;
    pages?: RawPage[];
  };
}

export function wikiUrl(lang: WikiLang, title: string): string {
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

/** Artículos por título (el pedido). Los que no existen no vuelven. */
export async function fetchPages(api: Api, lang: WikiLang, titles: string[]): Promise<Map<string, WikiPage>> {
  const out = new Map<string, WikiPage>();
  const unique = [...new Set(titles.map((t) => t.trim()).filter(Boolean))];
  for (let i = 0; i < unique.length; i += BATCH) {
    const chunk = unique.slice(i, i + BATCH);
    const base =
      `https://${lang}.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(chunk.join('|'))}` +
      '&prop=extracts%7Cpageimages%7Crevisions&exintro=1&explaintext=1&exlimit=max&piprop=name&pilimit=max' +
      '&rvprop=content&rvslots=main&rvsection=0&redirects=1&format=json&formatversion=2';
    const byTitle = new Map<string, WikiPage>();
    const alias = new Map<string, string>();
    let cont: Record<string, string> | undefined;
    for (let n = 0; n <= MAX_CONTINUES; n++) {
      const extra = cont
        ? Object.entries(cont)
            .map(([k, v]) => `&${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
            .join('')
        : '';
      const res = await api.get<RawResponse>(base + extra);
      for (const r of [...(res.query?.normalized ?? []), ...(res.query?.redirects ?? [])]) alias.set(r.from, r.to);
      for (const raw of res.query?.pages ?? []) {
        if (!raw.title || raw.missing) continue;
        const page = byTitle.get(raw.title) ?? { title: raw.title };
        if (raw.extract) page.extract = raw.extract;
        if (raw.pageimage) page.image = raw.pageimage;
        const text = raw.revisions?.[0]?.slots?.main?.content;
        if (text) page.wikitext = text;
        byTitle.set(raw.title, page);
      }
      cont = res.continue;
      if (!cont) break;
    }
    for (const asked of chunk) {
      // Título pedido -> normalizado -> destino de la redirección.
      let title = asked;
      for (let hop = 0; hop < 3 && alias.has(title); hop++) title = alias.get(title)!;
      const page = byTitle.get(title);
      if (page) out.set(asked, page);
    }
  }
  return out;
}

/** Texto que termina en una abreviatura o inicial ("St", "Dr", "J"): el punto que sigue no cierra la oración. */
const ABBREVIATION = /(?:^|[\s(])(?:[A-ZÁÉÍÓÚÑ]|St|Mt|Dr|Jr|Sr|Sra|No|Av|Gral|Ing|Pte|Prov|Bros|Inc|Ltd|Co|vs|approx|aprox|EE|UU)$/;

/**
 * Extracto corto: el primer párrafo, sin restos de notas ni paréntesis vacíos, recortado en un final de oración
 * (o de palabra, con "…") si pasa del máximo.
 */
export function shortExtract(extract: string | undefined, max = 420): string | undefined {
  if (!extract) return undefined;
  const first = extract
    .split(/\n+/)
    .map((p) => p.trim())
    .find((p) => p.length > 40);
  if (!first) return undefined;
  let t = first
    .replace(/[​‎‏﻿]/g, '')
    .replace(/\[\d+\]/g, '')
    .replace(/\(\s*[,;]?\s*\)/g, '')
    .replace(/\s+([,;.:)])/g, '$1')
    .replace(/\(\s+/g, '(')
    .replace(/\s+/g, ' ')
    .trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  // Último final de oración dentro del límite (un punto seguido de espacio y mayúscula, que no sea abreviatura).
  let end = -1;
  for (const m of cut.matchAll(/[.!?](?=\s+[A-ZÁÉÍÓÚÑ¿¡"«])/g)) {
    const i = m.index ?? -1;
    if (i >= 0 && !ABBREVIATION.test(cut.slice(0, i))) end = i;
  }
  if (end >= max * 0.45) return cut.slice(0, end + 1);
  t = cut.slice(0, cut.lastIndexOf(' ')).replace(/[\s,;:–—-]+$/u, '');
  return `${t}…`;
}
