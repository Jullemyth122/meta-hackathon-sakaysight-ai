/**
 * How OpenStreetMap features look in the 3D map. Keys are OpenMapTiles
 * `class` values (https://openmaptiles.org/schema/), which is the schema that
 * OpenFreeMap serves.
 *
 * Kept apart from the decoding code so the look can be tuned in one place.
 * Palette: a light "paper map" so jeepneys, stops and the route stand out.
 */

import type { Rgb } from './meshBuilder';

/**
 * '#rrggbb' (sRGB, as designers write it) -> linear 0..255 bytes, because
 * three.js treats vertex colours as linear. Skipping this washes every colour
 * out toward white.
 */
function hex(h: string): Rgb {
  const linear = (i: number) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    const l = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    return Math.round(l * 255);
  };
  return [linear(1), linear(3), linear(5)];
}

export const LAND_COLOR = '#ece7dd';

/** Flat areas, drawn in this order (later covers earlier). */
export const AREA_PRIORITY = ['landcover', 'landuse', 'aeroway', 'park'] as const;

const LANDCOVER: Record<string, Rgb> = {
  wood: hex('#bfdaa9'),
  forest: hex('#bfdaa9'),
  grass: hex('#d3e8c0'),
  meadow: hex('#d3e8c0'),
  park: hex('#cfe6ba'),
  farmland: hex('#ebe9cf'),
  wetland: hex('#cfe3dc'),
  sand: hex('#f3e8c8'),
  rock: hex('#e3e0da'),
  ice: hex('#f4f6f7'),
};

const LANDUSE: Record<string, Rgb> = {
  residential: hex('#e7e2d8'),
  suburb: hex('#e7e2d8'),
  neighbourhood: hex('#e7e2d8'),
  commercial: hex('#eee2dc'),
  retail: hex('#eee2dc'),
  industrial: hex('#e4dfe6'),
  garages: hex('#e4dfe6'),
  railway: hex('#e3e0dc'),
  school: hex('#f0e7cf'),
  college: hex('#f0e7cf'),
  university: hex('#f0e7cf'),
  kindergarten: hex('#f0e7cf'),
  hospital: hex('#f2e0de'),
  cemetery: hex('#d6e3d0'),
  stadium: hex('#cde7c2'),
  pitch: hex('#cde7c2'),
  playground: hex('#cde7c2'),
  bus_station: hex('#e2dfe6'),
};

const DEFAULT_AREA = hex('#e7e2d8');

export function areaColor(layer: string, cls: string): Rgb {
  if (layer === 'park') return hex('#c9e4b4');
  if (layer === 'aeroway') return hex('#e2e0e8');
  if (layer === 'landcover') return LANDCOVER[cls] ?? DEFAULT_AREA;
  return LANDUSE[cls] ?? DEFAULT_AREA;
}

export const WATER = hex('#9fcbec');

/** Waterway line widths in metres. */
export const WATERWAY_WIDTH: Record<string, number> = {
  river: 10,
  canal: 7,
  stream: 3,
  drain: 1.6,
  ditch: 1.6,
};

/**
 * Road widths come from typical Metro Manila lane counts at LANE_M a lane.
 * OpenMapTiles has no lane data, but it does say `oneway`: a big road mapped
 * as two one-way lines (Quirino Highway, Commonwealth) is a divided highway,
 * and each line is one carriageway. Vehicles keep to the kerb-side lane, so
 * the wider the road, the further out they are, as on the real thing.
 */
export interface RoadStyle {
  /** Two-way road, kerb to kerb, metres. */
  width: number;
  /**
   * One way only, metres: one carriageway of a divided road, or a small
   * one-way street, narrower than the same street both ways.
   */
  carriageway?: number;
  fill: Rgb;
  casing: Rgb;
}

const MAJOR_CASING = hex('#c9b388');
const MINOR_CASING = hex('#cdc6b9');
const WHITE = hex('#ffffff');

export const ROADS: Record<string, RoadStyle> = {
  // 4 lanes each way (NLEX, Skyway).
  motorway: { width: 28, carriageway: 14, fill: hex('#eedcaa'), casing: MAJOR_CASING },
  // 6 lanes each way: Commonwealth, EDSA.
  trunk: { width: 42, carriageway: 21, fill: hex('#f2e2b8'), casing: MAJOR_CASING },
  // 2 lanes each way, or 3 a side where divided: Quirino Highway, Regalado Avenue.
  primary: { width: 14, carriageway: 10.5, fill: hex('#f5e8c6'), casing: MAJOR_CASING },
  // 2 lanes each way: most city roads.
  secondary: { width: 14, carriageway: 7, fill: hex('#f8f0dc'), casing: MINOR_CASING },
  tertiary: { width: 8, carriageway: 6, fill: WHITE, casing: MINOR_CASING },
  busway: { width: 8, fill: WHITE, casing: MINOR_CASING },
  minor: { width: 7, carriageway: 5, fill: WHITE, casing: MINOR_CASING },
  service: { width: 5.5, carriageway: 4.5, fill: WHITE, casing: MINOR_CASING },
  track: { width: 3, fill: hex('#f6f1e6'), casing: MINOR_CASING },
  path: { width: 1.6, fill: hex('#f6f1e6'), casing: MINOR_CASING },
};

/** Casing is this much wider than the fill (0.9 m of kerb line each side). */
export const CASING_EXTRA_M = 1.8;

/** Visual clearance beyond rendered road edges; not a surveyed setback. */
export const BUILDING_ROAD_CLEARANCE_M = 1.5;
/** Physical fallback road width; also protects the complete driven route across tiles. */
export const ROUTE_ROAD_WIDTH_M = 9;

