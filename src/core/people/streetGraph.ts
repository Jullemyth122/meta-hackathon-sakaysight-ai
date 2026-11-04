/**
 * The neighbourhood streets as a graph, and the walks and tricycle rides
 * along them to and from a route's stops: where a commuter comes from before
 * they reach the stop (home in the morning, work in the evening), and where
 * they go once off.
 *
 *   graph      junctions and bends are nodes, street segments are edges.
 *              Vector tiles split streets at tile edges, and often draw a
 *              side street up to another without a point in common, so ends
 *              left dangling are joined to any node, else any street,
 *              within JOIN_M.
 *   stops      every side street meeting the road within ENTRY_M of a stop
 *              is a way in to it: out of the street onto the stop's pavement
 *              (over the road, from the far side) and along it.
 *   catchment  one Dijkstra from all the ways in at once labels every
 *              street point within MAX_REACH_M (tricycle range) with the
 *              stop its people use: the nearest by street, by the side
 *              streets (not along national roads). Far neighbourhoods come
 *              to the stop their streets lead to.
 *   a spot     someone setting out from a spot of their own (the commuter
 *              app's rider) joins the nearest street that leads somewhere,
 *              and goes the way its neighbourhood goes; or, when that stop
 *              does not take them where they are going, the shortest way
 *              by any street, national roads' pavements too (wayFrom).
 *
 * The graph runs along street centre lines; people are put beside them (see
 * Lane): on foot at the street's edge, just off the road as drawn, and by
 * tricycle in the right-hand lane. The route's own road is not walked down
 * the middle of, only along its pavement.
 */

import type { LocalPoint } from '../geo/projection';
import type { Route } from '../geo/routes';
import { CASING_EXTRA_M } from '../map/style';

/** Street points closer than this (metres) are one node: shared vertices of joining streets. */
const SNAP_M = 0.5;
/** A street end left dangling (cut at a tile edge) joins the nearest node within this (metres). */
const JOIN_M = 3;
/** Spatial index cell (metres). */
const CELL_M = 25;
/** A metre of a street being gone round counts as this many. */
const AVOID_COST = 6;
/**
 * A side street is a way in to a stop when it meets the road (comes within
 * STREET_END_M of the stop's pavement) up to this far along it (metres).
 */
export const ENTRY_M = 600;
const STREET_END_M = 50;
/** Crossing the road to the stop counts as this much further to go (metres). */
const CROSSING_M = 30;
/** People come to a stop from this far by street at most: a tricycle ride (metres). */
export const MAX_REACH_M = 3000;
/**
 * From a spot of their own (the commuter app's rider), people go up to this
 * far by street to a stop that takes them where they are going (metres).
 */
const MAX_SEARCH_M = 2 * MAX_REACH_M;
/** Stops this close (straight) are beside each other: people of one board at the other (metres). */
export const STOP_NEAR_M = 300;
/** Homes and workplaces start this far along the streets from the stop at least (metres)… */
const MIN_WALK_M = 40;
/** …and this far from the route's own road. */
const ROUTE_CLEAR_M = 25;
/** A street segment with both ends this close to the route line is the route's own road. */
const ON_ROUTE_M = 8;
/**
 * Where people come from: any street point of a stop's catchment, as many
 * homes line every street; beyond NEAR_M fewer ride from each (other routes,
 * own vehicles), down by e each FAR_FADE_M further.
 */
const NEAR_M = 600;
const FAR_FADE_M = 1800;
/** Of the candidates at about a distance asked for, choose among this many. */
const CHOICE = 16;

export type Point3 = [number, number, number];

/**
 * Where on a street someone goes: on foot along its edge, left or right of
 * the way they are going, or by tricycle in the right-hand lane (traffic
 * keeps right in the Philippines).
 */
export type Lane = 'left' | 'right' | 'drive';
/** On foot, this far out from the road's edge as the map draws it: past its kerb line (metres). */
const BESIDE_ROAD_M = CASING_EXTRA_M / 2 + 0.6;
/** Footpaths and tracks this narrow or less are walked on, not beside (metres). */
const WALKED_ON_M = 3;
/** A tricycle keeps to its own lane on streets at least this wide (metres). */
const TWO_LANES_M = 6;
/** A corner of the offset path no further than this many offsets from its street point; else bevelled. */
const MITER_LIMIT = 2.5;

/** How far to the right of a street's centre line someone in `lane` goes, on a street `width` wide. */
function laneOffset(lane: Lane, width: number): number {
  if (lane === 'drive') return width >= TWO_LANES_M ? width / 4 : 0;
  const out = width > WALKED_ON_M ? width / 2 + BESIDE_ROAD_M : 0;
  return lane === 'right' ? out : -out;
}

/**
 * The way along street points `pts` (centre lines, in going order) moved
 * into `lane`: each stretch `widths[i]` wide (pts[i] to pts[i + 1]) shifted
 * sideways, corners where the shifted stretches meet.
 */
export function inLane(
  pts: readonly LocalPoint[],
  widths: readonly number[],
  lane: Lane,
): Point3[] {
  const { p, w } = withoutRepeats(pts, widths);
  return shiftedBy(
    p,
    w.map((width) => laneOffset(lane, width)),
  );
}

/** Points without repeats: a stretch of no length has no direction. */
function withoutRepeats(pts: readonly LocalPoint[], widths: readonly number[]) {
  const p: LocalPoint[] = [];
  const w: number[] = [];
  pts.forEach((q, i) => {
    const last = p[p.length - 1];
    if (last && Math.hypot(q.x - last.x, q.z - last.z) < 1e-3) return;
    if (last) w.push(widths[i - 1] ?? 0);
    p.push(q);
  });
  return { p, w };
}

