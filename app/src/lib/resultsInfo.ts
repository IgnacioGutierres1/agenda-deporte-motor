import type { EventResultsFile, Series, Session } from '@dm/shared';

/**
 * Sesiones de un evento que ya terminaron y no tienen resultado en la app: las que el calendario marca sin
 * resultado o que no figuran en el archivo de resultados (si ya llegó; `{ sessions: [] }` si no está publicado).
 * En la pestaña Resultados se muestran igual, con el enlace a la fuente oficial, para que no parezca que la sesión
 * no existió.
 */
export function finishedWithoutResults(sessions: Session[], file: Pick<EventResultsFile, 'sessions'> | undefined, now: string): Session[] {
  const withRows = new Set((file?.sessions ?? []).filter((s) => s.rows.length > 0).map((s) => s.sessionId));
  const nowMs = Date.parse(now);
  return sessions.filter((s) => {
    if (withRows.has(s.id)) return false;
    // Con el archivo leído, manda lo que trae; sin archivo, la marca del calendario.
    if (!file && s.hasResults) return false;
    const end = Date.parse(s.endUtc);
    return Number.isFinite(end) && end <= nowMs;
  });
}

/** Palabras de una página de resultados o clasificaciones (no la de campeonato: "?standings", "standings"). */
const RESULTS_PAGE = /result|resultado|clasificaci|classification(?!.*standings)|ergebnis/i;
const STANDINGS_PAGE = /standings|campeonato|ranking|posiciones|point-standings/i;

/**
 * Página oficial donde buscar un resultado que la app no tiene: la de resultados de la categoría si está entre sus
 * páginas oficiales; si no, la principal (calendario o temporada, que enlazan a cada fecha).
 */
export function officialResultsUrl(series: Pick<Series, 'officialUrls'> | undefined): string {
  const urls = series?.officialUrls ?? [];
  return urls.find((u) => RESULTS_PAGE.test(u) && !STANDINGS_PAGE.test(u)) ?? urls[0] ?? '';
}
