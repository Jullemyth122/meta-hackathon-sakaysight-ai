/**
 * The streets people walk (and tricycles drive) to a jeepney stop, from the
 * same vector tiles the 3D map is drawn from: so a commuter coming from home
 * follows a street you can see on the map.
 *
 * The roads people walk and tricycles run on: secondary and tertiary roads,
 * minor and service streets, tracks and footpaths. National roads (primary,
 * trunk) come too, marked: tricycles are barred from them and the jeepney
 * routes run on them, so the everyday crowd comes by the side streets
 * (streetGraph.ts), but someone setting out from a spot of their own walks
 * along a highway's pavement where no side street goes. Motorways are left
 * out: nobody walks the expressway. They are kept apart, with flyovers, ramps
 * and tunnels (`hazards`), to say where nobody can wait for a ride (riskAt).
 *
 * Runs in the tile workers (src/map/tileWorker.ts) when asked for streets
 * only; a pure function of its inputs, so testable in Node.
 */

import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import { createProjection, type LatLng, type LocalPoint } from '../geo/projection';
import { ROADS, roadClass, roadWidth } from './style';
import { tileToLocal, type TileId } from './tiles';

/** OpenMapTiles `transportation` classes people walk along to a stop. */
export const WALKABLE = new Set(['secondary', 'tertiary', 'minor', 'service', 'track', 'path']);
/** National roads: walked along their pavement only where no side street goes. */
export const NATIONAL = new Set(['primary', 'trunk']);

/** Roads nobody can stand by waiting for a ride. */
export const ROAD_RISKS = ['expressway', 'ramp', 'flyover', 'tunnel'] as const;
export type RoadRisk = (typeof ROAD_RISKS)[number];
/** A spot this close to a road of ROAD_RISKS (metres), and closer than to any other road, is on it. */
const ON_RISKY_ROAD_M = 25;

/**
 * Street lines in local metres, flattened for transfer between threads:
 * line k is points[2·starts[k] .. 2·starts[k+1]) as x, z pairs,
 * widths[k] metres wide kerb to kerb as the map draws it, and a national
 * road when national[k] is 1, unsafe to wait by when risky[k] is 1.
 */
export interface StreetLines {
  points: Float32Array;
  starts: Uint32Array;
  widths: Float32Array;
  national: Uint8Array;
  risky: Uint8Array;
  /** One way: 1 along the line's points, -1 against them, 0 both ways. */
  oneway?: Int8Array;
  /** A street for a jeepney: not a track, a footpath, or a car park's or a driveway's service road. */
  drivable?: Uint8Array;
  /** Lines of ROAD_RISKS, as above: each kinds[k] an index into ROAD_RISKS. */
  hazards: { points: Float32Array; starts: Uint32Array; kinds: Uint8Array };
}

/** A street's points, its width kerb to kerb when known (metres), and whether it is a national road. */
export type StreetLine = LocalPoint[] & {
  width?: number;
  national?: boolean;
  oneway?: number;
  drivable?: boolean;
};

const LINE = 2;
const POINT = 1;
/** OpenStreetMap's barriers across a street (poi layer): a subdivision's gate, a boom. */
const GATES = new Set(['gate', 'lift_gate']);
/**
 * A gate this close to a street (metres) is on it, across it: OpenStreetMap
 * puts a gate on the line it closes. Further off, it is a house's on its own
 * driveway, which closes nothing.
 */
const GATE_ON_M = 1.5;

/** Which of ROAD_RISKS a road of class `cls` is: -1 for an ordinary road. */
function riskOf(cls: string, properties: Record<string, unknown>): number {
  const fast = cls === 'motorway' || NATIONAL.has(cls);
  if (properties.brunnel === 'tunnel' && fast) return ROAD_RISKS.indexOf('tunnel');
  if (properties.ramp === 1 && fast) return ROAD_RISKS.indexOf('ramp');
  if (cls === 'motorway') return ROAD_RISKS.indexOf('expressway');
  return properties.brunnel === 'bridge' && fast ? ROAD_RISKS.indexOf('flyover') : -1;
}

