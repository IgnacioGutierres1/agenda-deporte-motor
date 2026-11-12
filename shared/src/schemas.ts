/**
 * Esquemas zod para validar los archivos de data/ y config/ al leerlos.
 * Se mantienen alineados con types.ts (los tests verifican que un archivo de ejemplo pase).
 */
import { z } from 'zod';

const isoUtc = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?Z$/, 'Se espera ISO UTC con "Z"');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Se espera YYYY-MM-DD');

export const sourceSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  kind: z.enum(['api', 'html', 'pdf', 'image']),
  method: z.enum(['directo', 'ia']),
  fetchedAt: isoUtc,
  model: z.string().optional(),
});

export const seriesSchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  name: z.string().min(1),
  shortName: z.string().min(1),
  group: z.enum(['f1-fia', 'moto', 'usa', 'gt-endurance', 'asia', 'argentina', 'otros']),
  checklistItem: z.number().int().min(1).optional(),
  officialUrls: z.array(z.string().url()),
  strategy: z.enum(['adapter', 'generic']),
  adapter: z.string().optional(),
  origin: z.enum(['default', 'user', 'discovered']),
  enabled: z.boolean(),
  color: z.string().optional(),
  rosterUrls: z.array(z.string().url()).optional(),
});

export const eventSchema = z.object({
  id: z.string(),
  seriesId: z.string(),
  name: z.string(),
  round: z.number().int().optional(),
  circuit: z.string(),
  country: z.string(),
  tz: z.string(),
  dateStart: isoDate,
  dateEnd: isoDate,
  sessionsStatus: z.enum(['published', 'pending']),
  source: sourceSchema,
});

export const sessionSchema = z
  .object({
    id: z.string(),
    eventId: z.string(),
    seriesId: z.string(),
    type: z.enum(['practica', 'clasificacion', 'sprint', 'serie', 'carrera', 'warmup', 'otro']),
    name: z.string(),
    startUtc: isoUtc,
    endUtc: isoUtc,
    endEstimated: z.boolean(),
    localStartText: z.string().optional(),
    broadcast: z.array(z.string()),
    broadcastIsDefault: z.boolean(),
    source: sourceSchema,
    changedAt: isoUtc.optional(),
    previousStartUtc: isoUtc.optional(),
    hasResults: z.boolean(),
  })
  .refine((s) => s.endUtc > s.startUtc, { message: 'endUtc debe ser posterior a startUtc' });

export const scheduleFileSchema = z.object({
  version: z.literal(1),
  generatedAt: isoUtc,
  series: z.array(seriesSchema),
  events: z.array(eventSchema),
  sessions: z.array(sessionSchema),
});

export const statusFileSchema = z.object({
  version: z.literal(1),
  generatedAt: isoUtc,
  series: z.array(
    z.object({
      seriesId: z.string(),
      state: z.enum(['ok', 'stale', 'error', 'disabled']),
      lastAttempt: isoUtc,
      lastSuccess: isoUtc.optional(),
      message: z.string().optional(),
      sourceUrl: z.string().optional(),
      standingsAvailable: z.boolean(),
    }),
  ),
});

export const resultRowSchema = z.object({
  pos: z.number().int().positive().nullable(),
  status: z.string().optional(),
  number: z.string().optional(),
  driver: z.string().min(1),
  team: z.string().optional(),
  vehicle: z.string().optional(),
  laps: z.number().int().nonnegative().optional(),
  time: z.string().optional(),
  gap: z.string().optional(),
  bestLap: z.string().optional(),
  points: z.number().optional(),
});

export const eventResultsFileSchema = z.object({
  seriesId: z.string(),
  eventId: z.string(),
  updatedAt: isoUtc,
  sessions: z.array(
    z.object({ sessionId: z.string(), rows: z.array(resultRowSchema), source: sourceSchema }),
  ),
});

export const standingsFileSchema = z.object({
  seriesId: z.string(),
  season: z.number().int(),
  updatedAt: isoUtc,
  tables: z.array(
    z.object({
      title: z.string(),
      rows: z.array(
        z.object({
          pos: z.number().int().positive(),
          name: z.string().min(1),
          team: z.string().optional(),
          number: z.string().optional(),
          points: z.number(),
          wins: z.number().int().optional(),
          country: z.string().optional(),
        }),
      ),
    }),
  ),
  source: sourceSchema,
});

