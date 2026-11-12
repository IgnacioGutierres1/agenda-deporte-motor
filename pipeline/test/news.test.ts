import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { newsFileSchema, type NewsFile, type NewsItem } from '@dm/shared';
import { createLogger } from '../src/core/log.ts';
import { newsConfigSchema, type NewsConfig } from '../src/news/config.ts';
import {
  canonicalKey,
  cleanUrl,
  collectNews,
  runNews,
  selectNews,
  similarTitles,
} from '../src/news/index.ts';
import { clip, decodeFeed, parseDate, parseFeed } from '../src/news/parse.ts';
import { tagSeries, tagUrl } from '../src/news/tag.ts';
import { fakeHttp, fixture } from './fake-http.ts';

const NOW = new Date('2026-11-10T21:00:00Z');
const log = createLogger('test', true);
const news = (name: string) => fixture(`news/${name}`);

describe('parseFeed (RSS 2.0)', () => {
  it('lee un WordPress argentino (APTP): título, link, fecha UTC, bajada sin el pie automático y categorías', () => {
    const items = parseFeed(news('aptp.xml'), 'https://aptpweb.com.ar/feed/');
    expect(items).toHaveLength(3);
    const [first] = items;
    expect(first!.title).toBe('SANTIAGO LANTELLA SE PRESENTARÁ EN LA CLASE UNO DE LA MANO DEL MDS RACING');
    expect(first!.url).toBe('https://aptpweb.com.ar/santiago-lantella-se-presentara-en-la-clase-uno-de-la-mano-del-mds-racing/');
    expect(first!.publishedAt).toBe('2026-11-10T11:25:42Z');
    expect(first!.summary).toMatch(/^El piloto de Balcarce volverá/);
    expect(first!.summary).not.toMatch(/se publicó primero/);
    expect(first!.categories).toEqual(['Clase 1']);
  });

  it('formula1.com no informa fecha: publishedAt queda en null', () => {
    const items = parseFeed(news('formula1.xml'), 'https://www.formula1.com/en/latest/all.xml');
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.publishedAt === null)).toBe(true);
    expect(items[0]!.title).toBe('PALMER: Why Norris’ Sao Paulo victory was one of his best ever wins');
    expect(items[0]!.image).toBeUndefined();
  });

  it('FIA: bajada con HTML escapado (sin CDATA), sin el rótulo "Sport news", e imagen de ese HTML', () => {
    const items = parseFeed(news('fia.xml'), 'https://www.fia.com/rss/news');
    expect(items[0]!.summary).toMatch(/^Additional Development and Upgrade Opportunities/);
    expect(items[0]!.summary).not.toMatch(/<p|&lt;/);
    expect(items[0]!.image).toBe('https://www.fia.com/sites/default/files/news/main_image/302_1.png');
  });

  it('SoloTC: entidades HTML y fechas con offset', () => {
    const items = parseFeed(news('solotc.xml'), 'https://www.solotc.com.ar/feed/');
    expect(items).toHaveLength(15);
    expect(items[3]!.title).toBe('Catalán Magni: “El balance de este año es irregular”');
    expect(items[0]!.summary).not.toMatch(/contenido original/);
  });

  it('CDATA con etiquetas adentro no se confunde con la estructura; entidades decodificadas', () => {
    const xml = `<?xml version="1.0"?><rss version="2.0"><channel><title>X</title>
      <item>
        <title>TC Pista &#8211; Fecha 10 &amp; final</title>
        <link>/notas/fecha-10</link>
        <pubDate>Sun, 08 Nov 2026 18:12:38 -0300</pubDate>
        <description><![CDATA[<p><title>no soy el título</title><img src="data:image/gif;base64,AAA"><img src="/fotos/portada.jpg" width="800" height="450"> Gran carrera &amp; definición.</p>]]></description>
      </item></channel></rss>`;
    const [item] = parseFeed(xml, 'https://medio.example.com.ar/feed/');
    expect(item!.title).toBe('TC Pista – Fecha 10 & final');
    expect(item!.url).toBe('https://medio.example.com.ar/notas/fecha-10');
    expect(item!.publishedAt).toBe('2026-11-08T21:12:38Z');
    expect(item!.image).toBe('https://medio.example.com.ar/fotos/portada.jpg');
    expect(item!.summary).toBe('no soy el título Gran carrera & definición.');
  });

  it('rechaza lo que no es un feed', () => {
    expect(() => parseFeed('<!doctype html><html><body>404</body></html>', 'https://x.org/')).toThrow(/no es un feed/);
  });
});