/** Points `p` with each stretch moved `offs[i]` to the right, corners where the moved stretches meet. */
function shiftedBy(p: readonly LocalPoint[], offs: readonly number[]): Point3[] {
  if (p.length < 2) return p.map((q) => [q.x, 0, q.z]);
  const dirs = p.slice(1).map((q, i) => {
    const len = Math.hypot(q.x - p[i]!.x, q.z - p[i]!.z);
    return { x: (q.x - p[i]!.x) / len, z: (q.z - p[i]!.z) / len };
  });
  // Right of a direction (dx, dz) is (−dz, dx), as in stopLayout.ts.
  const shifted = (q: LocalPoint, d: LocalPoint, o: number): Point3 => [
    q.x - d.z * o,
    0,
    q.z + d.x * o,
  ];
  const out: Point3[] = [shifted(p[0]!, dirs[0]!, offs[0]!)];
  for (let i = 1; i < p.length - 1; i++) {
    const q = p[i]!;
    const d0 = dirs[i - 1]!;
    const d1 = dirs[i]!;
    const o0 = offs[i - 1]!;
    const o1 = offs[i]!;
    const a = shifted(q, d0, o0);
    const b = shifted(q, d1, o1);
    // Where the two shifted stretches cross: a + t·d0 = b + s·d1.
    const cross = d0.x * d1.z - d0.z * d1.x;
    if (Math.abs(cross) < 0.05) {
      // Straight on: step across if the street changes width here.
      out.push(a);
      if (Math.abs(o0 - o1) > 0.05) out.push(b);
      continue;
    }
    const rx = b[0] - a[0];
    const rz = b[2] - a[2];
    const t = (rx * d1.z - rz * d1.x) / cross;
    const corner: Point3 = [a[0] + d0.x * t, 0, a[2] + d0.z * t];
    const limit = MITER_LIMIT * Math.max(Math.abs(o0), Math.abs(o1));
    if (Math.hypot(corner[0] - q.x, corner[2] - q.z) <= limit) out.push(corner);
    else out.push(a, b); // a sharp turn: round the corner in two
  }
  out.push(shifted(p[p.length - 1]!, dirs[dirs.length - 1]!, offs[offs.length - 1]!));
  return out;
}

/** The way is looked at this far back from its end to tell which side of the road it ends on (metres). */
const END_LOOK_M = 5;
/** Beyond this many times its kerb offset, a spot is off the road: gone to from the kerb. */
const OFF_THE_KERB = 1.5;
/** A sideways turn this sharp ends a road (a stretch of the same width is another road). */
const NEW_ROAD_COS = Math.cos((50 * Math.PI) / 180);
/** Stretches compared when looking for a line that crosses itself. */
const TANGLE_WINDOW = 24;
/** Corners turning more than this are rounded (radians)… */
const ROUND_FROM = 0.15;
/** …starting this far before the corner (metres), or less of a short stretch… */
const ROUND_M = 12;
const ROUND_SHARE = 0.45;
/** …in this many steps for each radian of the turn. */
const ROUND_STEPS = 9;

/** Where stretches a–b and c–d cross, if they do. */
function crossing(a: Point3, b: Point3, c: Point3, d: Point3): Point3 | null {
  const ex = b[0] - a[0];
  const ez = b[2] - a[2];
  const fx = d[0] - c[0];
  const fz = d[2] - c[2];
  const cross = ex * fz - ez * fx;
  if (cross === 0) return null;
  const t = ((c[0] - a[0]) * fz - (c[2] - a[2]) * fx) / cross;
  const u = ((c[0] - a[0]) * ez - (c[2] - a[2]) * ex) / cross;
  return t > 0 && t < 1 && u > 0 && u < 1 ? [a[0] + ex * t, 0, a[2] + ez * t] : null;
}

/** The line without the loops and spikes a sideways shift makes on the inside of a turn. */
function untangled(line: readonly Point3[]): Point3[] {
  const out: Point3[] = [];
  for (let i = 0; i < line.length; i++) {
    out.push(line[i]!);
    if (i + 1 >= line.length) break;
    // The furthest stretch this one crosses: all between is the loop.
    for (let j = Math.min(line.length - 2, i + TANGLE_WINDOW); j > i + 1; j--) {
      const at = crossing(line[i]!, line[i + 1]!, line[j]!, line[j + 1]!);
      if (!at) continue;
      out.push(at);
      i = j;
      break;
    }
  }
  return out;
}

/** The line with its corners rounded. */
export function rounded(line: readonly Point3[]): Point3[] {
  if (line.length < 3) return [...line];
  const out: Point3[] = [line[0]!];
  for (let i = 1; i + 1 < line.length; i++) {
    const a = line[i - 1]!;
    const q = line[i]!;
    const b = line[i + 1]!;
    const inX = q[0] - a[0];
    const inZ = q[2] - a[2];
    const outX = b[0] - q[0];
    const outZ = b[2] - q[2];
    const lenIn = Math.hypot(inX, inZ);
    const lenOut = Math.hypot(outX, outZ);
    const turn = Math.acos(
      Math.max(-1, Math.min(1, (inX * outX + inZ * outZ) / (lenIn * lenOut || 1))),
    );
    if (turn < ROUND_FROM) {
      out.push(q);
      continue;
    }
    const before = Math.min(ROUND_M, lenIn * ROUND_SHARE) / (lenIn || 1);
    const after = Math.min(ROUND_M, lenOut * ROUND_SHARE) / (lenOut || 1);
    const sx = q[0] - inX * before;
    const sz = q[2] - inZ * before;
    const ex = q[0] + outX * after;
    const ez = q[2] + outZ * after;
    const steps = Math.ceil(turn * ROUND_STEPS);
    for (let k = 0; k <= steps; k++) {
      const t = k / steps;
      const u = 1 - t;
      out.push([
        u * u * sx + 2 * u * t * q[0] + t * t * ex,
        0,
        u * u * sz + 2 * u * t * q[2] + t * t * ez,
      ]);
    }
  }
  out.push(line[line.length - 1]!);
  return out;
}

/**
 * A way by the streets as it is gone and as it is drawn: one smooth line to
 * `goal` at the side of the road. It keeps to the side of the road `goal` is
 * on, so nobody walks the far kerb and cuts across to it; on foot all the way,
 * a tricycle in its lane until that last road. Turns are rounded, and where a
 * turn folds back (a side road meeting a highway at a slant) it goes round
 * inside the corner, not out to the junction and back.
 */
