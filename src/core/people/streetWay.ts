/**
 * The way between any two spots of the map along its streets: what a planned
 * trip draws, and what "you" then go by. Shortest by street, from whichever
 * street near each spot makes the whole way shortest, not simply the nearest:
 * a spot by a divided highway can lie nearest its far carriageway, reached
 * only by going all the way round. Never straight over another road to get
 * to a street: roads are crossed where they meet. Tricycles keep off national
 * roads wherever a side street will do; on foot, their roadside is as good as any.
 *
 * The route's catchments (streetGraph.ts) only know the streets around its
 * stops, and only a focused route has them, so this works from the tiles
 * along the way itself (map/streetWayWorker.ts).
 */

import type { LocalPoint, Projection } from '../geo/projection';
import type { StreetLine } from '../map/streets';
import { tileKey, tilesAround, type TileId } from '../map/tiles';
import { StreetGraph } from './streetGraph';

/** A spot joins a street this far away at most (metres). */
export const SPOT_TO_STREET_M = 400;
/** Tiles along the way: a look this often (metres), and this far to either side. */
const CORRIDOR_STEP_M = 1000;
const CORRIDOR_MARGIN_M = 1200;
/** A way no longer than this many times the straight line, nor less room than the floor. */
const MAX_DETOUR = 5;
const MIN_SEARCH_M = 6000;
/** Points closer than this are one point (metres). */
const SAME_POINT_M = 0.5;
/** Every street this close to a spot (metres) can be the one it joins… */
const SPOT_CHOICE_M = 15;
/** …a step off the street counting this many times its metres, so a nearer street is preferred. */
const OFF_STREET_COST = 1.5;
/** A metre of national road, as metres of side street: barred to tricycles, a last resort. */
const NATIONAL_COST = { walk: 1, tricycle: 8 };
/** How close to a road being gone round a street is that same road (metres). */
const AVOID_WITHIN_M = 14;

export type WayMode = keyof typeof NATIONAL_COST;

export interface StreetWay {
  points: LocalPoint[];
  /** Each stretch's street width (points[i] to points[i + 1]; 0 off the streets). */
  widths: number[];
  metres: number;
}

interface Joined {
  at: LocalPoint;
  a: number;
  b: number;
}

/**
 * A street node a spot can start from: the cost to it, and the street point on
 * the way if any, on a street that wide.
 */
type Seeds = Map<number, { cost: number; via: LocalPoint | null; width: number }>;

/** The tiles to load for the way from `from` to `to`, nearest the start first. */
export function corridorTiles(
  from: LocalPoint,
  to: LocalPoint,
  projection: Projection,
  zoom: number,
): TileId[] {
  const length = Math.hypot(to.x - from.x, to.z - from.z);
  const steps = Math.max(1, Math.ceil(length / CORRIDOR_STEP_M));
  const tiles = new Map<string, TileId>();
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const p = { x: from.x + (to.x - from.x) * t, z: from.z + (to.z - from.z) * t };
    for (const tile of tilesAround([p], projection, CORRIDOR_MARGIN_M, zoom))
      tiles.set(tileKey(tile), tile);
  }
  return [...tiles.values()];
}

/** Where both spots join the same connected streets, the larger of the two pieces if they differ. */
function joinBoth(g: StreetGraph, from: LocalPoint, to: LocalPoint): [Joined, Joined] | null {
  const a = g.snap(from, SPOT_TO_STREET_M);
  const b = g.snap(to, SPOT_TO_STREET_M);
  if (!a || !b) return null;
  const pa = g.piece[a.a]!;
  const pb = g.piece[b.a]!;
  if (pa === pb) return [a, b];
  // The nearest street can be a loose piece (a car park's aisles) that leads nowhere.
  const size = (piece: number) => g.piece.reduce((n, p) => n + (p === piece ? 1 : 0), 0);
  const pieces = size(pa) >= size(pb) ? [pa, pb] : [pb, pa];
  for (const piece of pieces) {
    const inPiece = (n: number) => g.piece[n] === piece;
    const x = g.snap(from, SPOT_TO_STREET_M, inPiece);
    const y = g.snap(to, SPOT_TO_STREET_M, inPiece);
    if (x && y) return [x, y];
  }
  return null;
}

