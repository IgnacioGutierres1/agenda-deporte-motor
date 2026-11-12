/** Utilidades de texto compartidas por el etiquetado y el agrupado de noticias. */

/** Minúsculas, sin acentos y solo letras/números separados por un espacio. */
export function normalizeTitle(title: string): string {
  return title
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Palabras vacías en castellano e inglés (no distinguen una nota de otra). */
const STOPWORDS = new Set(
  (
    // castellano
    'el la los las un una unos unas de del al a en y o u e que con por para su sus se lo le les es son fue ' +
    'ser como mas pero sin sobre tras entre desde hasta ante hacia muy ya no si su este esta estos estas ese esa ' +
    'eso aquel nos mi tu hay ha han tiene tienen fin vez dos tres ' +
    // inglés
    'the a an of in on at to for and or but with from by as is are was were be been his her their its it this that ' +
    'these those after before over into out up down about than then he she they we you i not no so how why what who ' +
    'will can has have had do does did just more most new says said'
  ).split(' '),
);

/** Palabras con contenido (3+ letras o números) de un título, sin repetir. */
export function contentTokens(title: string): string[] {
  const out = new Set<string>();
  for (const w of normalizeTitle(title).split(' ')) {
    if (!w || STOPWORDS.has(w)) continue;
    if (/^\d+$/.test(w) || w.length >= 3) out.add(w);
  }
  return [...out];
}

/**
 * Nombres propios y números de un título: palabras con contenido que empiezan con mayúscula o dígito
 * ("Andrea Stella quiere que McLaren…" → andrea, stella, mclaren). Sirve para comparar títulos en
 * idiomas distintos, donde lo único que coincide son los nombres.
 */
export function properTokens(title: string): string[] {
  const content = new Set(contentTokens(title));
  const out = new Set<string>();
  for (const word of title.split(/[\s"“”'‘’«»:;,.!?¡¿()[\]–—-]+/u)) {
    if (!/^[\p{Lu}\d]/u.test(word)) continue;
    for (const t of normalizeTitle(word).split(' ')) if (content.has(t)) out.add(t);
  }
  return [...out];
}
