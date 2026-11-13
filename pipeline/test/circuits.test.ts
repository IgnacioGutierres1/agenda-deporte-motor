import { describe, expect, it } from 'vitest';
import { circuitId } from '@dm/shared';
import { createApi, SourceLimitError } from '../src/circuits/api.ts';
import { cleanCredit, fetchImages, fileFromUploadUrl, fileKey, isPhotoFile, isPlanFile } from '../src/circuits/commons.ts';
import { cityQueries, geocodeCity } from '../src/circuits/geocode.ts';
import { groupCircuits } from '../src/circuits/group.ts';
import { fileNames, findDirection, lapTime, parseInfobox, plainValue } from '../src/circuits/infobox.ts';
import { countryMatches, distanceKm, nameLevel, pickMatch, pickNearby } from '../src/circuits/match.ts';
import { fetchPages, shortExtract, wikiUrl } from '../src/circuits/wikipedia.ts';
import { isTrack, parseEntity, type WdEntity, type WdPlace } from '../src/circuits/wikidata.ts';
import { HttpError, type Http } from '../src/core/http.ts';
import { fixture } from './fake-http.ts';

const json = <T = any>(name: string): T => JSON.parse(fixture(`circuits/${name}`)) as T;

/** Http falso: cada request se resuelve con la primera ruta cuyo patrón aparece en la URL (decodificada). */
function routeHttp(routes: Array<[pattern: string | RegExp, body: unknown | (() => unknown)]>): Http & { calls: string[] } {
  const calls: string[] = [];
  const get = async (url: string) => {
    calls.push(url);
    const decoded = decodeURIComponent(url);
    const route = routes.find(([p]) => (typeof p === 'string' ? decoded.includes(p) : p.test(decoded)));
    if (!route) throw new HttpError(url, 404, `HTTP 404 en ${url}`);
    const body = typeof route[1] === 'function' ? (route[1] as () => unknown)() : route[1];
    return { url, status: 200, contentType: 'application/json', body };
  };
  return {
    calls,
    json: get as Http['json'],
    text: async () => {
      throw new Error('las fichas de circuitos solo piden JSON');
    },
    bytes: async () => {
      throw new Error('las fichas de circuitos solo piden JSON');
    },
  };
}

const noSleep = async () => {};
const apiFor = (http: Http) => createApi({ http, pauseMs: 0, sleep: noSleep });

describe('groupCircuits', () => {
  const ev = (circuit: string, country: string, seriesId = 'f1') => ({ circuit, country, seriesId });

  it('agrupa como la app: misma clave, el nombre más usado y el país más frecuente', () => {
    const groups = groupCircuits([
      ev('Circuit Paul Ricard', 'Francia', 'elms'),
      ev('Paul Ricard', 'Francia', 'gtwce'),
      ev('Paul Ricard', '', 'f4'),
      ev('Michelin 12H PAUL RICARD', 'Francia', '24h-series'),
      ev('Autódromo Oscar y Juan Gálvez', 'Argentina', 'tc'),
      ev('A confirmar', 'Argentina', 'tc'),
    ]);
    expect(groups.map((g) => g.id)).toEqual(['oscar-y-juan-galvez', 'paul-ricard']);
    const ricard = groups[1]!;
    expect(ricard).toMatchObject({ key: 'paul ricard', name: 'Paul Ricard', country: 'Francia', events: 4 });
    expect(ricard.names).toEqual(['Paul Ricard', 'Circuit Paul Ricard', 'Michelin 12H PAUL RICARD']);
    expect(ricard.seriesIds).toEqual(['elms', 'gtwce', 'f4', '24h-series']);
    // El id es el que usa la app para buscar la ficha.
    expect(ricard.id).toBe(circuitId('Michelin 12H PAUL RICARD'));
  });

  it('un nombre de carrera solo se usa si no hay otro', () => {
    const [g] = groupCircuits([ev('CrowdStrike 24 Hours of Spa', 'Bélgica'), ev('CrowdStrike 24 Hours of Spa', 'Bélgica'), ev('Spa-Francorchamps', 'Bélgica')]);
    expect(g!.name).toBe('Spa-Francorchamps');
  });
});

