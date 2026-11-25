/**
 * Dominio propio (fase 0.1 de la migración): datos en su dirección con respaldo local, caché del service worker
 * para esa dirección, mudanza de lo guardado desde la dirección anterior y renovación de los avisos.
 */
// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { absoluteDataUrl, dataUrl, dataUrls, fetchData, fetchFromData, localDataUrl, normalizeDataBase, webcalUrl, DataLoadError, DataNotFoundError } from '../src/lib/data.ts';
import {
  applyMoveFromUrl,
  decodeMove,
  encodeMove,
  hasSomethingToMove,
  isLegacyLocation,
  moveLink,
  moveTarget,
  newSiteIsLive,
  sanitizeMove,
  takeMoveFromHash,
  SETTINGS_STORAGE_KEY,
  type MoveEnv,
} from '../src/lib/mudanza.ts';
import { base64UrlToBytes, pushSyncMark, sameServerKey } from '../src/lib/push.ts';
import { dataPattern, withTrailingSlash } from '../build/data-pattern.ts';

const OWN = 'https://data.gridagenda.com/';
const json = (body: unknown, status = 200, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': type } });

describe('dirección de los datos', () => {
  it('con dirección propia los archivos salen de ahí; sin ella, de data/ junto a la app', () => {
    expect(normalizeDataBase(' https://data.gridagenda.com ')).toBe(OWN);
    expect(normalizeDataBase(undefined)).toBe('');
    expect(dataUrl('schedule.json', './', OWN)).toBe('https://data.gridagenda.com/schedule.json');
    expect(dataUrl('/results/f1/x.json', './', OWN)).toBe('https://data.gridagenda.com/results/f1/x.json');
    expect(dataUrl('schedule.json', './', '')).toBe('./data/schedule.json');
    expect(localDataUrl('schedule.json', '/agenda-deporte-motor')).toBe('/agenda-deporte-motor/data/schedule.json');
    // Orden de prueba: primero la propia, después la copia local.
    expect(dataUrls('news.json', './', OWN)).toEqual(['https://data.gridagenda.com/news.json', './data/news.json']);
    expect(dataUrls('news.json', './', '')).toEqual(['./data/news.json']);
  });

  it('enlaces para compartir: la dirección propia, o la de la página (también bajo sub-ruta y con base relativa)', () => {
    const page = 'https://usuario.github.io/agenda-deporte-motor/#/ajustes';
    expect(absoluteDataUrl('feeds/f1.ics', page, './', '')).toBe('https://usuario.github.io/agenda-deporte-motor/data/feeds/f1.ics');
    expect(webcalUrl('feeds/f1.ics', 'https://gridagenda.com/#/exportar', './', '')).toBe('webcal://gridagenda.com/data/feeds/f1.ics');
    expect(webcalUrl(undefined, page, './', OWN)).toBe('webcal://data.gridagenda.com/feeds/deporte-motor.ics');
    expect(absoluteDataUrl('feeds/tc.ics', page, './', OWN)).toBe('https://data.gridagenda.com/feeds/tc.ics');
  });

  it('si la dirección propia falla (red, 5xx, cupo), se lee la copia local; un 404 no se reintenta', async () => {
    const urls = ['https://data.gridagenda.com/x.json', './data/x.json'];
    const down = vi.fn(async (u: RequestInfo | URL) => (String(u).startsWith('https://data.') ? json({}, 503) : json({ ok: 1 })));
    expect(await (await fetchFromData('x.json', {}, down as typeof fetch, urls)).json()).toEqual({ ok: 1 });
    expect(down).toHaveBeenCalledTimes(2);

    const offline = vi.fn(async (u: RequestInfo | URL) => {
      if (String(u).startsWith('https://data.')) throw new TypeError('Failed to fetch');
      return json({ ok: 2 });
    });
    expect(await (await fetchFromData('x.json', {}, offline as typeof fetch, urls)).json()).toEqual({ ok: 2 });

    const quota = vi.fn(async (u: RequestInfo | URL) => (String(u).startsWith('https://data.') ? json({}, 429) : json({ ok: 3 })));
    expect(await (await fetchFromData('x.json', {}, quota as typeof fetch, urls)).json()).toEqual({ ok: 3 });

    const missing = vi.fn(async () => json({}, 404));
    expect((await fetchFromData('x.json', {}, missing as typeof fetch, urls)).status).toBe(404);
    expect(missing).toHaveBeenCalledTimes(1);

    // Todo caído: la última respuesta, o el error de red si no hubo ninguna.
    expect((await fetchFromData('x.json', {}, (async () => json({}, 500)) as typeof fetch, urls)).status).toBe(500);
    await expect(
      fetchFromData('x.json', {}, (async () => {
        throw new TypeError('sin red');
      }) as typeof fetch, urls),
    ).rejects.toThrow('sin red');
  });

  it('fetchData mantiene sus errores: sin conexión, 404 y HTML en lugar de datos', async () => {
    await expect(fetchData('a.json', { fetchFn: (async () => json({ a: 1 })) as typeof fetch })).resolves.toEqual({ a: 1 });
    await expect(fetchData('a.json', { fetchFn: (async () => json({}, 404)) as typeof fetch })).rejects.toBeInstanceOf(DataNotFoundError);
    await expect(fetchData('a.json', { fetchFn: (async () => json('<html>', 200, 'text/html')) as typeof fetch })).rejects.toBeInstanceOf(DataNotFoundError);
    await expect(
      fetchData('a.json', {
        fetchFn: (async () => {
          throw new TypeError('x');
        }) as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(DataLoadError);
  });
});

describe('caché del service worker para los datos', () => {
  /** Igual que RegExpRoute de Workbox: en otro origen el patrón tiene que calzar desde el inicio de la URL. */
  const matches = (re: RegExp, href: string, appOrigin = 'https://gridagenda.com') => {
    const m = re.exec(href);
    return !!m && (new URL(href).origin === appOrigin || m.index === 0);
  };

  it('sin dirección propia: solo data/ junto a la app', () => {
    const all = dataPattern('[^?]+\\.json');
    expect(matches(all, 'https://gridagenda.com/data/schedule.json')).toBe(true);
    expect(matches(all, 'https://data.gridagenda.com/schedule.json')).toBe(false);
    expect(matches(all, 'https://gridagenda.com/assets/app.js')).toBe(false);
  });

  it('con dirección propia: esa dirección y data/ (respaldo), cada tipo en su caché', () => {
    expect(withTrailingSlash('https://data.gridagenda.com')).toBe(OWN);
    const drivers = dataPattern('drivers/[^/?]+\\.json', OWN);
    const tracks = dataPattern('tracks/[^/?]+\\.json', OWN);
    const all = dataPattern('[^?]+\\.json', OWN);
    expect(matches(drivers, 'https://data.gridagenda.com/drivers/0a.json')).toBe(true);
    expect(matches(drivers, 'https://gridagenda.com/data/drivers/0a.json')).toBe(true);
    expect(matches(drivers, 'https://data.gridagenda.com/drivers-index.json')).toBe(false);
    expect(matches(tracks, 'https://data.gridagenda.com/tracks/monza.json')).toBe(true);
    expect(matches(all, 'https://data.gridagenda.com/results/f1/x.json')).toBe(true);
    // Desde la dirección anterior de la app también se guardan.
    expect(matches(all, 'https://data.gridagenda.com/schedule.json', 'https://usuario.github.io')).toBe(true);
    // Otros dominios (clima, API) y los calendarios no entran.
    expect(matches(all, 'https://api.open-meteo.com/v1/forecast.json')).toBe(false);
    expect(matches(all, 'https://otro.example/https://data.gridagenda.com/x.json')).toBe(false);
    expect(matches(all, 'https://data.gridagenda.com/feeds/f1.ics')).toBe(false);
  });
});

describe('mudanza de lo guardado a la dirección nueva', () => {
  const settings = {
    timeZone: 'America/Argentina/Buenos_Aires',
    hiddenSeries: ['nls'],
    followedSeries: ['f1', 'tc', 'tc'],
    followedDrivers: [{ id: 'franco-colapinto', name: 'Franco Colapinto', seriesIds: ['f1'] }],
    followedTeams: [{ id: 'team-wrt', name: 'Team WRT', seriesIds: ['wec', 'gtwc-europe'] }],
    notifyEnabled: true,
    notifyLead: 45,
    theme: 'light',
    themeChosen: true,
    showWeather: false,
    googleClientId: 'abc.apps.googleusercontent.com',
    githubRepo: 'usuario/repo',
    githubToken: 'github_pat_SECRETO',
  };

  it('viaja lo guardado, nunca el token de GitHub ni el estado de los avisos', () => {
    const link = moveLink(settings, 'https://gridagenda.com');
    expect(link.startsWith('https://gridagenda.com/#/?mudanza=')).toBe(true);
    const back = decodeMove(link.split('mudanza=')[1]!);
    expect(back).toEqual({
      timeZone: 'America/Argentina/Buenos_Aires',
      hiddenSeries: ['nls'],
      followedSeries: ['f1', 'tc'],
      followedDrivers: settings.followedDrivers,
      followedTeams: settings.followedTeams,
      notifyLead: 45,
      theme: 'light',
      themeChosen: true,
      showWeather: false,
      googleClientId: 'abc.apps.googleusercontent.com',
      githubRepo: 'usuario/repo',
    });
    expect(JSON.stringify(back)).not.toContain('SECRETO');
    expect(back).not.toHaveProperty('notifyEnabled');
  });

  it('nombres con tildes y eñes sobreviven al enlace; sin nada seguido, el enlace va a la portada', () => {
    const p = { followedDrivers: [{ id: 'n-1', name: 'Agustín Canapino Ñandú', seriesIds: ['tc'] }] };
    expect(decodeMove(encodeMove(p))).toEqual(p);
    expect(moveTarget({ theme: 'dark' }, 'https://gridagenda.com')).toBe('https://gridagenda.com/');
    expect(moveTarget(settings, 'https://gridagenda.com')).toContain('#/?mudanza=');
  });

  it('descarta lo que no reconoce o tiene otro tipo', () => {
    expect(sanitizeMove({ followedSeries: 'f1', theme: 'rosa', notifyLead: -5, followedDrivers: [{ id: 1 }, null, { id: 'a', name: 'A' }], extra: 1 })).toEqual({
      followedDrivers: [{ id: 'a', name: 'A', seriesIds: [] }],
    });
    expect(sanitizeMove(null)).toEqual({});
    expect(decodeMove('no es base64 !!')).toBeNull();
    expect(decodeMove(btoa('[1,2]'))).toBeNull();
    expect(decodeMove('')).toBeNull();
    expect(hasSomethingToMove({ theme: 'dark' })).toBe(false);
  });

  it('dirección anterior: cualquier host que no sea el principal, salvo desarrollo', () => {
    const app = 'https://gridagenda.com';
    expect(isLegacyLocation({ origin: 'https://usuario.github.io', hostname: 'usuario.github.io' }, app)).toBe(true);
    expect(isLegacyLocation({ origin: app, hostname: 'gridagenda.com' }, app)).toBe(false);
    expect(isLegacyLocation({ origin: 'http://localhost:5173', hostname: 'localhost' }, app)).toBe(false);
    expect(isLegacyLocation({ origin: 'https://usuario.github.io', hostname: 'usuario.github.io' }, '')).toBe(false);
  });

  it('el aviso espera a que la dirección nueva sirva la app', async () => {
    const app = 'https://gridagenda.com';
    const live = vi.fn(async () => json({ name: 'Grid Agenda' }));
    expect(await newSiteIsLive(app, live as typeof fetch)).toBe(true);
    expect(live).toHaveBeenCalledWith('https://gridagenda.com/manifest.webmanifest', { cache: 'no-store' });
    expect(await newSiteIsLive(app, (async () => json({}, 404)) as typeof fetch)).toBe(false);
    expect(await newSiteIsLive(app, (async () => new Response('<html>', { status: 200 })) as typeof fetch)).toBe(false);
    expect(
      await newSiteIsLive(app, (async () => {
        throw new TypeError('DNS');
      }) as typeof fetch),
    ).toBe(false);
    expect(await newSiteIsLive('', live as typeof fetch)).toBe(false);
  });

  /** Entorno de mentira para abrir un enlace de mudanza. */
  function open(hash: string, saved?: unknown, answer = true) {
    const store = new Map<string, string>();
    if (saved !== undefined) store.set(SETTINGS_STORAGE_KEY, JSON.stringify(saved));
    const replaced: string[] = [];
    const confirm = vi.fn(() => answer);
    const env: MoveEnv = {
      location: { hash, pathname: '/', search: '' },
      history: { replaceState: (_d, _u, url) => void replaced.push(url) },
      storage: { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => void store.set(k, v) },
      confirm,
    };
    const result = applyMoveFromUrl(env);
    const now = store.has(SETTINGS_STORAGE_KEY) ? (JSON.parse(store.get(SETTINGS_STORAGE_KEY)!) as Record<string, unknown>) : undefined;
    return { result, replaced, confirm, now };
  }

  it('al abrir el enlace en un dispositivo sin nada guardado: se aplica sin preguntar y se limpia la URL', () => {
    const r = open(`#/?mudanza=${encodeMove(settings)}`);
    expect(r.result).toBe('applied');
    expect(r.confirm).not.toHaveBeenCalled();
    expect(r.replaced).toEqual(['/#/']);
    expect(r.now).toMatchObject({ followedSeries: ['f1', 'tc'], theme: 'light', notifyEnabled: false });
    expect(r.now).not.toHaveProperty('githubToken');
  });

  it('si acá ya había cosas seguidas, pregunta; el token de este dispositivo no se toca', () => {
    const here = { followedSeries: ['wrc'], githubToken: 'token-de-aca', notifyEnabled: true };
    const yes = open(`#/?mudanza=${encodeMove(settings)}&x=1`, here, true);
    expect(yes.confirm).toHaveBeenCalledTimes(1);
    expect(yes.result).toBe('applied');
    expect(yes.replaced).toEqual(['/#/?x=1']);
    expect(yes.now).toMatchObject({ followedSeries: ['f1', 'tc'], githubToken: 'token-de-aca', notifyEnabled: false });

    const no = open(`#/?mudanza=${encodeMove(settings)}`, here, false);
    expect(no.result).toBe('declined');
    expect(no.now).toEqual(here);
    expect(no.replaced).toEqual(['/#/']);
  });

  it('enlace roto o vacío: no cambia nada, pero igual sale de la URL; sin mudanza, no hace nada', () => {
    const bad = open('#/?mudanza=%%%', { followedSeries: ['wrc'] });
    expect(bad.result).toBe('invalid');
    expect(bad.now).toEqual({ followedSeries: ['wrc'] });
    expect(bad.replaced).toEqual(['/#/']);
    expect(open(`#/?mudanza=${encodeMove({ theme: 'dark' })}`).result).toBe('invalid');
    const none = open('#/evento/abc?tab=contexto');
    expect(none.result).toBeNull();
    expect(none.replaced).toEqual([]);
    expect(takeMoveFromHash('#/categorias')).toBeNull();
  });
});

describe('avisos al cambiar de servidor', () => {
  it('detecta si la suscripción se creó con otra clave', () => {
    const key = base64UrlToBytes('AQIDBA');
    expect([...key]).toEqual([1, 2, 3, 4]);
    expect(sameServerKey(new Uint8Array([1, 2, 3, 4]).buffer, key)).toBe(true);
    expect(sameServerKey(new Uint8Array([1, 2, 3, 5]).buffer, key)).toBe(false);
    expect(sameServerKey(new Uint8Array([1, 2, 3]).buffer, key)).toBe(false);
    // El navegador no informa la clave: no se puede saber, no se renueva.
    expect(sameServerKey(null, key)).toBeNull();
  });

  it('la marca de sincronización cambia con el servidor o con las preferencias', () => {
    const prefs = { seriesIds: ['f1', 'tc'], leadMinutes: 30, timeZone: 'America/Argentina/Buenos_Aires' };
    const a = pushSyncMark(prefs, 'https://viejo.workers.dev');
    expect(pushSyncMark(prefs, 'https://viejo.workers.dev')).toBe(a);
    expect(pushSyncMark(prefs, 'https://api.gridagenda.com')).not.toBe(a);
    expect(pushSyncMark({ ...prefs, leadMinutes: 15 }, 'https://viejo.workers.dev')).not.toBe(a);
  });
});