/** Walkable street lines of one tile (none for a tile without a transportation layer). */
export function streetLines(buffer: ArrayBuffer, tile: TileId, origin: LatLng): StreetLines {
  const vt = new VectorTile(new PbfReader(new Uint8Array(buffer)));
  const layer = vt.layers.transportation;
  const coords: number[] = [];
  const starts: number[] = [0];
  const widths: number[] = [];
  const national: number[] = [];
  const risky: number[] = [];
  const oneways: number[] = [];
  const drivable: number[] = [];
  const hazardCoords: number[] = [];
  const hazardStarts: number[] = [0];
  const hazardKinds: number[] = [];
  if (layer) {
    const toLocal = tileToLocal(tile, layer.extent, createProjection(origin));
    for (let i = 0; i < layer.length; i++) {
      const f = layer.feature(i);
      if (f.type !== LINE) continue;
      const cls = roadClass(String(f.properties.class ?? ''));
      const risk = riskOf(cls, f.properties);
      if (risk >= 0)
        for (const line of f.loadGeometry()) {
          for (const p of line) {
            const q = toLocal(p.x, p.y);
            hazardCoords.push(q.x, q.z);
          }
          hazardStarts.push(hazardCoords.length / 2);
          hazardKinds.push(risk);
        }
      if (f.properties.brunnel === 'tunnel') continue;
      const major = NATIONAL.has(cls);
      if (!major && !WALKABLE.has(cls)) continue;
      const oneway = f.properties.oneway === 1 || f.properties.oneway === -1;
      const width = roadWidth(ROADS[cls]!, oneway);
      for (const line of f.loadGeometry()) {
        if (line.length < 2) continue;
        for (const p of line) {
          const q = toLocal(p.x, p.y);
          coords.push(q.x, q.z);
        }
        starts.push(coords.length / 2);
        widths.push(width);
        national.push(major ? 1 : 0);
        risky.push(risk >= 0 ? 1 : 0);
        oneways.push(oneway ? (f.properties.oneway as number) : 0);
        // Not for a jeepney: tracks, footpaths, service roads, and streets
        // OpenStreetMap marks private (access=no: a gated subdivision's).
        drivable.push(
          cls === 'track' || cls === 'path' || cls === 'service' || f.properties.access === 'no'
            ? 0
            : 1,
        );
      }
    }
    // A gate on a street closes it to a jeepney (a subdivision's, a guard's
    // boom); never a national road, which a gate beside it does not close.
    const gates: LocalPoint[] = [];
    const poi = vt.layers.poi;
    if (poi) {
      const toLocal = tileToLocal(tile, poi.extent, createProjection(origin));
      for (let i = 0; i < poi.length; i++) {
        const f = poi.feature(i);
        if (f.type !== POINT || !GATES.has(String(f.properties.class ?? ''))) continue;
        for (const ring of f.loadGeometry()) for (const g of ring) gates.push(toLocal(g.x, g.y));
      }
    }
    if (gates.length > 0)
      for (let k = 0; k + 1 < starts.length; k++) {
        if (drivable[k] === 0 || national[k] === 1) continue;
        for (let i = starts[k]!; i + 1 < starts[k + 1]! && drivable[k] === 1; i++) {
          const a = { x: coords[2 * i]!, z: coords[2 * i + 1]! };
          const b = { x: coords[2 * i + 2]!, z: coords[2 * i + 3]! };
          if (gates.some((g) => fromSegment(g, a, b) <= GATE_ON_M)) drivable[k] = 0;
        }
      }
  }
  return {
    points: new Float32Array(coords),
    starts: new Uint32Array(starts),
    widths: new Float32Array(widths),
    national: new Uint8Array(national),
    risky: new Uint8Array(risky),
    oneway: new Int8Array(oneways),
    drivable: new Uint8Array(drivable),
    hazards: {
      points: new Float32Array(hazardCoords),
      starts: new Uint32Array(hazardStarts),
      kinds: new Uint8Array(hazardKinds),
    },
  };
}

/** Metres from `p` to the segment `a`–`b`. */
function fromSegment(p: LocalPoint, a: LocalPoint, b: LocalPoint): number {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const t = Math.max(
    0,
    Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / (dx * dx + dz * dz || 1)),
  );
  return Math.hypot(a.x + t * dx - p.x, a.z + t * dz - p.z);
}