describe('Wikidata: parseEntity', () => {
  const raw = json('wd-entities.json').entities.Q171417;

  it('lee tipo, país, coordenadas, longitud, inauguración, sitio, foto y artículos de Monza', () => {
    const e = parseEntity(raw)!;
    expect(e.id).toBe('Q171417');
    expect(e.labels).toMatchObject({ es: 'Autodromo Nazionale di Monza', en: 'Monza Circuit' });
    // Etiquetas y alias de todos los idiomas, sin repetir.
    expect(e.names).toContain('Circuito de Monza');
    expect(e.names).toContain('Autodromo Nazionale Monza');
    expect(new Set(e.names).size).toBe(e.names.length);
    expect(e.types).toContain('Q2338524');
    expect(isTrack(e)).toBe(true);
    expect(e.countries).toEqual(['Q38']);
    expect(e.locatedIn).toBe('Q6252');
    expect(e.lat).toBeCloseTo(45.62056, 4);
    expect(e.lon).toBeCloseTo(9.28944, 4);
    expect(e.lengthM).toBe(5793);
    expect(e.website).toBe('https://www.monzanet.it');
    expect(e.image).toBe('1975 Italian GP race start - Niki Lauda & Clay Regazzoni (Ferrari 312T).jpg');
    expect(e.routeMap).toBeUndefined();
    expect(e.eswiki).toBe('Autodromo Nazionale di Monza');
    expect(e.enwiki).toBe('Monza Circuit');
    expect(e.sitelinks).toBeGreaterThan(5);
  });

  it('convierte unidades, prefiere el rango preferido y deja de lado lo obsoleto o con fecha de fin', () => {
    const claim = (value: unknown, extra: Record<string, unknown> = {}) => ({
      mainsnak: { snaktype: 'value', datavalue: { value } },
      rank: 'normal',
      ...extra,
    });
    const time = (t: string) => [{ snaktype: 'value', datavalue: { value: { time: t } } }];
    const e = parseEntity({
      id: 'Q1',
      labels: { en: { language: 'en', value: 'Somewhere Speedway' } },
      claims: {
        P31: [claim({ id: 'Q2338524' })],
        P17: [claim({ id: 'Q183' }), claim({ id: 'Q16957' }, { qualifiers: { P582: time('+1990-10-02T00:00:00Z') } })],
        P2043: [
          claim({ amount: '+2.5', unit: 'http://www.wikidata.org/entity/Q253276' }, { qualifiers: { P582: time('+1999-00-00T00:00:00Z') } }),
          claim({ amount: '+4.023', unit: 'http://www.wikidata.org/entity/Q828224' }),
        ],
        P2044: [claim({ amount: '+100', unit: 'http://www.wikidata.org/entity/Q3710' })],
        P1083: [claim({ amount: '+50000', unit: '1' }, { rank: 'deprecated' }), claim({ amount: '+101500', unit: '1' })],
        P571: [claim({ time: '+1959-02-22T00:00:00Z' })],
        P856: [{ mainsnak: { snaktype: 'somevalue' }, rank: 'normal' }],
      },
    })!;
    expect(e.countries).toEqual(['Q183']);
    expect(e.lengthM).toBe(4023);
    expect(e.elevationM).toBe(30);
    expect(e.capacity).toBe(101500);
    expect(e.opened).toBe(1959);
    expect(e.website).toBeUndefined();
    expect(e.sitelinks).toBe(0);
  });

  it('un elemento inexistente no se lee', () => {
    expect(parseEntity({ id: 'Q999999999', missing: '' })).toBeNull();
  });
});

