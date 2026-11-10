/**
 * Lectores deterministas (sin IA) para calendarios oficiales con estructura conocida.
 * Cada receta solo interpreta el HTML/JSON que publica el sitio oficial; lo que no resuelve
 * (cronogramas en PDF, páginas sin estructura) queda para el flujo genérico con Gemini.
 */
import { localToUtc, toUtcIso, type Source } from '@dm/shared';
import type { FetchedDocument } from '../extract/document.ts';
import {
  absoluteUrl,
  attr,
  blocksByClass,
  extractEmbeddedJson,
  textByClass,
  textOf,
} from '../extract/html.ts';
import {
  countryName,
  dateInZone,
  guessTimeZone,
  isoDate,
  monthNumber,
  parseDateRangeText,
  shiftDate,
} from './places.ts';
import type { CalendarEntry, ExtractedSession, RecipeContext, SiteRecipe } from './types.ts';

const host = (url: string): string => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

const stripComments = (html: string) => html.replace(/<!--[\s\S]*?-->/g, ' ');

function tzFor(country: string, place: string, fallback = 'UTC'): string {
  return guessTimeZone(country, place) ?? fallback;
}

function dedupe(entries: CalendarEntry[]): CalendarEntry[] {
  const seen = new Set<string>();
  return entries.filter((e) => {
    const key = e.url ? e.url.toLowerCase() : `${e.name}|${e.dateStart}|${e.championship ?? ''}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function roundOf(text: string): number | undefined {
  const m = text.match(/(?:round|fecha|ronda|nls)\s*(\d{1,2})/i);
  return m ? Number(m[1]) : undefined;
}

/** Busca recursivamente en un JSON el primer array de objetos que cumpla el predicado. */
export function findArray(value: unknown, pred: (item: Record<string, unknown>) => boolean, depth = 0): Record<string, unknown>[] | null {
  if (depth > 25 || !value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    const objs = value.filter((v): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v));
    if (objs.length > 0 && objs.length === value.length && objs.some(pred)) return objs;
    for (const v of value) {
      const r = findArray(v, pred, depth + 1);
      if (r) return r;
    }
    return null;
  }
  for (const v of Object.values(value as Record<string, unknown>)) {
    const r = findArray(v, pred, depth + 1);
    if (r) return r;
  }
  return null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

// ─── SRO Motorsports Group (GT World Challenge, IGTC, calendario general de SRO) ───────────────

const sro: SiteRecipe = {
  name: 'sro',
  match: (url) => /(gt-world-challenge-[a-z]+\.com|intercontinentalgtchallenge\.com|sro-motorsports\.com)$/.test(host(url)),
  calendar(doc, ctx) {
    const html = stripComments(doc.raw);
    const out: CalendarEntry[] = [];
    for (const b of blocksByClass(html, 'calendar__list-item')) {
      const part = (cls: string) => {
        const block = b.match(new RegExp(`class="${cls}"[\\s\\S]*?</div>`))?.[0] ?? '';
        return {
          d: textByClass(block, 'calendar__date-number'),
          m: textByClass(block, 'calendar__date-month'),
          y: textByClass(block, 'calendar__date-year'),
        };
      };
      const s = part('calendar__date-start');
      const e = part('calendar__date-end');
      const name = textByClass(b, 'calendar__race-header');
      if (!s.d || !name) continue;
      const start = isoDate(Number(s.y) || ctx.season, monthNumber(s.m) ?? 0, Number(s.d));
      const end = e.d ? isoDate(Number(e.y) || Number(s.y) || ctx.season, monthNumber(e.m) ?? 0, Number(e.d)) : start;
      if (!start || !end) continue;
      const country = textByClass(b, 'calendar__race-subheading-text');
      const texts = [...b.matchAll(/class="calendar__race-text"[^>]*>([\s\S]*?)<\/span>/g)].map((m) => textOf(m[1] ?? '')).filter(Boolean);
      const roundText = texts.find((t) => /round/i.test(t)) ?? '';
      const championship = texts.find((t) => !/round/i.test(t));
      const href = [...b.matchAll(/href="([^"]*\/event\/\d+[^"]*)"/g)][0]?.[1];
      const url = href ? (absoluteUrl(href, doc.url) ?? undefined) : undefined;
      out.push({
        name,
        circuit: name,
        country: countryName(country),
        tz: tzFor(country, name),
        dateStart: start,
        dateEnd: end < start ? start : end,
        round: roundOf(roundText),
        url,
        ...(championship ? { championship, ...(url ? { championshipUrl: `${new URL(url).origin}/calendar` } : {}) } : {}),
      });
    }
    for (const b of blocksByClass(html, 'past-events__list-item')) {
      const spans = [...b.matchAll(/class="past-events__piped-list-span"[^>]*>([\s\S]*?)<\/span>\s*<\/li>/g)].map((m) => m[1] ?? '');
      if (spans.length < 2) continue;
      const dates = parseDateRangeText(textOf(spans[0]!), ctx.season);
      const venue = textOf(spans[1]!.match(/<strong>([\s\S]*?)<\/strong>/)?.[1] ?? '');
      const country = textOf(spans[1]!.replace(/<strong>[\s\S]*?<\/strong>/, ''));
      const href = b.match(/href="([^"]*\/event\/\d+[^"]*)"/)?.[1];
      if (!dates || !venue) continue;
      out.push({
        name: venue,
        circuit: venue,
        country: countryName(country),
        tz: tzFor(country, venue),
        dateStart: dates.start,
        dateEnd: dates.end,
        round: roundOf(textOf(spans[2] ?? '')),
        url: href ? (absoluteUrl(href, doc.url) ?? undefined) : undefined,
      });
    }
    return dedupe(out).sort((a, b) => a.dateStart.localeCompare(b.dateStart));
  },
};

// ─── IndyCar / Indy NXT ───────────────────────────────────────────────────────────────────────

const indycar: SiteRecipe = {
  name: 'indycar',
  match: (url) => /^(indycar\.com|indynxt\.com)$/.test(host(url)),
  calendarUrl: (url, season) => {
    const u = new URL(url);
    if (!u.searchParams.has('year')) u.searchParams.set('year', String(season));
    return u.toString();
  },
  calendar(doc, ctx) {
    const out: CalendarEntry[] = [];
    for (const b of blocksByClass(stripComments(doc.raw), 'event-card')) {
      const href = b.match(/<a\b[^>]*href="([^"]+)"[^>]*class="event-card-link"/)?.[1] ?? b.match(/class="event-card-link"[^>]*href="([^"]+)"/)?.[1];
      if (!href || !new RegExp(`/schedule/${ctx.season}/`, 'i').test(href)) continue;
      const day = parseDateRangeText(textByClass(b, 'event-card-header-date'), ctx.season);
      if (!day) continue;
      const title = textByClass(b, 'event-card-title');
      const track = textByClass(b, 'event-card-track-name') || title;
      const location = textByClass(b, 'event-card-track-location');
      const url = absoluteUrl(href, doc.url) ?? undefined;
      // Fechas dobles (Indy NXT): una tarjeta por carrera; se agrupan en un solo evento.
      const prev = out.find((e) => e.circuit === track && Math.abs(Date.parse(e.dateEnd) - Date.parse(day.start)) <= 2 * 86_400_000);
      if (prev) {
        if (day.start > prev.dateEnd) prev.dateEnd = day.start;
        continue;
      }
      out.push({
        name: title || track,
        circuit: track,
        country: 'United States',
        tz: tzFor(/canada|ontario|toronto/i.test(location) ? 'Canada' : 'United States', `${location} ${track}`),
        dateStart: shiftDate(day.start, -2),
        dateEnd: day.start,
        url,
      });
    }
    return dedupe(out);
  },
};

// ─── FIA WEC / ELMS (misma plataforma del ACO) ────────────────────────────────────────────────

const aco: SiteRecipe = {
  name: 'aco',
  match: (url) => /^(fiawec\.com|europeanlemansseries\.com|asianlemansseries\.com)$/.test(host(url)),
  calendarUrl: (url, season) => {
    const u = new URL(url);
    return /\/season\/\d{4}/.test(u.pathname) ? url.replace(/\/season\/\d{4}/, `/season/${season}`) : `${u.origin}/en/season/${season}`;
  },
  calendar(doc, ctx) {
    const html = stripComments(doc.raw);
    const byUrl = new Map<string, CalendarEntry>();
    const re = new RegExp(`<a\\b[^>]*href="(/en/race/[^"]*-${ctx.season})\\s*"[^>]*>([\\s\\S]*?)</a>`, 'g');
    for (const m of html.matchAll(re)) {
      const url = absoluteUrl(m[1]!.trim(), doc.url);
      if (!url) continue;
      const inner = m[2] ?? '';
      const after = html.slice(m.index! + m[0].length, m.index! + m[0].length + 1500);
      const strip = inner.match(/<strong[^>]*>\s*(\d{1,2})\s*<\/strong>\s*<small[^>]*>\s*([A-Za-z]+)\s*<\/small>/);
      const card = after.match(/class="text-primary text-uppercase[^"]*"[^>]*>\s*(\d{1,2}\s+[A-Za-z]+)\s*</);
      const dayText = strip ? `${strip[1]} ${strip[2]}` : card?.[1];
      const flag = (inner + after.slice(0, 600)).match(/flag:([A-Z]{2})/)?.[1] ?? '';
      const venue = textOf(after.match(/class="fs-7 fw-bold[^"]*"[^>]*>([\s\S]*?)<\/div>/)?.[1] ?? '');
      const alt = attr(inner.match(/<img\b[^>]*>/)?.[0] ?? '', 'alt');
      const slugName = m[1]!.split('/').pop()!.replace(new RegExp(`-${ctx.season}$`), '').replace(/-/g, ' ');
      const name = alt ? textOf(alt) : slugName.replace(/\b\w/g, (c) => c.toUpperCase());
      const existing = byUrl.get(url);
      if (existing?.dateStart) continue;
      if (!dayText) {
        if (!existing) byUrl.set(url, { name, circuit: venue || name, country: countryName(flag), tz: tzFor(flag, venue), dateStart: '', dateEnd: '', url });
        continue;
      }
      const day = parseDateRangeText(dayText, ctx.season);
      if (!day) continue;
      byUrl.set(url, {
        name: alt === undefined && existing ? existing.name : name,
        circuit: venue || existing?.circuit || name,
        country: countryName(flag || existing?.country || ''),
        tz: tzFor(flag || existing?.country || '', venue || name),
        dateStart: shiftDate(day.start, /prologue|test/i.test(name) ? -1 : -2),
        dateEnd: day.start,
        url,
      });
    }
    return [...byUrl.values()].filter((e) => e.dateStart);
  },
};