export function wayLine(
  pts: readonly LocalPoint[],
  widths: readonly number[],
  mode: 'walk' | 'tricycle',
  goal: LocalPoint = pts[pts.length - 1]!,
): Point3[] {
  const { p, w } = withoutRepeats(pts, widths);
  const end: Point3 = [goal.x, 0, goal.z];
  let last = w.length - 1;
  while (last >= 0 && w[last] === 0) last--;
  if (last < 0) return rounded([...p.map((q): Point3 => [q.x, 0, q.z]), end]);
  // Which side of the end of that road `goal` is on, right of the way along it.
  const on = p[last + 1]!;
  let k = last;
  while (k > 0 && Math.hypot(on.x - p[k]!.x, on.z - p[k]!.z) < END_LOOK_M) k--;
  const dx = on.x - p[k]!.x;
  const dz = on.z - p[k]!.z;
  const lane: Lane = -dz * (goal.x - on.x) + dx * (goal.z - on.z) >= 0 ? 'right' : 'left';
  // The last road starts where the way turned onto it.
  let from = last;
  const dirOf = (i: number) => {
    const len = Math.hypot(p[i + 1]!.x - p[i]!.x, p[i + 1]!.z - p[i]!.z);
    return { x: (p[i + 1]!.x - p[i]!.x) / len, z: (p[i + 1]!.z - p[i]!.z) / len };
  };
  while (from > 0 && w[from - 1]! > 0) {
    const a = dirOf(from - 1);
    const b = dirOf(from);
    if (a.x * b.x + a.z * b.z < NEW_ROAD_COS) break;
    from--;
  }
  const offs = w
    .slice(0, last + 1)
    .map((width, i) => laneOffset(mode === 'walk' || i >= from ? lane : 'drive', width));
  const line = shiftedBy(p.slice(0, last + 2), offs);
  // The kerb is about where `goal` stands; further, on to it from there.
  const away = Math.hypot(goal.x - on.x, goal.z - on.z);
  if (away <= Math.abs(offs[last]!) * OFF_THE_KERB) line.pop();
  // Never past it and back.
  while (line.length >= 2) {
    const a = line[line.length - 2]!;
    const b = line[line.length - 1]!;
    if ((end[0] - b[0]) * (b[0] - a[0]) + (end[2] - b[2]) * (b[2] - a[2]) >= 0) break;
    line.pop();
  }
  line.push(end);
  return rounded(untangled(line));
}

/** Shortest street distances from the starts, and the way back to them. */
interface Reach {
  /** Per node: metres from the nearest start (Infinity: not reached). */
  dist: Float64Array;
  /** Per node: the node before it on the way from there (-1 at a start). */
  prev: Int32Array;
}

/** How a route's stops meet the streets (from stopLayout.ts). */
export interface StopSides {
  /** Where people stand at the stop, going `direction`. */
  spot(stop: number, direction: 1 | -1): LocalPoint;
  /**
   * Someone coming out of a side street at `p`, on to the stop: onto its
   * pavement level with `p` (first the far pavement when across the road),
   * then along it towards the stop. Null when `p` is more than `withinM`
   * along the road.
   */
  pavement(
    stop: number,
    direction: 1 | -1,
    p: LocalPoint,
    withinM: number,
  ): { way: LocalPoint[]; across: boolean } | null;
}

/** One number for spatial index cell (cx, cz): cells span ±2^20 either way. */
const cellKey = (cx: number, cz: number) => (cx + 1_048_576) * 2_097_152 + (cz + 1_048_576);

/**
 * A spatial index as flat arrays, to send between threads as it is: cell
 * keys sorted, and cell i's items in items[starts[i] .. starts[i + 1]).
 */
export interface CellIndex {
  keys: Float64Array;
  starts: Uint32Array;
  items: Int32Array;
}

const NO_ITEMS = new Int32Array(0);

/** A spatial index built as a Map, frozen into flat arrays. */
function freeze(map: Map<number, number[]>): CellIndex {
  const keys = Float64Array.from(map.keys()).sort();
  const starts = new Uint32Array(keys.length + 1);
  keys.forEach((k, i) => (starts[i + 1] = starts[i]! + map.get(k)!.length));
  const items = new Int32Array(starts[keys.length]!);
  keys.forEach((k, i) => items.set(map.get(k)!, starts[i]));
  return { keys, starts, items };
}

/** Cell `key`'s items in a spatial index, built (a Map) or frozen. */
function inCell(index: Map<number, number[]> | CellIndex, key: number): ArrayLike<number> {
  if (index instanceof Map) return index.get(key) ?? NO_ITEMS;
  let lo = 0;
  let hi = index.keys.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const k = index.keys[mid]!;
    if (k === key) return index.items.subarray(index.starts[mid], index.starts[mid + 1]);
    if (k < key) lo = mid + 1;
    else hi = mid - 1;
  }
  return NO_ITEMS;
}

/**
 * A StreetGraph as flat arrays: node i's edges are edges[starts[i] ..
 * starts[i + 1]); its spatial indexes as they are.
 */
export interface GraphState {
  x: Float64Array;
  z: Float64Array;
  piece: Int32Array;
  starts: Uint32Array;
  edges: Float64Array;
  cells: CellIndex;
  segments: CellIndex;
}

/** A street line: its points, its width kerb to kerb (metres) and whether it is a national road. */
export type GraphLine = readonly LocalPoint[] & { width?: number; national?: boolean };

/** Per edge in StreetGraph's adjacency: neighbour, metres, width, national (1) or not (0). */
export const EDGE = 4;

export class StreetGraph {
  readonly x: number[] = [];
  readonly z: number[] = [];
  /** Per node: which connected piece of the network it is in. */
  readonly piece: Int32Array;
  /** Per node: its edges, EDGE numbers each (see EDGE); a view of the state's, when sent. */
  private readonly adj: Array<number[] | Float64Array> = [];
  /** Per cell: its nodes. A Map while building, then frozen (flat arrays). */
  private cells: Map<number, number[]> | CellIndex = new Map();
  /** Per cell: the segments through it, as node pairs (a long straight street crosses many). */
  private segmentCells: Map<number, number[]> | CellIndex = new Map();

