/**
 * Hash FNV-1a de 64 bits (sincrónico, sin dependencias, igual en Node y navegador).
 * Se usa para ids estables de eventos y sesiones.
 */
export function stableHash(...parts: Array<string | number | undefined>): string {
  const input = parts
    .map((p) => (p === undefined ? '' : String(p).trim().toLowerCase()))
    .join('|');
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of new TextEncoder().encode(input)) {
    h ^= BigInt(byte);
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, '0');
}

/** "Gran Premio de Qatar" -> "gran-premio-de-qatar" */
export function slugify(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
