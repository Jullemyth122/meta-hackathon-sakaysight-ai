/**
 * Where a phone is, coarsely: the map cell its session is filed under, and
 * whether it is a vehicle or a person. A phone listens only to the cells its
 * map shows, and only to the kind it shows (a commuter sees jeepneys, not
 * other commuters), instead of to every phone in Metro Manila.
 */

import type { LatLng } from '../geo/projection';
import type { SessionUpdate } from './types';

/** A cell is this many degrees on a side: about 1.1 km in Metro Manila. */
export const CELL_DEG = 0.01;
/** At most this many cells are listened to at once (a 7 × 7 block, about 7.7 km across). */
export const MOST_CELLS = 49;
const METRES_PER_DEG = 111_320;

/** `v`: vehicles (drivers' phones), `p`: people (commuters' phones). */
export type AreaKind = 'v' | 'p';

const cellAt = (lat: number, lng: number): [number, number] => [
  Math.floor(lat / CELL_DEG),
  Math.floor(lng / CELL_DEG),
];

/** The area a session is filed under: its kind and its cell, e.g. `v:1475_12105`. */
export function areaOf(update: Pick<SessionUpdate, 'meta' | 'fix'>): string {
  const [i, j] = cellAt(update.fix.lat, update.fix.lng);
  return `${update.meta.role === 'commuter' ? 'p' : 'v'}:${i}_${j}`;
}

/** The areas of `kinds` within `radiusM` of `at`: at most MOST_CELLS cells, nearest first. */
export function areasAround(at: LatLng, radiusM: number, kinds: readonly AreaKind[]): string[] {
  if (kinds.length === 0) return [];
  const dLat = radiusM / METRES_PER_DEG;
  const dLng = radiusM / (METRES_PER_DEG * Math.cos((at.lat * Math.PI) / 180));
  const [i0, j0] = cellAt(at.lat - dLat, at.lng - dLng);
  const [i1, j1] = cellAt(at.lat + dLat, at.lng + dLng);
  const cells: Array<{ key: string; d: number }> = [];
  for (let i = i0; i <= i1; i++)
    for (let j = j0; j <= j1; j++) {
      const lat = (i + 0.5) * CELL_DEG;
      const lng = (j + 0.5) * CELL_DEG;
      cells.push({ key: `${i}_${j}`, d: Math.hypot(lat - at.lat, (lng - at.lng) * (dLat / dLng)) });
    }
  cells.sort((a, b) => a.d - b.d);
  return cells
    .slice(0, MOST_CELLS)
    .flatMap(({ key }) => kinds.map((kind) => `${kind}:${key}`))
    .sort();
}