  /** From street lines; or, with `state`, as another thread built it (toState), no lines needed. */
  constructor(lines: Iterable<GraphLine>, state?: GraphState) {
    if (state) {
      this.x = Array.from(state.x);
      this.z = Array.from(state.z);
      for (let i = 0; i < state.x.length; i++)
        this.adj.push(state.edges.subarray(state.starts[i]!, state.starts[i + 1]!));
      this.piece = state.piece;
      this.cells = state.cells;
      this.segmentCells = state.segments;
      return;
    }
    const ids = new Map<number, number>();
    const node = (p: LocalPoint) => {
      const key = cellKey(Math.round(p.x / SNAP_M), Math.round(p.z / SNAP_M));
      let id = ids.get(key);
      if (id === undefined) {
        id = this.addNode(p);
        ids.set(key, id);
      }
      return id;
    };
    for (const line of lines) {
      const width = line.width ?? 0;
      const national = line.national ? 1 : 0;
      for (let i = 1; i < line.length; i++)
        this.link(node(line[i - 1]!), node(line[i]!), width, national);
    }
    // Loose ends: streets cut at tile edges, and side streets drawn up to
    // another street without a point in common (a T-junction). Each joins
    // the nearest other node within JOIN_M, or else the nearest street
    // there, which is split at that point.
    this.indexSegments();
    const splits = new Map<string, Array<{ t: number; end: number }>>();
    for (let a = 0; a < this.x.length; a++) {
      const edges = this.adj[a]!;
      if (edges.length !== EDGE) continue; // exactly one neighbour
      const p = { x: this.x[a]!, z: this.z[a]! };
      const b = this.nearest(p, JOIN_M, a);
      if (b >= 0 && b !== edges[0]) {
        this.link(a, b, edges[2]!, edges[3]!);
        continue;
      }
      const onto = this.snap(p, JOIN_M, (u, v) => u !== a && v !== a);
      if (!onto) continue;
      const [u, v] = onto.a < onto.b ? [onto.a, onto.b] : [onto.b, onto.a];
      const t = Math.hypot(onto.at.x - this.x[u]!, onto.at.z - this.z[u]!);
      const key = `${u},${v}`;
      (splits.get(key) ?? splits.set(key, []).get(key)!).push({ t, end: a });
    }
    for (const [key, ends] of splits) {
      const [u, v] = key.split(',').map(Number) as [number, number];
      const edges = this.adj[u]!;
      let k = 0;
      while (k < edges.length && edges[k] !== v) k += EDGE;
      const width = edges[k + 2]!;
      const national = edges[k + 3]!;
      this.unlink(u, v);
      let from = u;
      for (const { t, end } of ends.sort((p, q) => p.t - q.t)) {
        const len = Math.hypot(this.x[v]! - this.x[u]!, this.z[v]! - this.z[u]!) || 1;
        const m = this.addNode({
          x: this.x[u]! + ((this.x[v]! - this.x[u]!) * t) / len,
          z: this.z[u]! + ((this.z[v]! - this.z[u]!) * t) / len,
        });
        this.link(from, m, width, national);
        const own = this.adj[end]!;
        this.link(m, end, own[2]!, own[3]!);
        from = m;
      }
      this.link(from, v, width, national);
    }
    // The network's connected pieces.
    this.piece = new Int32Array(this.x.length).fill(-1);
    for (let s = 0, pieces = 0; s < this.x.length; s++) {
      if (this.piece[s]! >= 0) continue;
      const stack = [s];
      this.piece[s] = pieces;
      while (stack.length > 0) {
        const edges = this.adj[stack.pop()!]!;
        for (let k = 0; k < edges.length; k += EDGE)
          if (this.piece[edges[k]!]! < 0) {
            this.piece[edges[k]!] = pieces;
            stack.push(edges[k]!);
          }
      }
      pieces++;
    }
    this.indexSegments();
    this.cells = freeze(this.cells as Map<number, number[]>);
    this.segmentCells = freeze(this.segmentCells as Map<number, number[]>);
  }

  /** Each segment into every cell it passes through, for snap. */
  private indexSegments(): void {
    const index = new Map<number, number[]>();
    this.segmentCells = index;
    for (let a = 0; a < this.x.length; a++) {
      const edges = this.adj[a]!;
      for (let k = 0; k < edges.length; k += EDGE) {
        const b = edges[k]!;
        if (b < a) continue;
        const steps = Math.max(1, Math.ceil(edges[k + 1]! / (CELL_M / 2)));
        let last = NaN;
        for (let i = 0; i <= steps; i++) {
          const t = i / steps;
          const cell = this.cell(
            this.x[a]! + (this.x[b]! - this.x[a]!) * t,
            this.z[a]! + (this.z[b]! - this.z[a]!) * t,
          );
          if (cell === last) continue;
          last = cell;
          (index.get(cell) ?? index.set(cell, []).get(cell)!).push(a, b);
        }
      }
    }
  }

  get size(): number {
    return this.x.length;
  }

  /** The graph as flat arrays, to send to another thread (see the constructor). */
  toState(): GraphState {
    const n = this.size;
    const starts = new Uint32Array(n + 1);
    for (let i = 0; i < n; i++) starts[i + 1] = starts[i]! + this.adj[i]!.length;
    const edges = new Float64Array(starts[n]!);
    for (let i = 0; i < n; i++) edges.set(this.adj[i]!, starts[i]);
    return {
      x: Float64Array.from(this.x),
      z: Float64Array.from(this.z),
      piece: this.piece,
      starts,
      edges,
      cells: this.cells as CellIndex,
      segments: this.segmentCells as CellIndex,
    };
  }

  private cell(x: number, z: number): number {
    return cellKey(Math.floor(x / CELL_M), Math.floor(z / CELL_M));
  }

  private addNode(p: LocalPoint): number {
    const id = this.x.length;
    this.x.push(p.x);
    this.z.push(p.z);
    this.adj.push([]);
    const cells = this.cells as Map<number, number[]>;
    const cell = this.cell(p.x, p.z);
    (cells.get(cell) ?? cells.set(cell, []).get(cell)!).push(id);
    return id;
  }

  /** Remove every segment between `a` and `b`. */
  private unlink(a: number, b: number): void {
    for (const [from, to] of [
      [a, b],
      [b, a],
    ] as const) {
      const edges = this.adj[from]!;
      const kept: number[] = [];
      for (let k = 0; k < edges.length; k += EDGE)
        if (edges[k] !== to) for (let e = k; e < k + EDGE; e++) kept.push(edges[e]!);
      this.adj[from] = kept;
    }
  }

  private link(a: number, b: number, width: number, national: number): void {
    if (a === b) return;
    const d = Math.hypot(this.x[a]! - this.x[b]!, this.z[a]! - this.z[b]!);
    // Only while building, when every node's edges are an array of its own.
    (this.adj[a] as number[]).push(b, d, width, national);
    (this.adj[b] as number[]).push(a, d, width, national);
  }

  /** Node `n`'s edges: neighbour, street metres, width, national; EDGE numbers each. */
  edges(n: number): ArrayLike<number> {
    return this.adj[n]!;
  }

  /** The node nearest `p` within `within` metres (not `except`), or -1. */
  nearest(p: LocalPoint, within: number, except = -1): number {
    let best = -1;
    let bestD = within;
    for (const n of this.within(p, within)) {
      if (n === except) continue;
      const d = Math.hypot(this.x[n]! - p.x, this.z[n]! - p.z);
      if (d <= bestD) {
        best = n;
        bestD = d;
      }
    }
    return best;
  }

