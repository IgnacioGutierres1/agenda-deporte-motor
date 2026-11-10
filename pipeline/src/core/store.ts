import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ZodType } from 'zod';

export async function readJson<T>(file: string, schema?: ZodType<T>): Promise<T | null> {
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  const data: unknown = JSON.parse(raw);
  return schema ? schema.parse(data) : (data as T);
}

/** Escritura atómica (archivo temporal + rename) con JSON indentado y salto final. */
export async function writeJson(file: string, data: unknown): Promise<void> {
  await writeText(file, JSON.stringify(data, null, 2) + '\n');
}

export async function writeText(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, content, 'utf8');
  await rename(tmp, file);
}