/** Where spot `p` can join the streets of `j`'s connected piece. */
function seedsOf(g: StreetGraph, p: LocalPoint, j: Joined, national: number): Seeds {
  const seeds: Seeds = new Map();
  const add = (n: number, cost: number, via: LocalPoint | null, width = 0) => {
    const known = seeds.get(n);
    if (!known || cost < known.cost) seeds.set(n, { cost, via, width });
  };
  const hop = Math.hypot(j.at.x - p.x, j.at.z - p.z) * OFF_STREET_COST;
  const along = g.nationalRoad(j.a, j.b) ? national : 1;
  for (const n of [j.a, j.b])
    add(n, hop + Math.hypot(g.x[n]! - j.at.x, g.z[n]! - j.at.z) * along, j.at, g.widthOf(j.a, j.b));
  for (const n of g.within(p, SPOT_CHOICE_M))
    if (g.piece[n] === g.piece[j.a] && !g.crossesStreet(p, n))
      add(n, Math.hypot(g.x[n]! - p.x, g.z[n]! - p.z) * OFF_STREET_COST, null);
  return seeds;
}

/** One point of a way: street node `n` when it is one; `width` of the street coming to it, if not. */
type Step = { p: LocalPoint; n?: number; width?: number };

/** The steps without repeats, each stretch's width, and how long they are. */
function wayOf(g: StreetGraph, steps: readonly Step[]): StreetWay {
  const kept: Step[] = [];
  const widths: number[] = [];
  let metres = 0;
  for (const step of steps) {
    const last = kept[kept.length - 1];
    const d = last ? Math.hypot(step.p.x - last.p.x, step.p.z - last.p.z) : Infinity;
    if (d < SAME_POINT_M) {
      // The same place: a street node from here on.
      last!.n ??= step.n;
      continue;
    }
    if (last) {
      metres += d;
      const both = last.n !== undefined && step.n !== undefined;
      widths.push(both ? g.widthOf(last.n!, step.n!) : (step.width ?? 0));
    }
    kept.push(step);
  }
  return { points: kept.map((s) => s.p), widths, metres };
}

/**
 * The shortest way from `from` to `to` by street. Null when either spot is
 * further than SPOT_TO_STREET_M from a street, or no street joins them.
 */
/** The streets a jeepney can drive: no footpaths. */
export const drivingGraph = (lines: readonly StreetLine[]): StreetGraph =>
  new StreetGraph(lines.filter((l) => l.drivable !== false));

export function streetWay(
  g: StreetGraph,
  from: LocalPoint,
  to: LocalPoint,
  mode: WayMode = 'walk',
  /** A road to go round, as points along it: taken only where there is no other way. */
  avoid?: readonly LocalPoint[],
): StreetWay | null {
  const both = joinBoth(g, from, to);
  if (!both) return null;
  const [a, b] = both;
  const national = NATIONAL_COST[mode];
  const starts = seedsOf(g, from, a, national);
  const ends = seedsOf(g, to, b, national);

  // From the far end, so each node's path back to it is in going order.
  const straight = Math.hypot(to.x - from.x, to.z - from.z);
  const reach = g.reach(
    [...ends].map(([n, { cost }]) => [n, cost] as const),
    Math.max(MIN_SEARCH_M, straight * MAX_DETOUR) * national,
    national,
    avoid && new Set(avoid.flatMap((p) => g.within(p, AVOID_WITHIN_M))),
  );
  let start = -1;
  let onStreets = Infinity;
  for (const [n, { cost }] of starts)
    if (cost + reach.dist[n]! < onStreets) [start, onStreets] = [n, cost + reach.dist[n]!];

  // Both on one stretch of street: nothing but that stretch between them.
  const sameStretch = (a.a === b.a && a.b === b.b) || (a.a === b.b && a.b === b.a);
  const direct =
    Math.hypot(a.at.x - b.at.x, a.at.z - b.at.z) * (g.nationalRoad(a.a, a.b) ? national : 1);
  const stretchWidth = g.widthOf(a.a, a.b);
  if (sameStretch && direct <= onStreets) {
    const way = wayOf(g, [{ p: from }, { p: a.at }, { p: b.at }, { p: to }]);
    return { ...way, widths: way.widths.map(() => stretchWidth) };
  }
  if (start < 0) return null;
  const nodes = g.pathTo(reach, start);
  const first = starts.get(start)!;
  const last = ends.get(nodes[nodes.length - 1]!);
  return wayOf(g, [
    { p: from },
    ...(first.via ? [{ p: first.via }] : []),
    ...nodes.map((n, i) => ({
      p: { x: g.x[n]!, z: g.z[n]! },
      n,
      ...(i === 0 && first.via && { width: first.width }),
    })),
    ...(last?.via ? [{ p: last.via, width: last.width }] : []),
    { p: to },
  ]);
}