  /** How wide the street from node `a` to its neighbour `b` is, kerb to kerb (0 when not known). */
  widthOf(a: number, b: number): number {
    const edges = this.adj[a]!;
    let width = 0;
    for (let k = 0; k < edges.length; k += EDGE)
      if (edges[k] === b) width = Math.max(width, edges[k + 2]!);
    return width;
  }

  /** Whether the street from node `a` to its neighbour `b` is a national road. */
  nationalRoad(a: number, b: number): boolean {
    const edges = this.adj[a]!;
    for (let k = 0; k < edges.length; k += EDGE) if (edges[k] === b && edges[k + 3]) return true;
    return false;
  }

  /**
   * The street point nearest `p` within `within` metres, on a segment a–b
   * that passes `accept`: on the segment, not only at its ends. Null when
   * no such street is that close.
   */
  snap(
    p: LocalPoint,
    within: number,
    accept: (a: number, b: number) => boolean = () => true,
  ): { at: LocalPoint; a: number; b: number } | null {
    let best: { at: LocalPoint; a: number; b: number } | null = null;
    let bestD = within;
    const r = Math.ceil(within / CELL_M);
    const cx = Math.floor(p.x / CELL_M);
    const cz = Math.floor(p.z / CELL_M);
    for (let dx = -r; dx <= r; dx++)
      for (let dz = -r; dz <= r; dz++) {
        const pairs = inCell(this.segmentCells, cellKey(cx + dx, cz + dz));
        for (let k = 0; k < pairs.length; k += 2) {
          const a = pairs[k]!;
          const b = pairs[k + 1]!;
          const ex = this.x[b]! - this.x[a]!;
          const ez = this.z[b]! - this.z[a]!;
          const len2 = ex * ex + ez * ez;
          const t =
            len2 > 0
              ? Math.max(0, Math.min(1, ((p.x - this.x[a]!) * ex + (p.z - this.z[a]!) * ez) / len2))
              : 0;
          const ax = this.x[a]! + ex * t;
          const az = this.z[a]! + ez * t;
          const d = Math.hypot(ax - p.x, az - p.z);
          if (d < bestD && accept(a, b)) {
            bestD = d;
            best = { at: { x: ax, z: az }, a, b };
          }
        }
      }
    return best;
  }

  /** Whether the straight line from `a` to node `to` crosses a street on its way there. */
  crossesStreet(a: LocalPoint, to: number): boolean {
    const bx = this.x[to]!;
    const bz = this.z[to]!;
    const dx = bx - a.x;
    const dz = bz - a.z;
    const minX = Math.floor(Math.min(a.x, bx) / CELL_M);
    const maxX = Math.floor(Math.max(a.x, bx) / CELL_M);
    const minZ = Math.floor(Math.min(a.z, bz) / CELL_M);
    const maxZ = Math.floor(Math.max(a.z, bz) / CELL_M);
    for (let cx = minX; cx <= maxX; cx++)
      for (let cz = minZ; cz <= maxZ; cz++) {
        const pairs = inCell(this.segmentCells, cellKey(cx, cz));
        for (let k = 0; k < pairs.length; k += 2) {
          const p = pairs[k]!;
          const q = pairs[k + 1]!;
          // The street the line ends on is the one it is going to.
          if (p === to || q === to) continue;
          const ex = this.x[q]! - this.x[p]!;
          const ez = this.z[q]! - this.z[p]!;
          const cross = dx * ez - dz * ex;
          if (cross === 0) continue;
          const ax = this.x[p]! - a.x;
          const az = this.z[p]! - a.z;
          const along = (ax * ez - az * ex) / cross;
          const onStreet = (ax * dz - az * dx) / cross;
          if (along > 0 && along < 1 && onStreet >= 0 && onStreet <= 1) return true;
        }
      }
    return false;
  }

  /**
   * Street nodes `nodes` (in going order) as a way in `lane`; from `start`
   * first when given: a point on a street `width` wide leading to the first
   * node (a spot snapped to the streets).
   */
  wayAlong(
    nodes: readonly number[],
    lane: Lane,
    start?: { at: LocalPoint; width: number },
  ): Point3[] {
    const pts = nodes.map((n) => ({ x: this.x[n]!, z: this.z[n]! }));
    const widths = nodes.slice(1).map((n, i) => this.widthOf(nodes[i]!, n));
    if (start) {
      pts.unshift(start.at);
      widths.unshift(start.width);
    }
    return inLane(pts, widths, lane);
  }

  /** Every node within `r` metres of `p`, straight. */
  within(p: LocalPoint, r: number): number[] {
    const out: number[] = [];
    const k = Math.ceil(r / CELL_M);
    const cx = Math.floor(p.x / CELL_M);
    const cz = Math.floor(p.z / CELL_M);
    for (let dx = -k; dx <= k; dx++)
      for (let dz = -k; dz <= k; dz++) {
        const items = inCell(this.cells, cellKey(cx + dx, cz + dz));
        for (let i = 0; i < items.length; i++) {
          const n = items[i]!;
          if (Math.hypot(this.x[n]! - p.x, this.z[n]! - p.z) <= r) out.push(n);
        }
      }
    return out;
  }

  /**
   * Every node within `maxM` along the streets of the nearest of `from`
   * (node, metres already gone to reach it): Dijkstra from many starts. Each
   * metre of national road counts as `national` metres, and of street
   * between nodes in `avoid` as AVOID_COST.
   */
  reach(
    from: ReadonlyArray<readonly [number, number]>,
    maxM: number,
    national = 1,
    avoid?: ReadonlySet<number>,
  ): Reach {
    const dist = new Float64Array(this.size).fill(Infinity);
    const prev = new Int32Array(this.size).fill(-1);
    const heap = new MinHeap();
    for (const [n, d] of from)
      if (d < dist[n]!) {
        dist[n] = d;
        heap.push(n, d);
      }
    while (heap.size > 0) {
      const [n, d] = heap.pop();
      if (d > dist[n]!) continue;
      const edges = this.adj[n]!;
      for (let k = 0; k < edges.length; k += EDGE) {
        const m = edges[k]!;
        const cost = avoid?.has(n) && avoid.has(m) ? AVOID_COST : 1;
        const nd = d + edges[k + 1]! * (edges[k + 3] ? national : 1) * cost;
        if (nd > maxM || nd >= dist[m]!) continue;
        dist[m] = nd;
        prev[m] = n;
        heap.push(m, nd);
      }
    }
    return { dist, prev };
  }

  /** The street nodes from `node` back to the reach's nearest start, in walking order. */
  pathTo(reach: Reach, node: number): number[] {
    const out: number[] = [];
    for (let n = node; n >= 0; n = reach.prev[n]!) out.push(n);
    return out;
  }
}