/** The lines of a StreetLines as point arrays, each with its width. */
export function* eachLine(s: StreetLines): Generator<StreetLine> {
  for (let k = 0; k + 1 < s.starts.length; k++) {
    const line: StreetLine = [];
    for (let i = s.starts[k]!; i < s.starts[k + 1]!; i++)
      line.push({ x: s.points[2 * i]!, z: s.points[2 * i + 1]! });
    line.width = s.widths[k];
    line.national = s.national[k] === 1;
    line.oneway = s.oneway?.[k] ?? 0;
    line.drivable = (s.drivable?.[k] ?? 1) === 1;
    yield line;
  }
}

/** A step this close to a one-way street (metres) is on it... */
const ON_ONE_WAY_M = 3;
/** ...and against it when it points this much the other way (cosine of the angle). */
const AGAINST_COS = -0.7;

/** Where `way` goes the wrong way down a one-way street: both ends of each such step. */
export function againstOneWay(
  way: readonly LocalPoint[],
  lines: readonly StreetLine[],
): LocalPoint[] {
  const oneWays = lines.filter((l) => l.oneway);
  const wrong: LocalPoint[] = [];
  for (let i = 0; i + 1 < way.length; i++) {
    const a = way[i]!;
    const b = way[i + 1]!;
    const steps = Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 10) || 1;
    for (let k = 0; k < steps; k++) {
      const p = {
        x: a.x + ((b.x - a.x) * (k + 0.5)) / steps,
        z: a.z + ((b.z - a.z) * (k + 0.5)) / steps,
      };
      if (oneWays.some((line) => goesAgainst(p, a, b, line))) {
        wrong.push(a, b);
        break;
      }
    }
  }
  return wrong;
}

function goesAgainst(p: LocalPoint, a: LocalPoint, b: LocalPoint, line: StreetLine): boolean {
  const stepM = Math.hypot(b.x - a.x, b.z - a.z);
  if (stepM === 0) return false;
  for (let i = 0; i + 1 < line.length; i++) {
    const u = line[i]!;
    const v = line[i + 1]!;
    const dx = v.x - u.x;
    const dz = v.z - u.z;
    const len2 = dx * dx + dz * dz;
    if (len2 === 0) continue;
    const t = Math.max(0, Math.min(1, ((p.x - u.x) * dx + (p.z - u.z) * dz) / len2));
    if (Math.hypot(p.x - u.x - t * dx, p.z - u.z - t * dz) > ON_ONE_WAY_M) continue;
    const cos = (((b.x - a.x) * dx + (b.z - a.z) * dz) * line.oneway!) / (stepM * Math.sqrt(len2));
    if (cos < AGAINST_COS) return true;
  }
  return false;
}

/** Metres from `p` to the nearest point of flat line `from` to `to` of `points`. */
function toLine(p: LocalPoint, points: Float32Array, from: number, to: number): number {
  let least = Infinity;
  for (let i = from; i + 1 < to; i++) {
    const ax = points[2 * i]!;
    const az = points[2 * i + 1]!;
    const ex = points[2 * i + 2]! - ax;
    const ez = points[2 * i + 3]! - az;
    const len2 = ex * ex + ez * ez;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - ax) * ex + (p.z - az) * ez) / len2)) : 0;
    least = Math.min(least, Math.hypot(ax + ex * t - p.x, az + ez * t - p.z));
  }
  return least;
}

/** A spot on a road goes this far past its edge (metres)… */
const PAST_THE_EDGE_M = 1;
/** …unless it is no wider than this: a path, to stand on (metres). */
const STOOD_ON_M = 3.5;
/** Out of one road can be into another, at a junction: this many tries. */
const OUT_TRIES = 4;

/**
 * `p`, or the nearest place off the road when it is on one, as the map draws
 * it: a pin dropped on a road belongs at its side.
 */
