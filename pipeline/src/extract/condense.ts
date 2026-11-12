/**
 * Recorte de documentos largos para proveedores de IA con poco margen por pedido (Groq gratis: ~8 mil
 * tokens por minuto, que es también el tope práctico de un pedido).
 *
 * En lugar de cortar al final (y perder, p. ej., el cronograma del domingo), se parte el texto en bloques
 * y se conservan los que mencionan lo que se busca (serie, evento, circuito, fechas, sesiones), con sus
 * vecinos inmediatos (los encabezados y la continuación de una tabla), en el orden original.
 * La validación posterior se hace contra el texto COMPLETO del documento, así que recortar nunca deja
 * pasar un dato que no figure en el documento oficial: a lo sumo se pierde alguno.
 */
import { normalizeForMatch } from '../validate.ts';

/** Estimación conservadora (texto con muchos números y fechas: ~3 caracteres por token). */
export const CHARS_PER_TOKEN = 3;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

const GAP = '\n[…]\n';
const MAX_BLOCK = 800;

/** Bloques de hasta MAX_BLOCK caracteres, cortando por párrafos y, si hace falta, por líneas. */
function blocks(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    if (para.length <= MAX_BLOCK) {
      if (para.trim()) out.push(para);
      continue;
    }
    let cur = '';
    for (const line of para.split('\n')) {
      // Una línea gigante (texto de PDF sin saltos) se corta en pedazos fijos.
      for (let i = 0; i < Math.max(line.length, 1); i += MAX_BLOCK) {
        const piece = line.slice(i, i + MAX_BLOCK);
        if (cur && cur.length + piece.length + 1 > MAX_BLOCK) {
          out.push(cur);
          cur = '';
        }
        cur = cur ? `${cur}\n${piece}` : piece;
      }
    }
    if (cur.trim()) out.push(cur);
  }
  return out;
}

const TIME_RE = /(^|[^0-9])\d{1,2}\s*[:.h]\s*\d{2}(?![0-9])/g;

/**
 * Devuelve el texto si entra en maxChars; si no, un extracto de hasta maxChars con los bloques más
 * relevantes para `focus`. Sin términos de búsqueda (o si ninguno aparece) se queda con el principio.
 */
export function condenseText(text: string, maxChars: number, focus: string[] = []): string {
  if (text.length <= maxChars) return text;
  const parts = blocks(text);
  const terms = [...new Set(focus.map((f) => normalizeForMatch(f)).filter((t) => t.length >= 3))];
  const own = parts.map((p) => {
    const norm = normalizeForMatch(p);
    const hits = terms.reduce((n, t) => n + (norm.includes(t) ? 1 : 0), 0);
    // Las horas pesan poco por sí solas, pero desempatan entre bloques que nombran lo mismo
    // (el cronograma frente a la nota de prensa que lo anuncia).
    const times = Math.min((p.match(TIME_RE) ?? []).length, 10);
    return hits * 10 + times;
  });
  if (!own.some((s) => s >= 10)) return headOf(parts, maxChars);
  // Un bloque relevante arrastra a sus vecinos (encabezado de la tabla, filas que siguen en el bloque siguiente).
  const score = own.map((s, i) => s + 0.5 * Math.max(own[i - 1] ?? 0, own[i + 1] ?? 0));
  const order = score.map((s, i) => ({ s, i })).sort((a, b) => b.s - a.s || a.i - b.i);
  const keep = new Set<number>();
  let size = 0;
  for (const { s, i } of order) {
    if (s <= 0) break;
    const cost = parts[i]!.length + GAP.length;
    if (size + cost > maxChars) continue;
    keep.add(i);
    size += cost;
  }
  // Lo que sobra del cupo se completa con el principio del documento (título, fechas generales).
  for (let i = 0; i < parts.length; i++) {
    if (keep.has(i)) continue;
    const cost = parts[i]!.length + GAP.length;
    if (size + cost > maxChars) break;
    keep.add(i);
    size += cost;
  }
  let out = '';
  let prev = -1;
  for (let i = 0; i < parts.length; i++) {
    if (!keep.has(i)) continue;
    out += (out ? (i === prev + 1 ? '\n\n' : GAP) : i > 0 ? GAP.trimStart() : '') + parts[i];
    prev = i;
  }
  return out.slice(0, maxChars);
}

function headOf(parts: string[], maxChars: number): string {
  let out = '';
  for (const p of parts) {
    if (out.length + p.length + 2 > maxChars) break;
    out += (out ? '\n\n' : '') + p;
  }
  return out || parts[0]!.slice(0, maxChars);
}