/** A binary min-heap of (node, distance). */
class MinHeap {
  private readonly nodes: number[] = [];
  private readonly keys: number[] = [];
  get size(): number {
    return this.nodes.length;
  }
  push(node: number, key: number): void {
    let i = this.nodes.length;
    this.nodes.push(node);
    this.keys.push(key);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p]! <= key) break;
      this.swap(i, p);
      i = p;
    }
  }
  pop(): [number, number] {
    const top: [number, number] = [this.nodes[0]!, this.keys[0]!];
    const lastNode = this.nodes.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.nodes.length > 0) {
      this.nodes[0] = lastNode;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.keys.length && this.keys[l]! < this.keys[m]!) m = l;
        if (r < this.keys.length && this.keys[r]! < this.keys[m]!) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
  private swap(a: number, b: number): void {
    [this.nodes[a], this.nodes[b]] = [this.nodes[b]!, this.nodes[a]!];
    [this.keys[a], this.keys[b]] = [this.keys[b]!, this.keys[a]!];
  }
}

/** A place a commuter comes from or goes to: a street node, and how far it is from its stop. */
export interface StreetPlace {
  node: number;
  /** Metres from the place to its stop, by street and pavement. */
  metres: number;
}

/** A stop as its people come to it: one per stop and direction served. */
export interface StopSlot {
  stop: number;
  direction: 1 | -1;
  spot: LocalPoint;
}

export interface Slot extends StopSlot {
  /** Its street points (homes, workplaces), nearest first. */
  places: number[];
  /** Running total of their weights (see NEAR_M), for drawing one. */
  weights: Float64Array;
  /** Its ways in: the street node, the way on from it to the stop, and the metres that is. */
  entries: Array<{ node: number; way: LocalPoint[]; metres: number }>;
}

/** One direction's labelling (see the file comment): per street node, its stop and the way there. */
export interface Pass {
  /** Metres to its stop (Infinity beyond reach). */
  dist: Float64Array;
  /** Its stop: slot index, -1 for none. */
  label: Int32Array;
  /** The next node on the way there, -1 at a way in. */
  prev: Int32Array;
}

/** Catchments' working-out as plain data, to send between threads. */
export interface CatchmentsState {
  passes: Array<[1 | -1, Pass]>;
  ways: Array<[number, LocalPoint[]]>;
  slots: Slot[];
  leading: number[];
}

/**
 * The street neighbourhood of every stop of a route (see the file comment),
 * for each direction the route is served in: someone going one way uses
 * that way's stop nearest to them, crossing the road to it when they must.
 */
export class Catchments {
  private readonly passes = new Map<1 | -1, Pass>();
  /** Each way in (slot × nodes + node): from the street end on to the stop. */
  private readonly ways = new Map<number, LocalPoint[]>();
  private readonly slots: Slot[] = [];
  private readonly slotAt = new Map<string, number>();
  /** The pieces of the street network (StreetGraph.piece) that lead to a stop. */
  private readonly leading = new Set<number>();

  constructor(
    readonly graph: StreetGraph,
    route: Route,
    private readonly sides: StopSides,
    /** As another thread worked it out (toState): taken as it is. */
    state?: CatchmentsState,
  ) {
    if (state) {
      for (const [direction, pass] of state.passes) this.passes.set(direction, pass);
      for (const [key, way] of state.ways) this.ways.set(key, way);
      this.slots.push(...state.slots);
      this.slots.forEach((s, i) => this.slotAt.set(`${s.stop}:${s.direction}`, i));
      for (const piece of state.leading) this.leading.add(piece);
      return;
    }
    const g = graph;
    const N = g.size;
    const routeCells = sampleCells(route, ROUTE_CLEAR_M, ROUTE_CLEAR_M / 2);
    const onRoadCells = sampleCells(route, ON_ROUTE_M, 2);
    const besideRoute = (n: number) => near(routeCells, ROUTE_CLEAR_M, g.x[n]!, g.z[n]!, Infinity);
    const onRoad = new Uint8Array(N);
    for (let n = 0; n < N; n++)
      onRoad[n] = near(onRoadCells, ON_ROUTE_M, g.x[n]!, g.z[n]!, ON_ROUTE_M) ? 1 : 0;
    const sideStreet = (n: number) => {
      const edges = g.edges(n);
      for (let k = 0; k < edges.length; k += EDGE) if (!edges[k + 3]) return true;
      return false;
    };

    const directions: ReadonlyArray<1 | -1> = route.loop ? [1] : [1, -1];
    for (const direction of directions) {
      const pass: Pass = {
        dist: new Float64Array(N).fill(Infinity),
        label: new Int32Array(N).fill(-1),
        prev: new Int32Array(N).fill(-1),
      };
      this.passes.set(direction, pass);
      const { dist, label, prev } = pass;
      const heap = new MinHeap();
      // The ways in to each stop: side streets meeting the road near it.
      route.stops.forEach((_, stop) => {
        const slot = this.slots.length;
        const spot = sides.spot(stop, direction);
        const entries: Slot['entries'] = [];
        this.slots.push({
          stop,
          direction,
          spot,
          places: [],
          weights: new Float64Array(0),
          entries,
        });
        this.slotAt.set(`${stop}:${direction}`, slot);
        for (const n of g.within(spot, ENTRY_M + STREET_END_M)) {
          // Side streets often end at a junction on the road itself: those
          // count too, but not the national road's own points between them.
          if (!besideRoute(n) || !sideStreet(n)) continue;
          const entry = this.entry(n, stop, direction, spot);
          if (!entry) continue;
          const { way, metres } = entry;
          entries.push({ node: n, way, metres });
          if (metres < dist[n]!) {
            dist[n] = metres;
            label[n] = slot;
            prev[n] = -1;
            this.ways.set(slot * N + n, way);
            heap.push(n, metres);
          }
        }
      });
      // Out from all of them at once: each street point to its nearest stop.
      while (heap.size > 0) {
        const [n, d] = heap.pop();
        if (d > dist[n]!) continue;
        const edges = g.edges(n);
        for (let k = 0; k < edges.length; k += EDGE) {
          const m = edges[k]!;
          if (onRoad[n] && onRoad[m]) continue; // not down the middle of the route's road
          if (edges[k + 3]) continue; // nor along a national road: by the side streets
          const nd = d + edges[k + 1]!;
          if (nd > MAX_REACH_M || nd >= dist[m]!) continue;
          dist[m] = nd;
          label[m] = label[n]!;
          prev[m] = n;
          heap.push(m, nd);
        }
      }
      // Each stop's places, nearest first.
      for (let n = 0; n < N; n++) {
        if (label[n]! < 0) continue;
        this.leading.add(g.piece[n]!);
        if (dist[n]! >= MIN_WALK_M && !besideRoute(n)) this.slots[label[n]!]!.places.push(n);
      }
    }
    // Weighted for drawing: as many as live there, fewer from far (NEAR_M).
    for (const s of this.slots) {
      const { dist } = this.passes.get(s.direction)!;
      s.places.sort((a, b) => dist[a]! - dist[b]!);
      s.weights = new Float64Array(s.places.length);
      let total = 0;
      s.places.forEach((n, i) => {
        const d = dist[n]!;
        total += d <= NEAR_M ? 1 : Math.exp(-(d - NEAR_M) / FAR_FADE_M);
        s.weights[i] = total;
      });
    }
  }

