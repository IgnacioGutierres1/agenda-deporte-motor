/**
 * Fichas de circuito (data/circuits.json) y trazados (data/tracks/{id}.json): textos, links y cálculos para
 * mostrarlos. Lógica pura, sin Vue ni Pinia.
 */
import type { CircuitImage, CircuitInfo, CircuitLapRecord, CircuitTrackFile, MotorEvent } from '@dm/shared';
import type { Circuit } from './circuits.ts';
import { formatDateRange } from './format.ts';

/** 125000 -> "125.000" (siempre con separador de miles, también en números de cuatro cifras). */
export function thousands(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** Longitud del trazado en kilómetros con tres decimales: 5419 -> "5,419 km". */
export function lengthKm(lengthM: number): string {
  return `${(lengthM / 1000).toFixed(3).replace('.', ',')} km`;
}

const positive = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
const text = (s: unknown): string => (typeof s === 'string' ? s.trim() : '');

/** Lo que acompaña al tiempo del récord: "Lando Norris · McLaren MCL38 · 2024 · F1". */
export function lapRecordDetail(r: CircuitLapRecord): string {
  return [text(r.driver), text(r.vehicle), positive(r.year) ? String(r.year) : '', text(r.series)].filter(Boolean).join(' · ');
}

/** Récord en una línea corta (bloque "El circuito" del evento): "1:22.384 · Lando Norris (2024)". */
export function lapRecordShort(r: CircuitLapRecord): string {
  const who = text(r.driver);
  const year = positive(r.year) ? String(r.year) : '';
  const tail = who && year ? `${who} (${year})` : who || year;
  return [text(r.time), tail].filter(Boolean).join(' · ');
}

export interface CircuitFact {
  key: 'length' | 'turns' | 'direction' | 'opened' | 'capacity' | 'elevation' | 'city' | 'record';
  label: string;
  value: string;
  /** Segunda línea (récord: piloto, auto, año y categoría). */
  detail?: string;
  /** Ocupa todo el ancho de la grilla. */
  wide?: boolean;
}

/** Datos de la ficha técnica, solo los que existen (sin renglones vacíos). */
export function circuitFacts(info: CircuitInfo): CircuitFact[] {
  const out: CircuitFact[] = [];
  if (positive(info.lengthM)) out.push({ key: 'length', label: 'Longitud', value: lengthKm(info.lengthM) });
  if (positive(info.turns)) out.push({ key: 'turns', label: 'Curvas', value: String(info.turns) });
  if (text(info.direction)) out.push({ key: 'direction', label: 'Sentido', value: text(info.direction) });
  if (positive(info.opened)) out.push({ key: 'opened', label: 'Inauguración', value: String(info.opened) });
  if (positive(info.capacity)) out.push({ key: 'capacity', label: 'Capacidad', value: `${thousands(info.capacity)} personas` });
  if (typeof info.elevationM === 'number' && Number.isFinite(info.elevationM)) {
    out.push({ key: 'elevation', label: 'Altitud', value: `${thousands(info.elevationM)} m s. n. m.` });
  }
  if (text(info.city)) out.push({ key: 'city', label: 'Ciudad', value: text(info.city) });
  const record = info.lapRecord;
  if (record && text(record.time)) {
    const detail = lapRecordDetail(record);
    out.push({ key: 'record', label: 'Récord de vuelta', value: text(record.time), ...(detail ? { detail } : {}), wide: true });
  }
  return out;
}

/** Resumen para una línea: "5,419 km · 16 curvas". */
export function circuitShortFacts(info: CircuitInfo): string {
  const parts: string[] = [];
  if (positive(info.lengthM)) parts.push(lengthKm(info.lengthM));
  if (positive(info.turns)) parts.push(`${info.turns} ${info.turns === 1 ? 'curva' : 'curvas'}`);
  return parts.join(' · ');
}

/** La ficha tiene algo para el bloque "El circuito" del evento (dibujo, longitud, curvas o récord). */
export function hasCircuitHighlights(info: CircuitInfo): boolean {
  return !!info.hasTrack || !!info.map?.url || !!circuitShortFacts(info) || !!text(info.lapRecord?.time);
}

export interface MapLinks {
  /** Google Maps con el circuito como destino ("Cómo llegar"). */
  directions: string;
  /** El punto en OpenStreetMap. */
  map: string;
}

/** Links a mapas con las coordenadas de la ficha; null si no hay coordenadas válidas. */
export function mapLinks(info: Pick<CircuitInfo, 'lat' | 'lon' | 'coordsApprox'>): MapLinks | null {
  const { lat, lon } = info;
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (lat === 0 && lon === 0)) return null;
  const la = lat.toFixed(5);
  const lo = lon.toFixed(5);
  // Con las coordenadas de la ciudad se abre el mapa más alejado.
  const zoom = info.coordsApprox ? 12 : 15;
  return {
    directions: `https://www.google.com/maps/dir/?api=1&destination=${la},${lo}`,
    map: `https://www.openstreetmap.org/?mlat=${la}&mlon=${lo}#map=${zoom}/${la}/${lo}`,
  };
}

