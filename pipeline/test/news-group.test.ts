import { describe, expect, it } from 'vitest';
import type { NewsItem } from '@dm/shared';
import { createContextTagger, venueKeys } from '../src/news/context.ts';
import { groupStories, imageKey, mergeDuplicates } from '../src/news/group.ts';
import { applyDailyQuotas, selectNews, toNewsItem } from '../src/news/index.ts';
import { fillMissingImages, ogImage, smallerImage, type ImageCache } from '../src/news/og.ts';
import { tagSeries, tagUrl } from '../src/news/tag.ts';
import { properTokens } from '../src/news/text.ts';
import { fakeHttp } from './fake-http.ts';

const NOW = new Date('2026-11-12T06:00:00Z');

let seq = 0;
const item = (over: Partial<NewsItem>): NewsItem => ({
  id: `i${++seq}`,
  title: 'Una nota cualquiera',
  url: `https://medio.example.org/nota-${seq}`,
  source: 'Medio',
  sourceKind: 'medio',
  publishedAt: '2026-11-11T12:00:00Z',
  seriesIds: [],
  lang: 'en',
  ...over,
});

const titles = (items: NewsItem[]) => items.map((i) => i.title).sort();

describe('agrupado de la misma noticia', () => {
  it('Motorsport.com en inglés y su edición latinoamericana (misma foto en otra CDN): queda la de castellano', () => {
    const en = item({
      title: 'Andrea Stella wants McLaren to "finally" make peace with Las Vegas',
      url: 'https://www.motorsport.com/f1/news/andrea-stella/10873819/',
      source: 'Motorsport.com',
      publishedAt: '2026-11-11T11:18:24Z',
      image: 'https://cdn-1.motorsport.com/images/amp/YK15xn10/s6/graphics.jpg',
      seriesIds: ['f1'],
    });
    const es = item({
      title: 'Andrea Stella quiere que McLaren haga las paces "por fin" con Las Vegas',
      url: 'https://lat.motorsport.com/f1/news/andrea-stella/10873900/',
      source: 'Motorsport.com Latinoamérica',
      publishedAt: '2026-11-11T16:43:16Z',
      image: 'https://cdn-7.motorsport.com/images/amp/YK15xn10/s6/graphics.jpg',
      lang: 'es',
    });
    const out = groupStories([en, es]);
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toMatch(/^Andrea Stella quiere/);
    expect(out[0]!.seriesIds).toEqual(['f1']); // une las categorías
    expect(out[0]!.alsoIn).toEqual([{ source: 'Motorsport.com', url: en.url, lang: 'en' }]);
  });

  it('en idiomas distintos sin foto en común: al menos 3 nombres propios en los dos títulos', () => {
    const es = item({ title: 'Andrea Stella quiere que McLaren haga las paces con Las Vegas', source: 'A', lang: 'es' });
    const en = item({ title: 'Andrea Stella wants McLaren to make peace with Las Vegas', source: 'B' });
    expect(groupStories([es, en])).toHaveLength(1);
    // Solo "Muniz" y "Daytona" en mayúscula en los dos: no alcanza (una nota es el traslado, otra el alta).
    const traslado = item({ title: 'Frankie Muniz trasladado al hospital tras un accidente en una práctica en Daytona', source: 'A', lang: 'es' });
    const alta = item({ title: 'Muniz Released From Hospital After Daytona Practice Accident', source: 'C' });
    expect(groupStories([traslado, alta])).toHaveLength(2);
  });

  it('mismo idioma: títulos que comparten casi todo; nunca dos notas del mismo medio en un grupo', () => {
    const racer = item({ title: 'Kyle Busch wins NASCAR’s Most Popular Driver award', source: 'RACER', publishedAt: '2026-11-11T01:33:14Z' });
    const msport = item({
      title: 'Kyle Busch posthumously wins NASCAR Cup Most Popular Driver Award',
      source: 'Motorsport.com',
      publishedAt: '2026-11-11T00:47:34Z',
    });
    const speech = item({
      title: "Samantha Busch full speech as she accepts Kyle Busch's Most Popular Driver award",
      source: 'Motorsport.com',
      publishedAt: '2026-11-11T01:13:40Z',
    });
    const out = groupStories([racer, msport, speech]);
    expect(out).toHaveLength(2);
    const award = out.find((i) => i.alsoIn)!;
    // Principal: la primera publicada (ninguna en castellano ni oficial).
    expect(award.title).toMatch(/posthumously/);
    expect(award.alsoIn!.map((a) => a.source)).toEqual(['RACER']);
  });

  it('no agrupa sesiones distintas, años distintos, notas muy separadas ni fotos genéricas', () => {
    const pole = item({ title: 'Verstappen takes Las Vegas Grand Prix pole position', source: 'A' });
    const race = item({ title: 'Verstappen wins Las Vegas Grand Prix position battle', source: 'B' });
    expect(groupStories([pole, race])).toHaveLength(2);

    const review = item({ title: 'Resumen de la temporada 2026 de IndyCar: AJ Foyt Racing', source: 'A', lang: 'es' });
    const sponsor = item({ title: 'AJ Foyt Racing unveils first Pierson sponsor for 2027 IndyCar season', source: 'B' });
    expect(groupStories([review, sponsor])).toHaveLength(2);

    const a = item({ title: 'Kyle Busch wins Most Popular Driver award again', source: 'A', publishedAt: '2026-11-09T00:00:00Z' });
    const b = item({ title: 'Kyle Busch wins Most Popular Driver award again', source: 'B', publishedAt: '2026-11-11T12:00:00Z' });
    expect(groupStories([a, b])).toHaveLength(2);

    const logo = 'https://medio.example.org/default-news.jpg';
    const generic = ['Colapinto habló', 'Colapinto probó', 'Colapinto viajó', 'Colapinto ganó'].map((title, k) =>
      item({ title, source: `S${k}`, image: logo, lang: 'es' }),
    );
    expect(groupStories(generic)).toHaveLength(4);
  });

  it('principal: castellano, después oficial, después la primera; las versiones de una corrida anterior se reconocen por link', () => {
    const oficial = item({ title: 'Norris wins the title in Abu Dhabi finale tonight', source: 'Formula 1', sourceKind: 'oficial', publishedAt: '2026-11-11T13:00:00Z' });
    const medio = item({ title: 'Norris wins the title in Abu Dhabi finale tonight!', source: 'The Race', publishedAt: '2026-11-11T10:00:00Z' });
    expect(groupStories([oficial, medio])[0]!.source).toBe('Formula 1');

    const previo = item({
      title: 'Norris campeón en Abu Dhabi',
      source: 'Olé',
      lang: 'es',
      alsoIn: [{ source: 'The Race', url: 'https://www.the-race.com/f1/norris-title/', lang: 'en' }],
    });
    // La misma nota de The Race vuelve a aparecer en el feed (sin fecha en común con el título en castellano).
    const vuelve = item({ title: 'How Norris finally got it done', source: 'The Race', url: 'https://the-race.com/f1/norris-title', publishedAt: '2026-11-13T00:00:00Z' });
    const out = groupStories([previo, vuelve]);
    expect(out).toHaveLength(1);
    expect(out[0]!.source).toBe('Olé');
    expect(out[0]!.alsoIn).toHaveLength(1);
  });

  it('mismo medio: link repetido o título retocado con la misma foto se funden sin "También en"', () => {
    const img = 'https://sportscar365.com/wp-content/uploads/2026/11/28676373.jpg-1.png';
    const out = mergeDuplicates([
      item({ title: 'Cindric Holds Off Noaker for Veterans Day Classic Win', source: 'Sportscar365', image: img }),
      item({ title: 'Cindric Holds Noaker for Veterans Day Classic Win at Daytona', source: 'Sportscar365', image: img }),
      item({ title: 'La sorpresa de Villagra en la Score Baja 1000', source: 'Campeones', image: 'https://c.org/x.jpg', lang: 'es' }),
      item({ title: 'Equipo argentino listo para la Score Baja 1000 tras probar el CanAm', source: 'Campeones', image: 'https://c.org/x.jpg', lang: 'es' }),
    ]);
    expect(out).toHaveLength(3);
    expect(out.every((i) => !i.alsoIn)).toBe(true);
  });

  it('imageKey y properTokens', () => {
    expect(imageKey('https://cdn-7.motorsport.com/images/amp/X/s6/a.jpg?w=1')).toBe(imageKey('https://cdn-1.motorsport.com/images/amp/X/s6/a.jpg'));
    expect(properTokens('Andrea Stella quiere que McLaren haga las paces "por fin" con Las Vegas en 2026')).toEqual([
      'andrea',
      'stella',
      'mclaren',
      'vegas',
      '2026',
    ]);
  });
});

