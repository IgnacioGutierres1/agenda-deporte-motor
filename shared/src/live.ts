/**
 * Tiempos en vivo: formato común para mostrar la tabla de una sesión en curso, sin importar
 * de qué sistema oficial de cronometraje venga (NASCAR, MotoGP, Speedhive/MyLaps…).
 * Los lectores de cada sistema convierten su JSON a este formato.
 */

export type LiveProvider = 'nascar' | 'motogp' | 'speedhive';

export type LiveFlag = 'green' | 'yellow' | 'red' | 'safety-car' | 'checkered' | 'none';

export type LiveStatus = 'live' | 'finished' | 'not-started' | 'unknown';

export interface LiveRow {
  pos: number;
  number?: string;
  driver: string;
  team?: string;
  vehicle?: string;
  laps?: number;
  /** Diferencia con el líder, como la publica la fuente ("+1.234", "1 V"). */
  gap?: string;
  /** Diferencia con el de adelante. */
  interval?: string;
  lastLap?: string;
  bestLap?: string;
  /** Estado si no está en pista normal: "Boxes", "Abandono"… */
  status?: string;
  inPit?: boolean;
}

export interface LiveBoard {
  provider: LiveProvider;
  /** Categoría de la app a la que corresponde, si se pudo determinar. */
  seriesId?: string;
  /** Nombre del evento según la fuente. */
  eventName: string;
  /** Nombre de la sesión según la fuente ("Carrera", "Práctica 2", "Q2"…). */
  sessionName: string;
  status: LiveStatus;
  flag?: LiveFlag;
  lap?: number;
  totalLaps?: number;
  /** Tiempo restante legible ("12:34") si la fuente lo informa. */
  remaining?: string;
  rows: LiveRow[];
  /** ISO UTC del momento de la lectura. */
  updatedAt: string;
  /** Página oficial donde verificar los tiempos. */
  sourceUrl: string;
}