// ─── Nürburgring Langstrecken-Serie ───────────────────────────────────────────────────────────

const nls: SiteRecipe = {
  name: 'nls',
  match: (url) => host(url) === 'nuerburgring-langstrecken-serie.de',
  calendar(doc, ctx) {
    const out: CalendarEntry[] = [];
    for (const row of stripComments(doc.raw).matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)) {
      const cells = [...row[1]!.matchAll(/<td\b[^>]*>([\s\S]*?)(?=<td\b|$)/g)].map((c) => c[1] ?? '');
      if (cells.length < 2) continue;
      const dates = parseDateRangeText(textOf(cells[0]!), ctx.season);
      const name = textOf(cells[1]!);
      if (!dates || !name || !dates.start.startsWith(String(ctx.season))) continue;
      const href = [...cells[1]!.matchAll(/href="([^"]+)"/g)].map((h) => h[1]!).find((h) => /nuerburgring-langstrecken-serie\.de|^\//.test(h));
      out.push({
        name,
        circuit: 'Nürburgring Nordschleife',
        country: 'Germany',
        tz: 'Europe/Berlin',
        dateStart: dates.start,
        dateEnd: dates.end,
        round: roundOf(name),
        url: href ? (absoluteUrl(href, doc.url) ?? undefined) : undefined,
      });
    }
    return dedupe(out);
  },
};

