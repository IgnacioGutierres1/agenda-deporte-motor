/**
 * Validación del historial (data/bios/**) con los esquemas compartidos. Este módulo se importa de forma diferida
 * desde el store de historial: así zod entra en un chunk aparte y no en el de la ficha.
 *
 * Un archivo con una ficha mal formada no se descarta entero: se quedan las fichas válidas.
 */
import { driverBiosShardFileSchema, seriesHistoryFileSchema, teamBiosFileSchema } from '@dm/shared';
import type { DriverBio, DriverBiosShardFile, SeriesHistory, SeriesHistoryFile, TeamBio, TeamBiosFile } from '@dm/shared';

/** Lo único que se usa de un esquema zod (la app no depende de zod directamente). */
interface ItemSchema {
  safeParse(item: unknown): { success: true; data: unknown } | { success: false };
}

export class InvalidBiosError extends Error {
  constructor(path: string) {
    super(`El archivo ${path} no tiene el formato esperado.`);
    this.name = 'InvalidBiosError';
  }
}

function validItems<T>(raw: unknown, schema: ItemSchema): T[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    const r = schema.safeParse(item);
    return r.success ? [r.data as T] : [];
  });
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return !!raw && typeof raw === 'object' && !Array.isArray(raw);
}

export function parseDriverBios(raw: unknown, path: string): DriverBiosShardFile {
  const full = driverBiosShardFileSchema.safeParse(raw);
  if (full.success) return full.data as DriverBiosShardFile;
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.bios)) throw new InvalidBiosError(path);
  return { version: 1, bios: validItems<DriverBio>(raw.bios, driverBiosShardFileSchema.shape.bios.element) };
}

export function parseTeamBios(raw: unknown, path: string): TeamBiosFile {
  const full = teamBiosFileSchema.safeParse(raw);
  if (full.success) return full.data as TeamBiosFile;
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.teams)) throw new InvalidBiosError(path);
  return {
    version: 1,
    generatedAt: String(raw.generatedAt ?? ''),
    teams: validItems<TeamBio>(raw.teams, teamBiosFileSchema.shape.teams.element),
  };
}

export function parseSeriesHistory(raw: unknown, path: string): SeriesHistoryFile {
  const full = seriesHistoryFileSchema.safeParse(raw);
  if (full.success) return full.data as SeriesHistoryFile;
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.series)) throw new InvalidBiosError(path);
  return {
    version: 1,
    generatedAt: String(raw.generatedAt ?? ''),
    series: validItems<SeriesHistory>(raw.series, seriesHistoryFileSchema.shape.series.element),
  };
}