describe('Ficha del artículo (infobox)', () => {
  const en = json('enwiki-pages.json').query.pages as Array<{ title: string; revisions: Array<{ slots: { main: { content: string } } }> }>;
  const es = json('eswiki-pages.json').query.pages as typeof en;
  const text = (pages: typeof en, title: string) => pages.find((p) => p.title === title)!.revisions[0]!.slots.main.content;

  it('Wikipedia en inglés: curvas, longitud y récord del trazado principal (el primero)', () => {
    const galvez = parseInfobox(text(en, 'Autódromo Oscar y Juan Gálvez'));
    expect(galvez).toMatchObject({ turns: 19, lengthM: 4259, opened: 1952, capacity: 45000, city: 'Buenos Aires' });
    expect(galvez.lapRecord).toEqual({ time: '1:27.981', driver: 'Gerhard Berger', vehicle: 'Benetton B197', year: 1997, series: 'F1' });
    expect(galvez.images).toEqual(['Autódromo Oscar y Juan Gálvez Detalles.svg']);

    const monza = parseInfobox(text(en, 'Monza Circuit'));
    expect(monza.turns).toBe(11);
    expect(monza.lapRecord).toMatchObject({ time: '1:20.901', driver: 'Lando Norris', year: 2025, series: 'F1' });
  });

  it('un óvalo: tiempo de menos de un minuto y el plano ("track_map") antes que la imagen', () => {
    const daytona = parseInfobox(text(en, 'Daytona International Speedway'));
    expect(daytona.turns).toBe(4);
    expect(daytona.lapRecord).toMatchObject({ time: '0:43.682', driver: 'Erik Jones', vehicle: 'Toyota Camry' });
    expect(daytona.capacity).toBe(101500);
    // La localidad salta la dirección postal.
    expect(daytona.city).toBe('Daytona Beach');
    expect(daytona.images).toEqual(['Daytona International Speedway Road Course 2024.svg', 'Daytona International Speedway 2024.svg']);
  });

  it('Wikipedia en español: "Ficha de circuito de carreras" con coma decimal, banderas y enlaces', () => {
    const spa = parseInfobox(text(es, 'Circuito de Spa-Francorchamps'));
    expect(spa).toMatchObject({ turns: 20, lengthM: 7004, opened: 1920, capacity: 70000, city: 'Francorchamps' });
    expect(spa.lapRecord).toEqual({ time: '1:44.701', driver: 'Sergio Pérez', vehicle: 'Red Bull-Honda RBPT', year: 2024, series: 'Fórmula 1' });
    expect(spa.images).toEqual(['Logo Circuit de Spa Francorchamps.svg', 'Spa-Francorchamps of Belgium.svg']);

    // 1'18.523 y la fecha completa en el año del récord.
    const olavarria = parseInfobox(text(es, 'Autódromo Hermanos Emiliozzi'));
    expect(olavarria.lapRecord).toEqual({ time: '1:18.523', driver: 'José María López', vehicle: 'Torino', year: 2009 });
    expect(olavarria.turns).toBeUndefined();
  });

  it('el año del récord sale del texto visible del enlace, no de su destino', () => {
    // [[:es:Anexo:Ronda de Junín del Súper TC 2000 2013|2013]]: el destino nombra "TC 2000".
    const marcilla = parseInfobox(text(en, 'Autódromo Eusebio Marcilla'));
    expect(marcilla.lapRecord).toMatchObject({ time: '1:22.551', driver: 'Leonel Pernía', vehicle: 'Renault Fluence', year: 2013 });
    expect(marcilla.city).toBe('Junín');
  });

  it('localidad: cada renglón de la dirección es una parte y {{bandera2}} deja el nombre', () => {
    const box = (location: string) => parseInfobox(`{{Infobox motorsport venue\n| location = ${location}\n| turns = 4\n}}`).city;
    expect(box('4847-F McCreary Road<br>[[Lebanon, Tennessee]], United States<br>37090')).toBe('Lebanon');
    expect(box('{{bandera2|Río Cuarto (ciudad)}}, [[Provincia de Córdoba (Argentina)|Córdoba]]')).toBe('Río Cuarto');
    expect(box('[[Hall County, Georgia|Hall County]], [[Georgia (U.S. state)|Georgia]]')).toBe('Hall County');
    // Capacidad: un año suelto no cuenta.
    expect(parseInfobox('{{Infobox motorsport venue\n| capacity = 2021: 76,812\n| turns = 3\n}}').capacity).toBe(76812);
  });

  it('sin ficha no inventa nada', () => {
    expect(parseInfobox("'''Algo''' es un lugar. {{Otra plantilla|turns=3}}")).toEqual({ images: [] });
  });

  it('plainValue, lapTime y fileNames limpian el wikitexto', () => {
    expect(plainValue('{{flagicon|AUT}} [[Gerhard Berger]]<ref name="x">cita</ref>')).toBe('Gerhard Berger');
    expect(plainValue("{{nowrap|''[[Dallara DW12#IR-18|Dallara IR-18]]''}} <!-- nota -->")).toBe('Dallara IR-18');
    expect(plainValue('{{ill|Juan Martín Trucco|es}}')).toBe('Juan Martín Trucco');
    expect(lapTime('1:20.901<br />({{cvt|257.781|km/h}})')).toBe('1:20.901');
    expect(lapTime('1:44,701')).toBe('1:44.701');
    expect(lapTime('13.762 s')).toBe('13.762');
    expect(lapTime('257.781 km/h')).toBeUndefined();
    expect(lapTime('sin datos')).toBeUndefined();
    expect(fileNames('[[File:Monza track map.svg|class=skin-invert|260px]]')).toEqual(['Monza track map.svg']);
    expect(fileNames('Monza_track_map.svg')).toEqual(['Monza track map.svg']);
  });

  it('sentido de giro: solo si el texto lo dice de una sola manera', () => {
    expect(findDirection('The circuit runs clockwise.')).toBe('Horario');
    expect(findDirection('It is run in an anti-clockwise direction.')).toBe('Antihorario');
    expect(findDirection('A counterclockwise oval.')).toBe('Antihorario');
    expect(findDirection('Se gira en sentido antihorario.')).toBe('Antihorario');
    expect(findDirection('en el sentido de las agujas del reloj')).toBe('Horario');
    expect(findDirection('en sentido contrario a las agujas del reloj')).toBe('Antihorario');
    expect(findDirection('Formerly clockwise, now anti-clockwise.')).toBeUndefined();
    expect(findDirection('Un circuito de carreras.')).toBeUndefined();
  });
});