describe('parseFeed (Atom)', () => {
  it('Campeones (Atom, castellano): link alternate, published, categorías por "term" e imagen del contenido', () => {
    const items = parseFeed(news('campeones-atom.xml'), 'https://campeones.com.ar/feed/atom/');
    expect(items).toHaveLength(5);
    const garro = items.find((i) => i.title.startsWith('Carlos Garro'))!;
    expect(garro.url).toBe('https://campeones.com.ar/carlos-garro-y-su-opinion-de-la-nueva-pista-de-rio-cuarto/');
    expect(garro.publishedAt).toBe('2026-11-10T17:38:26Z');
    expect(garro.categories).toContain('Turismo Carretera');
    expect(garro.image).toBe('https://campeones.com.ar/wp-content/uploads/2026/09/260922-TC-Rio-Cuarto.jpg');
    expect(items[0]!.summary).toBe(
      'El punto de vista de Allan McNish, director de competición en Audi, el argentino obligó a su piloto a salirse de la pista.',
    );
  });

  it('Sportscar365: saltea el banner publicitario (728x90) y toma la foto de la nota', () => {
    const [first] = parseFeed(news('sportscar365-atom.xml'), 'https://sportscar365.com/feed/atom/');
    expect(first!.image).toBe('https://sportscar365.com/wp-content/uploads/2026/11/BB_CTMP_7_12_25_07544-copy.jpg');
  });
});

describe('imágenes', () => {
  it('enclosure (motorsport.com), media:content (RACER, The Race)', () => {
    expect(parseFeed(news('motorsport-lat.xml'), 'https://lat.motorsport.com/')[0]!.image).toBe(
      'https://cdn-7.motorsport.com/images/amp/YXyKj9j6/s6/nikita-johnson-barber-motorspo.jpg',
    );
    expect(parseFeed(news('racer.xml'), 'https://racer.com/feed')[0]!.image).toMatch(
      /^https:\/\/cdn-cs-images\.racer\.com\/.+Nikita_Johnson.+\.jpg\?environment=live$/,
    );
    expect(parseFeed(news('the-race.xml'), 'https://www.the-race.com/rss/')[0]!.image).toBe(
      'https://storage.ghost.io/c/dd/af/ddafbd99-2ccd-468c-b622-4b3cccf80b49/content/images/2026/11/XPB_1453856_HiRes.jpg',
    );
  });

  it('solo http(s), sin íconos ni GIF; media:thumbnail y enclosure no imagen', () => {
    const rss = (inner: string) =>
      `<rss version="2.0"><channel><item><title>T</title><link>https://a.org/n</link>${inner}</item></channel></rss>`;
    const img = (inner: string) => parseFeed(rss(inner), 'https://a.org/')[0]!.image;
    expect(img('<media:content url="ftp://a.org/x.jpg" medium="image"/>')).toBeUndefined();
    expect(img('<enclosure url="https://a.org/audio.mp3" type="audio/mpeg"/>')).toBeUndefined();
    expect(img('<media:thumbnail url="https://a.org/t.jpg"/>')).toBe('https://a.org/t.jpg');
    expect(img('<description><![CDATA[<img src="https://a.org/logo.png"><img src="https://a.org/anim.gif"><img src="https://a.org/ok.webp">]]></description>')).toBe(
      'https://a.org/ok.webp',
    );
    expect(img('<description><![CDATA[<img src="javascript:alert(1)">]]></description>')).toBeUndefined();
  });
});