describe('topes por día', () => {
  const day = (d: number, h: number) => `2026-11-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00Z`;

  it('la ventana de días es real: con más notas que lugar, cada día conserva su parte', () => {
    // 10 días con 30 notas por día (de 6 medios y 3 categorías); entran 100.
    const all: NewsItem[] = [];
    for (let d = 3; d <= 12; d++) {
      for (let k = 0; k < 30; k++) {
        all.push(
          item({
            title: `Nota ${d}-${k} de ${['f1', 'motogp', 'tc'][k % 3]}`,
            source: `Medio ${k % 6}`,
            seriesIds: [['f1', 'motogp', 'tc'][k % 3]!],
            publishedAt: day(d, 4 + (k % 18)),
          }),
        );
      }
    }
    const out = selectNews(all, { now: NOW, maxAgeDays: 10, maxItems: 100, maxPerFeed: 100, maxPerFeedPerDay: 30, maxPerSeriesPerDay: 30 });
    expect(out).toHaveLength(100);
    const days = new Set(out.map((i) => i.publishedAt.slice(0, 10)));
    expect(days.size).toBe(10);
    // Sin topes por día, el total se llena con los últimos días.
    const plain = selectNews(all, { now: NOW, maxAgeDays: 10, maxItems: 100, maxPerFeed: 100 });
    expect(new Set(plain.map((i) => i.publishedAt.slice(0, 10))).size).toBeLessThanOrEqual(5);
  });

  it('tope por categoría y por medio en un día; entran primero las más relevantes', () => {
    const f1 = Array.from({ length: 8 }, (_, k) =>
      item({ title: `F1 ${k}`, source: `M${k}`, seriesIds: ['f1'], publishedAt: day(11, 10 + k) }),
    );
    const grouped = item({
      title: 'F1 agrupada',
      source: 'M9',
      seriesIds: ['f1'],
      publishedAt: day(11, 5),
      alsoIn: [{ source: 'Otro', url: 'https://otro.org/x' }],
    });
    const prolific = Array.from({ length: 6 }, (_, k) => item({ title: `Moto ${k}`, source: 'Crash', seriesIds: ['motogp'], publishedAt: day(11, 4 + k) }));
    const untagged = Array.from({ length: 5 }, (_, k) => item({ title: `Baja ${k}`, source: `B${k}`, publishedAt: day(11, 4 + k) }));
    const out = applyDailyQuotas([...f1, grouped, ...prolific, ...untagged], {
      now: NOW,
      maxAgeDays: 10,
      maxItems: 450,
      maxPerFeed: 80,
      maxPerFeedPerDay: 4,
      maxPerSeriesPerDay: 5,
    });
    const f1Out = out.filter((i) => i.seriesIds.includes('f1'));
    expect(f1Out).toHaveLength(5);
    expect(f1Out.some((i) => i.title === 'F1 agrupada')).toBe(true); // la contada por varios medios entra aunque sea la más vieja
    expect(out.filter((i) => i.source === 'Crash')).toHaveLength(4);
    expect(out.filter((i) => !i.seriesIds.length)).toHaveLength(5); // las sin categoría también tienen su tope (5)
    expect([...out].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))).toEqual(out);
  });
});