  /**
   * Street node `n` as a way in to `stop` going `direction`: out of the
   * street onto the stop's pavement (over the road from the far side) and
   * along it to `spot`, and the metres that is. Null when the street does
   * not come within STREET_END_M of the pavement there.
   */
  private entry(
    n: number,
    stop: number,
    direction: 1 | -1,
    spot: LocalPoint,
  ): { way: LocalPoint[]; metres: number } | null {
    const p = { x: this.graph.x[n]!, z: this.graph.z[n]! };
    const onto = this.sides.pavement(stop, direction, p, ENTRY_M);
    if (!onto) return null;
    const { way, across } = onto;
    let metres = Math.hypot(p.x - way[0]!.x, p.z - way[0]!.z);
    if (metres > STREET_END_M) return null;
    if (across) metres += CROSSING_M;
    for (let k = 0; k < way.length; k++) {
      const next = way[k + 1] ?? spot;
      metres += Math.hypot(next.x - way[k]!.x, next.z - way[k]!.z);
    }
    return { way, metres };
  }

  /**
   * The street point nearest `p` within `withinM` that leads to a stop:
   * not a loose piece of street (a car park's aisles, a footpath stub, a
   * subdivision reached only by the highway) that goes nowhere.
   */
  onStreets(p: LocalPoint, withinM: number): { at: LocalPoint; a: number; b: number } | null {
    return this.graph.snap(p, withinM, (n) => this.leading.has(this.graph.piece[n]!));
  }

  /**
   * Where spot `p` joins the streets (onStreets): the street point, how wide
   * that street is, and the street nodes either way along it with the
   * metres to each.
   */
  private join(p: LocalPoint, withinM: number) {
    const g = this.graph;
    const at = this.onStreets(p, withinM);
    if (!at) return null;
    const along = (n: number) => Math.hypot(g.x[n]! - at.at.x, g.z[n]! - at.at.z);
    return {
      start: { at: at.at, width: g.widthOf(at.a, at.b) },
      ends: [
        [at.a, along(at.a)],
        [at.b, along(at.b)],
      ] as Array<readonly [number, number]>,
      hop: Math.hypot(at.at.x - p.x, at.at.z - p.z),
    };
  }

  /** Of what `reach` reached, the way in to slot `slot`'s stop that is least far in all. */
  private bestEntry(
    reach: Reach,
    slot: number,
  ): { node: number; way: LocalPoint[]; metres: number } | null {
    let best: { node: number; way: LocalPoint[]; metres: number } | null = null;
    for (const e of this.slots[slot]!.entries) {
      const d = reach.dist[e.node]!;
      if (d < Infinity && (!best || d + e.metres < best.metres))
        best = { node: e.node, way: e.way, metres: d + e.metres };
    }
    return best;
  }

  /**
   * From spot `from` (joining the streets within `withinM`), the nearest
   * stop by street, going either way, that `suits` (it goes where they are
   * going): for a spot whose own neighbourhood's stops do not. Null when no
   * street is that close, or none leads to such a stop.
   */
  nearestByStreet(
    from: LocalPoint,
    withinM: number,
    suits: (stop: number, direction: 1 | -1) => boolean,
  ): (StopSlot & { metres: number }) | null {
    const j = this.join(from, withinM);
    if (!j) return null;
    const reach = this.graph.reach(j.ends, MAX_SEARCH_M);
    let best: (StopSlot & { metres: number }) | null = null;
    this.slots.forEach((s, i) => {
      if (!suits(s.stop, s.direction)) return;
      const e = this.bestEntry(reach, i);
      if (e && (!best || j.hop + e.metres < best.metres))
        best = { stop: s.stop, direction: s.direction, spot: s.spot, metres: j.hop + e.metres };
    });
    return best;
  }

  /**
   * The way from spot `from` to `target` at `stop` going `direction`, by the
   * streets, in `lane`: onto the nearest street (within `withinM`), then the
   * way its neighbourhood goes to its stop when that is this one or beside
   * it (STOP_NEAR_M), else the shortest way along the streets to this stop.
   * Null when no street is that close, or none leads there.
   */
  wayFrom(
    from: LocalPoint,
    stop: number,
    direction: 1 | -1,
    target: LocalPoint,
    lane: Lane,
    withinM: number,
  ): Point3[] | null {
    const pass = this.passes.get(direction);
    const own = this.slotAt.get(`${stop}:${direction}`);
    if (!pass || own === undefined) return null;
    const head: Point3 = [from.x, 0, from.z];
    // Already by the stop: just step over.
    if (Math.hypot(target.x - from.x, target.z - from.z) <= STREET_END_M)
      return [head, [target.x, 0, target.z]];
    const j = this.join(from, withinM);
    if (!j) return null;
    const ownSpot = this.slots[own]!.spot;
    let viaNode = -1;
    let least = Infinity;
    for (const [n, along] of j.ends) {
      const slot = this.slots[pass.label[n]!];
      if (!slot || Math.hypot(slot.spot.x - ownSpot.x, slot.spot.z - ownSpot.z) > STOP_NEAR_M)
        continue;
      if (along + pass.dist[n]! < least) [viaNode, least] = [n, along + pass.dist[n]!];
    }
    if (viaNode >= 0) return [head, ...this.toStop(viaNode, direction, target, lane, j.start)!];
    const reach = this.graph.reach(j.ends, MAX_SEARCH_M);
    const e = this.bestEntry(reach, own);
    if (!e) return null;
    const nodes = this.graph.pathTo(reach, e.node).reverse();
    return [
      head,
      ...this.graph.wayAlong(nodes, lane, j.start),
      ...e.way.map((p): Point3 => [p.x, 0, p.z]),
      [target.x, 0, target.z],
    ];
  }