describe('fechas y textos', () => {
  it('RFC 822 con GMT/offset e ISO 8601 → ISO UTC', () => {
    expect(parseDate('Tue, 10 Nov 2026 16:00:00 GMT')).toBe('2026-11-10T16:00:00Z');
    expect(parseDate('Tue, 10 Nov 2026 13:42:00 -0300')).toBe('2026-11-10T16:42:00Z');
    expect(parseDate('2026-11-10T20:56:02+01:00')).toBe('2026-11-10T19:56:02Z');
    expect(parseDate('cualquier cosa')).toBeNull();
  });

  it('recorta la bajada en una palabra', () => {
    const s = clip('palabra '.repeat(60).trim(), 240);
    expect(s.length).toBeLessThanOrEqual(240);
    expect(s.endsWith('palabra…')).toBe(true);
  });

  it('decodifica feeds en ISO-8859-1', () => {
    const latin1 = Uint8Array.from([...'<?xml version="1.0" encoding="ISO-8859-1"?><rss><x>Fórmula</x></rss>'].map((c) => c.charCodeAt(0)));
    expect(decodeFeed(latin1)).toContain('Fórmula');
    expect(decodeFeed(new TextEncoder().encode('<rss>Fórmula</rss>'), 'text/xml; charset=utf-8')).toContain('Fórmula');
  });
});

describe('tagSeries', () => {
  const es = (title: string) => tagSeries({ title, lang: 'es' });
  const en = (title: string) => tagSeries({ title, lang: 'en' });

  it('TC no se confunde con TC2000, TC Pista, TC Pick Up ni TC Mouras', () => {
    expect(es('Canapino ganó en el Súper TC2000')).toEqual(['tc2000']);
    expect(es('TC 2000: cronograma de la fecha')).toEqual(['tc2000']);
    expect(es('Ganó el TC Pista en Río Cuarto')).toEqual(['tc-pista']);
    expect(es('TC Pick Up: Canapino ganó la Final')).toEqual(['tc-pickup']);
    expect(es('TC PickUp y TC Mouras en La Plata')).toEqual(['tc-mouras', 'tc-pickup']);
    expect(es('TC Pista Mouras: clasificación')).toEqual(['tc-mouras']);
    expect(es('Trucco confirmó cómo sigue en el TC 2027')).toEqual(['tc']);
    expect(es('El TC y el TC Pista visitan Río Cuarto')).toEqual(['tc-pista', 'tc']);
    expect(es('Turismo Carretera: la Copa de Oro')).toEqual(['tc']);
  });

  it('"TC" a secas solo en castellano y no dentro de otras siglas', () => {
    expect(en('Driver aids: TC and ABS banned')).toEqual([]);
    expect(es('La ACTC confirmó el calendario')).toEqual([]);
  });

  it('Turismo Nacional, TN por clase y Turismo Pista; "TN" solo (canal de TV) no cuenta', () => {
    expect(es('Turismo Nacional: Clase 3 en San Nicolás')).toEqual(['tn']);
    expect(es('Werner dominó en el TN Clase 3')).toEqual(['tn']);
    expect(es('La Clase 2 del TN corre en Buenos Aires')).toEqual(['tn']);
    expect(es('Entrevista en TN con Colapinto')).toEqual([]);
    expect(es('Clase Uno del Turismo Pista en Rafaela')).toEqual(['turismo-pista']);
  });

  it('monoplazas: F1 Academy, Fórmula 2/3 y F1', () => {
    expect(en('F1 ACADEMY announces 2027 calendar')).toEqual(['f1-academy']);
    expect(es('Varrone deja la Fórmula 2')).toEqual(['f2']);
    expect(en('F2 and F3 title deciders')).toEqual(['f2', 'f3']);
    expect(es('Colapinto en la Fórmula 1')).toEqual(['f1']);
    expect(en("Liberty Media sells F1's parent company")).toEqual(['f1']);
    expect(en('Formula E: Vandoorne joins Jaguar')).toEqual([]);
  });

  it('motos, EE.UU. y resistencia', () => {
    expect(en('Old Moto2 injury at the heart of MotoGP retirement')).toEqual(['moto2', 'motogp']);
    expect(en('Red Bull MotoGP Rookies Cup champion crowned')).toEqual([]);
    expect(en('Indy NXT champion steps up to IndyCar')).toEqual(['indy-nxt', 'indycar']);
    expect(en('Blaney to skip NASCAR events')).toEqual(['nascar-cup']);
    expect(en('Xfinity Series finale at Phoenix')).toEqual(['nascar-xfinity']);
    expect(en('Truck Series champion crowned')).toEqual(['nascar-truck']);
    expect(es('Ferrari gana las 24 Horas de Le Mans')).toEqual(['wec']);
    expect(en('European Le Mans Series: Portimão finale')).toEqual(['elms']);
    expect(en('Inter Europol returns to Asian Le Mans Series')).toEqual(['alms']);
    expect(en('ALMS: Le Castellet opens the 2026-27 season')).toEqual(['alms']);
    expect(en('Petit Le Mans: IMSA crowns champions')).toEqual(['imsa']);
    expect(en('DTM and GT World Challenge Europe share Hockenheim')).toEqual(['gtwc-europe', 'dtm']);
  });

  it('usa también categorías del feed y la bajada', () => {
    expect(tagSeries({ title: 'Norris explicó el incidente', categories: ['Formula 1'], lang: 'es' })).toEqual(['f1']);
    expect(tagSeries({ title: 'Garro aprobó la pista', summary: 'para los autos de TC y TC Pista', lang: 'es' })).toEqual([
      'tc-pista',
      'tc',
    ]);
  });

  it('tagUrl: secciones de la URL y palabras inequívocas del slug', () => {
    expect(tagUrl('https://lat.motorsport.com/f1/news/ocon-agradece/10873666/')).toEqual(['f1']);
    expect(tagUrl('https://www.the-race.com/formula-1/x/')).toEqual(['f1']);
    expect(tagUrl('https://www.ole.com.ar/autos/fia-formula1-qatar_0_U8GxRVTjvl.html')).toEqual(['f1']);
    expect(tagUrl('https://sportscar365.com/imsa/iwsc/walker/')).toEqual(['imsa']);
    expect(tagUrl('https://www.solotc.com.ar/agustin-canapino-repetir-triple-corona-2026-tc-tn-tcpu/')).toEqual([]);
  });
});

