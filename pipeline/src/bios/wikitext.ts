/**
 * Lectura mínima de wikitexto: tablas (`{| … |}`) con sus celdas ya pasadas a texto plano, respetando rowspan y
 * colspan, y el título de la sección en la que está cada una. Alcanza para las tablas de trayectoria de los
 * artículos de pilotos ("Career summary", "Resumen de carrera"), que son tablas simples sin tablas anidadas.
 */
import { decodeEntities } from '../extract/html.ts';

export interface WikiCell {
  /** Texto plano de la celda. */
  text: string;
  /** Destino del primer enlace interno de la celda ("2019 F4 Spanish Championship"). */
  link?: string;
  header: boolean;
}

export interface WikiTable {
  /** Título de la sección (el más cercano) en la que está la tabla. */
  heading: string;
  /** Títulos de todas las secciones que la contienen, de la más general a la más específica. */
  headings: string[];
  rows: WikiCell[][];
}

/** Saca comentarios y notas al pie (<ref>), que pueden traer tablas, enlaces o barras verticales. */
export function stripNoise(wikitext: string): string {
  return wikitext
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<ref\b[^>]*\/>/gi, '')
    .replace(/<ref\b[^>]*>[\s\S]*?<\/ref>/gi, '')
    .replace(/\{\{(?:efn|refn|notetag|nota|sfn|cn|citation needed|cita requerida)\b[^{}]*\}\}/gi, '');
}

const FLAG_TEMPLATES =
  /^(flagicon|flag|flagcountry|flagdeco|flagu|flagicon image|bandera|bandera2|banderas|band|flagathlete)$/;
const FIRST_PARAM = new Set([
  'abbr',
  'abbreviation',
  'abreviatura',
  'abrev',
  'tooltip',
  'nowrap',
  'nobr',
  'small',
  'big',
  'nts',
  'ntsh',
  'mgp',
  'sup',
  'sub',
  'nobold',
  'noitalic',
  'center',
  'resize',
]);
const DROP = new Set([
  'yes',
  'no',
  'n/a',
  'na',
  'dunno',
  'ref',
  'reflist',
  'update section',
  'update',
  'actualizar',
  'clear',
  'dagger',
  'double-dagger',
  'ddagger',
]);

/** Texto que muestra una plantilla (sin plantillas anidadas): lo justo para las celdas de las tablas. */
function templateText(inner: string): string {
  const parts = inner.split('|');
  const name = parts[0]!.trim().toLowerCase().replace(/_/g, ' ');
  const positional = parts.slice(1).filter((p) => !/^\s*[\w -]+\s*=/.test(p)).map((p) => p.trim());
  if (name === 'dagger') return '†';
  if (name === 'double-dagger' || name === 'ddagger') return '‡';
  if (DROP.has(name)) return '';
  if (name === 'flagathlete') return positional[0] ?? '';
  if (FIRST_PARAM.has(name)) return positional[0] ?? '';
  // Banderas: {{flagicon|ARG}}, {{ARG}}.
  if (FLAG_TEMPLATES.test(name) || (/^[A-Z]{3}$/.test(parts[0]!.trim()) && !positional.length)) return '';
  if (name === 'sort' || name === 'sortkey' || name === 'ordenar') return positional[1] ?? positional[0] ?? '';
  if (name === 'sortname') return positional.slice(0, 2).join(' ');
  // Plantillas desconocidas: si tienen un solo parámetro suele ser lo que se muestra ({{F1|2021}}); si no, nada.
  return positional.length === 1 ? positional[0]! : '';
}

/** Texto plano de una celda y el destino de su primer enlace interno. */
export function cellText(raw: string): { text: string; link?: string } {
  let t = raw;
  // Plantillas, de las más internas hacia afuera.
  for (let i = 0; i < 10 && t.includes('{{'); i++) {
    const next = t.replace(/\{\{([^{}]*)\}\}/g, (_, inner: string) => templateText(inner));
    if (next === t) break;
    t = next;
  }
  t = t.replace(/\[\[(?:File|Image|Archivo|Imagen|Fichero|Category|Categoría):[^\]]*\]\]/gi, '');
  let link: string | undefined;
  t = t.replace(/\[\[([^\]|]*)(?:\|([^\]]*))?\]\]/g, (_, target: string, label?: string) => {
    if (link === undefined) link = target.replace(/#.*$/, '').replace(/_/g, ' ').trim() || undefined;
    return label ?? target;
  });
  t = t
    .replace(/\[(?:https?:)?\/\/\S+\s+([^\]]*)\]/g, '$1')
    .replace(/\[(?:https?:)?\/\/\S+\]/g, '')
    .replace(/'{2,}/g, '')
    .replace(/<sup\b[^>]*>[\s\S]*?<\/sup>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' / ')
    .replace(/<[^>]*>/g, ' ');
  const text = decodeEntities(t)
    .replace(/ /g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\s*\/\s*|\s*\/\s*$/g, '')
    .trim();
  return link ? { text, link } : { text };
}

