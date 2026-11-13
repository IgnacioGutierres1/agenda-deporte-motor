import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MotorEvent, Series, Session, Source } from '@dm/shared';
import { MAIN_FEED, buildFeed, buildSeriesFeeds, seriesCalendarName, writeSeriesFeeds } from '../src/core/feed.ts';

const NOW = new Date('2026-11-12T12:00:00Z');
const source = (url: string): Source => ({ url, title: 'x', kind: 'html', method: 'directo', fetchedAt: '2026-11-12T00:00:00Z' });
const series = (id: string, name: string, enabled = true): Series => ({
  id,
  name,
  shortName: name,
  group: 'argentina',
  officialUrls: ['https://example.org/'],
  strategy: 'generic',
  origin: 'default',
  enabled,
});
const event = (id: string, seriesId: string, dateStart: string, dateEnd: string, status: MotorEvent['sessionsStatus'] = 'pending'): MotorEvent => ({
  id,
  seriesId,
  name: `Evento ${id}`,
  circuit: `Circuito ${id}`,
  country: 'Argentina',
  tz: 'America/Argentina/Buenos_Aires',
  dateStart,
  dateEnd,
  sessionsStatus: status,
  source: source(`https://example.org/${id}`),
});
const session = (id: string, ev: MotorEvent, startUtc: string, broadcastIsDefault = true): Session => ({
  id,
  eventId: ev.id,
  seriesId: ev.seriesId,
  type: 'carrera',
  name: 'Carrera',
  startUtc,
  endUtc: new Date(new Date(startUtc).getTime() + 3600_000).toISOString().replace(/\.\d{3}Z$/, 'Z'),
  endEstimated: false,
  broadcast: ['TV Pública'],
  broadcastIsDefault,
  source: source(`https://example.org/${ev.id}/cronograma`),
  hasResults: false,
});

const vevents = (ics: string) => ics.split('BEGIN:VEVENT').slice(1);
const uids = (ics: string) => vevents(ics).map((v) => v.match(/UID:([^\r]+)@/)![1]);

