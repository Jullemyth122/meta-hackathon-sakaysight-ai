/**
 * A way round traffic that a driver would really take: on from where they
 * are, off the road at a junction on their own side, along streets a jeepney
 * fits, never against a one-way, and back onto the same road further on, on
 * the same side. So it never crosses the road, turns back, or cuts through a
 * block, and it comes back before the stop anyone on board is getting off at:
 * riders are the point of the trip. It has to save real time, and be about as
 * direct as the road. Otherwise there is no way round, and it says so.
 *
 * A pure function of the streets and the road ahead (map/streetWayWorker.ts).
 */

import type { LocalPoint } from '../geo/projection';
import { againstOneWay, type StreetLine } from '../map/streets';
import { EDGE, type StreetGraph } from './streetGraph';

/** Closer than this to the line of the road, a node is on the road (metres). */
const ON_ROAD_M = 14;
/** Nodes this far to the wrong side are over the road: never gone through (metres). */
const OVER_THE_ROAD_M = 250;
/** Not off the road sooner than this: there is no turning at the last second (metres). */
const LEAVE_FROM_M = 30;
/** Junctions tried, nearest first. */
const MOST_LEAVES = 40;
/** Off the road for at least this much of it (metres). */
const SHORTEST_M = 200;
/** At most this many times the road it replaces, and this far in all. */
const MOST_DETOUR = 1.5;
const LONGEST_M = 2500;
/** Side streets, stops and all (km/h). */
const SIDE_STREET_KMH = 20;
/** Each turn off and back on the road (seconds). */
const TURN_S = 15;
/** Worth a driver leaving the road for this much saved (seconds). */
const SAVES_AT_LEAST_S = 60;
/** Cells of the index of the road (metres). */
const CELL_M = 50;

export interface RoundAsk {
  /** The road ahead, a point every `stepM`, from where the vehicle is. */
  road: LocalPoint[];
  stepM: number;
  /** Traffic on it, in metres ahead, and its speed. */
  jam: { fromM: number; toM: number; mps: number };
  /** The vehicle's pace on a clear stretch (m/s). */
  paceMps: number;
  /** The first stop someone on board gets off at (metres ahead): it comes back before it. */
  stopAtM: number;
}

export interface Round {
  points: LocalPoint[];
  /** Of those, the side streets alone: off the road and not yet back on it. */
  street: LocalPoint[];
  /** Off the road and back on, in metres ahead. */
  leaveM: number;
  rejoinM: number;
  /** Along the side streets. */
  metres: number;
  minutes: number;
  /** The same stretch by the road, in this traffic. */
  roadMinutes: number;
}

export interface RoundAnswer {
  round: Round | null;
  /**
   * Other ways round, each leaving or rejoining the road somewhere else, best
   * first: for weighing against the best one (fares on the way, diesel). Each
   * is back before the riders' stop, and at most ALTERNATIVE_SLOWER_S slower
   * than staying on the road.
   */
  others?: Round[];
  /** There was a way, but past the stop riders are getting off at. */
  skipsTheirStop: boolean;
}

/** Other ways are offered up to this much slower than the road (seconds). */
const ALTERNATIVE_SLOWER_S = 120;
/** At most this many of them: with the best and the road itself, three ways to weigh. */
const MOST_OTHERS = 1;
/** Another way leaves or rejoins the road at least this far from each one offered (metres). */
const ANOTHER_WAY_M = 120;

interface Place {
  /** Metres ahead along the road. */
  along: number;
  /** Metres from its line; positive on the right, the driver's own side. */
  off: number;
}

/** Each node's place against the road, for those near it. */
function placesOn(g: StreetGraph, { road, stepM }: RoundAsk): Map<number, Place> {
  const cells = new Map<string, number[]>();
  const key = (x: number, z: number) => `${Math.floor(x / CELL_M)},${Math.floor(z / CELL_M)}`;
  const reach = Math.ceil(OVER_THE_ROAD_M / CELL_M);
  road.forEach((p, i) => {
    const list = cells.get(key(p.x, p.z));
    if (list) list.push(i);
    else cells.set(key(p.x, p.z), [i]);
  });
  const places = new Map<number, Place>();
  for (let n = 0; n < g.size; n++) {
    const x = g.x[n]!;
    const z = g.z[n]!;
    let best = -1;
    let bestD = Infinity;
    const cx = Math.floor(x / CELL_M);
    const cz = Math.floor(z / CELL_M);
    for (let i = cx - reach; i <= cx + reach; i++)
      for (let j = cz - reach; j <= cz + reach; j++)
        for (const k of cells.get(`${i},${j}`) ?? []) {
          const d = Math.hypot(road[k]!.x - x, road[k]!.z - z);
          if (d < bestD) [best, bestD] = [k, d];
        }
    if (best < 0 || bestD > OVER_THE_ROAD_M) continue;
    const a = road[Math.max(0, best - 1)]!;
    const b = road[Math.min(road.length - 1, best + 1)]!;
    const right = -(b.z - a.z) * (x - a.x) + (b.x - a.x) * (z - a.z);
    places.set(n, { along: best * stepM, off: right >= 0 ? bestD : -bestD });
  }
  return places;
}

/** The time by the road between two points of it, with its traffic (seconds). */
export function roadSeconds(ask: RoundAsk, from: number, to: number): number {
  const { jam, paceMps } = ask;
  const inJam = Math.max(0, Math.min(to, jam.toM) - Math.max(from, jam.fromM));
  return (to - from - inJam) / paceMps + inJam / jam.mps;
}