describe('dedupe y selección', () => {
  it('cleanUrl / canonicalKey: sin utm, sin barra final, sin www', () => {
    const raw =
      'https://lat.motorsport.com/f1/news/ocon/10873666/?utm_source=RSS&utm_medium=referral&utm_campaign=RSS-ALL#top';
    expect(cleanUrl(raw)).toBe('https://lat.motorsport.com/f1/news/ocon/10873666/');
    expect(canonicalKey('https://www.ejemplo.com/nota/?b=2&a=1&utm_source=x')).toBe(canonicalKey('http://ejemplo.com/nota?a=1&b=2'));
  });

  it('títulos casi idénticos', () => {
    expect(similarTitles('Canapino ganó la Final de TC Pick Up en La Plata', 'Canapino ganó la final de TC Pick Up en La Plata!')).toBe(true);
    expect(
      similarTitles('Canapino ganó la Final de TC Pick Up en La Plata', 'Canapino ganó la clasificación de TC Pick Up en La Plata'),
    ).toBe(false);
  });

  const item = (over: Partial<NewsItem>): NewsItem => ({
    id: 'x',
    title: 'Una nota cualquiera',
    url: 'https://a.org/n',
    source: 'Medio',
    sourceKind: 'medio',
    publishedAt: '2026-11-10T12:00:00Z',
    seriesIds: [],
    ...over,
  });
  const opts = { now: NOW, maxAgeDays: 10, maxItems: 250, maxPerFeed: 40 };

  it('deduplica por link canónico y por título, prefiere la fuente oficial y une categorías', () => {
    const out = selectNews(
      [
        item({ id: 'a', url: 'https://www.a.org/n/?utm_source=rss', seriesIds: ['tc'] }),
        item({ id: 'b', url: 'https://a.org/n', seriesIds: ['tc-pista'], image: 'https://a.org/i.jpg' }),
        item({ id: 'c', title: 'Nota oficial idéntica', url: 'https://medio.org/x', publishedAt: '2026-11-10T10:00:00Z' }),
        item({ id: 'd', title: 'Nota oficial idéntica', url: 'https://oficial.org/x', source: 'Oficial', sourceKind: 'oficial', publishedAt: '2026-11-10T11:00:00Z' }),
      ],
      opts,
    );
    expect(out).toHaveLength(2);
    const a = out.find((i) => i.url.includes('a.org'))!;
    expect(a.seriesIds.sort()).toEqual(['tc', 'tc-pista']);
    expect(a.image).toBe('https://a.org/i.jpg');
    expect(out.find((i) => i.title === 'Nota oficial idéntica')!.source).toBe('Oficial');
  });

  it('ventana de días, orden por fecha descendente y topes por fuente y total', () => {
    const many = Array.from({ length: 12 }, (_, k) =>
      item({
        id: `m${k}`,
        title: `Nota número ${k} del medio prolífico`,
        url: `https://p.org/${k}`,
        source: 'Prolífico',
        publishedAt: `2026-11-10T${String(k + 6).padStart(2, '0')}:00:00Z`,
      }),
    );
    const others = [
      item({ id: 'o1', title: 'Otra fuente', url: 'https://o.org/1', source: 'Otro', publishedAt: '2026-11-09T00:00:00Z' }),
      item({ id: 'old', title: 'Vieja', url: 'https://o.org/old', source: 'Otro', publishedAt: '2026-10-25T00:00:00Z' }),
    ];
    const out = selectNews([...others, ...many], { ...opts, maxPerFeed: 5 });
    expect(out.map((i) => i.id)).toEqual(['m11', 'm10', 'm9', 'm8', 'm7', 'o1']);
    expect(selectNews([...others, ...many], { ...opts, maxItems: 3 })).toHaveLength(3);
  });
});