describe('feed de suscripción (.ics)', () => {
  const all = [series('tc', 'Turismo Carretera'), series('tn', 'Turismo Nacional'), series('off', 'Apagada', false)];
  const rioCuarto = event('rio-cuarto', 'tc', '2026-11-13', '2026-11-15');
  const sanNicolas = event('san-nicolas', 'tc', '2026-11-20', '2026-11-22', 'published');
  const past = event('pasado', 'tc', '2026-11-06', '2026-11-08');
  const today = event('hoy', 'tn', '2026-11-10', '2026-11-12');
  const far = event('lejos', 'tn', '2027-03-01', '2027-03-03');
  const disabled = event('apagada', 'off', '2026-11-20', '2026-11-22');
  // Marcado pendiente pero ya con alguna sesión: no se duplica como día completo.
  const partial = event('parcial', 'tn', '2026-11-27', '2026-11-29');
  const sessions = [session('s-sn', sanNicolas, '2026-11-22T17:00:00Z', false), session('s-parcial', partial, '2026-11-29T16:00:00Z')];
  const events = [rioCuarto, sanNicolas, past, today, far, disabled, partial];
  const broadcast = { tc: ['TV Pública', 'Motorplay'] };

  it('suma los eventos futuros sin horarios como día completo, sin pasados, apagados ni duplicados', () => {
    const ics = buildFeed(all, events, sessions, NOW, { broadcast });
    expect(uids(ics).sort()).toEqual(['hoy', 'rio-cuarto', 's-parcial', 's-sn']);
    const rc = vevents(ics).find((v) => v.includes('UID:rio-cuarto@'))!.replace(/\r\n /g, '');
    expect(rc).toContain('DTSTART;VALUE=DATE:20261113');
    expect(rc).toContain('DTEND;VALUE=DATE:20261116');
    expect(rc).toContain('SUMMARY:Turismo Carretera (Circuito rio-cuarto) - Evento rio-cuarto (horarios a confirmar)');
    expect(rc).toContain('Transmisión habitual: TV Pública\\, Motorplay\\nFuente: https://example.org/rio-cuarto');
    // Sin transmisión habitual configurada para la serie.
    expect(vevents(ics).find((v) => v.includes('UID:hoy@'))).toContain('Transmisión: A confirmar');
  });

  it('marca la transmisión habitual en las sesiones', () => {
    const ics = buildFeed(all, events, sessions, NOW, { broadcast });
    expect(vevents(ics).find((v) => v.includes('UID:s-sn@'))).toContain('DESCRIPTION:Transmisión: TV Pública\\n');
    expect(vevents(ics).find((v) => v.includes('UID:s-parcial@'))).toContain('DESCRIPTION:Transmisión habitual: TV Pública\\n');
  });

  it('cuando se publican los horarios, el evento de día completo deja de emitirse (mismo UID que desaparece)', () => {
    const before = buildFeed(all, [rioCuarto], [], NOW);
    expect(uids(before)).toEqual(['rio-cuarto']);
    const published = { ...rioCuarto, sessionsStatus: 'published' as const };
    const after = buildFeed(all, [published], [session('s-rc', published, '2026-11-15T17:00:00Z')], NOW);
    expect(uids(after)).toEqual(['s-rc']);
    // El id del evento es estable entre corridas: el mismo UID mientras siga sin horarios.
    expect(uids(buildFeed(all, [rioCuarto], [], new Date('2026-11-13T09:00:00Z')))).toEqual(['rio-cuarto']);
  });

  it('los ensayos (kind test) no van como día completo, pero sus sesiones sí', () => {
    const test = { ...event('ensayo', 'tc', '2026-11-17', '2026-11-18'), kind: 'test' as const };
    expect(uids(buildFeed(all, [test], [], NOW))).toEqual([]);
    const withTimes = { ...test, sessionsStatus: 'published' as const };
    expect(uids(buildFeed(all, [withTimes], [session('s-ensayo', withTimes, '2026-11-17T13:00:00Z')], NOW))).toEqual(['s-ensayo']);
  });

  it('respeta onlySeries y mantiene CRLF', () => {
    const ics = buildFeed(all, events, sessions, NOW, { onlySeries: ['tn'] });
    expect(uids(ics).sort()).toEqual(['hoy', 's-parcial']);
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('el nombre del calendario se puede cambiar; por defecto es "Deporte Motor"', () => {
    expect(buildFeed(all, events, sessions, NOW)).toContain('X-WR-CALNAME:Deporte Motor\r\n');
    expect(buildFeed(all, events, sessions, NOW, { calendarName: 'TC; Pista' })).toContain('X-WR-CALNAME:TC\\; Pista\r\n');
  });
});

describe('calendarios por categoría (data/feeds/{seriesId}.ics)', () => {
  const all = [series('tc', 'Turismo Carretera'), series('tn', 'Turismo Nacional (Clase 2 y 3)'), series('f1', 'Fórmula 1'), series('off', 'Apagada', false)];
  const rioCuarto = event('rio-cuarto', 'tc', '2026-11-13', '2026-11-15');
  const sanNicolas = event('san-nicolas', 'tc', '2026-11-20', '2026-11-22', 'published');
  const tnFinal = event('tn-final', 'tn', '2026-11-27', '2026-11-29', 'published');
  const apagada = event('apagada', 'off', '2026-11-20', '2026-11-22');
  const events = [rioCuarto, sanNicolas, tnFinal, apagada];
  const sessions = [session('s-sn', sanNicolas, '2026-11-22T17:00:00Z', false), session('s-tn', tnFinal, '2026-11-29T16:00:00Z')];
  const broadcast = { tc: ['TV Pública', 'Motorplay'] };
  const calName = (ics: string) => ics.match(/X-WR-CALNAME:([^\r]*)\r\n/)![1];

  it('arma uno por categoría habilitada, con el nombre de la categoría y solo sus eventos', () => {
    const feeds = buildSeriesFeeds(all, events, sessions, NOW, { broadcast });
    expect([...feeds.keys()]).toEqual(['tc', 'tn', 'f1']);
    const tc = feeds.get('tc')!;
    expect(calName(tc)).toBe('Turismo Carretera');
    expect(uids(tc).sort()).toEqual(['rio-cuarto', 's-sn']);
    // Mismas reglas que el general: el evento sin horarios va como día completo con la transmisión habitual.
    expect(tc.replace(/\r\n /g, '')).toContain('Transmisión habitual: TV Pública\\, Motorplay\\nFuente: https://example.org/rio-cuarto');
    expect(calName(feeds.get('tn')!)).toBe('Turismo Nacional (Clase 2 y 3)');
    expect(uids(feeds.get('tn')!)).toEqual(['s-tn']);
    // Lo mismo que daría el general filtrado por esa categoría.
    expect(uids(tc).sort()).toEqual(uids(buildFeed(all, events, sessions, NOW, { onlySeries: ['tc'], broadcast })).sort());
  });

  it('una categoría sin nada en la ventana igual tiene su calendario (válido y vacío), para no dar 404', () => {
    const f1 = buildSeriesFeeds(all, events, sessions, NOW).get('f1')!;
    expect(calName(f1)).toBe('Fórmula 1');
    expect(uids(f1)).toEqual([]);
    expect(f1.startsWith('BEGIN:VCALENDAR\r\nVERSION:2.0\r\n')).toBe(true);
    expect(f1.endsWith('END:VCALENDAR\r\n')).toBe(true);
  });

  it('nombre del calendario sin comas ni punto y coma (hay clientes que mostrarían el escape)', () => {
    expect(seriesCalendarName({ name: 'Fórmula 1', shortName: 'F1' })).toBe('Fórmula 1');
    expect(seriesCalendarName({ name: 'Turismo Pista (Clases 1, 2 y 3)', shortName: 'Turismo Pista' })).toBe('Turismo Pista');
    expect(seriesCalendarName({ name: 'A, B; C', shortName: 'A, B' })).toBe('A B C');
    const tp = { ...series('turismo-pista', 'Turismo Pista (Clases 1, 2 y 3)'), shortName: 'Turismo Pista' };
    expect(calName(buildSeriesFeeds([tp], [], [], NOW).get('turismo-pista')!)).toBe('Turismo Pista');
  });

  it('no usa como nombre de archivo el del calendario general ni un id que no sea un slug', () => {
    const raros = [series(MAIN_FEED, 'Choca con el general'), series('../fuera', 'Sale de la carpeta'), series('Con Espacios', 'Raro'), series('tc', 'Turismo Carretera')];
    expect([...buildSeriesFeeds(raros, events, sessions, NOW).keys()]).toEqual(['tc']);
  });

  describe('escritura', () => {
    let dir: string;
    beforeEach(async () => {
      dir = await mkdtemp(path.join(os.tmpdir(), 'dm-feeds-'));
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });
    const list = async () => (await readdir(dir)).sort();

    it('escribe un .ics por categoría habilitada y borra los de las que ya no existen o están apagadas', async () => {
      await writeFile(path.join(dir, `${MAIN_FEED}.ics`), 'GENERAL');
      await writeFile(path.join(dir, 'off.ics'), 'VIEJO: categoría deshabilitada');
      await writeFile(path.join(dir, 'ya-no-existe.ics'), 'VIEJO: categoría borrada');
      await writeFile(path.join(dir, 'notas.txt'), 'no es un calendario');

      const report = await writeSeriesFeeds(dir, all, events, sessions, NOW, { broadcast });
      expect(report.written).toEqual(['tc', 'tn', 'f1']);
      expect(report.unchanged).toEqual([]);
      expect(report.removed.sort()).toEqual(['off', 'ya-no-existe']);
      expect(await list()).toEqual([`${MAIN_FEED}.ics`, 'f1.ics', 'notas.txt', 'tc.ics', 'tn.ics']);
      // El general no es de esta función: queda como estaba.
      expect(await readFile(path.join(dir, `${MAIN_FEED}.ics`), 'utf8')).toBe('GENERAL');
      const tc = await readFile(path.join(dir, 'tc.ics'), 'utf8');
      expect(tc).toBe(buildSeriesFeeds(all, events, sessions, NOW, { broadcast }).get('tc'));
      // En disco siguen con CRLF.
      expect(tc.replace(/\r\n/g, '')).not.toContain('\n');
    });

    it('crea la carpeta si no existe', async () => {
      const nested = path.join(dir, 'data', 'feeds');
      const report = await writeSeriesFeeds(nested, all, events, sessions, NOW);
      expect(report.written).toHaveLength(3);
      expect((await readdir(nested)).sort()).toEqual(['f1.ics', 'tc.ics', 'tn.ics']);
    });

    it('no reescribe un calendario que solo cambiaría en la hora de generación', async () => {
      await writeSeriesFeeds(dir, all, events, sessions, NOW, { broadcast });
      const before = await readFile(path.join(dir, 'tc.ics'), 'utf8');
      // Una hora después, sin novedades: mismo contenido salvo DTSTAMP.
      const later = new Date(NOW.getTime() + 3600_000);
      const second = await writeSeriesFeeds(dir, all, events, sessions, later, { broadcast });
      expect(second).toEqual({ written: [], unchanged: ['tc', 'tn', 'f1'], removed: [] });
      expect(await readFile(path.join(dir, 'tc.ics'), 'utf8')).toBe(before);
      // Con una novedad (cambió un horario) sí se reescribe, solo el de esa categoría.
      const moved = sessions.map((s) => (s.id === 's-sn' ? { ...s, startUtc: '2026-11-22T18:00:00Z', endUtc: '2026-11-22T19:00:00Z' } : s));
      const third = await writeSeriesFeeds(dir, all, events, moved, later, { broadcast });
      expect(third).toEqual({ written: ['tc'], unchanged: ['tn', 'f1'], removed: [] });
      expect(await readFile(path.join(dir, 'tc.ics'), 'utf8')).toContain('DTSTART:20261122T180000Z');
    });
  });
});