export const RAIL = { width: 1.8, color: hex('#9a948c') };
export const RAIL_CLASSES = new Set(['rail', 'transit']);

/** Draw order of road classes: minor roads first, so highways sit on top. */
export const ROAD_ORDER = Object.keys(ROADS).reverse();

/** Paved width of one road feature, metres. */
export function roadWidth(style: RoadStyle, oneway: boolean): number {
  return oneway && style.carriageway ? style.carriageway : style.width;
}

/** One lane, metres: a bus (2.5 m) fits with room either side. */
export const LANE_M = 3.5;
/** A lane line's dashes: this long, this far apart, this wide (metres). */
export const LANE_DASH = { on: 3, off: 6, width: 0.18 };
export const LANE_LINE = hex('#ffffff');
/** Smaller streets' lines, grey on their white surface. */
export const STREET_LINE = hex('#b9bdc6');
/** Road classes with painted lines: none on the smallest streets. */
const MARKED = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);

/**
 * The lines painted on a road of `width`, as offsets from its middle (right
 * positive): dashes between lanes, and a solid line down the middle of a
 * two-way road. Only roads with marked lanes (a `carriageway` class).
 */
export function laneLines(cls: string, oneway: boolean): Array<{ offset: number; solid: boolean }> {
  const style = ROADS[cls];
  if (!style || !MARKED.has(cls)) return [];
  const width = roadWidth(style, oneway);
  const lines: Array<{ offset: number; solid: boolean }> = [];
  if (oneway) {
    // A small one-way street, two tight lanes at most: no line down it.
    const lanes = Math.floor(width / LANE_M);
    for (let k = 1; k < lanes; k++) lines.push({ offset: -width / 2 + k * LANE_M, solid: false });
    return lines;
  }
  // Two ways: the line down the middle is what says so.
  lines.push({ offset: 0, solid: true });
  const each = Math.floor(width / 2 / LANE_M);
  for (let k = 1; k < each; k++)
    for (const side of [-1, 1]) lines.push({ offset: side * k * LANE_M, solid: false });
  return lines;
}

/** `class` values for roads; `_construction` and `_ramp` variants map to these. */
export function roadClass(cls: string): string {
  return cls.replace(/_construction$/, '');
}

const WALLS = ['#e4ddd0', '#ddd8cf', '#e8dfcc', '#d9d6d1', '#e6dccb'].map(hex);

/**
 * Roofs as seen from above in a Philippine neighbourhood: mostly painted
 * GI sheet (red oxide, blue, green) and bare grey, kept muted so the route
 * and jeepneys still stand out. Weighted toward the common ones by repetition.
 */
const ROOFS = [
  '#b8644f',
  '#b8644f',
  '#a95a49', // red oxide
  '#6f8fae',
  '#5f80a3', // blue
  '#7d9c80', // green
  '#a7a9a8',
  '#a7a9a8',
  '#b9b5ad', // bare / grey
  '#d9d2c4',
  '#d9d2c4', // concrete deck
].map(hex);

function pick<T>(list: readonly T[], seed: number, salt: number): T {
  const h = Math.imul(Math.floor(seed) ^ salt, 2654435761) >>> 0;
  return list[h % list.length]!;
}

/**
 * Wall and roof colours for one building, chosen by a hash of its position:
 * stable between reloads, varied between neighbours.
 */
export function buildingColors(seed: number): { wall: Rgb; roof: Rgb } {
  return { wall: pick(WALLS, seed, 0x9e37), roof: pick(ROOFS, seed, 0x51ed) };
}

/** OpenMapTiles fills unknown heights, but be defensive: 2 floors. */
export const DEFAULT_BUILDING_HEIGHT_M = 6;

/** Place labels shown on the map, by OpenMapTiles `place` class. */
export const LABEL_PLACES = new Set(['city', 'town', 'suburb', 'quarter', 'village']);

/** Street names: a main road's from further off than a side street's (OpenMapTiles class). */
export const ROAD_LABELS: Readonly<Record<string, 'road' | 'street'>> = {
  motorway: 'road',
  trunk: 'road',
  primary: 'road',
  secondary: 'road',
  tertiary: 'street',
  minor: 'street',
};

/** Fast-food chains everyone gives directions by ("sa tapat ng Jollibee"). */
const DIRECTION_CHAINS = /jollibee|mcdonald|mang inasal|chowking|greenwich|kfc|andok/i;

/**
 * Landmarks named on the map, by OpenMapTiles `poi` class and subclass: what
 * people give directions by (a mall or market, a church, a school, a hospital,
 * the barangay hall, a tricycle terminal), and stations. Null: not named.
 */
export function landmarkKind(
  cls: string,
  subclass: string,
  name: string,
): 'landmark' | 'station' | null {
  if (cls === 'railway') return 'station';
  if (cls === 'grocery' || cls === 'shop')
    return ['mall', 'department_store', 'marketplace', 'supermarket'].includes(subclass)
      ? 'landmark'
      : null;
  if (['college', 'school', 'university', 'place_of_worship', 'town_hall', 'police'].includes(cls))
    return 'landmark';
  if (cls === 'hospital') return subclass === 'hospital' ? 'landmark' : null;
  // A tricycle (TODA) or jeepney terminal, and the barangay hall.
  if (cls === 'office') return subclass === 'taxi' || subclass === 'government' ? 'landmark' : null;
  if (cls === 'bus') return subclass === 'bus_station' ? 'landmark' : null;
  if (cls === 'fast_food') return DIRECTION_CHAINS.test(name) ? 'landmark' : null;
  return null;
}
