/**
 * Utilidades comunes a los lectores de tiempos en vivo (live-*.ts).
 * Funciones puras y tolerantes: ante datos raros devuelven undefined, nunca lanzan.
 */

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function str(v: unknown): string | undefined {
  if (typeof v === 'string') {
    const t = v.trim();
    return t ? t : undefined;
  }
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

export function num(v: unknown): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

function clockFromParts(h: number, m: number, s: number, frac: string): string {
  const f = frac ? `.${frac}` : '';
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${f}`;
  if (m > 0) return `${m}:${String(s).padStart(2, '0')}${f}`;
  return `${s}${f}`;
}

function clockFromSeconds(seconds: number): string | undefined {
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const ms = Math.round(seconds * 1000);
  const whole = Math.floor(ms / 1000);
  const frac = String(ms % 1000).padStart(3, '0');
  return clockFromParts(Math.floor(whole / 3600), Math.floor((whole % 3600) / 60), whole % 60, frac);
}

/**
 * Normaliza un tiempo de reloj a "1:23.456" / "59.123" / "1:02:03.456".
 * Acepta segundos (número), "1'53.940" (MotoGP), "01:35.050" (Speedhive), "41'29.173".
 * Conserva los decimales que publica la fuente. Cero, negativos o basura -> undefined.
 */
export function formatClock(v: unknown): string | undefined {
  if (typeof v === 'number') return clockFromSeconds(v);
  if (typeof v !== 'string') return undefined;
  const t = v.trim().replace(/[’']/g, ':');
  const m = t.match(/^(?:(\d+):)?(?:(\d+):)?(\d+)(?:\.(\d+))?$/);
  if (!m) return undefined;
  // Con dos separadores: h:m:s; con uno: m:s.
  const a = m[1] !== undefined ? Number(m[1]) : undefined;
  const b = m[2] !== undefined ? Number(m[2]) : undefined;
  const sec = Number(m[3]);
  const frac = m[4] ?? '';
  let h = 0;
  let min = 0;
  if (a !== undefined && b !== undefined) {
    h = a;
    min = b;
  } else if (a !== undefined) {
    min = a;
  }
  // Normaliza desbordes ("75" segundos) pasando por segundos totales.
  const total = h * 3600 + min * 60 + sec;
  if (total === 0 && !/[1-9]/.test(frac)) return undefined;
  return clockFromParts(Math.floor(total / 3600), Math.floor((total % 3600) / 60), total % 60, frac);
}

/** Diferencia de tiempo: "+1.234" (o "+1:02.345"). Cero o inválido -> undefined. */
export function formatGapTime(v: unknown): string | undefined {
  if (typeof v === 'string' && v.trim().startsWith('-')) return undefined;
  const c = formatClock(typeof v === 'string' ? v.trim().replace(/^\+/, '') : v);
  return c ? `+${c}` : undefined;
}

/** Vueltas de diferencia: "1 V", "3 V". */
export function formatLapsBehind(laps: number): string {
  return `${laps} V`;
}

/** Segundos restantes -> "12:34" (o "1:02:03"). */
export function formatRemaining(seconds: number): string | undefined {
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

export function isoNow(now: Date): string {
  return Number.isNaN(now.getTime()) ? new Date().toISOString() : now.toISOString();
}

/** Quita las claves con undefined (tablas más limpias y comparaciones de tests más simples). */
export function stripUndefined<T extends object>(o: T): T {
  for (const k of Object.keys(o) as Array<keyof T>) if (o[k] === undefined) delete o[k];
  return o;
}