describe('Wikipedia: fetchPages y shortExtract', () => {
  it('pide varios artículos por request y los devuelve por el título pedido (con redirecciones)', async () => {
    const body = json('enwiki-pages.json');
    const http = routeHttp([['en.wikipedia.org/w/api.php', body]]);
    const pages = await fetchPages(apiFor(http), 'en', ['Monza Circuit', 'Long Beach street circuit', 'No existe']);
    expect(http.calls).toHaveLength(1);
    expect(http.calls[0]).toContain('titles=Monza%20Circuit%7CLong%20Beach%20street%20circuit%7CNo%20existe');
    expect(pages.get('Monza Circuit')).toMatchObject({ title: 'Monza Circuit', image: 'Monza_track_map.svg' });
    expect(pages.get('Monza Circuit')!.extract).toMatch(/^The Monza Circuit/);
    expect(pages.get('Monza Circuit')!.wikitext).toContain('Infobox motorsport venue');
    expect(pages.has('No existe')).toBe(false);
    // "Long Beach street circuit" redirige a un artículo que el fixture recortado no trae.
    expect(pages.has('Long Beach street circuit')).toBe(false);
  });

  it('sigue las continuaciones de la API y junta lo de cada artículo', async () => {
    let n = 0;
    const http = routeHttp([
      [
        'es.wikipedia.org/w/api.php',
        () =>
          n++ === 0
            ? { continue: { excontinue: '1', continue: '||' }, query: { pages: [{ title: 'A', extract: 'Texto de A.' }, { title: 'B', pageimage: 'B.svg' }] } }
            : { query: { pages: [{ title: 'A' }, { title: 'B', extract: 'Texto de B.' }] } },
      ],
    ]);
    const pages = await fetchPages(apiFor(http), 'es', ['A', 'B']);
    expect(http.calls).toHaveLength(2);
    expect(http.calls[1]).toContain('&excontinue=1');
    expect(pages.get('A')).toEqual({ title: 'A', extract: 'Texto de A.' });
    expect(pages.get('B')).toEqual({ title: 'B', image: 'B.svg', extract: 'Texto de B.' });
  });

  it('extracto corto: primer párrafo, sin marcas invisibles, cortado en un final de oración', () => {
    const monza = (json('eswiki-pages.json').query.pages as Array<{ title: string; extract: string }>).find((p) => p.title.includes('Monza'))!;
    const short = shortExtract(monza.extract)!;
    expect(short).toBe(
      'El Autodromo Nazionale di Monza es un autódromo ubicado en el parque de la villa real de Monza en las cercanías de Monza, región de Lombardía, Italia, a unos 33 km al norte de la ciudad de Milán. Es conocido popularmente como el Templo de la Velocidad.',
    );
    const long = `${'Una oración bastante larga sobre el circuito de St. Petersburg y su historia. '.repeat(8)}`;
    const cut = shortExtract(long, 200)!;
    expect(cut.length).toBeLessThanOrEqual(200);
    expect(cut.endsWith('historia.')).toBe(true);
    expect(shortExtract('palabra '.repeat(100), 50)!.endsWith('…')).toBe(true);
    expect(shortExtract('')).toBeUndefined();
    expect(wikiUrl('es', 'Autódromo Oscar y Juan Gálvez')).toBe('https://es.wikipedia.org/wiki/Aut%C3%B3dromo_Oscar_y_Juan_G%C3%A1lvez');
  });
});