export function offRoads(parts: readonly StreetLines[], p: LocalPoint): LocalPoint {
  let at = p;
  for (let tries = 0; tries < OUT_TRIES; tries++) {
    let deepest = 0;
    let out: LocalPoint | null = null;
    for (const part of parts)
      for (const line of eachLine(part)) {
        const half = (line.width ?? 0) / 2;
        if (half * 2 <= STOOD_ON_M) continue;
        for (let i = 0; i + 1 < line.length; i++) {
          const a = line[i]!;
          const ex = line[i + 1]!.x - a.x;
          const ez = line[i + 1]!.z - a.z;
          const len2 = ex * ex + ez * ez;
          if (len2 === 0) continue;
          const t = Math.max(0, Math.min(1, ((at.x - a.x) * ex + (at.z - a.z) * ez) / len2));
          const fx = a.x + ex * t;
          const fz = a.z + ez * t;
          const d = Math.hypot(at.x - fx, at.z - fz);
          if (half - d <= deepest) continue;
          deepest = half - d;
          // Out the way it already lies from the middle; dead on it, to the right of the road.
          const len = Math.sqrt(len2);
          const nx = d > 1e-3 ? (at.x - fx) / d : -ez / len;
          const nz = d > 1e-3 ? (at.z - fz) / d : ex / len;
          out = { x: fx + nx * (half + PAST_THE_EDGE_M), z: fz + nz * (half + PAST_THE_EDGE_M) };
        }
      }
    if (!out) return at;
    at = out;
  }
  return at;
}

/** The side of a road: a point on its edge, and which way is along it and away from it. */
export interface RoadEdge {
  x: number;
  z: number;
  ux: number;
  uz: number;
  nx: number;
  nz: number;
}

/** A road this far from a spot (metres) is the one it stands by, at most. */
const ROAD_EDGE_LOOK_M = 80;

/** The edge of the road nearest `p`, on the side `p` is on; null with no road near. */
export function roadEdge(parts: readonly StreetLines[], p: LocalPoint): RoadEdge | null {
  let best: RoadEdge | null = null;
  let nearest = ROAD_EDGE_LOOK_M;
  for (const part of parts)
    for (const line of eachLine(part)) {
      const half = (line.width ?? 0) / 2;
      if (half * 2 <= STOOD_ON_M) continue;
      for (let i = 0; i + 1 < line.length; i++) {
        const a = line[i]!;
        const ex = line[i + 1]!.x - a.x;
        const ez = line[i + 1]!.z - a.z;
        const len2 = ex * ex + ez * ez;
        if (len2 === 0) continue;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * ex + (p.z - a.z) * ez) / len2));
        const fx = a.x + ex * t;
        const fz = a.z + ez * t;
        const d = Math.hypot(p.x - fx, p.z - fz);
        if (d - half >= nearest) continue;
        nearest = d - half;
        const len = Math.sqrt(len2);
        const nx = d > 1e-3 ? (p.x - fx) / d : -ez / len;
        const nz = d > 1e-3 ? (p.z - fz) / d : ex / len;
        best = {
          x: fx + nx * (half + PAST_THE_EDGE_M),
          z: fz + nz * (half + PAST_THE_EDGE_M),
          ux: ex / len,
          uz: ez / len,
          nx,
          nz,
        };
      }
    }
  return best;
}

/** Where a station stands: at the side of a road, and how much of the ground it takes. */
export interface StationFit extends RoadEdge {
  length: number;
  depth: number;
  /** How far it has moved back from the road's edge, and along the road (metres). */
  back: number;
  slide: number;
  /** How much of its full depth its canopy and pumps take: a shallower plot of the same lanes keeps 1. */
  lanes: number;
  /** How far it still runs on to a street (metres): 0 with room for it, more where there was none. */
  over: number;
}

/**
 * A lane this narrow (metres) is no street to keep off: most by a station are
 * its own driveways, which OpenStreetMap maps as service roads.
 */
const DRIVEWAY_M = 6;
/** A forecourt is checked for roads this often (metres)… */
const FIT_STEP_M = 4;
/** …and has this much of a road under it at most (metres). */
const FIT_OVER_M = 0.4;
/** Tried in turn, the first clear of every road: its full size first, then less. */
const FIT_SCALES = [1, 0.85, 0.7, 0.55, 0.45];
const FIT_SLIDES_M = [0, 8, -8, 16, -16, 26, -26, 36, -36];
const FIT_BACKS_M = [0, 3, 6, 10];
/** One vehicles drive through slides no further, and is cut no shorter than the last scale. */
const FIT_ON_SLIDE_M = 16;
const FIT_ON_SCALE = 0.6;
/** Its plot can be this much of its depth: at the last, the shop goes, the pump lanes stay. */
const FIT_ON_DEPTHS = [1, 0.8, 0.6];

