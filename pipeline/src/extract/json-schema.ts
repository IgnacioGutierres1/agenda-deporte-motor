/**
 * Esquemas de respuesta para los proveedores de IA compatibles con OpenAI (Groq).
 *
 * Los prompts del pipeline describen la salida con el subconjunto OpenAPI que acepta Gemini (GeminiSchema).
 * Acá se traduce a JSON Schema y, como esos proveedores no siempre garantizan el esquema, se controla
 * la respuesta antes de aceptarla: una salida que no lo cumple se descarta (nunca se usa "a medias").
 */
import type { GeminiSchema } from './gemini.ts';

type JsonSchema = Record<string, unknown>;

const TYPE: Record<GeminiSchema['type'], string> = {
  OBJECT: 'object',
  ARRAY: 'array',
  STRING: 'string',
  INTEGER: 'integer',
  NUMBER: 'number',
  BOOLEAN: 'boolean',
};

/**
 * GeminiSchema -> JSON Schema.
 * - strict: el formato de "structured outputs" estricto (Groq, OpenAI): todo objeto lleva
 *   additionalProperties: false y TODAS sus propiedades en required; las opcionales pasan a admitir null
 *   (conformToSchema después quita esos null, para que el resultado quede igual que el de Gemini).
 * - no estricto: JSON Schema común (para pegar en el prompt en modo JSON).
 */
export function toJsonSchema(schema: GeminiSchema, strict: boolean, optional = false): JsonSchema {
  const nullable = !!schema.nullable || (strict && optional);
  const type = TYPE[schema.type];
  const out: JsonSchema = { type: nullable ? [type, 'null'] : type };
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = nullable ? [...schema.enum, null] : schema.enum;
  if (schema.type === 'OBJECT') {
    const props = schema.properties ?? {};
    const required = new Set(schema.required ?? []);
    out.properties = Object.fromEntries(
      Object.entries(props).map(([k, v]) => [k, toJsonSchema(v, strict, !required.has(k))]),
    );
    out.required = strict ? Object.keys(props) : [...required];
    if (strict) out.additionalProperties = false;
  }
  if (schema.type === 'ARRAY' && schema.items) out.items = toJsonSchema(schema.items, strict);
  return out;
}

/**
 * Ajusta una respuesta al esquema y la controla. Devuelve el valor normalizado o el primer problema.
 * Normaliza solo lo inocuo: null en un campo opcional no anulable se quita (en modo estricto el modelo
 * tiene que mandar todos los campos), números como texto en campos de texto y viceversa ("12" <-> 12).
 */
export function conformToSchema(value: unknown, schema: GeminiSchema, path = '$'): { value?: unknown; error?: string } {
  if (value === null || value === undefined) {
    return schema.nullable ? { value: null } : { error: `${path}: falta el dato` };
  }
  switch (schema.type) {
    case 'OBJECT': {
      if (typeof value !== 'object' || Array.isArray(value)) return { error: `${path}: se esperaba un objeto` };
      const src = value as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      const required = new Set(schema.required ?? []);
      for (const [key, prop] of Object.entries(schema.properties ?? {})) {
        const v = src[key];
        if (v === undefined || (v === null && !prop.nullable && !required.has(key))) {
          if (required.has(key)) return { error: `${path}.${key}: falta el dato` };
          continue;
        }
        const r = conformToSchema(v, prop, `${path}.${key}`);
        if (r.error) return r;
        out[key] = r.value;
      }
      return { value: out };
    }
    case 'ARRAY': {
      if (!Array.isArray(value)) return { error: `${path}: se esperaba una lista` };
      if (!schema.items) return { value };
      const out: unknown[] = [];
      for (const [i, item] of value.entries()) {
        const r = conformToSchema(item, schema.items, `${path}[${i}]`);
        if (r.error) return r;
        out.push(r.value);
      }
      return { value: out };
    }
    case 'STRING': {
      const v = typeof value === 'number' || typeof value === 'boolean' ? String(value) : value;
      if (typeof v !== 'string') return { error: `${path}: se esperaba texto` };
      if (schema.enum && !schema.enum.includes(v)) return { error: `${path}: "${v}" no es un valor admitido` };
      return { value: v };
    }
    case 'INTEGER':
    case 'NUMBER': {
      const v = typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value) ? Number(value) : value;
      if (typeof v !== 'number' || !Number.isFinite(v)) return { error: `${path}: se esperaba un número` };
      if (schema.type === 'INTEGER' && !Number.isInteger(v)) return { error: `${path}: se esperaba un entero` };
      return { value: v };
    }
    case 'BOOLEAN':
      return typeof value === 'boolean' ? { value } : { error: `${path}: se esperaba verdadero/falso` };
  }
}
