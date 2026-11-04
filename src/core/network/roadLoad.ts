/**
 * How much of each route's fleet a road can show at once. Licensed fleets are
 * sized from the region's totals (fleetSize.ts), and a route knows nothing of
 * the others on its road: added up, a main road ends up carrying more
 * vehicles than it could hold. So each route's flow is drawn at the share its
 * busiest roads have room for, on every road alike.
 *
 * A share per route, not per stretch of road: which vehicles are drawn never
 * changes as they drive, so nothing appears or disappears on the way.
 *
 * MAX_PER_LANE_KM is an assumption: nobody publishes public vehicles per lane
 * on these roads. It leaves about 125 m to the next one in a lane, 40 m
 * across three lanes, with room left for the private cars not drawn here.
 */

import { laneRoomAt, type Route } from '../geo/routes';
import { LANE_M } from '../map/style';

const MAX_PER_LANE_KM = 8;
/** The road is looked at this often along a route, in cells this size (metres). */
const STEP_M = 100;
const CELL_M = 200;
/** Each way along a road counts on its own: this many directions. */
const DIRECTIONS = 8;
/** A route's share is set by its busier roads: this far up, not its one worst corner. */
const BUSY_PART = 0.25;
/** Even the busiest road shows this much of a fleet. */
const LEAST_SHARE = 0.05;

interface Cell {
  /** Vehicles per km going this way. */
  load: number;
  lanes: number;
}

/** The share of each route's fleet to draw, 0–1, index for index with `routes`. */
export function roadShares(
  routes: ReadonlyArray<{ route: Route; vehicles: number }>,
): Float32Array {
  const cells = new Map<string, Cell>();
  const keysOf = routes.map(({ route, vehicles }) => {
    const line = route.polyline;
    const L = line.length;
    const perKm = (vehicles / L) * 1000;
    const steps = Math.max(1, Math.ceil(L / STEP_M));
    const keys: string[] = [];
    for (let n = 0; n < steps; n++) {
      const s = (n * L) / steps;
      const p = line.pointAt(s);
      const way = Math.round(((line.headingAt(s, 20) / (2 * Math.PI)) % 1) * DIRECTIONS);
      const dir = ((way % DIRECTIONS) + DIRECTIONS) % DIRECTIONS;
      const key = `${Math.round(p.x / CELL_M)},${Math.round(p.z / CELL_M)},${dir}`;
      keys.push(key);
      const cell = cells.get(key) ?? { load: 0, lanes: 1 };
      // Each sample stands for its share of the cell's length.
      cell.load += perKm * (STEP_M / CELL_M);
      cell.lanes = Math.max(cell.lanes, 1 + Math.floor(laneRoomAt(route, s) / LANE_M));
      cells.set(key, cell);
    }
    return keys;
  });
  return Float32Array.from(keysOf, (keys) => {
    const room = keys
      .map((key) => {
        const cell = cells.get(key)!;
        return (cell.lanes * MAX_PER_LANE_KM) / Math.max(cell.load, 1e-6);
      })
      .sort((a, b) => a - b);
    const busy = room[Math.floor(room.length * BUSY_PART)] ?? 1;
    return Math.max(LEAST_SHARE, Math.min(1, busy));
  });
}