  /** Everything worked out, to send to another thread (the graph separately: StreetGraph.toState). */
  toState(): CatchmentsState {
    return {
      passes: [...this.passes],
      ways: [...this.ways],
      slots: this.slots,
      leading: [...this.leading],
    };
  }

  /** The stop's slot with places, or the nearest one with some (a stop squeezed between others). */
  private slotFor(stop: number, direction: 1 | -1): Slot | null {
    const own = this.slots[this.slotAt.get(`${stop}:${direction}`) ?? -1];
    if (!own) return null;
    if (own.places.length > 0) return own;
    let best: Slot | null = null;
    let bestD = ENTRY_M;
    for (const s of this.slots) {
      const d = Math.hypot(s.spot.x - own.spot.x, s.spot.z - own.spot.z);
      if (s.direction === direction && s.places.length > 0 && d < bestD) {
        best = s;
        bestD = d;
      }
    }
    return best;
  }

  /** Whether `stop` has streets around it to come and go by. */
  has(stop: number, direction: 1 | -1): boolean {
    return this.slotFor(stop, direction) !== null;
  }

  /** A place people of `stop` come from, drawn by `pick` (0–1) as they live along its streets. */
  place(stop: number, direction: 1 | -1, pick: number): StreetPlace | null {
    const s = this.slotFor(stop, direction);
    if (!s) return null;
    const w = s.weights;
    const target = pick * w[w.length - 1]!;
    let lo = 0;
    let hi = w.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (w[mid]! < target) lo = mid + 1;
      else hi = mid;
    }
    const node = s.places[lo]!;
    return { node, metres: this.passes.get(direction)!.dist[node]! };
  }

  /** A place about `metres` from `stop` (as near as its streets allow), one of a few by `pick`. */
  placeAbout(stop: number, direction: 1 | -1, metres: number, pick: number): StreetPlace | null {
    const s = this.slotFor(stop, direction);
    if (!s) return null;
    const { dist } = this.passes.get(direction)!;
    const { places } = s;
    let lo = 0;
    let hi = places.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (dist[places[mid]!]! < metres) lo = mid + 1;
      else hi = mid;
    }
    const from = Math.max(0, Math.min(places.length - CHOICE, lo - CHOICE / 2));
    const options = places.slice(from, from + CHOICE);
    const node = options[Math.min(options.length - 1, Math.floor(pick * options.length))]!;
    return { node, metres: dist[node]! };
  }

  /**
   * The stop someone at street point `node` uses going `direction`, and how
   * far it is; null beyond reach.
   */
  stopOf(node: number, direction: 1 | -1): (StopSlot & { metres: number }) | null {
    const pass = this.passes.get(direction);
    const slot = pass && this.slots[pass.label[node] ?? -1];
    return slot ? { ...slot, metres: pass.dist[node]! } : null;
  }

  /** The directions the route is served in (one round a loop). */
  get directions(): Array<1 | -1> {
    return [...this.passes.keys()];
  }

  /** Every stop going `direction` whose waiting area is within `r` metres of `p`, straight. */
  slotsNear(p: LocalPoint, r: number, direction: 1 | -1): StopSlot[] {
    return this.slots.filter(
      (s) => s.direction === direction && Math.hypot(s.spot.x - p.x, s.spot.z - p.z) <= r,
    );
  }

  /** The street nodes from `node` to its way in to its stop going `direction`, and that way in. */
  private streetsTo(
    node: number,
    direction: 1 | -1,
  ): { nodes: number[]; way: readonly LocalPoint[] } | null {
    const pass = this.passes.get(direction);
    const slot = pass?.label[node] ?? -1;
    if (!pass || slot < 0) return null;
    const nodes: number[] = [];
    let n = node;
    for (; pass.prev[n]! >= 0; n = pass.prev[n]!) nodes.push(n);
    nodes.push(n);
    return { nodes, way: this.ways.get(slot * this.graph.size + n)! };
  }

  /**
   * The way from `node` to its stop going `direction`: along the streets in
   * `lane` (from `start` on the street first, when given), out onto the
   * stop's pavement and along it, then to `spot` (in going order). Null
   * beyond reach.
   */
  toStop(
    node: number,
    direction: 1 | -1,
    spot: LocalPoint,
    lane: Lane = 'right',
    start?: { at: LocalPoint; width: number },
  ): Point3[] | null {
    const s = this.streetsTo(node, direction);
    if (!s) return null;
    return [
      ...this.graph.wayAlong(s.nodes, lane, start),
      ...s.way.map((p): Point3 => [p.x, 0, p.z]),
      [spot.x, 0, spot.z],
    ];
  }

  /** The way from `from` (at the stop) to `node`: toStop, the other way round, in `lane` going that way. */
  fromStop(
    node: number,
    direction: 1 | -1,
    from: LocalPoint,
    lane: Lane = 'right',
  ): Point3[] | null {
    const s = this.streetsTo(node, direction);
    if (!s) return null;
    return [
      [from.x, 0, from.z],
      ...[...s.way].reverse().map((p): Point3 => [p.x, 0, p.z]),
      ...this.graph.wayAlong(s.nodes.reverse(), lane),
    ];
  }
}

/** The route's line sampled every `step` metres into cells of `size`. */
function sampleCells(route: Route, size: number, step: number): Map<string, LocalPoint[]> {
  const cells = new Map<string, LocalPoint[]>();
  const line = route.polyline;
  for (let s = 0; s <= line.length; s += step) {
    const p = line.pointAt(s);
    const key = `${Math.floor(p.x / size)},${Math.floor(p.z / size)}`;
    (cells.get(key) ?? cells.set(key, []).get(key)!).push(p);
  }
  return cells;
}

/**
 * Whether (x, z) is near the sampled route: in or beside a cell holding a
 * sample, and within `within` metres of one (Infinity: the cells are enough).
 */
function near(
  cells: Map<string, LocalPoint[]>,
  size: number,
  x: number,
  z: number,
  within: number,
): boolean {
  const cx = Math.floor(x / size);
  const cz = Math.floor(z / size);
  for (let dx = -1; dx <= 1; dx++)
    for (let dz = -1; dz <= 1; dz++) {
      const ps = cells.get(`${cx + dx},${cz + dz}`);
      if (!ps) continue;
      if (within === Infinity) return true;
      for (const p of ps) if (Math.hypot(p.x - x, p.z - z) <= within) return true;
    }
  return false;
}
