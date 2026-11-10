import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ScheduleFile, StatusFile } from '@dm/shared';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

export function fixture<T>(rel: string): T {
  return JSON.parse(readFileSync(path.join(dir, rel), 'utf8')) as T;
}

export const scheduleFixture = (): ScheduleFile => fixture<ScheduleFile>('schedule.json');
export const statusFixture = (): StatusFile => fixture<StatusFile>('status.json');

/** Sábado 14/11/2026 12:30 en Argentina: dentro del finde de San Nicolás, con la clasificación de TC en curso. */
export const NOW = '2026-11-14T15:30:00Z';