describe('Commons: imágenes con atribución', () => {
  it('miniatura de 960 px sin parámetros de seguimiento, autor en texto plano, licencia y página', async () => {
    const http = routeHttp([['commons.wikimedia.org/w/api.php', json('commons-images.json')]]);
    const photo = 'File:1975 Italian GP race start - Niki Lauda & Clay Regazzoni (Ferrari 312T).jpg';
    const images = await fetchImages(apiFor(http), ['Monza_track_map.svg', photo, 'No existe este archivo xyz.jpg']);
    expect(http.calls).toHaveLength(1);
    expect(decodeURIComponent(http.calls[0]!)).toContain('titles=File:Monza track map.svg|File:1975 Italian GP');
    expect(http.calls[0]).toContain('iiurlwidth=960');
    expect(images.get(fileKey('Monza track map.svg'))).toEqual({
      url: 'https://thumb.wikimedia.org/wikipedia/commons/thumb/f/f8/Monza_track_map.svg/960px-Monza_track_map.svg.png',
      width: 960,
      height: 490,
      credit: 'Will Pittenger',
      license: 'CC BY-SA 3.0',
      page: 'https://commons.wikimedia.org/wiki/File:Monza_track_map.svg',
    });
    const p = images.get(fileKey(photo))!;
    expect(p.url).toMatch(/^https:\/\/thumb\.wikimedia\.org\/.*960px-1975_Italian_GP.*\.jpg$/);
    expect(p.credit).not.toMatch(/[<>]/);
    expect(p.credit.length).toBeGreaterThan(2);
    expect(p.license).toBeTruthy();
    expect(images.has(fileKey('No existe este archivo xyz.jpg'))).toBe(false);
  });

  it('cleanCredit saca el HTML y normaliza "autor desconocido"', () => {
    expect(cleanCredit('<a href="//commons.wikimedia.org/wiki/User:Will_Pittenger" title="User:Will Pittenger">Will Pittenger</a>')).toBe('Will Pittenger');
    expect(cleanCredit('<span class="fn">Jos&eacute; &amp; Cía</span> <style>.x{color:red}</style>')).toBe('José & Cía');
    expect(cleanCredit('<div class="vcard">Unknown author<span style="display:none">Unknown author</span></div>')).toBe('Autor desconocido');
    expect(cleanCredit('User:Pepe (talk)')).toBe('Pepe');
    // Firmas y textos de plantilla que vienen así en Commons.
    expect(cleanCredit('Bobo12345 ( talk ) ( Uploads )')).toBe('Bobo12345');
    expect(cleanCredit('Mutari 10:51, 21 September 2007 (UTC)')).toBe('Mutari');
    expect(cleanCredit('en:User:Berniestew')).toBe('Berniestew');
    expect(cleanCredit('Gustavo Girardelli Own work This W3C-unspecified vector image was created with Inkscape. OpenStreetMap contributors')).toBe(
      'Gustavo Girardelli OpenStreetMap contributors',
    );
    expect(cleanCredit(`<p>${'palabra '.repeat(40)}</p>`).length).toBeLessThanOrEqual(120);
    expect(cleanCredit(undefined)).toBe('');
  });

  it('distingue plano, foto y logo por el nombre del archivo', () => {
    expect(isPlanFile('Monza track map.svg')).toBe(true);
    expect(isPlanFile('Autódromo Hermanos Emiliozzi.svg')).toBe(true);
    expect(isPlanFile('Circuito de Potrero de los Funes - trazado.png')).toBe(true);
    expect(isPlanFile('Suzuka circuit map--2005.png')).toBe(true);
    expect(isPlanFile('Logo Circuit de Spa Francorchamps.svg')).toBe(false);
    expect(isPlanFile('Flag of Italy.svg')).toBe(false);
    expect(isPlanFile('1975 Italian GP race start.jpg')).toBe(false);
    expect(isPhotoFile('1975 Italian GP race start.jpg')).toBe(true);
    expect(isPhotoFile('Monza track map.svg')).toBe(false);
    expect(isPhotoFile('Circuit map.png')).toBe(false);
    expect(isPhotoFile('Daytona International Speedway logo.png')).toBe(false);
    expect(fileFromUploadUrl('https://upload.wikimedia.org/wikipedia/commons/f/f9/Aut%C3%B3dromo_Hermanos_Emiliozzi.svg?utm_source=x')).toBe(
      'Autódromo Hermanos Emiliozzi.svg',
    );
    expect(fileFromUploadUrl('https://upload.wikimedia.org/wikipedia/en/a/ab/Logo_no_libre.png')).toBeUndefined();
  });
});

