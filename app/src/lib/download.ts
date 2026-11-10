/** Descarga de archivos que funciona también en iPhone (Safari y app instalada). */

export function isIos(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function canShareFile(file: File): boolean {
  try {
    return typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

export function icsFile(content: string, filename: string): File {
  return new File([content], filename, { type: 'text/calendar' });
}

/**
 * Descarga un .ics.
 * - iPhone: se abre como data: URL de tipo text/calendar, que Safari reconoce y ofrece "Agregar todo" al Calendario.
 * - Resto: link con atributo download sobre un Blob.
 */
export function downloadIcs(content: string, filename: string): 'ios' | 'download' {
  if (isIos()) {
    const a = document.createElement('a');
    a.href = `data:text/calendar;charset=utf-8,${encodeURIComponent(content)}`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
    return 'ios';
  }
  const url = URL.createObjectURL(new Blob([content], { type: 'text/calendar;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return 'download';
}

/** Comparte el archivo con la hoja nativa (iPhone/Android): permite guardarlo en Archivos o abrirlo en otra app. */
export async function shareIcs(content: string, filename: string): Promise<boolean> {
  const file = icsFile(content, filename);
  if (!canShareFile(file)) return false;
  try {
    await navigator.share({ files: [file], title: filename });
    return true;
  } catch {
    return false; // el usuario canceló
  }
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}