describe('etiquetado', () => {
  const en = (title: string, extra: { categories?: string[]; summary?: string } = {}) => tagSeries({ title, lang: 'en', ...extra });

  it('ALMS: Asian Le Mans (con o sin "Series"), AsLMS y ALMS', () => {
    expect(en('Asian Le Mans opener moves to Paul Ricard')).toEqual(['alms']);
    expect(en('AsLMS: Inter Europol confirms lineup')).toEqual(['alms']);
    expect(en('ALMS entry list revealed')).toEqual(['alms']);
    expect(en('Asian LMS season preview')).toEqual(['alms']);
    expect(en('European Le Mans Series champions')).toEqual(['elms']);
    expect(en('Alms for the poor')).toEqual([]);
  });

  it('IMSA: la sigla sola no cuenta en notas de copas que IMSA fiscaliza; el WeatherTech y sus clases sí', () => {
    expect(en('Cindric Holds Off Noaker for Win', { categories: ['Ford Racing', 'IMSA', 'Mustang Challenge NA'] })).toEqual([]);
    expect(en('Whelen Mazda MX-5 Cup reveals 2027 calendar', { summary: 'The IMSA-sanctioned series…' })).toEqual([]);
    expect(en('BMW Has Already Determined Eng’s Replacement in GTP', { categories: ['IMSA', 'BMW'] })).toEqual(['imsa']);
    expect(en('Walker returns', { categories: ['WeatherTech Championship', 'IMSA'] })).toEqual(['imsa']);
    expect(en('Sargent joins Wright in IMSA')).toEqual(['imsa']);
    expect(tagUrl('https://sportscar365.com/imsa/porsche-carrera-cup-na/maxson-selected/')).toEqual([]);
    expect(tagUrl('https://sportscar365.com/imsa/vp-racing-sportscar-challenge/forbush/')).toEqual([]);
    expect(tagUrl('https://sportscar365.com/imsa/iwsc/walker/')).toEqual(['imsa']);
  });

  const feed = { name: 'Medio', kind: 'medio' as const, lang: 'en' as const };
  const raw = (title: string, summary = '', categories: string[] = []) => ({ title, url: 'https://m.org/n', publishedAt: '2026-11-11T12:00:00Z', summary, categories });
  const ctx = { nowIso: '2026-11-12T00:00:00Z', maxChars: 240, prevById: new Map<string, NewsItem>() };

  it('la bajada solo se usa si el título, las etiquetas y la URL no ubican la nota', () => {
    expect(toNewsItem(feed, raw('Roos: BoP needs to be cornerstone of WEC 2030 regs', 'Like in IMSA, the GTP…'), ctx).seriesIds).toEqual(['wec']);
    expect(toNewsItem(feed, raw('The RACER Mailbag', 'Questions about IMSA and IndyCar'), ctx).seriesIds.sort()).toEqual(['imsa', 'indycar']);
  });

  const tagger = createContextTagger({
    drivers: [
      { name: 'Liam Lawson', entries: [{ seriesId: 'f1' }] },
      { name: 'Franco Colapinto', entries: [{ seriesId: 'f1' }] },
      { name: 'Jake Walker', lineups: [{ seriesId: 'imsa' }, { seriesId: 'gtwc-america' }] },
      { name: '- Bankcy', lineups: [{ seriesId: 'elms' }] },
    ],
    teams: [
      { name: 'Racing Bulls', entries: [{ seriesId: 'f1' }] },
      { name: 'Ford Racing', entries: [{ seriesId: 'nascar-cup' }] },
      { name: 'Ferrari', entries: [{ seriesId: 'f1' }] },
    ],
    events: [
      { seriesId: 'alms', name: '4 Hours of Le Castellet', circuit: 'Paul Ricard', dateStart: '2026-11-13', dateEnd: '2026-11-15' },
      { seriesId: 'tc', name: 'Fecha 14 — RIO CUARTO', circuit: 'Parque Ciudad de Rio Cuarto', dateStart: '2026-11-13', dateEnd: '2026-11-15' },
      { seriesId: 'tc-pista', name: 'Fecha 14 — RIO CUARTO', circuit: 'Parque Ciudad de Rio Cuarto', dateStart: '2026-11-13', dateEnd: '2026-11-15' },
    ],
  });

  it('por contexto: pilotos y equipos inequívocos, y circuitos de fechas cercanas con una sola categoría', () => {
    const at = '2026-11-11T12:00:00Z';
    expect(tagger.tag('Liam Lawson, el mejor del resto', at)).toEqual(['f1']);
    expect(tagger.tag('El tenso cruce entre Franco Colapinto y su ingeniero', at)).toEqual(['f1']);
    expect(tagger.tag('Racing Bulls confirma su dupla', at)).toEqual(['f1']);
    expect(tagger.tag('Jake Walker returns to Turner', at)).toEqual([]); // corre en dos categorías
    expect(tagger.tag('Ford Racing drivers set for Veterans Day Classic', at)).toEqual([]); // nombre genérico
    expect(tagger.tag('Ferrari confirma a Hamilton', at)).toEqual([]); // una sola palabra
    expect(tagger.tag('Lawson renovó', at)).toEqual([]); // solo apellido
    expect(tagger.tag('Martins Set for LMP2 Debut as Paul Ricard Entry Finalized', at)).toEqual(['alms']);
    expect(tagger.tag('Paul Ricard recibe una prueba de F4', '2026-09-01T00:00:00Z')).toEqual([]); // lejos de la fecha
    expect(tagger.tag('Todo listo en Río Cuarto', at)).toEqual([]); // TC y TC Pista: ambiguo
    expect(venueKeys({ name: 'Fecha 14 — RIO CUARTO', circuit: 'Parque Ciudad de Rio Cuarto' })).toEqual(['rio cuarto']);
    expect(venueKeys({ name: '4 Hours of Le Castellet', circuit: 'Paul Ricard' })).toEqual(['paul ricard', 'le castellet']);
  });

  it('toNewsItem usa el contexto solo si las palabras clave no encontraron nada', () => {
    const withTagger = { ...ctx, tagger };
    expect(toNewsItem(feed, raw('Liam Lawson, el mejor del resto'), withTagger).seriesIds).toEqual(['f1']);
    expect(toNewsItem(feed, raw('Liam Lawson tests for MotoGP team'), withTagger).seriesIds).toEqual(['motogp']);
  });
});