describe('Elección del elemento de Wikidata', () => {
  const track = (id: string, names: string[], extra: Partial<WdEntity> = {}): WdEntity => ({
    id,
    labels: { es: names[0]! },
    names,
    descriptions: [],
    types: ['Q2338524'],
    countries: ['Q414'],
    sitelinks: 5,
    ...extra,
  });
  const places = new Map<string, WdPlace>([
    ['Q414', { id: 'Q414', label: 'Argentina', names: ['Argentina', 'República Argentina'] }],
    ['Q38', { id: 'Q38', label: 'Italia', names: ['Italia', 'Italy'] }],
    ['Q30', { id: 'Q30', label: 'Estados Unidos', names: ['Estados Unidos', 'United States', 'USA'] }],
    ['Q148', { id: 'Q148', label: 'República Popular China', names: ['República Popular China', 'China'] }],
    ['Q213', { id: 'Q213', label: 'República Checa', names: ['República Checa', 'Chequia', 'Czech Republic'] }],
    ['Q100', { id: 'Q100', label: 'Olavarría', names: ['Olavarría', 'Olavarria'] }],
    ['Q101', { id: 'Q101', label: 'Buenos Aires', names: ['Buenos Aires', 'Ciudad Autónoma de Buenos Aires'] }],
  ]);
  const arg = (key: string) => ({ key, country: 'Argentina' });

  it('nivel de coincidencia por nombre', () => {
    expect(nameLevel('monza', ['Autodromo Nazionale di Monza', 'Monza Circuit'])).toBe(3);
    expect(nameLevel('daytona', ['Daytona International Speedway'])).toBe(2);
    expect(nameLevel('chang buriram', ['Chang International Circuit'])).toBe(2);
    expect(nameLevel('olavarria', ['Autódromo Hermanos Emiliozzi'])).toBe(0);
    // Un nombre hecho solo de palabras genéricas no alcanza para la coincidencia "al revés".
    expect(nameLevel('raceway park san juan', ['Raceway Park'])).toBe(0);
  });

  it('valida el país con sus nombres en español e inglés (y Macao dentro de China)', () => {
    const e = (country: string) => track('Q1', ['X'], { countries: [country] });
    expect(countryMatches('Estados Unidos', e('Q30'), places)).toBe(true);
    expect(countryMatches('Chequia', e('Q213'), places)).toBe(true);
    expect(countryMatches('Macao', e('Q148'), places)).toBe(true);
    // Wikidata informa China con su nombre oficial, sin el corto entre las etiquetas.
    const prc = new Map([['Q148', { id: 'Q148', label: 'República Popular China', names: ['República Popular China', "People's Republic of China"] }]]);
    expect(countryMatches('China', e('Q148'), prc)).toBe(true);
    expect(countryMatches('Italia', e('Q414'), places)).toBe(false);
    expect(countryMatches('', e('Q414'), places)).toBeNull();
  });

  it('descarta lo que no es un circuito o es de otro país, aunque coincida el nombre', () => {
    const city = track('Q6252', ['Monza'], { types: ['Q515'], countries: ['Q38'], sitelinks: 150 });
    const other = track('Q2', ['Circuito de Monza'], { countries: ['Q414'] });
    const real = track('Q171417', ['Autodromo Nazionale di Monza', 'Circuito de Monza'], { countries: ['Q38'], sitelinks: 46 });
    expect(pickMatch({ key: 'monza', country: 'Italia' }, [city, other, real], places).match).toEqual({ entity: real, level: 3 });
    expect(pickMatch({ key: 'monza', country: 'Italia' }, [city, other], places)).toEqual({});
  });

  it('un nombre de ciudad se identifica por el lugar del circuito (localidad o descripción)', () => {
    const emiliozzi = track('Q15194186', ['Autódromo Hermanos Emiliozzi'], { locatedIn: 'Q100' });
    expect(pickMatch(arg('olavarria'), [emiliozzi], places).match).toEqual({ entity: emiliozzi, level: 1 });
    const byDescription = track('Q3', ['Autódromo Eusebio Marcilla'], { descriptions: ['autódromo de Junín, Argentina'] });
    expect(pickMatch(arg('junin'), [byDescription], places).match?.level).toBe(1);
    expect(pickMatch(arg('salta'), [emiliozzi, byDescription], places)).toEqual({});
  });

  it('entre varios parecidos solo elige si uno es claramente el más conocido', () => {
    const galvez = track('Q173116', ['Autódromo Oscar y Juan Gálvez'], { locatedIn: 'Q101', sitelinks: 30 });
    const palermo = track('Q16890403', ['Circuito Palermo'], { locatedIn: 'Q101', sitelinks: 2 });
    const otro = track('Q4', ['Autódromo Roberto Mouras'], { locatedIn: 'Q101', sitelinks: 14 });
    expect(pickMatch(arg('buenos aires'), [palermo, galvez], places).match?.entity).toBe(galvez);
    const doubt = pickMatch(arg('buenos aires'), [palermo, galvez, otro], places);
    expect(doubt.match).toBeUndefined();
    expect(doubt.ambiguous?.map((e) => e.id)).toEqual(['Q173116', 'Q4', 'Q16890403']);
    // La coincidencia exacta del nombre le gana a las demás sin discusión.
    const exact = track('Q5', ['Autódromo de Buenos Aires'], { sitelinks: 1 });
    expect(pickMatch(arg('buenos aires'), [galvez, otro, exact], places).match).toEqual({ entity: exact, level: 3 });
  });

  it('sin país en el evento solo vale el nombre exacto', () => {
    const daytona = track('Q6', ['Daytona International Speedway', 'Daytona'], { countries: ['Q30'] });
    expect(pickMatch({ key: 'daytona', country: '' }, [daytona], places).match?.level).toBe(3);
    expect(pickMatch({ key: 'daytona road', country: '' }, [daytona], places)).toEqual({});
  });

  it('por cercanía: el circuito de ese país a menos de 25 km de la ciudad', () => {
    const junin = { lat: -34.5939, lon: -60.9464 };
    const marcilla = track('Q5712988', ['Autódromo Eusebio Marcilla'], { lat: -34.64987, lon: -61.01736 });
    const lejos = track('Q7', ['Autódromo Lejano'], { lat: -36.0, lon: -60.9 });
    const sinCoordenadas = track('Q8', ['Autódromo Sin Coordenadas']);
    const deOtroPais = track('Q9', ['Otro'], { lat: -34.6, lon: -60.95, countries: ['Q38'] });
    expect(distanceKm(junin, { lat: marcilla.lat!, lon: marcilla.lon! })).toBeCloseTo(9, 0);
    expect(pickNearby('Argentina', junin, [lejos, sinCoordenadas, deOtroPais, marcilla], places).match).toEqual({ entity: marcilla, level: 1 });
    expect(pickNearby('Argentina', junin, [lejos, deOtroPais], places)).toEqual({});
    // Dos circuitos cerca de la misma ciudad y ninguno claramente más conocido: no se elige.
    const vecino = track('Q10', ['Kartódromo de Junín'], { lat: -34.6, lon: -60.95, sitelinks: 4 });
    expect(pickNearby('Argentina', junin, [marcilla, vecino], places).ambiguous?.map((e) => e.id)).toEqual(['Q5712988', 'Q10']);
    expect(pickNearby('Argentina', junin, [{ ...marcilla, sitelinks: 12 }, vecino], places).match?.entity.id).toBe('Q5712988');
  });
});

