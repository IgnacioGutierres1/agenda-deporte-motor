import { describe, expect, it } from 'vitest';
import { discoveredFileSchema, type DiscoveredFile, type Source } from '@dm/shared';
import { createKnownMatcher, runDiscovery, type DiscoveryConfig } from '../src/discovery/index.ts';
import { fakeGemini, fakeHttp, fixture, genericSeries, testContext } from './fakes.ts';

const SRO = 'https://www.sro-motorsports.com/';
const NOW = '2026-11-10T12:00:00Z';

const config: DiscoveryConfig = {
  calendars: [{ name: 'SRO', url: SRO }],
  allowedDomains: ['sro-motorsports.com', 'gt4-america.com', 'cdaaca.org.ar'],
  searchEnabled: false,
  windowDays: 60,
  aliases: { 'gtwc-australia': ['GT World Challenge Australia'] },
  ignore: ['gala'],
};

const known = [
  genericSeries('gtwc-australia', 'Fanatec GT World Challenge Australia', ['https://www.gt-world-challenge-australia.com/calendar']),
  genericSeries('tc-pista', 'TC Pista', ['https://actc.org.ar/tcp/calendario']),
  genericSeries('tc-pista-mouras', 'TC Pista Mouras', ['https://actc.org.ar/tcpm/calendario'], { origin: 'user' }),
  // Las descubiertas previas también llegan en "known", pero no cuentan como configuradas.
  genericSeries('gt4-america', 'GT4 America', ['https://www.gt4-america.com/calendar'], { origin: 'discovered' }),
];

const oldSource: Source = { url: SRO, title: 'SRO', kind: 'html', method: 'directo', fetchedAt: '2026-10-01T00:00:00Z' };
const previous: DiscoveredFile = {
  version: 1,
  generatedAt: '2026-11-03T00:00:00Z',
  items: [
    { seriesId: 'gt4-america', name: 'GT4 America', officialUrl: 'https://www.gt4-america.com/calendar', firstSeen: '2026-10-01', source: oldSource },
    { seriesId: 'tc-pista-mouras', name: 'TC Pista Mouras', officialUrl: 'https://actc.org.ar/tcpm/calendario', firstSeen: '2026-10-01', source: oldSource },
    { seriesId: 'rally-viejo', name: 'Rally Viejo', officialUrl: 'https://www.fia.com/calendar', firstSeen: '2026-07-01', nextEventDate: '2026-08-01', source: oldSource },
    { seriesId: 'top-race', name: 'TOP RACE', officialUrl: 'https://www.cdaaca.org.ar/eventos', firstSeen: '2026-11-03', nextEventDate: '2026-12-04', source: oldSource },
  ],
};

describe('descubrimiento', () => {
  it('reconoce categorías configuradas por nombre, nombre corto, id o alias, sin confundir parecidas', () => {
    const match = createKnownMatcher(known.filter((s) => s.origin !== 'discovered'), config.aliases);
    expect(match('GT World Challenge Australia Powered by AWS')).toBe('gtwc-australia');
    expect(match('TC Pista')).toBe('tc-pista');
    expect(match('TC Pista Pick Up')).toBeNull();
    expect(match('GT4 America')).toBeNull();
  });

  it('Fuente 1: registra solo competencias no configuradas, conserva firstSeen y descarta las que ya son categorías', async () => {
    const http = fakeHttp({ [SRO]: fixture('discovery-sro-home.html') });
    const gemini = fakeGemini({}, { available: false });
    const out = await runDiscovery({ known, previous }, testContext(http, NOW), { config, gemini: () => gemini, env: {} });

    expect(discoveredFileSchema.parse(out)).toEqual(out);
    expect(out.items.map((i) => [i.seriesId, i.firstSeen, i.nextEventDate ?? null])).toEqual([
      ['gt4-america', '2026-10-01', '2026-12-04'], // hallada de nuevo: conserva la primera fecha
      ['top-race', '2026-11-03', '2026-12-04'], // no apareció esta vez, pero es reciente: se conserva
    ]);
    const gt4 = out.items[0]!;
    expect(gt4.officialUrl).toBe('https://www.gt4-america.com/calendar');
    expect(gt4.source).toMatchObject({ url: SRO, method: 'directo' });
    // Australia es conocida, la gala se ignora, la de 2027 cae fuera de la ventana,
    // TC Pista Mouras pasó a ser categoría del usuario y Rally Viejo expiró.
  });

  it('Fuente 2: solo acepta hallazgos de dominios oficiales o de sitios que se pueden verificar', async () => {
    const http = fakeHttp({
      [SRO]: fixture('discovery-sro-home.html'),
      'https://formula-zonal.example.org/': '<html><title>Fórmula Zonal</title><body>Campeonato Fórmula Zonal 2026</body></html>',
    });
    const reply = JSON.stringify([
      { championship: 'Top Race', eventName: '10ma fecha', dateStart: '2026-12-04', officialUrl: 'https://www.cdaaca.org.ar/eventos/10ma-fecha-top-race' },
      { championship: 'Fórmula Zonal', eventName: 'Fecha 9', dateStart: '2026-11-29', officialUrl: 'https://formula-zonal.example.org/' },
      { championship: 'Inventada Cup', eventName: 'R1', dateStart: '2026-11-30', officialUrl: 'https://no-existe.example.org/' },
      { championship: 'TC Pista', eventName: 'Fecha 14', dateStart: '2026-11-15', officialUrl: 'https://actc.org.ar/tcp/calendario' },
    ]);
    const gemini = fakeGemini({}, { search: () => ({ text: reply, sources: [] }) });
    const out = await runDiscovery(
      { known, previous: null },
      testContext(http, NOW),
      { config: { ...config, maxSearchCalls: 1 }, gemini: () => gemini, env: { DISCOVERY_SEARCH: '1' } },
    );
    expect(gemini.searches).toHaveLength(1);
    expect(gemini.searches[0]).toContain('cdaaca.org.ar');
    expect(out.items.map((i) => [i.seriesId, i.source.method])).toEqual([
      ['formula-zonal', 'ia'],
      ['gt4-america', 'directo'],
      ['top-race', 'ia'],
    ]);
    expect(discoveredFileSchema.parse(out)).toEqual(out);
  });
});