export function wayRound(g: StreetGraph, lines: readonly StreetLine[], ask: RoundAsk): RoundAnswer {
  const places = placesOn(g, ask);
  const onRoad = (n: number) => {
    const p = places.get(n);
    return p !== undefined && Math.abs(p.off) <= ON_ROAD_M;
  };
  const overTheRoad = (n: number) => (places.get(n)?.off ?? 0) < -ON_ROAD_M;
  const oneWays = lines.filter((l) => l.oneway);
  const pointOf = (n: number) => ({ x: g.x[n]!, z: g.z[n]! });
  const wrongWay = (a: number, b: number) =>
    againstOneWay([pointOf(a), pointOf(b)], oneWays).length > 0;

  /** Junctions on the road ahead with a street off it on the driver's side. */
  const leaves = [...places]
    .filter(([n, p]) => {
      if (!onRoad(n) || p.along < LEAVE_FROM_M || p.along >= ask.jam.toM) return false;
      const edges = g.edges(n);
      for (let k = 0; k < edges.length; k += EDGE) {
        const off = places.get(edges[k]!)?.off ?? 0;
        if (off > ON_ROAD_M) return true;
      }
      return false;
    })
    .sort((a, b) => a[1].along - b[1].along)
    .slice(0, MOST_LEAVES);

  /** Every way that would do, kept light: built into a Round only if offered. */
  const found: Array<{
    saves: number;
    sideS: number;
    leaveM: number;
    rejoinM: number;
    metres: number;
    end: number;
    prev: Map<number, number>;
  }> = [];
  let skipsTheirStop = false;

  for (const [leave, { along: leaveM }] of leaves) {
    const dist = new Map<number, number>([[leave, 0]]);
    const prev = new Map<number, number>();
    const queue: Array<[number, number]> = [];
    const edgesOf = g.edges(leave);
    for (let k = 0; k < edgesOf.length; k += EDGE) {
      const m = edgesOf[k]!;
      if ((places.get(m)?.off ?? 0) <= ON_ROAD_M || wrongWay(leave, m)) continue;
      dist.set(m, edgesOf[k + 1]!);
      prev.set(m, leave);
      queue.push([edgesOf[k + 1]!, m]);
    }
    while (queue.length > 0) {
      queue.sort((a, b) => b[0] - a[0]);
      const [d, n] = queue.pop()!;
      if (d > dist.get(n)!) continue;
      const edges = g.edges(n);
      for (let k = 0; k < edges.length; k += EDGE) {
        const m = edges[k]!;
        const nd = d + edges[k + 1]!;
        if (nd > LONGEST_M || nd >= (dist.get(m) ?? Infinity)) continue;
        if (overTheRoad(m) || wrongWay(n, m)) continue;
        dist.set(m, nd);
        prev.set(m, n);
        if (onRoad(m)) continue; // back on the road: as far as this way goes
        queue.push([nd, m]);
      }
    }
    for (const [n, metres] of dist) {
      if (n === leave || !onRoad(n)) continue;
      const rejoinM = places.get(n)!.along;
      const overM = rejoinM - leaveM;
      if (overM < SHORTEST_M || metres > MOST_DETOUR * overM) continue;
      const sideS = metres / (SIDE_STREET_KMH / 3.6) + 2 * TURN_S;
      const saves = roadSeconds(ask, leaveM, rejoinM) - sideS;
      if (saves < -ALTERNATIVE_SLOWER_S) continue;
      if (rejoinM > ask.stopAtM) {
        if (saves >= SAVES_AT_LEAST_S) skipsTheirStop = true;
        continue;
      }
      found.push({ saves, sideS, leaveM, rejoinM, metres, end: n, prev });
    }
  }

  const build = (w: (typeof found)[number]): Round => {
    const nodes: number[] = [];
    for (let at: number | undefined = w.end; at !== undefined; at = w.prev.get(at)) nodes.push(at);
    const onTheRoad = ask.road.slice(0, Math.floor(w.leaveM / ask.stepM) + 1);
    nodes.reverse();
    return {
      points: [...onTheRoad, ...nodes.map(pointOf)],
      street: nodes.filter((m) => !onRoad(m)).map(pointOf),
      leaveM: w.leaveM,
      rejoinM: w.rejoinM,
      metres: w.metres,
      minutes: Math.round(w.sideS / 6) / 10,
      roadMinutes: Math.round(roadSeconds(ask, w.leaveM, w.rejoinM) / 6) / 10,
    };
  };
  found.sort((a, b) => b.saves - a.saves);
  const first = found[0];
  const best = first && first.saves >= SAVES_AT_LEAST_S ? first : null;
  // Others leave or rejoin somewhere else than every way already offered.
  const offered = best ? [best] : [];
  for (const w of found) {
    if (offered.length >= (best ? 1 : 0) + MOST_OTHERS) break;
    const apart = offered.every(
      (o) =>
        Math.abs(o.leaveM - w.leaveM) >= ANOTHER_WAY_M ||
        Math.abs(o.rejoinM - w.rejoinM) >= ANOTHER_WAY_M,
    );
    if (apart) offered.push(w);
  }
  const others = offered.filter((w) => w !== best).map(build);
  return { round: best ? build(best) : null, others, skipsTheirStop };
}
