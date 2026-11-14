/**
 * Lector de tablas de Wikipedia (class="wikitable") a partir del HTML que devuelve action=parse.
 *  - Expande rowspan y colspan: cada fila queda con una celda por columna (una celda que ocupa varias filas se
 *    repite en cada una, como la temporada de una tabla por clases).
 *  - Las filas de encabezado (todas <th>) se combinan por columna ("Constructor Chassis").
 *  - Cada celda trae su texto limpio (sin notas al pie, claves de orden ocultas ni banderas), sus renglones
 *    (separados por <br> o ítems de lista: las tripulaciones) y los artículos a los que enlaza.
 *  - Cada tabla sabe bajo qué títulos de sección está.
 */
import { parse, type HTMLElement } from 'node-html-parser';
import { decodeEntities, textOf } from '../extract/html.ts';

export interface WikiCell {
  text: string;
  /** Renglones de la celda (uno por <br> o <li>), ya limpios. */
  lines: string[];
  /** Títulos de los artículos enlazados, en orden (sin banderas, archivos ni notas). */
  links: string[];
  header: boolean;
}

export interface WikiTable {
  /** Orden de la tabla en la página (entre las wikitable). */
  index: number;
  /** Títulos de sección bajo los que está, del más general al más específico. */
  headings: string[];
  caption?: string;
  /** Encabezado combinado de cada columna. */
  header: string[];
  rows: WikiCell[][];
}

const EMPTY: WikiCell = { text: '', lines: [], links: [], header: false };

/** Quita del HTML de una celda lo que no es contenido: notas, claves de orden, estilos, banderas e íconos. */
function cleanCellHtml(html: string): string {
  return html
    .replace(/<(style|script)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<sup\b[\s\S]*?<\/sup>/gi, '')
    .replace(/<span\b[^>]*(?:display:\s*none|class="[^"]*\bsortkey\b)[^>]*>[\s\S]*?<\/span>/gi, '')
    .replace(/<span\b[^>]*class="[^"]*\bflagicon\b[^"]*"[^>]*>(?:\s*<span\b[^>]*>)?\s*(?:<a\b[^>]*>)?\s*<img\b[^>]*>\s*(?:<\/a>)?\s*(?:<\/span>)?/gi, ' ')
    .replace(/<img\b[^>]*>/gi, ' ')
    .replace(/<a\b[^>]*>\s*<\/a>/gi, ' ');
}

/** Limpia un renglón: marcas de nota (†, *, ‡), "(2)" de cantidad de títulos y espacios. */
export function cleanText(raw: string): string {
  return raw
    .replace(/[\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/\[\s*(?:\d+|[a-z]{1,3}|nota? \d+|note \d+|citation needed)\s*\]/gi, '')
    .replace(/[†‡§*#^]+/g, ' ')
    // Cantidad de títulos al lado del nombre ("Invicta Racing (2)", "Chevrolet (43)").
    .replace(/\s*\(\s*\d{1,2}\s*\)(?=\s*$|\s*[,/;])/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,;.)])/g, '$1')
    .trim();
}

function cellOf(el: HTMLElement): WikiCell {
  const html = cleanCellHtml(el.innerHTML);
  const links: string[] = [];
  for (const m of html.matchAll(/<a\b[^>]*\bhref="\/wiki\/([^"#?]+)[^"]*"[^>]*>([\s\S]*?)<\/a>/gi)) {
    if (!textOf(m[2] ?? '')) continue;
    let title: string;
    try {
      title = decodeURIComponent(decodeEntities(m[1]!)).replace(/_/g, ' ');
    } catch {
      continue;
    }
    if (/^(?:File|Archivo|Image|Imagen|Help|Ayuda|Special|Especial|Wikipedia|Template|Plantilla|Category|Categoría):/i.test(title)) continue;
    links.push(title);
  }
  const lines = html
    .split(/<br\s*\/?>|<\/li>|<\/p>|<\/div>/i)
    .map((part) => cleanText(textOf(part)))
    .filter(Boolean);
  return { text: cleanText(lines.join(' ')), lines, links, header: el.tagName === 'TH' };
}

/** Tablas wikitable del HTML de una página, en orden, con sus filas expandidas. */
export function parseWikiTables(html: string): WikiTable[] {
  const root = parse(html);
  const out: WikiTable[] = [];
  const headings: string[] = [];
  for (const el of root.querySelectorAll('h2, h3, h4, h5, table')) {
    const tag = el.tagName;
    if (/^H\d$/.test(tag)) {
      const level = Number(tag[1]) - 2;
      headings.length = level;
      headings[level] = cleanText(textOf(el.innerHTML.replace(/<span class="mw-editsection[\s\S]*$/i, '')));
      continue;
    }
    if (!/\bwikitable\b/.test(el.getAttribute('class') ?? '')) continue;
    // Las tablas anidadas se leen como parte de la celda que las contiene.
    if (el.parentNode && (el.parentNode as HTMLElement).closest?.('table')) continue;
    out.push(readTable(el, out.length, headings.filter(Boolean)));
  }
  return out;
}

function readTable(table: HTMLElement, index: number, headings: string[]): WikiTable {
  const rows = table.querySelectorAll('tr').filter((tr) => tr.closest('table') === table);
  const grid: WikiCell[][] = [];
  // Celdas que siguen abiertas por un rowspan: columna -> { celda, filas que faltan }.
  const pending = new Map<number, { cell: WikiCell; left: number }>();
  for (const tr of rows) {
    const out: WikiCell[] = [];
    let col = 0;
    const take = () => {
      for (;;) {
        const p = pending.get(col);
        if (!p) return;
        out[col] = p.cell;
        if (--p.left <= 0) pending.delete(col);
        col++;
      }
    };
    const cells = tr.childNodes.filter((n) => n.nodeType === 1 && /^T[HD]$/.test((n as HTMLElement).tagName)) as HTMLElement[];
    for (const td of cells) {
      take();
      const cell = cellOf(td);
      const colspan = Math.min(Math.max(1, Number(td.getAttribute('colspan')) || 1), 30);
      const rowspan = Math.min(Math.max(1, Number(td.getAttribute('rowspan')) || 1), 500);
      for (let k = 0; k < colspan; k++) {
        out[col] = cell;
        if (rowspan > 1) pending.set(col, { cell, left: rowspan - 1 });
        col++;
      }
    }
    take();
    // Columnas que quedaron abiertas más allá del final de la fila.
    for (const [c, p] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
      if (c < out.length || out[c]) continue;
      out[c] = p.cell;
      if (--p.left <= 0) pending.delete(c);
    }
    for (let c = 0; c < out.length; c++) out[c] ??= EMPTY;
    if (out.length) grid.push(out);
  }
  // Encabezado: las primeras filas formadas solo por <th>.
  let headerRows = 0;
  while (headerRows < grid.length && grid[headerRows]!.every((c) => c.header || !c.text)) headerRows++;
  const width = Math.max(0, ...grid.map((r) => r.length));
  const header: string[] = [];
  for (let c = 0; c < width; c++) {
    const parts: string[] = [];
    for (let r = 0; r < headerRows; r++) {
      const t = grid[r]![c]?.text ?? '';
      if (t && parts[parts.length - 1] !== t) parts.push(t);
    }
    header.push(parts.join(' '));
  }
  const caption = table.querySelector('caption');
  return {
    index,
    headings,
    ...(caption ? { caption: cleanText(textOf(caption.innerHTML)) } : {}),
    header,
    rows: grid.slice(headerRows),
  };
}
