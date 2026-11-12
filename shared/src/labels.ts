import type { SeriesGroup, SessionType, SeriesState } from './types.ts';

export const SESSION_TYPE_LABELS: Record<SessionType, string> = {
  practica: 'Entrenamiento',
  clasificacion: 'Clasificación',
  sprint: 'Sprint',
  serie: 'Serie',
  carrera: 'Carrera',
  warmup: 'Warm-up',
  otro: 'Otro',
};

export const GROUP_LABELS: Record<SeriesGroup, string> = {
  'f1-fia': 'Fórmula 1 y soporte FIA',
  moto: 'Motociclismo',
  usa: 'Monoplazas y turismo USA',
  'gt-endurance': 'GT, turismo y resistencia',
  asia: 'Asia y Oceanía',
  argentina: 'Nacionales argentinas',
  otros: 'Otras',
};

export const STATE_LABELS: Record<SeriesState, string> = {
  ok: 'OK',
  stale: 'Desactualizada',
  error: 'Error de fuente',
  disabled: 'Desactivada',
};
