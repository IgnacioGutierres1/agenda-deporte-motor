/**
 * Historial y perfiles (tanda 5): biografía, foto y trayectoria de pilotos, escudo e historia de equipos, e historia
 * y campeones de cada categoría. Lo genera el pipeline (pipeline/src/bios) y se publica aparte de los datos de la
 * temporada, porque cambia poco y viene de otras fuentes (Wikidata, Wikipedia, Commons y, para las fotos, los sitios
 * oficiales que ya lee el pipeline):
 *   data/bios/drivers/{shard}.json  →  DriverBiosShardFile (mismo shard que data/drivers, ver driverShard)
 *   data/bios/teams.json            →  TeamBiosFile
 *   data/bios/series.json           →  SeriesHistoryFile
 * Todo es opcional: un piloto sin artículo en Wikipedia no tiene ficha, y la app muestra solo lo que haya.
 */
import type { CircuitImage } from './types.ts';

/**
 * Imagen con su atribución. De Commons: autor, licencia y página del archivo. De un sitio oficial: credit con el
 * nombre del sitio ("MotoGP.com"), license "© titular" y page la página oficial donde se publica.
 */
export type CreditedImage = CircuitImage;

/** De dónde sale un dato del historial. */
export type BioSource = 'wikidata' | 'wikipedia' | 'oficial' | 'app';

/** Un texto descriptivo con su procedencia. */
export interface BioSummary {
  /** Uno o dos párrafos, texto plano. */
  text: string;
  /** Idioma del texto: se prefiere Wikipedia en español; si no hay artículo, en inglés (la app lo aclara). */
  lang: 'es' | 'en';
  /** Artículo del que sale (para el enlace "Leer más" y la atribución CC BY-SA). */
  url: string;
}

/** Una temporada de la trayectoria de un piloto en una categoría. */
export interface CareerSeason {
  season: number;
  /** Nombre de la categoría como se la conoce ("Fórmula 2", "GP2 Series", "Fórmula Renault Eurocup"). */
  series: string;
  /** Id de la categoría cuando es una de las que sigue la app. */
  seriesId?: string;
  team?: string;
  /** Puesto final en el campeonato de pilotos. */
  pos?: number;
  points?: number;
  races?: number;
  wins?: number;
  podiums?: number;
  poles?: number;
  /** true si fue campeón esa temporada. */
  champion?: true;
  source: BioSource;
}

/** Un título ganado ("Campeón de Fórmula 1 2021"). */
export interface BioTitle {
  season: number;
  series: string;
  seriesId?: string;
}

/** Ficha de historial de un piloto. */
export interface DriverBio {
  /** Id del piloto en data/drivers (ver driverId). */
  id: string;
  /** Ítem de Wikidata ("Q2239218"), cuando se identificó con seguridad. */
  wikidata?: string;
  summary?: BioSummary;
  /** YYYY-MM-DD. */
  birthDate?: string;
  /** Lugar de nacimiento en español ("Ciudad Autónoma de Buenos Aires, Argentina"). */
  birthPlace?: string;
  /** Nacionalidad deportiva en español ("Argentina"). */
  nationality?: string;
  photo?: CreditedImage;
  /** Temporadas, de la más reciente a la más vieja. */
  career?: CareerSeason[];
  titles?: BioTitle[];
  /** Enlaces oficiales y redes, si la fuente los publica (sitio personal, Instagram, X). */
  links?: { label: string; url: string }[];
  updatedAt: string;
}

/** Contenido de data/bios/drivers/{shard}.json, ordenado por id. Sin fecha de generación (como DriverShardFile). */
export interface DriverBiosShardFile {
  version: 1;
  bios: DriverBio[];
}

/** Ficha de historial de un equipo. */
export interface TeamBio {
  /** Id del equipo en data/teams.json (ver teamId). */
  id: string;
  wikidata?: string;
  summary?: BioSummary;
  /** Escudo o logo. */
  logo?: CreditedImage;
  /** Año de fundación. */
  founded?: number;
  /** Sede ("Brackley, Reino Unido"). */
  base?: string;
  /** País del equipo en español. */
  country?: string;
  /** Director o jefe de equipo actual. */
  principal?: string;
  titles?: BioTitle[];
  /** Categorías en las que corrió, con los años (para la línea de tiempo). */
  history?: { series: string; seriesId?: string; from: number; to?: number }[];
  website?: string;
  updatedAt: string;
}

/** Contenido de data/bios/teams.json */
export interface TeamBiosFile {
  version: 1;
  generatedAt: string;
  teams: TeamBio[];
}

/** Campeón de una temporada de una categoría. */
export interface SeriesChampion {
  season: number;
  /** Piloto o tripulación ("A / B"); ausente si esa temporada solo hay campeón de equipos o marcas. */
  driver?: string;
  /** Id en data/drivers cuando el piloto figura en la app. */
  driverId?: string;
  team?: string;
  teamId?: string;
  /** Auto o moto ("Red Bull RB20", "Ducati Desmosedici GP24"). */
  vehicle?: string;
  /** Aclaración ("Clase Hypercar", "Campeonato de pilotos LMP2"). */
  note?: string;
}

/** Historia de una categoría. */
export interface SeriesHistory {
  seriesId: string;
  wikidata?: string;
  summary?: BioSummary;
  logo?: CreditedImage;
  /** Año de la primera temporada. */
  founded?: number;
  /** Organizador o ente que la fiscaliza ("FIA", "ACTC", "SRO Motorsports Group"). */
  organizer?: string;
  /** De la temporada más reciente a la más vieja. */
  champions: SeriesChampion[];
  /** Récords y datos curiosos con su valor ("Más títulos": "Juan María Traverso (16)"). */
  records?: { label: string; value: string }[];
  /** Artículo o página de donde sale la lista de campeones. */
  championsSource?: { url: string; title: string };
  updatedAt: string;
}

/** Contenido de data/bios/series.json */
export interface SeriesHistoryFile {
  version: 1;
  generatedAt: string;
  series: SeriesHistory[];
}
