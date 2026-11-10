import { describe, expect, it } from 'vitest';
import type { ScheduleFile, Source } from '@dm/shared';
import { isProxyAllowed } from '@dm/shared/live-sources';
import { dueNotifications, parseSubscribeBody, windowStart, type SubscriberRecord } from '../src/due.ts';

const source: Source = { url: 'https://example.org', title: 'x', kind: 'html', method: 'directo', fetchedAt: '2026-11-10T00:00:00Z' };

const schedule = {
  version: 1,
  generatedAt: '2026-11-13T00:00:00Z',
  series: [
    { id: 'tc', name: 'Turismo Carretera', shortName: 'TC', group: 'argentina', officialUrls: [], strategy: 'generic', origin: 'default', enabled: true },
    { id: 'f1', name: 'Fórmula 1', shortName: 'F1', group: 'f1-fia', officialUrls: [], strategy: 'adapter', origin: 'default', enabled: true },
    { id: 'off', name: 'Desactivada', shortName: 'OFF', group: 'otros', officialUrls: [], strategy: 'generic', origin: 'default', enabled: false },
  ],
  events: [
    { id: 'ev-tc', seriesId: 'tc', name: 'Fecha 14 — Río Cuarto', circuit: 'Río Cuarto', country: 'Argentina', tz: 'America/Argentina/Cordoba', dateStart: '2026-11-13', dateEnd: '2026-11-15', sessionsStatus: 'published', source },
  ],
  sessions: [
    // 15:40 ARG = 18:40 UTC
    { id: 's-clasi', eventId: 'ev-tc', seriesId: 'tc', type: 'clasificacion', name: 'Clasificación', startUtc: '2026-11-14T18:40:00Z', endUtc: '2026-11-14T19:10:00Z', endEstimated: false, broadcast: ['TV Pública'], broadcastIsDefault: true, source, hasResults: false },
    { id: 's-final', eventId: 'ev-tc', seriesId: 'tc', type: 'carrera', name: 'Final', startUtc: '2026-11-15T16:00:00Z', endUtc: '2026-11-15T17:00:00Z', endEstimated: true, broadcast: [], broadcastIsDefault: true, source, hasResults: false },
    { id: 's-off', eventId: 'ev-x', seriesId: 'off', type: 'carrera', name: 'Carrera', startUtc: '2026-11-14T18:40:00Z', endUtc: '2026-11-14T19:40:00Z', endEstimated: true, broadcast: [], broadcastIsDefault: true, source, hasResults: false },
  ],
} as unknown as ScheduleFile;

const sub = (id: string, seriesIds: string[], leadMinutes = 30): SubscriberRecord => ({
  id,
  subscription: { endpoint: `https://push.example.org/${id}`, keys: { p256dh: 'k', auth: 'a' } },
  seriesIds,
  leadMinutes,
  timeZone: 'America/Argentina/Buenos_Aires',
  updatedAt: '2026-11-13T00:00:00Z',
});

describe('avisos', () => {
  it('avisa una sola vez, en la ventana de 5 minutos que corresponde a la anticipación', () => {
    const subs = [sub('a', ['tc', 'off']), sub('b', ['f1']), sub('c', ['tc'], 60)];
    // Cron de las 18:10 UTC: ventana de inicio [18:40, 18:45) para 30 min.
    const at1810 = dueNotifications(schedule, subs, windowStart(Date.parse('2026-11-14T18:10:20Z')));
    expect(at1810).toEqual([
      {
        subscriberId: 'a',
        sessionId: 's-clasi',
        title: 'TC: Clasificación en 30 minutos',
        body: '15:40 h · Fecha 14 — Río Cuarto · TV: TV Pública',
        path: '#/evento/ev-tc',
      },
    ]);
    // Las ventanas vecinas no repiten el aviso.
    expect(dueNotifications(schedule, subs, Date.parse('2026-11-14T18:05:00Z')).filter((n) => n.subscriberId === 'a')).toEqual([]);
    expect(dueNotifications(schedule, subs, Date.parse('2026-11-14T18:15:00Z')).filter((n) => n.subscriberId === 'a')).toEqual([]);
    // Con 60 minutos, a las 17:40.
    expect(dueNotifications(schedule, subs, Date.parse('2026-11-14T17:40:00Z')).map((n) => [n.subscriberId, n.title])).toEqual([
      ['c', 'TC: Clasificación en 1 hora'],
    ]);
  });

  it('valida el pedido de suscripción', () => {
    const ok = parseSubscribeBody(
      { subscription: { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'p', auth: 'a' } }, seriesIds: ['tc', 'tc', 'F1!', 'f1'], leadMinutes: 15, timeZone: 'America/Argentina/Buenos_Aires' },
      'id1',
      '2026-11-13T00:00:00Z',
    );
    expect(ok).toMatchObject({ id: 'id1', seriesIds: ['tc', 'f1'], leadMinutes: 15 });
    expect(parseSubscribeBody({ subscription: { endpoint: 'http://inseguro', keys: { p256dh: 'p', auth: 'a' } } }, 'x', '')).toBe('Suscripción inválida');
    expect(parseSubscribeBody({ subscription: { endpoint: 'https://x.org' } }, 'x', '')).toBe('Faltan las claves de la suscripción');
    // Anticipación no permitida → 30.
    expect(parseSubscribeBody({ subscription: { endpoint: 'https://x.org', keys: { p256dh: 'p', auth: 'a' } }, leadMinutes: 7 }, 'x', '')).toMatchObject({ leadMinutes: 30 });
  });

  it('el proxy solo acepta las direcciones exactas de las fuentes de tiempos en vivo', () => {
    expect(isProxyAllowed('https://api.motogp.pulselive.com/motogp/v1/timing-gateway/livetiming-lite')).toBe(true);
    expect(isProxyAllowed('https://eventresults-api.speedhive.com/api/v0.2.3/eventresults/sessions/123/classification')).toBe(true);
    expect(isProxyAllowed('https://eventresults-api.speedhive.com/api/v0.2.3/eventresults/organizations/1/events?count=5')).toBe(false);
    expect(isProxyAllowed('https://api.motogp.pulselive.com.evil.org/x')).toBe(false);
    expect(isProxyAllowed('https://example.org/')).toBe(false);
  });
});