// ─── 24H Series (Creventic) ───────────────────────────────────────────────────────────────────

const creventic: SiteRecipe = {
  name: '24h-series',
  match: (url) => host(url) === '24hseries.com',
  calendarUrl: (url) => {
    const u = new URL(url);
    return u.pathname === '/' ? `${u.origin}/races` : url;
  },
  calendar(doc, ctx) {
    const out: CalendarEntry[] = [];
    const ymd = (frag: string) => {
      const spans = [...frag.matchAll(/<span class="day[^"]*">([^<]*)<\/span>/g)].map((m) => m[1]!.trim());
      return spans.length >= 3 ? isoDate(Number(spans[2]), monthNumber(spans[1]!) ?? 0, Number(spans[0])) : null;
    };
    for (const b of blocksByClass(stripComments(doc.raw), 'raceItem', 4000)) {
      if (attr(b.slice(0, 400), 'data-year') !== String(ctx.season)) continue;
      const href = attr(b.slice(0, 400), 'href');
      const start = ymd(b.match(/<span class="start">([\s\S]*?<\/span>)<\/span>/)?.[1] ?? '');
      const end = ymd(b.match(/<span class="end">([\s\S]*?<\/span>)<\/span>/)?.[1] ?? '') ?? start;
      const name = textOf((b.match(/class="mediumTitle">([\s\S]*?)<\/span>(?:<i|\s*<\/span>)/)?.[1] ?? '').replace(/<span class="year">[\s\S]*?(<\/span>|$)/, '')).replace(/\s*\|\s*\d{4}$/, '');
      if (!href || !start || !end || !name) continue;
      const flag = decodeURIComponent(b.match(/Countries(?:%20| )Flags\/(?:flags\/)?([^"_.]+)[_.]/)?.[1] ?? '');
      const circuit = textOf(b.match(/class="infoContent">\s*<span class="smallTitle">([\s\S]*?)<\/span>/)?.[1] ?? '') || name;
      out.push({
        name,
        circuit,
        country: countryName(flag),
        tz: tzFor(flag, `${circuit} ${name}`),
        dateStart: start,
        dateEnd: end < start ? start : end,
        url: absoluteUrl(href, doc.url) ?? undefined,
      });
    }
    return dedupe(out);
  },
};

// ─── APAT (Turismo Nacional) ──────────────────────────────────────────────────────────────────

const apat: SiteRecipe = {
  name: 'apat',
  match: (url) => host(url) === 'apat.org.ar',
  calendarUrl: (url) => {
    const u = new URL(url);
    return u.pathname === '/' ? `${u.origin}/carreras` : url;
  },
  calendar(doc, ctx) {
    const out: CalendarEntry[] = [];
    for (const b of blocksByClass(stripComments(doc.raw), 'card-tn')) {
      const link = b.match(/<a\b[^>]*href="([^"]*\/carreras\/info\/(\d{4}-\d{2}-\d{2}))"[^>]*>([\s\S]*?)<\/a>/);
      if (!link || !link[2]!.startsWith(String(ctx.season))) continue;
      const race = link[2]!;
      const circuit = textOf(link[3] ?? '');
      const location = textOf(b.slice(link.index! + link[0].length).match(/<small[^>]*>([\s\S]*?)<\/small>/)?.[1] ?? '');
      out.push({
        name: location ? `${circuit} (${location})` : circuit,
        circuit,
        country: 'Argentina',
        tz: 'America/Argentina/Buenos_Aires',
        dateStart: shiftDate(race, -2),
        dateEnd: race,
        url: absoluteUrl(link[1]!, doc.url) ?? undefined,
      });
    }
    return dedupe(out).sort((a, b) => a.dateStart.localeCompare(b.dateStart));
  },
};

// ─── TC2000 ───────────────────────────────────────────────────────────────────────────────────

const tc2000: SiteRecipe = {
  name: 'tc2000',
  match: (url) => host(url) === 'tc2000.com.ar',
  calendarUrl: (url) => {
    const u = new URL(url);
    return u.pathname === '/' ? `${u.origin}/carreras.php?evento=calendario` : url;
  },
  calendar(doc, ctx) {
    const out: CalendarEntry[] = [];
    for (const b of blocksByClass(stripComments(doc.raw), 'box-fechas', 1500)) {
      const round = Number(textByClass(b, 'item-fechas'));
      const dm = textByClass(b, 'gris').match(/(\d{1,2})\s*-\s*(\d{1,2})/);
      const circuit = textOf(b.match(/<h3[^>]*>([\s\S]*?)<\/h3>/)?.[1] ?? '');
      const href = b.match(/href="([^"]*accion=historial[^"]*)"/)?.[1];
      if (!dm || !circuit) continue;
      const race = isoDate(ctx.season, Number(dm[2]), Number(dm[1]));
      if (!race) continue;
      const id = href?.match(/id=(\d+)/)?.[1];
      out.push({
        name: `Fecha ${round || ''} ${circuit}`.replace(/\s+/g, ' ').trim(),
        circuit,
        country: 'Argentina',
        tz: 'America/Argentina/Buenos_Aires',
        dateStart: shiftDate(race, -2),
        dateEnd: race,
        ...(round ? { round } : {}),
        url: href ? (absoluteUrl(href, doc.url) ?? undefined) : undefined,
        ...(id ? { meta: { id } } : {}),
      });
    }
    return dedupe(out);
  },
};

// ─── ACTC (TC, TC Pista, TC Pick Up, TC Mouras) ───────────────────────────────────────────────

/** Código de categoría de ACTC a partir de la URL del calendario (https://actc.org.ar/tcp/calendario -> tcp). */
export function actcCategory(url: string): string {
  try {
    return new URL(url).pathname.split('/').filter(Boolean)[0]?.toLowerCase() ?? 'tc';
  } catch {
    return 'tc';
  }
}

const ACTC_SESSION = /entrenamiento|clasificaci|serie|final|carrera|tanda|prueba libre/i;
const ACTC_NOT_SESSION = /salida a pista|previa|c[aá]mara|nota tv|pregrilla|giro|reuni[oó]n|sorteo|entrega|verificaci|podio|conferencia/i;

const actc: SiteRecipe = {
  name: 'actc',
  match: (url) => host(url) === 'actc.org.ar',
  calendarUrl: (url) => {
    const u = new URL(url);
    return u.pathname === '/' ? `${u.origin}/tc/calendario` : url;
  },
  calendar(doc, ctx) {
    const code = actcCategory(doc.url);
    const out: CalendarEntry[] = [];
    for (const value of extractEmbeddedJson(doc.raw)) {
      const events = findArray(value, (o) => 'raceDate' in o && 'title' in o);
      if (!events) continue;
      for (const ev of events) {
        if (str(ev.category).toLowerCase() !== code) continue;
        const raceIso = str(ev.raceDate);
        if (!raceIso || Number(ev.year ?? raceIso.slice(0, 4)) !== ctx.season || ev.active === false) continue;
        const tz = 'America/Argentina/Buenos_Aires';
        const race = dateInZone(raceIso, tz);
        const endIso = str(ev.raceDateEnd);
        const circuit = obj(ev.circuit);
        const title = str(ev.title).trim();
        out.push({
          name: title,
          circuit: str(circuit.name) || title,
          country: 'Argentina',
          tz,
          dateStart: shiftDate(race, -2),
          dateEnd: endIso ? dateInZone(endIso, tz) : race,
          round: roundOf(title),
          url: doc.url,
          meta: { code, raceDate: race, location: str(circuit.location) },
        });
      }
      if (out.length) break;
    }
    // Dos eventos con el mismo título y fecha son el mismo (el sitio a veces repite fechas).
    return out.filter((e, i) => out.findIndex((x) => x.name === e.name && x.dateEnd === e.dateEnd) === i);
  },
  async sessions(entry, ctx) {
    const code = entry.meta?.code ?? actcCategory(ctx.series.officialUrls[0] ?? '');
    const raceDate = entry.meta?.raceDate ?? entry.dateEnd;
    const listUrl = 'https://actc.org.ar/api/schedules';
    const list = (await ctx.http.json<{ data?: Record<string, unknown>[] }>(listUrl)).body.data ?? [];
    const tz = entry.tz;
    const schedule = list.find((s) => {
      const cats = Array.isArray(s.categories) ? (s.categories as unknown[]).map((c) => str(c).toLowerCase()) : [str(s.category)];
      const evDate = str(obj(s.calendarEvent).raceDate);
      return s.published !== false && cats.includes(code) && !!evDate && dateInZone(evDate, tz) === raceDate;
    });
    if (!schedule) return null;
    let days = schedule.days as Record<string, unknown>[] | undefined;
    if (!Array.isArray(days)) {
      const detail = await ctx.http.json<{ data?: Record<string, unknown> }>(`${listUrl}/${str(schedule.id)}`);
      days = (detail.body.data?.days as Record<string, unknown>[] | undefined) ?? [];
    }
    const labels = new Set([code, ctx.series.shortName.toLowerCase().replace(/\s+/g, '')]);
    const sessions: ExtractedSession[] = [];
    for (const day of days) {
      const date = str(day.date).slice(0, 10);
      for (const item of (day.items as Record<string, unknown>[] | undefined) ?? []) {
        const title = str(item.title).trim();
        const logos = ((item.logos as Record<string, unknown>[] | undefined) ?? []).map((l) => str(l.label).toLowerCase().replace(/\s+/g, ''));
        if (!logos.some((l) => labels.has(l))) continue;
        if (item.trackType === 'administrative' || !ACTC_SESSION.test(title) || ACTC_NOT_SESSION.test(title)) continue;
        const startMin = Number(item.startMin);
        if (!Number.isFinite(startMin)) continue;
        const hhmm = (min: number) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
        const subtitle = str(item.subtitle).trim();
        const detail = subtitle.match(/grupo\s+\w+|\d\*?\s*(?:tercio|cuarto)|\w+\s+(?:tercio|cuarto)/i)?.[0];
        const name = detail ? `${title} (${detail.replace('*', '°')})` : title;
        const endMin = Number(item.endMin);
        sessions.push({
          name,
          startUtc: localToUtc(date, hhmm(startMin), tz),
          ...(Number.isFinite(endMin) && endMin > startMin && item.endMin !== null ? { endUtc: localToUtc(date, hhmm(endMin), tz) } : {}),
          localStartText: hhmm(startMin),
        });
      }
    }
    if (sessions.length === 0) return null;
    const ev = obj(schedule.calendarEvent);
    const source: Source = {
      url: `https://actc.org.ar/cronogramas/${str(schedule.id)}`,
      title: `Cronograma ACTC — ${str(ev.title) || entry.name}`,
      kind: 'api',
      method: 'directo',
      fetchedAt: isoNow(ctx.now),
    };
    return { sessions, source };
  },
};

// ─── DTM (API oficial de dtm.com) ─────────────────────────────────────────────────────────────

const dtm: SiteRecipe = {
  name: 'dtm',
  match: (url) => /^(dtm\.com|api\.dtm\.com)$/.test(host(url)),
  calendarUrl: (url) => (host(url) === 'api.dtm.com' ? url : 'https://api.dtm.com/data?query=events'),
  calendar(doc, ctx) {
    let data: unknown;
    try {
      data = JSON.parse(doc.raw);
    } catch {
      return [];
    }
    const events = (obj(data).events as Record<string, unknown>[] | undefined) ?? [];
    const out: CalendarEntry[] = [];
    for (const ev of events) {
      const cat = str(ev.eventCategory);
      const start = str(ev.startTime);
      if (!/^DTM\b/i.test(cat) || !start.startsWith(String(ctx.season)) || ev.hideOnOverview === true) continue;
      const country = obj(ev.country);
      const track = obj(ev.racetrack);
      const tz = tzFor(str(country.countryCode) || str(country.name), str(track.name));
      out.push({
        name: str(ev.name),
        circuit: str(track.name) || str(ev.name),
        country: countryName(str(country.name) || str(country.countryCode)),
        tz,
        dateStart: dateInZone(start, tz),
        dateEnd: dateInZone(str(ev.endTime) || start, tz),
        round: Number(ev.eventNumber) || undefined,
        url: `https://www.dtm.com/en/events/${str(ev.slug)}`,
        meta: { slug: str(ev.slug) },
      });
    }
    return out;
  },
  async sessions(entry, ctx) {
    const slug = entry.meta?.slug;
    if (!slug) return null;
    const res = await ctx.http.json<{ events?: Record<string, unknown>[] }>(
      `https://api.dtm.com/data?query=eventDetails&slug=${encodeURIComponent(slug)}`,
    );
    const ev = res.body.events?.[0];
    const items = (ev?.timetable as Record<string, unknown>[] | undefined) ?? [];
    const sessions: ExtractedSession[] = items
      .filter((i) => str(i.headline).trim().toUpperCase() === 'DTM')
      .filter((i) => !/autogramm|autograph|pit ?walk|pit ?lane|parade|interview|press|safari|taxi|grid ?walk/i.test(str(i.label)))
      .map((i) => ({
        name: str(i.label),
        startUtc: toUtcIso(str(i.start)),
        ...(str(i.end) ? { endUtc: toUtcIso(str(i.end)) } : {}),
      }));
    if (sessions.length === 0) return null;
    return {
      sessions,
      source: {
        url: entry.url ?? 'https://www.dtm.com/en/calendar',
        title: `Timetable DTM — ${entry.name}`,
        kind: 'api',
        method: 'directo',
        fetchedAt: isoNow(ctx.now),
      },
    };
  },
};

// ─── F1 Academy (datos de Next.js de f1academy.com) ───────────────────────────────────────────

const f1academy: SiteRecipe = {
  name: 'f1academy',
  match: (url) => host(url) === 'f1academy.com',
  calendar(doc, ctx) {
    const out: CalendarEntry[] = [];
    for (const value of extractEmbeddedJson(doc.raw)) {
      const races = findArray(value, (o) => 'RaceStartDate' in o && 'Sessions' in o);
      if (!races) continue;
      for (const r of races) {
        const start = str(r.RaceStartDate);
        if (!start.startsWith(String(ctx.season))) continue;
        const circuit = str(r.CircuitName);
        const country = str(r.CountryName);
        const sessions: ExtractedSession[] = ((r.Sessions as Record<string, unknown>[] | undefined) ?? [])
          .filter((s) => s.Unconfirmed !== true && str(s.SessionStartTime))
          .map((s) => {
            const startIso = str(s.SessionStartTime);
            return {
              name: str(s.SessionName),
              startUtc: toUtcIso(startIso),
              ...(str(s.SessionEndTime) ? { endUtc: toUtcIso(str(s.SessionEndTime)) } : {}),
              localStartText: startIso.slice(11, 16),
            };
          });
        out.push({
          name: str(r.CircuitShortName) || circuit,
          circuit,
          country: countryName(country),
          tz: tzFor(country, `${circuit} ${str(r.CircuitShortName)}`),
          dateStart: start,
          dateEnd: str(r.RaceEndDate) || start,
          round: Number(r.RoundNumber) || undefined,
          url: `https://www.f1academy.com/Racing-Series/Results?raceid=${str(r.RaceId)}`,
          ...(sessions.length ? { sessions } : {}),
        });
      }
      break;
    }
    return out;
  },
};

// ─── International GT Open (gtopen.gtsport.es) ────────────────────────────────────────────────

const gtopen: SiteRecipe = {
  name: 'gtopen',
  match: (url) => /^(gtopen\.gtsport\.es|gtopen\.net)$/.test(host(url)),
  calendarUrl: () => 'https://gtopen.gtsport.es/calendario',
  calendar(doc, ctx) {
    const out: CalendarEntry[] = [];
    for (const value of extractEmbeddedJson(doc.raw)) {
      const eventos = findArray(value, (o) => 'nombre' in o && 'fecha' in o && 'circuito' in o);
      if (!eventos) continue;
      for (const ev of eventos) {
        const fecha = str(ev.fecha);
        if (!fecha.startsWith(String(ctx.season))) continue;
        const circuito = obj(ev.circuito);
        const country = str(circuito.pais);
        const tz = tzFor(country, str(circuito.nombre));
        const race = dateInZone(fecha, tz);
        const docs = ((ev.docs as Record<string, unknown>[] | undefined) ?? []).filter((d) => /^schedule/i.test(str(d.nombre)));
        const schedule = docs.find((d) => /fin/i.test(str(d.nombre))) ?? docs.at(-1);
        const scheduleUrl = str(obj(obj(schedule).doc).url);
        out.push({
          name: str(ev.nombre).replace(/\s*-\s*GTO\s*-\s*\d{4}$/i, '') || str(circuito.nombre),
          circuit: str(circuito.nombre),
          country: countryName(country),
          tz,
          dateStart: shiftDate(race, -2),
          dateEnd: race,
          url: doc.url,
          ...(scheduleUrl ? { timetableUrl: scheduleUrl } : {}),
        });
      }
      if (out.length) break;
    }
    return out;
  },
};

// ─── FIA: calendario deportivo internacional (descubrimiento) ────────────────────────────────

const fia: SiteRecipe = {
  name: 'fia',
  match: (url) => host(url) === 'fia.com',
  calendar(doc, ctx) {
    const out: CalendarEntry[] = [];
    let year = ctx.now.getUTCFullYear();
    let lastMonth = 0;
    const html = stripComments(doc.raw);
    const blocks = blocksByClass(html, 'calendar-layout', 5000);
    let cursor = 0;
    for (const b of blocks) {
      // El link al evento (cuando existe) envuelve el bloque: se busca también justo antes.
      const at = html.indexOf(b.slice(0, 200), cursor);
      cursor = at > 0 ? at + 1 : cursor;
      const before = at > 0 ? html.slice(Math.max(0, at - 400), at) : '';
      if (/^<[^>]*calendar-layout cancelled/.test(b) || /class="pane-event-status"[\s\S]{0,120}cancel/i.test(b)) continue;
      const title = textOf(b.match(/region-right[\s\S]*?<p>([\s\S]*?)<\/p>/)?.[1] ?? '');
      const sd = b.match(/<span class="start day">(\d{1,2})<\/span>\s*<span class="start month">([A-Za-z]+)<\/span>/);
      const ed = b.match(/<span class="end day">(\d{1,2})<\/span>\s*<span class="end month">([A-Za-z]+)<\/span>/);
      const linkRe = /href="([^"]*\/championship\/events\/([^/"]+)\/season-(\d{4})\/[^"]*)"/;
      const openAnchor = before.slice(before.lastIndexOf('<a ')); // ancla que envuelve el bloque (sin cerrar)
      const href = b.match(linkRe) ?? (openAnchor.includes('</a>') ? null : openAnchor.match(linkRe));
      if (!title || !sd) continue;
      const m1 = monthNumber(sd[2]!) ?? 0;
      if (href?.[3]) year = Number(href[3]);
      else if (lastMonth && m1 < lastMonth) year++;
      lastMonth = m1;
      const start = isoDate(year, m1, Number(sd[1]));
      const m2 = ed ? (monthNumber(ed[2]!) ?? m1) : m1;
      const end = ed ? isoDate(m2 < m1 ? year + 1 : year, m2, Number(ed[1])) : start;
      if (!start || !end) continue;
      const code = textByClass(b, 'country-label-wrapper');
      const slug = href?.[2] ?? '';
      const logo = b.match(/competition_logo\/public\/([^?"]+)/)?.[1] ?? '';
      const championship = slug ? humanize(slug) : fiaChampionshipFromLogo(logo);
      const url = href ? (absoluteUrl(href[1]!, doc.url) ?? undefined) : undefined;
      out.push({
        name: title,
        circuit: title,
        country: countryName(code),
        tz: tzFor(code, title),
        dateStart: start,
        dateEnd: end,
        url,
        championship: championship ?? title,
        // Una categoría descubierta acá se sigue leyendo de este mismo calendario, filtrada por campeonato.
        championshipUrl: doc.url,
      });
    }
    return dedupe(out);
  },
};

// ─── CDA del ACA: calendario deportivo nacional (descubrimiento) ──────────────────────────────

const cdaaca: SiteRecipe = {
  name: 'cdaaca',
  match: (url) => host(url) === 'cdaaca.org.ar',
  calendar(doc) {
    const out: CalendarEntry[] = [];
    const re = /<a\b[^>]*href="(\/eventos\/[^"]+)"[^>]*class="hidden md:grid[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    for (const m of doc.raw.matchAll(re)) {
      const spans = [...m[2]!.matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/g)].map((s) => textOf(s[1] ?? '')).filter(Boolean);
      if (spans.length < 3) continue;
      const date = parseDateRangeText(spans[0]!, new Date().getUTCFullYear());
      if (!date) continue;
      const [, category, circuit, number] = spans;
      const url = absoluteUrl(m[1]!, doc.url) ?? undefined;
      out.push({
        name: `${category}${number ? ` — Fecha ${number}` : ''}`,
        circuit: circuit ?? '',
        country: 'Argentina',
        tz: 'America/Argentina/Buenos_Aires',
        dateStart: date.start,
        dateEnd: date.end,
        url,
        championship: category!,
        championshipUrl: doc.url,
      });
    }
    return dedupe(out);
  },
};

/** El calendario de la FIA solo identifica el campeonato por su logo: nombre a partir del archivo. */
export function fiaChampionshipFromLogo(file: string): string | undefined {
  const f = file.toLowerCase();
  const region = (r: string) =>
    ({ master: 'Europe', european: 'Europe', world: 'World', middleeast: 'Middle East', asiapacific: 'Asia-Pacific', codasur: 'CODASUR', nacam: 'NACAM', africa: 'Africa' })[r] ??
    r.charAt(0).toUpperCase() + r.slice(1);
  if (/f1_championship|formula_?1|formula_one/.test(f)) return 'FIA Formula One World Championship';
  if (/(^|_)f2_|formula_?2/.test(f)) return 'FIA Formula 2 Championship';
  if (/(^|_)f3_|formula_?3/.test(f)) return 'FIA Formula 3 Championship';
  if (/f1_?academy/.test(f)) return 'F1 Academy';
  if (/formula_?e|(^|_)fe_/.test(f)) return 'FIA Formula E World Championship';
  if (/wec/.test(f)) return 'World Endurance Championship';
  if (/w2rc/.test(f)) return 'FIA World Rally-Raid Championship';
  if (/wrc/.test(f)) return 'FIA World Rally Championship';
  if (/tcrwt|tcr_world/.test(f)) return 'FIA TCR World Tour';
  if (/gt_world_cup/.test(f)) return 'FIA GT World Cup';
  const ert = f.match(/ert_([a-z]+)/);
  if (ert) return `FIA Rally Regional ${region(ert[1]!)}`;
  const baja = f.match(/bajacup_([a-z]+)/);
  if (baja) return baja[1] === 'world' ? 'FIA World Baja Cup' : `FIA Baja Cup ${region(baja[1]!)}`;
  return undefined;
}

function humanize(slug: string): string {
  return slug
    .split('-')
    .map((w) => (w === 'fia' ? 'FIA' : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(' ');
}

function isoNow(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export const RECIPES: SiteRecipe[] = [sro, indycar, aco, nls, creventic, apat, tc2000, actc, dtm, f1academy, gtopen, fia, cdaaca];

export function findRecipe(url: string): SiteRecipe | undefined {
  return RECIPES.find((r) => r.match(url));
}