/** Parte un texto por un separador ("||", "!!") sin cortar dentro de enlaces ni plantillas. */
function splitTop(line: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const two = line.slice(i, i + 2);
    if (two === '[[' || two === '{{') {
      depth++;
      i++;
    } else if ((two === ']]' || two === '}}') && depth > 0) {
      depth--;
      i++;
    } else if (depth === 0 && two === sep) {
      out.push(line.slice(start, i));
      start = i + 2;
      i++;
    }
  }
  out.push(line.slice(start));
  return out;
}

/** Separa los atributos ("align=left rowspan=2") del contenido de una celda. */
function splitAttrs(cell: string): { attrs: string; content: string } {
  let depth = 0;
  for (let i = 0; i < cell.length; i++) {
    const two = cell.slice(i, i + 2);
    if (two === '[[' || two === '{{') {
      depth++;
      i++;
    } else if ((two === ']]' || two === '}}') && depth > 0) {
      depth--;
      i++;
    } else if (depth === 0 && cell[i] === '|') {
      // En una celda, la primera barra suelta (fuera de enlaces y plantillas) separa los atributos del contenido.
      return { attrs: cell.slice(0, i), content: cell.slice(i + 1) };
    }
  }
  return { attrs: '', content: cell };
}

function span(attrs: string, name: string): number {
  const m = new RegExp(`${name}\\s*=\\s*["']?(\\d+)`, 'i').exec(attrs);
  const n = m ? Number(m[1]) : 1;
  return n >= 1 && n <= 60 ? n : 1;
}

interface RawCell {
  attrs: string;
  content: string;
  header: boolean;
}

/** Tablas del wikitexto con su sección. Las tablas anidadas se ignoran. */
export function parseTables(wikitext: string): WikiTable[] {
  const lines = stripNoise(wikitext).split('\n');
  const tables: WikiTable[] = [];
  const headingStack: Array<{ level: number; title: string }> = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!.trim();
    const h = /^(={2,6})\s*(.+?)\s*\1\s*$/.exec(line);
    if (h) {
      const level = h[1]!.length;
      while (headingStack.length && headingStack[headingStack.length - 1]!.level >= level) headingStack.pop();
      headingStack.push({ level, title: cellText(h[2]!).text });
      i++;
      continue;
    }
    if (!line.startsWith('{|')) {
      i++;
      continue;
    }
    // Junta las líneas de la tabla (las anidadas quedan afuera).
    const body: string[] = [];
    let depth = 1;
    i++;
    while (i < lines.length && depth > 0) {
      const l = lines[i]!.trim();
      if (l.startsWith('{|')) depth++;
      else if (l.startsWith('|}')) depth--;
      else if (depth === 1) body.push(l);
      i++;
    }
    const titles = headingStack.map((x) => x.title);
    tables.push({ heading: titles[titles.length - 1] ?? '', headings: titles, rows: buildGrid(readRows(body)) });
  }
  return tables;
}

function readRows(body: string[]): RawCell[][] {
  const rows: RawCell[][] = [];
  let row: RawCell[] = [];
  const flush = () => {
    if (row.length) rows.push(row);
    row = [];
  };
  for (const line of body) {
    if (line.startsWith('|-')) {
      flush();
    } else if (line.startsWith('|+')) {
      continue;
    } else if (line.startsWith('!')) {
      for (const c of splitTop(line.slice(1), '!!').flatMap((x) => splitTop(x, '||'))) {
        row.push({ ...splitAttrs(c), header: true });
      }
    } else if (line.startsWith('|')) {
      for (const c of splitTop(line.slice(1), '||')) row.push({ ...splitAttrs(c), header: false });
    } else if (row.length) {
      // Continuación de la celda anterior en otra línea.
      const last = row[row.length - 1]!;
      last.content += `\n${line}`;
    }
  }
  flush();
  return rows;
}

/** Arma la grilla repitiendo las celdas con rowspan/colspan en cada fila y columna que ocupan. */
function buildGrid(rows: RawCell[][]): WikiCell[][] {
  const pending = new Map<number, { cell: WikiCell; left: number }>();
  const grid: WikiCell[][] = [];
  for (const raw of rows) {
    const out: WikiCell[] = [];
    let col = 0;
    const fillPending = () => {
      for (let p = pending.get(col); p; p = pending.get(col)) {
        out[col] = p.cell;
        if (--p.left <= 0) pending.delete(col);
        col++;
      }
    };
    for (const c of raw) {
      fillPending();
      const cell: WikiCell = { ...cellText(c.content), header: c.header };
      const cols = span(c.attrs, 'colspan');
      const rowsDown = span(c.attrs, 'rowspan');
      for (let k = 0; k < cols; k++) {
        out[col] = cell;
        if (rowsDown > 1) pending.set(col, { cell, left: rowsDown - 1 });
        col++;
      }
    }
    fillPending();
    // Columnas que siguen ocupadas por un rowspan más allá de la última celda de la fila.
    for (const [c, p] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      if (c < col || out[c]) continue;
      out[c] = p.cell;
      if (--p.left <= 0) pending.delete(c);
    }
    grid.push(Array.from(out, (x) => x ?? { text: '', header: false }));
  }
  return grid;
}
