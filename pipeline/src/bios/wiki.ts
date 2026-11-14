/**
 * Artículos de Wikipedia (en español o en inglés): wikitexto (para la trayectoria y para confirmar la identidad)
 * e introducción en texto plano (para el resumen), de a 20 artículos por consulta.
 */
import type { BioSummary } from '@dm/shared';
import type { Api } from '../circuits/api.ts';

/** prop=extracts con exintro admite hasta 20 artículos por consulta. */
const BATCH = 20;

export interface WikiPage {
  lang: 'es' | 'en';
  /** Título final (después de normalizar y seguir redirecciones). */
  title: string;
  wikitext: string;
  /** Introducción en texto plano. */
  extract?: string;
}

interface PageJson {
  title?: string;
  missing?: boolean;
  extract?: string;
  revisions?: Array<{ slots?: { main?: { content?: string } } }>;
}

interface QueryJson {
  continue?: Record<string, string>;
  query?: {
    normalized?: Array<{ from: string; to: string }>;
    redirects?: Array<{ from: string; to: string }>;
    pages?: PageJson[];
  };
}

export function articleUrl(lang: 'es' | 'en', title: string): string {
  return `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_')).replace(/%2F/g, '/').replace(/%3A/g, ':')}`;
}

/** Artículos por el título pedido. Los que no existen no vuelven. */
export async function fetchPages(api: Api, lang: 'es' | 'en', titles: string[]): Promise<Map<string, WikiPage>> {
  const out = new Map<string, WikiPage>();
  const unique = [...new Set(titles.filter(Boolean))];
  for (let i = 0; i < unique.length; i += BATCH) {
    const chunk = unique.slice(i, i + BATCH);
    const base =
      `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&formatversion=2&redirects=1` +
      '&prop=revisions%7Cextracts&rvprop=content&rvslots=main&exintro=1&explaintext=1&exlimit=20' +
      `&titles=${encodeURIComponent(chunk.join('|'))}`;
    const pages = new Map<string, PageJson>();
    const alias = new Map<string, string>();
    let cont: Record<string, string> | undefined;
    // Si el contenido no entra en una respuesta, la API manda el resto con "continue".
    for (let round = 0; round < 6; round++) {
      const url = cont ? `${base}&${new URLSearchParams(cont).toString()}` : base;
      const res = await api.get<QueryJson>(url);
      for (const n of [...(res.query?.normalized ?? []), ...(res.query?.redirects ?? [])]) alias.set(n.from, n.to);
      for (const p of res.query?.pages ?? []) {
        if (!p.title || p.missing) continue;
        const prev = pages.get(p.title) ?? {};
        pages.set(p.title, {
          ...prev,
          ...p,
          revisions: p.revisions?.length ? p.revisions : prev.revisions,
          extract: p.extract ?? prev.extract,
        });
      }
      cont = res.continue;
      if (!cont) break;
    }
    for (const requested of chunk) {
      let title = requested;
      for (let k = 0; k < 3 && alias.has(title); k++) title = alias.get(title)!;
      const p = pages.get(title);
      const wikitext = p?.revisions?.[0]?.slots?.main?.content;
      if (!p || typeof wikitext !== 'string') continue;
      const page: WikiPage = { lang, title, wikitext };
      if (p.extract?.trim()) page.extract = p.extract;
      out.set(requested, page);
    }
  }
  return out;
}

/** Hasta este largo se suma el segundo párrafo de la introducción. */
const SHORT = 320;
const MAX = 1100;

/**
 * Resumen a partir de la introducción del artículo: el primer párrafo (y el segundo si el primero es corto), sin la
 * pronunciación entre corchetes.
 */
export function summaryOf(page: WikiPage): BioSummary | undefined {
  if (!page.extract) return undefined;
  const paragraphs = page.extract
    // Espacios de ancho cero que dejan las referencias quitadas.
    .replace(/[​-‍⁠﻿]/g, '')
    .replace(/\s*\((?:[^()]*?)(?:pronunciation|pronunciación)[^()]*?\)/gi, (m) => {
      // "(Spanish pronunciation: [ˈfɾaŋko]; born 27 May 2003)" → "(born 27 May 2003)"
      const rest = m.replace(/^\s*\(/, '').replace(/\)$/, '').split(/;\s*/).filter((p) => !/pronunciation|pronunciación|\[/i.test(p));
      return rest.length ? ` (${rest.join('; ')})` : '';
    })
    .replace(/\[[^\]]*ˈ[^\]]*\]/g, '')
    .split(/\n+/)
    .map((p) => p.replace(/\s+/g, ' ').replace(/\s+([,.;])/g, '$1').trim())
    .filter((p) => p.length > 40);
  if (!paragraphs.length) return undefined;
  let text = paragraphs[0]!;
  if (text.length < SHORT && paragraphs[1]) text = `${text}\n\n${paragraphs[1]}`;
  if (text.length > MAX) {
    const cut = text.slice(0, MAX);
    const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('.\n'));
    text = end > 200 ? cut.slice(0, end + 1) : `${cut.replace(/\s+\S*$/, '')}…`;
  }
  return { text, lang: page.lang, url: articleUrl(page.lang, page.title) };
}