/** The first and last point of a road stretch, and half the road's width. */
type Stretch = readonly [number, number, number, number, number];

/** How far the rectangle runs on to any of `roads` (metres), 0 when clear. */
function overRoads(roads: readonly Stretch[], e: RoadEdge, length: number, depth: number): number {
  let most = 0;
  for (let along = -length / 2; along <= length / 2 + 0.01; along += FIT_STEP_M)
    for (let inM = 0; inM <= depth + 0.01; inM += FIT_STEP_M) {
      const px = e.x + e.ux * along + e.nx * inM;
      const pz = e.z + e.uz * along + e.nz * inM;
      for (const [ax, az, bx, bz, half] of roads) {
        const ex = bx - ax;
        const ez = bz - az;
        const len2 = ex * ex + ez * ez;
        const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * ex + (pz - az) * ez) / len2)) : 0;
        most = Math.max(most, half - Math.hypot(ax + ex * t - px, az + ez * t - pz));
      }
    }
  return most;
}

/**
 * Where a station `length` by `depth` fits beside a road near `at`, clear of
 * every road the map draws: it slides along the road, moves back from it and
 * is smaller only as it has to, the full size wherever that fits. `on`: the
 * road vehicles drive in from, so it stays deep enough for its pumps and close
 * to that point. Null with no road near.
 */
export function stationFit(
  parts: readonly StreetLines[],
  at: LocalPoint,
  on: RoadEdge | undefined,
  length: number,
  depth: number,
): StationFit | null {
  const start = on ?? roadEdge(parts, at);
  if (!start) return null;
  const reach = length + depth + 40;
  const roads: Stretch[] = [];
  for (const part of parts)
    for (const line of eachLine(part)) {
      const half = (line.width ?? 0) / 2;
      if (half * 2 <= DRIVEWAY_M) continue;
      for (let i = 0; i + 1 < line.length; i++) {
        const a = line[i]!;
        const b = line[i + 1]!;
        if (Math.hypot(a.x - start.x, a.z - start.z) > reach + Math.hypot(b.x - a.x, b.z - a.z))
          continue;
        roads.push([a.x, a.z, b.x, b.z, half]);
      }
    }
  let best: StationFit | null = null;
  let least = Infinity;
  const scales = on ? FIT_SCALES.filter((k) => k >= FIT_ON_SCALE) : FIT_SCALES;
  const slides = on ? FIT_SLIDES_M.filter((m) => Math.abs(m) <= FIT_ON_SLIDE_M) : FIT_SLIDES_M;
  for (const scale of scales)
    for (const slide of slides)
      for (const back of FIT_BACKS_M)
        for (const deep of on ? FIT_ON_DEPTHS : [scale]) {
          const fit: StationFit = {
            ...start,
            x: start.x + start.ux * slide + start.nx * back,
            z: start.z + start.uz * slide + start.nz * back,
            length: length * scale,
            depth: depth * deep,
            back,
            slide,
            lanes: on ? 1 : scale,
            over: 0,
          };
          const over = overRoads(roads, fit, fit.length, fit.depth);
          fit.over = Math.max(0, over);
          if (over <= FIT_OVER_M) return fit;
          if (over < least) [least, best] = [over, fit];
        }
  return best;
}

/** What makes `p` no place to wait for a ride, or null when nothing does. */
export function riskAt(parts: readonly StreetLines[], p: LocalPoint): RoadRisk | null {
  let plain = Infinity;
  let nearest = Infinity;
  let kind = 0;
  for (const s of parts) {
    for (let k = 0; k + 1 < s.starts.length; k++)
      if (s.risky[k] !== 1)
        plain = Math.min(plain, toLine(p, s.points, s.starts[k]!, s.starts[k + 1]!));
    const { points, starts, kinds } = s.hazards;
    for (let k = 0; k + 1 < starts.length; k++) {
      const d = toLine(p, points, starts[k]!, starts[k + 1]!);
      if (d < nearest) [nearest, kind] = [d, kinds[k]!];
    }
  }
  return nearest <= ON_RISKY_ROAD_M && nearest < plain ? ROAD_RISKS[kind]! : null;
}