describe('Coordenadas aproximadas (Open-Meteo)', () => {
  const body = json('geocoding-olavarria.json');

  it('ciudad dentro del país del evento; no toma aeropuertos', async () => {
    const http = routeHttp([['geocoding-api.open-meteo.com/v1/search?name=Olavarría', body]]);
    const hit = await geocodeCity(apiFor(http), 'Olavarría', 'Argentina');
    expect(hit).toEqual({ name: 'Olavarría', lat: -36.8938, lon: -60.3232, admin1: 'Buenos Aires' });
    expect(http.calls[0]).toContain('language=es');
    // Mismo nombre en otro país, o en otra provincia: no vale.
    expect(await geocodeCity(apiFor(routeHttp([['open-meteo', body]])), 'Olavarría', 'Chile')).toBeNull();
    expect(await geocodeCity(apiFor(routeHttp([['open-meteo', body]])), 'Olavarría, Santa Fe', 'Argentina')).toBeNull();
    expect((await geocodeCity(apiFor(routeHttp([['open-meteo', body]])), 'Olavarría, Buenos Aires', 'Argentina'))?.name).toBe('Olavarría');
  });

  it('sin resultados o con un nombre que no coincide, nada', async () => {
    expect(await geocodeCity(apiFor(routeHttp([['open-meteo', { generationtime_ms: 0.1 }]])), 'Xyzzy', 'Argentina')).toBeNull();
    const airport = { results: [{ name: 'Olavarria Airport', latitude: -36.89, longitude: -60.21, feature_code: 'AIRP', country_code: 'AR' }] };
    expect(await geocodeCity(apiFor(routeHttp([['open-meteo', airport]])), 'Olavarria', 'Argentina')).toBeNull();
    const other = { results: [{ name: 'Roberto', latitude: -30, longitude: -60, feature_code: 'PPL', country_code: 'AR' }] };
    expect(await geocodeCity(apiFor(routeHttp([['open-meteo', other]])), 'Roberto Mouras', 'Argentina')).toBeNull();
  });

  it('varias localidades con el mismo nombre: solo vale la que es mucho más grande, o la de la provincia indicada', async () => {
    const town = (name: string, admin1: string, population: number, latitude: number) => ({
      name,
      latitude,
      longitude: -60,
      feature_code: 'PPL',
      country_code: 'AR',
      admin1,
      population,
    });
    const sanMartin = { results: [town('San Martín', 'Buenos Aires', 422_000, -34.57), town('San Martín', 'Mendoza', 79_000, -33.08)] };
    const api = () => apiFor(routeHttp([['open-meteo', sanMartin]]));
    expect(await geocodeCity(api(), 'San Martín', 'Argentina')).toBeNull();
    expect((await geocodeCity(api(), 'San Martín, Mendoza', 'Argentina'))?.lat).toBe(-33.08);
    const junin = { results: [town('Junín', 'Mendoza', 6_000, -33.15), town('Junín', 'Buenos Aires', 87_500, -34.59)] };
    expect((await geocodeCity(apiFor(routeHttp([['open-meteo', junin]])), 'Junín', 'Argentina'))?.admin1).toBe('Buenos Aires');
  });

  it('cityQueries saca las palabras de circuito y parte por comas', () => {
    expect(cityQueries('Autódromo Ciudad de Concordia')).toEqual(['Autódromo Ciudad de Concordia', 'Concordia']);
    expect(cityQueries('General Roca, Río Negro')).toEqual(['General Roca, Río Negro', 'General Roca']);
    expect(cityQueries('Olavarría')).toEqual(['Olavarría']);
  });
});

