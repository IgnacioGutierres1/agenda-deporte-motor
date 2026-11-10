import { describe, expect, it, vi } from 'vitest';
import { GitHubClient, GitHubError, decodeBase64Utf8, encodeBase64Utf8 } from '../src/github/client.ts';
import {
  EMPTY_USER_CONFIG,
  addSeries,
  commitUserConfig,
  hideDiscovered,
  pinDiscovered,
  setSeriesDisabled,
} from '../src/github/user-config.ts';
import { parseRepo } from '../src/stores/settings.ts';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function client(fetchFn: typeof fetch) {
  return new GitHubClient({ owner: 'nacho', repo: 'agenda-deporte-motor', token: 'github_pat_x', fetchFn });
}

describe('base64 UTF-8', () => {
  it('ida y vuelta con tildes y eñes', () => {
    const text = '{"name":"Fórmula Nacional — Ñandú"}';
    expect(decodeBase64Utf8(encodeBase64Utf8(text))).toBe(text);
    expect(encodeBase64Utf8('ñ')).toBe('w7E=');
  });
});

describe('parseRepo', () => {
  it('acepta owner/repo', () => {
    expect(parseRepo('nacho/agenda-deporte-motor')).toEqual({ owner: 'nacho', repo: 'agenda-deporte-motor' });
    expect(parseRepo('owner')).toBeNull();
    expect(parseRepo('https://github.com/a/b')).toBeNull();
  });
});

describe('GitHubClient', () => {
  it('GET de contenidos con headers y decodificación', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      json({ sha: 'abc', content: encodeBase64Utf8('{"a":"ó"}'), encoding: 'base64' }),
    );
    const file = await client(fetchFn).getFile('config/series.user.json', 'main');
    expect(file).toEqual({ sha: 'abc', text: '{"a":"ó"}' });
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/nacho/agenda-deporte-motor/contents/config/series.user.json?ref=main');
    expect(init!.method).toBe('GET');
    expect(init!.headers).toMatchObject({
      Accept: 'application/vnd.github+json',
      Authorization: 'Bearer github_pat_x',
      'X-GitHub-Api-Version': '2022-11-28',
    });
  });

  it('GET devuelve null si el archivo no existe', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(json({ message: 'Not Found' }, 404));
    expect(await client(fetchFn).getFile('x.json')).toBeNull();
  });

  it('dispara el workflow update.yml en main', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 204 }));
    await client(fetchFn).dispatchWorkflow();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe('https://api.github.com/repos/nacho/agenda-deporte-motor/actions/workflows/update.yml/dispatches');
    expect(init!.method).toBe('POST');
    expect(JSON.parse(init!.body as string)).toEqual({ ref: 'main' });
  });

  it('traduce errores de permisos', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(json({ message: 'Resource not accessible' }, 403));
    const err = await client(fetchFn).dispatchWorkflow().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubError);
    expect((err as GitHubError).message).toMatch(/Actions: Read and write/);
  });
});

describe('cambios de config/series.user.json', () => {
  it('agrega una categoría con id slug y flujo genérico', () => {
    const { config, message } = addSeries(EMPTY_USER_CONFIG, { name: 'Fórmula Nacional', url: 'https://example.org/fn' });
    expect(config.added[0]).toMatchObject({
      id: 'formula-nacional',
      name: 'Fórmula Nacional',
      officialUrls: ['https://example.org/fn'],
      strategy: 'generic',
      group: 'otros',
    });
    expect(message).toBe('config: agregar categoría "Fórmula Nacional" desde la app');
    expect(() => addSeries(config, { name: 'Fórmula Nacional' })).toThrow(/Ya existe/);
    expect(() => addSeries(EMPTY_USER_CONFIG, { name: 'X', url: 'ftp://x' })).toThrow(/URL/);
    expect(addSeries(EMPTY_USER_CONFIG, { name: 'Sin URL' }).config.added[0]!.officialUrls).toEqual([]);
  });

  it('desactiva, fija y oculta sin duplicar', () => {
    let c = setSeriesDisabled(EMPTY_USER_CONFIG, 'f3', true).config;
    c = setSeriesDisabled(c, 'f3', true).config;
    expect(c.disabled).toEqual(['f3']);
    expect(setSeriesDisabled(c, 'f3', false).config.disabled).toEqual([]);
    c = pinDiscovered(c, 'copa-truck').config;
    expect(c.pinned).toEqual(['copa-truck']);
    c = hideDiscovered(c, 'copa-truck').config;
    expect(c.pinned).toEqual([]);
    expect(c.hidden).toEqual(['copa-truck']);
  });

  it('commit: GET sha → PUT base64 con mensaje en español → dispatch', async () => {
    const current = { added: [], disabled: ['top-race'], pinned: [], hidden: [] };
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ sha: 'sha-1', content: encodeBase64Utf8(JSON.stringify(current)), encoding: 'base64' }))
      .mockResolvedValueOnce(json({ content: {}, commit: {} }, 200))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    const res = await commitUserConfig(client(fetchFn), (c) => setSeriesDisabled(c, 'f3', true, 'FIA Fórmula 3'));
    expect(res.workflowTriggered).toBe(true);
    expect(res.config.disabled).toEqual(['top-race', 'f3']);

    const [putUrl, putInit] = fetchFn.mock.calls[1]!;
    expect(putUrl).toBe('https://api.github.com/repos/nacho/agenda-deporte-motor/contents/config/series.user.json');
    expect(putInit!.method).toBe('PUT');
    const body = JSON.parse(putInit!.body as string);
    expect(body.sha).toBe('sha-1');
    expect(body.branch).toBe('main');
    expect(body.message).toBe('config: desactivar "FIA Fórmula 3" desde la app');
    expect(JSON.parse(decodeBase64Utf8(body.content))).toEqual({ ...current, disabled: ['top-race', 'f3'] });

    expect(fetchFn.mock.calls[2]![0]).toMatch(/actions\/workflows\/update\.yml\/dispatches$/);
  });

  it('no escribe si el resultado no pasa el esquema', async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ message: 'Not Found' }, 404));
    await expect(
      commitUserConfig(client(fetchFn), (c) => ({
        config: { ...c, added: [{ id: 'Mal Id', name: 'x', shortName: 'x', officialUrls: [] }] },
        message: 'x',
      })),
    ).rejects.toThrow(/no es válido/);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });
});