describe('collectNews / runNews', () => {
  const config: NewsConfig = newsConfigSchema.parse({
    feeds: [
      { id: 'aptp', name: 'Turismo Pista (APTP)', url: 'https://aptpweb.com.ar/feed/', kind: 'oficial', lang: 'es', seriesIds: ['turismo-pista'] },
      { id: 'solotc', name: 'SoloTC', url: 'https://www.solotc.com.ar/feed/', kind: 'medio', lang: 'es' },
      { id: 'formula1', name: 'Formula 1', url: 'https://www.formula1.com/en/latest/all.xml', kind: 'oficial', lang: 'en', seriesIds: ['f1'] },
      { id: 'roto', name: 'Roto', url: 'https://roto.example.com/feed', kind: 'medio', lang: 'es' },
    ],
  });
  const routes = {
    'https://aptpweb.com.ar/feed/': news('aptp.xml'),
    'https://www.solotc.com.ar/feed/': news('solotc.xml'),
    'https://www.formula1.com/en/latest/all.xml': news('formula1.xml'),
  };

  it('un feed caído no corta la corrida; el resultado valida contra el esquema', async () => {
    const { file, stats } = await collectNews({ config, http: fakeHttp(routes), log, now: NOW });
    expect(file).not.toBeNull();
    expect(() => newsFileSchema.parse(file)).not.toThrow();
    expect(stats.find((s) => s.id === 'roto')).toMatchObject({ ok: false, fetched: 0 });
    expect(stats.find((s) => s.id === 'roto')!.error).toMatch(/404/);
    expect(stats.find((s) => s.id === 'solotc')).toMatchObject({ ok: true, fetched: 15, kept: 15 });

    const items = file!.items;
    // Orden descendente
    expect([...items].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))).toEqual(items);
    // APTP: categoría por la fuente
    expect(items.filter((i) => i.source === 'Turismo Pista (APTP)').every((i) => i.seriesIds.includes('turismo-pista'))).toBe(true);
    // SoloTC: TC Pick Up sin "tc"
    const pickup = items.find((i) => i.title === 'TC Pick Up: Canapino ganó la Final de la 10ª fecha en La Plata')!;
    expect(pickup.seriesIds).toEqual(['tc-pickup']);
    expect(pickup.summary!.startsWith('Agustín Canapino')).toBe(true); // sin el título repetido
    expect(pickup.summary!.length).toBeLessThanOrEqual(240);
    expect(pickup.lang).toBe('es');
    // F1 sin fecha: la de la corrida
    expect(items.filter((i) => i.source === 'Formula 1').every((i) => i.publishedAt === '2026-11-10T21:00:00Z')).toBe(true);
    // ids estables por link
    expect(new Set(items.map((i) => i.id)).size).toBe(items.length);
  });

  it('conserva notas anteriores (también de feeds caídos) y la fecha de primera vista de las notas sin fecha', async () => {
    const first = (await collectNews({ config, http: fakeHttp(routes), log, now: NOW })).file!;
    const prevRoto: NewsItem = {
      id: 'roto1',
      title: 'Nota de un medio que hoy no responde',
      url: 'https://roto.example.com/nota',
      source: 'Roto',
      sourceKind: 'medio',
      publishedAt: '2026-11-09T12:00:00Z',
      seriesIds: [],
    };
    const prevGone: NewsItem = { ...prevRoto, id: 'gone', url: 'https://ya-no-esta.org/n', title: 'Fuente quitada', source: 'Quitada' };
    const previous: NewsFile = { ...first, items: [...first.items, prevRoto, prevGone] };
    const later = new Date('2026-11-11T09:00:00Z');
    const { file } = await collectNews({ config, http: fakeHttp(routes), log, now: later, previous });
    expect(file!.items.some((i) => i.id === 'roto1')).toBe(true);
    expect(file!.items.some((i) => i.id === 'gone')).toBe(false);
    expect(file!.items.filter((i) => i.source === 'Formula 1').every((i) => i.publishedAt === '2026-11-10T21:00:00Z')).toBe(true);
  });

  it('si fallan todos los feeds no hay archivo nuevo y runNews conserva el anterior', async () => {
    const { file, stats } = await collectNews({ config, http: fakeHttp({}), log, now: NOW });
    expect(file).toBeNull();
    expect(stats.every((s) => !s.ok)).toBe(true);

    const dir = await mkdtemp(path.join(os.tmpdir(), 'news-'));
    const configDir = path.join(dir, 'config');
    const dataDir = path.join(dir, 'data');
    await mkdir(configDir);
    await mkdir(dataDir);
    await writeFile(path.join(configDir, 'news.json'), JSON.stringify(config));
    const prev = JSON.stringify({ version: 1, generatedAt: '2026-11-09T00:00:00Z', items: [] }, null, 2) + '\n';
    await writeFile(path.join(dataDir, 'news.json'), prev);

    await runNews({ http: fakeHttp({}), log, now: NOW, dataDir, configDir });
    expect(await readFile(path.join(dataDir, 'news.json'), 'utf8')).toBe(prev);

    const res = await runNews({ http: fakeHttp(routes), log, now: NOW, dataDir, configDir });
    expect(res!.file!.items.length).toBeGreaterThan(0);
    const written = newsFileSchema.parse(JSON.parse(await readFile(path.join(dataDir, 'news.json'), 'utf8')));
    expect(written.items).toHaveLength(res!.file!.items.length);
  });

  it('la configuración real es válida y sus categorías existen', async () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const cfg = newsConfigSchema.parse(JSON.parse(await readFile(path.join(root, 'config/news.json'), 'utf8')));
    const seriesFile = JSON.parse(await readFile(path.join(root, 'config/series.default.json'), 'utf8'));
    const known = new Set<string>((seriesFile.series ?? seriesFile).map((x: { id: string }) => x.id));
    for (const f of cfg.feeds) for (const id of f.seriesIds ?? []) expect(known.has(id), id).toBe(true);
    expect(cfg.feeds.length).toBeGreaterThanOrEqual(8);
    expect(new Set(cfg.feeds.map((f) => f.id)).size).toBe(cfg.feeds.length);
    expect(new Set(cfg.feeds.map((f) => f.name)).size).toBe(cfg.feeds.length);
  });
});
