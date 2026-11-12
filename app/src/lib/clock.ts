/**
 * Reloj compartido de la app: un solo temporizador que actualiza el "ahora" del store (estados en vivo,
 * cuentas regresivas) al empezar cada minuto, en lugar de un intervalo por fila. Con la pestaña oculta se
 * detiene; al volver, actualiza enseguida y retoma.
 */

/** Margen después del cambio de minuto, para no disparar unos milisegundos antes por imprecisión del timer. */
const SLACK_MS = 250;

/** Milisegundos hasta el próximo cambio de minuto (más el margen). */
export function msToNextMinute(nowMs: number): number {
  return 60_000 - (nowMs % 60_000) + SLACK_MS;
}

export interface ClockOptions {
  /** Para pruebas: reloj y documento propios. */
  now?: () => number;
  doc?: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
}

/** Llama a `tick` al empezar cada minuto mientras la página está visible. Devuelve la función para detenerlo. */
export function startClock(tick: () => void, opts: ClockOptions = {}): () => void {
  const now = opts.now ?? Date.now;
  const doc = opts.doc ?? (typeof document !== 'undefined' ? document : undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const schedule = () => {
    clearTimeout(timer);
    timer = undefined;
    if (stopped || doc?.visibilityState === 'hidden') return;
    timer = setTimeout(() => {
      tick();
      schedule();
    }, msToNextMinute(now()));
  };

  const onVisibility = () => {
    if (doc?.visibilityState === 'hidden') {
      clearTimeout(timer);
      timer = undefined;
      return;
    }
    tick();
    schedule();
  };

  doc?.addEventListener('visibilitychange', onVisibility);
  schedule();
  return () => {
    stopped = true;
    clearTimeout(timer);
    doc?.removeEventListener('visibilitychange', onVisibility);
  };
}