describe('Acceso a las APIs (pausas y límites)', () => {
  const failing = (statuses: number[]): Http & { calls: string[] } => {
    const calls: string[] = [];
    return {
      calls,
      json: (async (url: string) => {
        calls.push(url);
        const status = statuses.shift() ?? 200;
        if (status !== 200) throw new HttpError(url, status, `HTTP ${status} en ${url}`);
        return { url, status, contentType: 'application/json', body: { ok: true } };
      }) as Http['json'],
      text: async () => {
        throw new Error('no');
      },
      bytes: async () => {
        throw new Error('no');
      },
    };
  };
  const WD = 'https://www.wikidata.org/w/api.php?action=x';

  it('no repite una URL ya pedida y espera entre requests a Wikimedia', async () => {
    const http = failing([]);
    const slept: number[] = [];
    const api = createApi({ http, pauseMs: 5000, sleep: async (ms) => void slept.push(ms) });
    await api.get(`${WD}&n=1`);
    await api.get(`${WD}&n=1`);
    await api.get(`${WD}&n=2`);
    expect(http.calls).toHaveLength(2);
    expect(api.requests).toBe(2);
    expect(slept).toHaveLength(1);
    expect(slept[0]).toBeGreaterThan(4000);
  });

  it('ante un 429 espera y reintenta; si sigue, corta con SourceLimitError', async () => {
    const slept: number[] = [];
    const http = failing([429, 200]);
    const api = createApi({ http, pauseMs: 0, sleep: async (ms) => void slept.push(ms) });
    await expect(api.get(WD)).resolves.toEqual({ ok: true });
    expect(http.calls).toHaveLength(2);
    expect(Math.max(...slept)).toBeGreaterThanOrEqual(30_000);

    const blocked = createApi({ http: failing([429, 429, 429]), pauseMs: 0, sleep: noSleep, limitRetries: 2 });
    await expect(blocked.get(WD)).rejects.toBeInstanceOf(SourceLimitError);
  });

  it('un 403 no se reintenta ni se esquiva', async () => {
    const http = failing([403, 200]);
    const api = createApi({ http, pauseMs: 0, sleep: noSleep });
    await expect(api.get(WD)).rejects.toMatchObject({ name: 'SourceLimitError', status: 403 });
    expect(http.calls).toHaveLength(1);
  });

  it('un 404 es la respuesta (no se reintenta); una falla de red se reintenta una vez', async () => {
    const notFound = failing([404]);
    await expect(createApi({ http: notFound, pauseMs: 0, sleep: noSleep }).get(WD)).rejects.toMatchObject({ status: 404 });
    expect(notFound.calls).toHaveLength(1);
    const flaky = failing([503, 200]);
    await expect(createApi({ http: flaky, pauseMs: 0, sleep: noSleep }).get(WD)).resolves.toEqual({ ok: true });
    expect(flaky.calls).toHaveLength(2);
  });
});
