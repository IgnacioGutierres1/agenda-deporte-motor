import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BROADCAST_LINKS_VERIFIED_AT, broadcastKey, broadcastLink, broadcastLinkLines, youtubeSearchUrl } from '../src/broadcast.ts';
import { buildIcs, type IcsEventInput } from '../src/ics.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(path.join(here, '..', '..', 'config', 'broadcast.ar.json'), 'utf8')) as Record<string, unknown>;
const configNames = [...new Set(Object.values(config).flatMap((v) => (Array.isArray(v) ? (v as string[]) : [])))].sort();

/** Canales de la config sin enlace confirmado (ver el encabezado de shared/src/broadcast.ts): quedan como texto. */
const TEXT_ONLY = ['Fox Sports', 'IMSA TV', 'NASCAR TrackPass'];

describe('enlaces de transmisión', () => {
  it('la fecha de verificación es una fecha', () => {
    expect(BROADCAST_LINKS_VERIFIED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('busca sin distinguir mayúsculas, acentos, espacios ni el signo +', () => {
    const disney = broadcastLink('Disney+');
    expect(disney).toEqual({ url: 'https://www.disneyplus.com/es-ar', kind: 'official' });
    for (const name of ['disney+', 'DISNEY PLUS', ' Disney  Plus ', 'Disney+ Premium']) expect(broadcastLink(name)).toEqual(disney);
    expect(broadcastLink('tv publica')).toEqual(broadcastLink('TV Pública'));
    expect(broadcastLink('TELEVISIÓN PÚBLICA')?.url).toBe('https://www.canal7.com.ar/');
    for (const name of ['F1 TV', 'F1TV', 'f1 tv pro', 'F1 TV Premium']) expect(broadcastLink(name)?.url).toBe('https://f1tv.formula1.com/');
    expect(broadcastLink('youtube dtm')?.url).toBe('https://www.youtube.com/@DTM');
    expect(broadcastKey('  TV  Pública (diferido) ')).toBe('tvpublica');
  });

  it('los nombres viejos (de datos ya publicados) llevan al mismo sitio que los actuales', () => {
    expect(broadcastLink('FIA WEC TV')).toEqual(broadcastLink('FIAWEC+'));
    expect(broadcastLink('FIAWEC+')?.url).toBe('https://plus.fiawec.com/en');
    expect(broadcastLink('TV Pública')).toEqual(broadcastLink('Canal 7 (TV Pública)'));
    expect(broadcastLink('Canal 7')?.url).toBe('https://www.canal7.com.ar/');
  });

  it('las señales numeradas llevan al sitio del canal ("ESPN 2", "ESPN 3 HD")', () => {
    const espn = broadcastLink('ESPN');
    expect(espn?.url).toBe('https://www.espn.com.ar/');
    for (const name of ['ESPN 2', 'ESPN3', 'ESPN 3 HD', 'ESPN Premium', 'ESPN (diferido)']) expect(broadcastLink(name)).toEqual(espn);
    // Un número suelto no alcanza para inventar un canal.
    expect(broadcastLink('Canal 9')).toBeNull();
    expect(broadcastLink('F1')).toBeNull();
  });

  it('cada canal de config/broadcast.ar.json tiene enlace oficial o está anotado como "solo texto"', () => {
    expect(configNames.length).toBeGreaterThan(20);
    const withoutLink = configNames.filter((n) => broadcastLink(n)?.kind !== 'official');
    // Si esto falla al sumar un canal a la config: verificar su URL y agregarla a la tabla, o anotarlo acá.
    expect(withoutLink).toEqual(TEXT_ONLY);
    for (const name of TEXT_ONLY) expect(broadcastLink(name)).toBeNull();
    for (const name of configNames) {
      const link = broadcastLink(name);
      if (link) expect(link.url).toMatch(/^https:\/\/[a-z0-9.-]+\//);
    }
  });

  it('un "YouTube X" sin canal confirmado lleva a una búsqueda con el nombre', () => {
    expect(broadcastLink('YouTube Top Race')).toEqual({ url: 'https://www.youtube.com/results?search_query=Top%20Race', kind: 'search' });
    expect(broadcastLink('Youtube (canal oficial) Fórmula Nacional')?.url).toBe(youtubeSearchUrl('Fórmula Nacional'));
    // Solo "YouTube": se busca la categoría; sin categoría no hay qué buscar.
    expect(broadcastLink('YouTube', 'Top Race')).toEqual({ url: youtubeSearchUrl('Top Race'), kind: 'search' });
    expect(broadcastLink('YouTube (canal oficial)', 'Copa Truck')?.url).toBe(youtubeSearchUrl('Copa Truck'));
    expect(broadcastLink('YouTube')).toBeNull();
  });

  it('lo desconocido queda sin enlace', () => {
    for (const name of ['', '   ', 'DSports', 'Canal de la categoría', 'スーパー耐久']) expect(broadcastLink(name)).toBeNull();
  });

  it('renglones para el calendario: solo oficiales y sin repetir el mismo enlace', () => {
    expect(broadcastLinkLines(['ESPN', 'ESPN 2', 'Disney+', 'Fox Sports', 'YouTube Top Race'])).toEqual([
      'ESPN: https://www.espn.com.ar/',
      'Disney+: https://www.disneyplus.com/es-ar',
    ]);
    expect(broadcastLinkLines([])).toEqual([]);
  });
});

describe('ics: enlaces de transmisión en la descripción', () => {
  const base: IcsEventInput = {
    id: 'abc',
    startUtc: '2026-11-15T17:00:00Z',
    endUtc: '2026-11-15T18:00:00Z',
    seriesName: 'MotoGP',
    circuit: 'Valencia',
    sessionName: 'Carrera',
    country: 'España',
    broadcast: ['ESPN', 'Disney+', 'MotoGP VideoPass'],
    broadcastIsDefault: true,
    sourceUrl: 'https://www.motogp.com/en/calendar',
  };
  const description = (ics: string) =>
    ics
      .replace(/\r\n /g, '')
      .split('\r\n')
      .find((l) => l.startsWith('DESCRIPTION:'))!;

  it('suma "Dónde verlo" después de la fuente, sin tocar los dos primeros renglones', () => {
    expect(description(buildIcs([base]))).toBe(
      'DESCRIPTION:Transmisión habitual: ESPN\\, Disney+\\, MotoGP VideoPass\\nFuente: https://www.motogp.com/en/calendar' +
        '\\nDónde verlo:\\nESPN: https://www.espn.com.ar/\\nDisney+: https://www.disneyplus.com/es-ar' +
        '\\nMotoGP VideoPass: https://www.motogp.com/es/videopass',
    );
  });

  it('sin canales con enlace confirmado la descripción queda como antes', () => {
    expect(description(buildIcs([{ ...base, broadcast: ['Fox Sports'] }]))).toBe(
      'DESCRIPTION:Transmisión habitual: Fox Sports\\nFuente: https://www.motogp.com/en/calendar',
    );
    expect(description(buildIcs([{ ...base, broadcast: [] }]))).toBe('DESCRIPTION:Transmisión: A confirmar\\nFuente: https://www.motogp.com/en/calendar');
  });

  it('también en los eventos de día completo, y las líneas siguen plegadas a 75 octetos', () => {
    const ics = buildIcs([
      { allDay: true, id: 'ev', dateStart: '2026-11-13', dateEnd: '2026-11-15', seriesName: 'MotoGP', circuit: 'Valencia', eventName: 'GP', country: 'España', broadcast: ['Disney+'], broadcastIsDefault: true },
      base,
    ]);
    expect(description(ics)).toContain('Transmisión habitual: Disney+\\nDónde verlo:\\nDisney+: https://www.disneyplus.com/es-ar');
    for (const line of ics.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(ics.replace(/\r\n/g, '')).not.toContain('\n');
  });
});
