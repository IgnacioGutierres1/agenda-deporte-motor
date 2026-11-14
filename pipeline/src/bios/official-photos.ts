/**
 * Fotos oficiales de pilotos, para los que no tienen una foto libre en Commons. Solo de los sitios oficiales que el
 * pipeline ya lee, con el crédito del sitio y la página oficial del piloto:
 *  - Fórmula 1: página de pilotos de formula1.com (tarjeta de cada piloto con su foto);
 *  - MotoGP, Moto2 y Moto3: API de pilotos de motogp.com (foto de perfil de la temporada);
 *  - NASCAR: feed de pilotos de nascar.com (foto del piloto, salvo la genérica).
 * Si un sitio falla, se sigue sin sus fotos.
 */
import { baseDriverId, type CreditedImage } from '@dm/shared';
import { decodeEntities } from '../extract/html.ts';
import type { Http } from '../core/http.ts';
import type { Logger } from '../core/log.ts';
import { MOTOGP_API } from '../adapters/motogp.ts';
import { NASCAR_CACHER } from '../adapters/nascar.ts';

export const F1_DRIVERS_URL = 'https://www.formula1.com/en/drivers';
export const MOTOGP_RIDERS_URL = `${MOTOGP_API}/riders`;
export const NASCAR_DRIVERS_URL = `${NASCAR_CACHER}/drivers.json`;

/** Fuente de fotos oficiales de cada categoría. */
export const OFFICIAL_PHOTO_SERIES: Record<string, 'f1' | 'motogp' | 'nascar'> = {
  f1: 'f1',
  motogp: 'motogp',
  moto2: 'motogp',
  moto3: 'motogp',
  'nascar-cup': 'nascar',
  'nascar-xfinity': 'nascar',
  'nascar-truck': 'nascar',
};

/** Foto por id base del nombre del piloto (baseDriverId). */
export type PhotoMap = Map<string, CreditedImage>;

const slug = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** Tarjetas de la página de pilotos de formula1.com: nombre (en el contexto de analítica), enlace y foto. */
export function parseF1Drivers(html: string): PhotoMap {
  const out: PhotoMap = new Map();
  const parts = html.split(/(?=<a\b[^>]*href="\/en\/drivers\/[a-z0-9-]+")/);
  for (const part of parts) {
    const href = /^<a\b[^>]*href="(\/en\/drivers\/[a-z0-9-]+)"/.exec(part)?.[1];
    if (!href) continue;
    const card = part.slice(0, 20_000);
    let name: string | undefined;
    const ctx = /data-f1rd-a7s-context="([^"]+)"/.exec(card.slice(0, 600))?.[1];
    if (ctx) {
      try {
        const data = JSON.parse(Buffer.from(ctx, 'base64').toString('utf8')) as { driverName?: unknown };
        if (typeof data.driverName === 'string') name = data.driverName;
      } catch {
        // contexto ilegible: se usa el enlace
      }
    }
    name ??= href.split('/').pop()!.replace(/-/g, ' ');
    const img = /https:\/\/media\.formula1\.com\/image\/upload\/[^"\s]*?\/common\/f1\/\d{4}\/[a-z0-9]+\/[a-z0-9]+\/\d{4}[a-z0-9]+right\.(?:webp|png|jpg)/.exec(card)?.[0];
    const id = baseDriverId(name);
    if (!img || !id || out.has(id)) continue;
    out.set(id, {
      url: decodeEntities(img),
      credit: 'Formula1.com',
      license: '© Formula One World Championship Limited',
      page: `https://www.formula1.com${href}`,
    });
  }
  return out;
}

interface MotoGpRider {
  name?: string;
  surname?: string;
  current_career_step?: { pictures?: { profile?: { main?: string | null } } } | null;
}

export function parseMotoGpRiders(riders: MotoGpRider[]): PhotoMap {
  const out: PhotoMap = new Map();
  for (const r of Array.isArray(riders) ? riders : []) {
    const full = `${r.name ?? ''} ${r.surname ?? ''}`.trim();
    const photo = r.current_career_step?.pictures?.profile?.main;
    const id = baseDriverId(full);
    if (!id || !photo || !/^https:\/\/photos\.motogp\.com\//.test(photo) || out.has(id)) continue;
    out.set(id, {
      url: photo,
      credit: 'MotoGP.com',
      license: '© Dorna Sports, S.L.',
      page: `https://www.motogp.com/en/riders/profile/${slug(full)}`,
    });
  }
  return out;
}

interface NascarDriver {
  Full_Name?: string;
  Image?: string;
  Driver_Page?: string;
}

export function parseNascarDrivers(body: { response?: NascarDriver[] }): PhotoMap {
  const out: PhotoMap = new Map();
  for (const d of body.response ?? []) {
    const id = baseDriverId(d.Full_Name ?? '');
    const img = d.Image ?? '';
    // La genérica (default.svg) no es una foto del piloto.
    if (!id || !/^https:\/\/www\.nascar\.com\/wp-content\/uploads\/.+\.(png|jpe?g|webp)$/i.test(img) || out.has(id)) continue;
    const page = /^https:\/\/www\.nascar\.com\/drivers\/[a-z0-9-]+\/?$/.test(d.Driver_Page ?? '') ? d.Driver_Page! : 'https://www.nascar.com/drivers/';
    out.set(id, { url: img, credit: 'NASCAR.com', license: '© NASCAR Digital Media, LLC', page });
  }
  return out;
}

/** Fotos oficiales de las fuentes pedidas, por fuente. */
export async function fetchOfficialPhotos(
  http: Http,
  sources: Set<'f1' | 'motogp' | 'nascar'>,
  log: Logger,
): Promise<Map<'f1' | 'motogp' | 'nascar', PhotoMap>> {
  const out = new Map<'f1' | 'motogp' | 'nascar', PhotoMap>();
  const read: Record<'f1' | 'motogp' | 'nascar', () => Promise<PhotoMap>> = {
    f1: async () => parseF1Drivers((await http.text(F1_DRIVERS_URL, { noProxy: true })).body),
    motogp: async () => parseMotoGpRiders((await http.json<MotoGpRider[]>(MOTOGP_RIDERS_URL, { noProxy: true })).body),
    nascar: async () => parseNascarDrivers((await http.json<{ response?: NascarDriver[] }>(NASCAR_DRIVERS_URL, { noProxy: true })).body),
  };
  for (const source of sources) {
    try {
      const photos = await read[source]();
      out.set(source, photos);
      log.info(`Fotos oficiales (${source}): ${photos.size}`);
    } catch (err) {
      log.warn(`Fotos oficiales (${source}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return out;
}