describe('foto de la página (og:image)', () => {
  it('lee og:image del <head> y achica las de formula1.com', () => {
    const html = `<html><head><meta property="og:title" content="x"><meta property="og:image" content="https://media.formula1.com/image/upload/c_lfill,w_2048/q_auto/v1/a.webp"/></head><body><meta property="og:image" content="https://x.org/no.jpg"></body></html>`;
    expect(ogImage(html, 'https://www.formula1.com/en/latest/article/x')).toBe(
      'https://media.formula1.com/image/upload/c_lfill,w_960/q_auto/v1/a.webp',
    );
    expect(ogImage('<head><meta name="twitter:image" content="/fotos/a.jpg"></head>', 'https://aptpweb.com.ar/nota/')).toBe(
      'https://aptpweb.com.ar/fotos/a.jpg',
    );
    expect(ogImage('<head><meta property="og:image" content="https://a.org/logo.png"></head>', 'https://a.org/')).toBeUndefined();
    expect(smallerImage('https://a.org/w_2048/x.jpg')).toBe('https://a.org/w_2048/x.jpg');
  });

  it('pocas páginas por corrida, las más nuevas primero, y cada link una sola vez (con caché)', async () => {
    const page = (img: string) => `<head><meta property="og:image" content="${img}"></head>`;
    const http = fakeHttp({
      'https://f1.org/a': page('https://f1.org/a.jpg'),
      'https://f1.org/b': page('https://f1.org/b.jpg'),
      'https://f1.org/c': '<head></head>',
    });
    const items = [
      item({ url: 'https://f1.org/a', publishedAt: '2026-11-11T10:00:00Z' }),
      item({ url: 'https://f1.org/b', publishedAt: '2026-11-11T12:00:00Z' }),
      item({ url: 'https://f1.org/c', publishedAt: '2026-11-11T11:00:00Z' }),
      item({ url: 'https://f1.org/d', image: 'https://f1.org/d.jpg' }),
    ];
    const cache: ImageCache = { 'viejo.org/x': { image: null, checkedAt: '2026-10-01T00:00:00Z' } };
    const r1 = await fillMissingImages(items, { http, cache, limit: 2, now: NOW, keepDays: 12 });
    expect(r1).toMatchObject({ fetched: 2, found: 1 });
    expect(http.calls).toEqual(['https://f1.org/b', 'https://f1.org/c']);
    expect(items[1]!.image).toBe('https://f1.org/b.jpg');
    expect(cache['f1.org/c']).toMatchObject({ image: null });
    expect(cache['viejo.org/x']).toBeUndefined();

    // Siguiente corrida: b sale de la caché, c no se vuelve a pedir, a se pide ahora.
    const again = items.map((i) => ({ ...i, image: i.url.endsWith('/d') ? i.image : undefined }));
    const r2 = await fillMissingImages(again, { http, cache, limit: 2, now: NOW, keepDays: 12 });
    expect(r2).toMatchObject({ fetched: 1, found: 1, fromCache: 1 });
    expect(http.calls.slice(2)).toEqual(['https://f1.org/a']);
    expect(again.every((i) => i.url.endsWith('/c') || i.image)).toBe(true);
  });
});