/** Qué se muestra como dibujo del circuito: el trazado propio, el plano de Commons, un esqueleto o nada. */
export type CircuitFigureKind = 'track' | 'loading' | 'map' | 'none';

/** Solo direcciones web (los links salen de datos publicados): cualquier otra cosa se descarta. */
export function httpUrl(url: unknown): string {
  const u = text(url);
  return /^https?:\/\//i.test(u) ? u : '';
}

/** Atribución de una imagen de Commons: "Will Pittenger · CC BY-SA 3.0". */
export function imageCredit(img: CircuitImage): string {
  return [text(img.credit), text(img.license)].filter(Boolean).join(' · ') || 'Wikimedia Commons';
}

/** Anchos de miniatura que sirve Wikimedia Commons (otros devuelven error 400). */
const COMMONS_WIDTHS = [120, 250, 500, 960];

/**
 * Versión más chica de una miniatura de Commons ("…/thumb/4/4c/Losail.svg/960px-Losail.svg.png"): para las
 * miniaturas de las listas no hace falta bajar la de 960 px. Solo achica, y si la URL no es una miniatura
 * reconocible (archivo original, otro servidor) la devuelve igual.
 */
export function commonsThumb(url: string, minWidth: number): string {
  const m = /^(https:\/\/(?:upload|thumb)\.wikimedia\.org\/[^?#]*\/thumb\/[^?#]*\/)(\d+)px-([^/?#]+)/.exec(url);
  if (!m) return url;
  const width = COMMONS_WIDTHS.find((w) => w >= minWidth);
  if (!width || width >= Number(m[2])) return url;
  return `${m[1]}${width}px-${m[3]}`;
}

/** El archivo de trazado se puede dibujar (lienzo con tamaño y al menos un path). */
export function trackDrawable(track: CircuitTrackFile | undefined | null): track is CircuitTrackFile {
  return !!track && positive(track.width) && positive(track.height) && Array.isArray(track.paths) && track.paths.some((p) => text(p));
}

export interface TrackScale {
  meters: number;
  /** Largo de la barra en unidades del lienzo. */
  units: number;
  /** "500 m", "1 km". */
  label: string;
}

/**
 * Barra de escala "redonda" (1, 2 o 5 × 10ⁿ metros) que ocupe como mucho `target` del ancho del lienzo.
 * null si el archivo no trae metersPerUnit.
 */
export function trackScale(track: Pick<CircuitTrackFile, 'width' | 'metersPerUnit'>, target = 0.3): TrackScale | null {
  const mpu = track.metersPerUnit;
  if (!positive(mpu) || !positive(track.width)) return null;
  const max = track.width * mpu * target;
  if (!(max >= 1)) return null;
  const pow = 10 ** Math.floor(Math.log10(max));
  const meters = ([5, 2, 1].find((k) => k * pow <= max) ?? 1) * pow;
  const label = meters >= 1000 ? `${String(meters / 1000).replace('.', ',')} km` : `${meters} m`;
  return { meters, units: meters / mpu, label };
}

/** "27–29/11", con el año si no es el de referencia: "14/2/2027". */
export function dateRangeWithYear(dateStart: string, dateEnd: string, refYear: string): string {
  const range = formatDateRange(dateStart, dateEnd);
  const year = dateEnd.slice(0, 4);
  return year === refYear ? range : `${range}/${year}`;
}

export interface CircuitListRow {
  circuit: Circuit;
  info?: CircuitInfo;
  /** Próximo evento en el circuito (o el que está en curso). */
  next?: MotorEvent;
}

export interface CircuitCountryGroup {
  /** País como lo publica el calendario; '' si los eventos no lo traen. */
  country: string;
  label: string;
  rows: CircuitListRow[];
}

/**
 * Circuitos del calendario agrupados por país: primero el país "de casa", después alfabético y al final los
 * que no tienen país. Dentro de cada país, por nombre.
 */
export function circuitsByCountry(
  circuits: Circuit[],
  infoById: Map<string, CircuitInfo>,
  isUpcoming: (e: MotorEvent) => boolean,
  home = 'Argentina',
): CircuitCountryGroup[] {
  const groups = new Map<string, CircuitListRow[]>();
  for (const circuit of circuits) {
    const info = infoById.get(circuit.id);
    const next = circuit.events.find(isUpcoming);
    const row: CircuitListRow = { circuit, ...(info ? { info } : {}), ...(next ? { next } : {}) };
    const list = groups.get(circuit.country);
    if (list) list.push(row);
    else groups.set(circuit.country, [row]);
  }
  const rank = (country: string) => (country === home ? 0 : country ? 1 : 2);
  return [...groups.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0], 'es'))
    .map(([country, rows]) => ({
      country,
      label: country || 'Sin país publicado',
      rows: rows.sort((a, b) => a.circuit.name.localeCompare(b.circuit.name, 'es')),
    }));
}
