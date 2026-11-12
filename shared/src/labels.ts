import type { SeriesGroup, SessionType, SeriesState, StageKind, Surface } from './types.ts';

export const SESSION_TYPE_LABELS: Record<SessionType, string> = {
  practica: 'Entrenamiento',
  clasificacion: 'Clasificación',
  sprint: 'Sprint',
  serie: 'Serie',
  carrera: 'Carrera',
  warmup: 'Warm-up',
  etapa: 'Etapa',
  otro: 'Otro',
};

export const GROUP_LABELS: Record<SeriesGroup, string> = {
  'f1-fia': 'Fórmula 1 y soporte FIA',
  moto: 'Motociclismo',
  usa: 'Monoplazas y turismo USA',
  'gt-endurance': 'GT, turismo y resistencia',
  asia: 'Asia y Oceanía',
  rally: 'Rally y rally raid',
  argentina: 'Nacionales argentinas',
  otros: 'Otras',
};

export const STATE_LABELS: Record<SeriesState, string> = {
  ok: 'OK',
  stale: 'Desactualizada',
  error: 'Error de fuente',
  disabled: 'Desactivada',
};

export const SURFACE_LABELS: Record<Surface, string> = {
  asfalto: 'Asfalto',
  tierra: 'Tierra',
  nieve: 'Nieve',
  arena: 'Arena y desierto',
  mixto: 'Mixto (asfalto y tierra)',
};

export const STAGE_KIND_LABELS: Record<StageKind, string> = {
  shakedown: 'Shakedown',
  prologo: 'Prólogo',
  especial: 'Tramo cronometrado',
  superespecial: 'Superespecial',
  power: 'Power Stage',
  enlace: 'Enlace',
  descanso: 'Día de descanso',
};