export const userSeriesConfigSchema = z.object({
  added: z.array(
    seriesSchema.partial().extend({
      id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
      name: z.string().min(1),
      shortName: z.string().min(1),
      officialUrls: z.array(z.string().url()),
    }),
  ),
  disabled: z.array(z.string()),
  pinned: z.array(z.string()),
  hidden: z.array(z.string()),
});

export const discoveredFileSchema = z.object({
  version: z.literal(1),
  generatedAt: isoUtc,
  items: z.array(
    z.object({
      seriesId: z.string(),
      name: z.string(),
      officialUrl: z.string().url(),
      firstSeen: isoDate,
      nextEventDate: isoDate.optional(),
      source: sourceSchema,
    }),
  ),
});

const driverSummarySchema = z.object({
  id: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  name: z.string().min(1),
  entries: z.array(
    z.object({
      seriesId: z.string(),
      table: z.string().optional(),
      pos: z.number().int().positive(),
      points: z.number(),
      wins: z.number().int().nonnegative().optional(),
      number: z.string().optional(),
      team: z.string().optional(),
    }),
  ),
  country: z.string().optional(),
  lineups: z
    .array(
      z.object({
        seriesId: z.string(),
        team: z.string().optional(),
        number: z.string().optional(),
        vehicle: z.string().optional(),
        class: z.string().optional(),
      }),
    )
    .optional(),
});

const driverDetailSchema = driverSummarySchema.extend({
  recent: z.array(
    z.object({
      seriesId: z.string(),
      eventId: z.string(),
      sessionId: z.string(),
      startUtc: isoUtc,
      pos: z.number().int().positive().nullable(),
      status: z.string().optional(),
    }),
  ),
});

export const driversFileSchema = z.object({
  version: z.literal(1),
  generatedAt: isoUtc,
  drivers: z.array(driverDetailSchema),
});

/** data/drivers-index.json: sin las últimas carreras (strict: que no se cuelen campos pesados). */
export const driversIndexFileSchema = z.object({
  version: z.literal(1),
  generatedAt: isoUtc,
  drivers: z.array(driverSummarySchema.strict()),
});

/** data/drivers/{shard}.json */
export const driverShardFileSchema = z.object({
  version: z.literal(1),
  drivers: z.array(driverDetailSchema),
});

export const rosterFileSchema = z.object({
  seriesId: z.string(),
  season: z.number().int(),
  updatedAt: isoUtc,
  rows: z.array(
    z.object({
      driver: z.string().min(1),
      team: z.string().optional(),
      number: z.string().optional(),
      vehicle: z.string().optional(),
      class: z.string().optional(),
      country: z.string().optional(),
    }),
  ),
  source: sourceSchema,
});

const slugId = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/);

export const teamsFileSchema = z.object({
  version: z.literal(1),
  generatedAt: isoUtc,
  teams: z.array(
    z.object({
      id: slugId,
      name: z.string().min(1),
      entries: z.array(
        z.object({
          seriesId: z.string(),
          table: z.string().optional(),
          pos: z.number().int().positive().optional(),
          points: z.number().optional(),
          numbers: z.array(z.string()).optional(),
          vehicles: z.array(z.string()).optional(),
          classes: z.array(z.string()).optional(),
        }),
      ),
      drivers: z.array(
        z.object({ id: slugId, name: z.string().min(1), seriesId: z.string(), number: z.string().optional() }),
      ),
    }),
  ),
});

export const newsFileSchema = z.object({
  version: z.literal(1),
  generatedAt: isoUtc,
  items: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      url: z.string().url(),
      source: z.string().min(1),
      sourceKind: z.enum(['oficial', 'medio']),
      publishedAt: isoUtc,
      image: z.string().url().optional(),
      summary: z.string().optional(),
      seriesIds: z.array(z.string()),
      lang: z.string().optional(),
    }),
  ),
});
