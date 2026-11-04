/**
 * Trips across the network, from anywhere to anywhere: walk to a stop, ride
 * a jeepney (or two, with a short walk between), walk to where you are going.
 *
 * Like a commuter thinks about it: a direct jeepney if there is one, else
 * one change; no more (two changes is a different trip, by bus or train).
 * Each option gets its time door to door, its fares, and the next jeepney
 * with seats, from the live twin on the focused route and the flows
 * elsewhere.
 */

import { FARE_BY_VEHICLE, fareFor } from '../fare';
import type { LocalPoint } from '../geo/projection';
import { aheadOf, stopsAhead, type Route } from '../geo/routes';
import type { Network } from './network';
import { flowSpeedKmh } from './flow';
import { roadsideBoardings, YOUR_SPOT, type Roadside } from './roadside';

/** Walking to or from a stop, at most (metres). Further is a tricycle ride. */
export const WALK_TO_STOP_M = 700;
/**
 * A waiting area the commuter chose: the stops this close to it are it
 * (metres). Two routes' stops of one name can stand a few hundred metres apart.
 */
export const WAITING_AREA_M = 350;
/** Walking between two stops to change jeepneys, at most (metres). */
export const TRANSFER_WALK_M = 250;
/**
 * Further than a walk from any stop, a tricycle takes you to one, up to this
 * far (metres): the tricycle's job in the Philippines, door to the highway.
 */
export const TRICYCLE_M = 3000;
/** Tricycle: waiting at the line, then about 15 km/h on local streets, 1.3× the straight line. */
const TRICYCLE_WAIT_S = 180;
const TRICYCLE_MPS = 15 / 3.6;
const ROAD_FACTOR = 1.3;
const WALK_MPS = 1.2;
/**
 * Boarding stops considered per route near the start, each way it runs: the
 * nearest ones. Its two ways often pass within metres of each other (the
 * two sides of one road), and only one of them goes where you are going.
 */
const BOARD_STOPS_PER_ROUTE = 2;
/** Options returned. */
const MAX_OPTIONS = 3;
/** A change of jeepney is offered only if it beats riding straight through by this much. */
const TRANSFER_MUST_SAVE_S = 300;
/**
 * Arrivals at one stop are looked up once for this long of a trip's time
 * (seconds). A plan tries every stop against every other, over a million
 * lookups of the same few, which took the page minutes.
 */
const ARRIVALS_KEPT_S = 60;
/** Of the headway, the wait for a jeepney whose arrival is not looked up (on average, half). */
const ROUGH_WAIT_SHARE = 0.5;

export interface Arrival {
  plate: string;
  etaS: number;
  freeSeats: number;
  vehicle: number;
}

/** The next jeepneys of route r at stop i, at clock t (seconds), soonest first. */
export type ArrivalsAt = (route: number, stop: number, t: number) => Arrival[];

export interface Leg {
  route: number;
  routeName: string;
  board: number;
  boardName: string;
  alight: number;
  alightName: string;
  rideM: number;
  rideS: number;
  waitS: number;
  /** The jeepney to take: the first coming with an estimated free seat, else the first. */
  jeepney: Arrival | null;
  /** Boarding right where they chose, by the road, before stop `board`. */
  flag?: Roadside;
  fare: number;
  fareDiscounted: number;
  /**
   * Other routes that do this same ride (from near the same stop to near the
   * same place): a commuter takes whichever comes first.
   */
  alsoBy: string[];
}

/** How someone gets between a stop and where they are: on foot, or by tricycle. */
export type Access = 'walk' | 'tricycle';

export interface TripOption {
  legs: Leg[];
  /** To the first stop: metres (straight line) and how. */
  walkToM: number;
  toBy: Access;
  transferWalkM: number;
  /** From the last stop. */
  walkFromM: number;
  fromBy: Access;
  totalS: number;
  fare: number;
  fareDiscounted: number;
}

interface Candidate {
  route: number;
  stop: number;
  walkM: number;
  flag?: Roadside;
}

/** Which way along its loop stop `i` is: out to its far terminal (0), or back (1). */
function wayOf(route: Route, i: number): 0 | 1 {
  const far = route.stops.findIndex((s, k) => k > 0 && s.terminal);
  return far > 0 && i >= far ? 1 : 0;
}

/** Nearest boarding stops per route and way, at most BOARD_STOPS_PER_ROUTE each. */
function perRoute(list: ReadonlyArray<Candidate>, routes: readonly Route[]): Candidate[] {
  const count = new Map<string, number>();
  const out: Candidate[] = [];
  for (const c of list) {
    const key = `${c.route}:${wayOf(routes[c.route]!, c.stop)}`;
    const n = count.get(key) ?? 0;
    if (n >= BOARD_STOPS_PER_ROUTE) continue;
    count.set(key, n + 1);
    out.push(c);
  }
  return out;
}

/**
 * The cheapest way of going among `best`, sorted by time: a few minutes can
 * be worth less than the pesos. The fastest at that fare (`all` is sorted),
 * in place of the slowest kept when there is no room. Only a line not offered
 * already: the same jeepney to an earlier stop is cheaper, but not where
 * they are going.
 */
export function keepCheapest(best: TripOption[], all: readonly TripOption[]): void {
  const lines = (o: TripOption) => o.legs.map((l) => l.route).join('>');
  const offered = new Set(best.map(lines));
  const alsoBy = best.flatMap((o) => o.legs.at(-1)!.alsoBy);
  const cheapest = all
    .filter((o) => !offered.has(lines(o)) && !alsoBy.includes(o.legs.at(-1)!.routeName))
    .reduce<TripOption | null>((low, o) => (low === null || o.fare < low.fare ? o : low), null);
  if (!cheapest || best.some((o) => o.fare <= cheapest.fare)) return;
  if (best.length === MAX_OPTIONS) best.pop();
  best.push(cheapest);
  best.sort((x, y) => x.totalS - y.totalS);
}

export function planTrips(
  network: Network,
  from: LocalPoint,
  to: LocalPoint,
  clockS: number,
  arrivalsAt: ArrivalsAt,
  /** How they go to the first stop, when they have said (else walking if near, as most do). */
  toBy?: Access,
  /**
   * The waiting area they chose (a stop, or a spot by the road): they board
   * there, coming from `from` (home), rather than at the stops near home.
   * Right there when a route passes it; else at the stops around it.
   */
  via?: LocalPoint,
): TripOption[] {
  if (via) {
    const walkM = Math.hypot(via.x - from.x, via.z - from.z);
    const here = network.routes.flatMap(({ route }, r) =>
      roadsideBoardings(route, via).map(({ stop, flag }): Candidate => ({
        route: r,
        stop,
        walkM,
        ...(flag && { flag }),
      })),
    );
    const found = plan(network, from, to, clockS, arrivalsAt, toBy, via, here);
    if (found.length > 0) return found;
  }
  return plan(network, from, to, clockS, arrivalsAt, toBy, via, []);
}

function plan(
  network: Network,
  from: LocalPoint,
  to: LocalPoint,
  clockS: number,
  arrivalsAt: ArrivalsAt,
  toBy: Access | undefined,
  via: LocalPoint | undefined,
  /** Boarding right at the waiting area; none: at the stops around it. */
  here: readonly Candidate[],
): TripOption[] {
  const routes = network.routes.map((r) => r.route);
  const speed = flowSpeedKmh((clockS / 3600) % 24) / 3.6;
  // Stops within a walk; if there are none, within a tricycle ride. Gone
  // the way they said, when they said.
  const reach = (
    p: LocalPoint,
    by?: Access,
  ): { by: Access; stops: ReturnType<typeof network.stops.near> } => {
    const walk = network.stops.near(p, WALK_TO_STOP_M);
    const stops = walk.length > 0 ? walk : network.stops.near(p, TRICYCLE_M);
    return { by: by ?? (walk.length > 0 ? 'walk' : 'tricycle'), stops };
  };
  const access = (m: number, by: Access) =>
    by === 'walk' ? m / WALK_MPS : TRICYCLE_WAIT_S + (m * ROAD_FACTOR) / TRICYCLE_MPS;
  const origin = via
    ? (() => {
        // At the waiting area chosen: its stops, and the way to them is from home.
        const stops = network.stops.near(via, WAITING_AREA_M).map((st) => ({
          ...st,
          distanceM: Math.hypot(st.x - from.x, st.z - from.z),
        }));
        const nearest = Math.min(here[0]?.walkM ?? Infinity, ...stops.map((st) => st.distanceM));
        return {
          by: toBy ?? (nearest <= WALK_TO_STOP_M ? 'walk' : 'tricycle'),
          stops: stops.sort((a, b) => a.distanceM - b.distanceM),
        } as ReturnType<typeof reach>;
      })()
    : reach(from, toBy);
  const destination = reach(to);
  const starts =
    here.length > 0
      ? here
      : perRoute(
          origin.stops.map((s) => ({ route: s.route, stop: s.stop, walkM: s.distanceM })),
          routes,
        );
  // Where each route can drop us within reach of the destination.
  const ends = new Map<number, Map<number, number>>();
  for (const s of destination.stops) {
    const m = ends.get(s.route) ?? new Map<number, number>();
    if (!m.has(s.stop)) m.set(s.stop, s.distanceM);
    ends.set(s.route, m);
  }

  const arrivals = new Map<string, Arrival[]>();
  const comingAt = (route: number, stop: number, atS: number): Arrival[] => {
    const key = `${route}:${stop}:${Math.round(atS / ARRIVALS_KEPT_S)}`;
    let coming = arrivals.get(key);
    if (!coming) arrivals.set(key, (coming = arrivalsAt(route, stop, atS)));
    return coming;
  };

  /**
   * One ride. `roughly`: half the headway for the wait, no jeepney named, for
   * comparing the many trips with a change; the ones kept get the real next
   * jeepney at the end.
   */
  const leg = (
    route: number,
    board: number,
    alight: number,
    atS: number,
    roughly = false,
    flag?: Roadside,
  ): Leg => {
    const r = routes[route]!;
    const rideM = aheadOf(r, flag?.s ?? r.stops[board]!.s, r.stops[alight]!.s);
    // By the road, it reaches them before it reaches the stop; those past them are gone.
    const soonerS = flag ? aheadOf(r, flag.s, r.stops[board]!.s) / speed : 0;
    const coming = (roughly ? [] : comingAt(route, board, atS))
      .map((a) => ({ ...a, etaS: a.etaS - soonerS }))
      .filter((a) => a.etaS >= 0);
    const jeepney = coming.find((a) => a.freeSeats > 0) ?? coming[0] ?? null;
    const km = rideM / 1000;
    return {
      route,
      routeName: r.name,
      board,
      boardName: flag ? YOUR_SPOT : r.stops[board]!.name,
      alight,
      alightName: r.stops[alight]!.name,
      rideM,
      rideS: rideM / speed,
      waitS:
        jeepney?.etaS ?? network.routes[route]!.meta.headwayS * (roughly ? ROUGH_WAIT_SHARE : 1),
      jeepney,
      fare: fareFor(km, false, FARE_BY_VEHICLE[network.routes[route]!.route.kind ?? 'jeepney']),
      fareDiscounted: fareFor(
        km,
        true,
        FARE_BY_VEHICLE[network.routes[route]!.route.kind ?? 'jeepney'],
      ),
      alsoBy: [],
      ...(flag && { flag }),
    };
  };

  // A stop's neighbours and what lies ahead of it, each worked out once: many
  // boarding stops share the road ahead, and the routes crossing it.
  const crossing = new Map<string, ReturnType<typeof network.stops.near>>();
  const crossingAt = (route: number, stop: number) => {
    const key = `${route}:${stop}`;
    let near = crossing.get(key);
    if (!near) {
      const r = routes[route]!;
      near = network.stops.near(r.polyline.pointAt(r.stops[stop]!.s), TRANSFER_WALK_M);
      crossing.set(key, near);
    }
    return near;
  };
  const onward = new Map<string, number[]>();
  const onwardOf = (route: number, stop: number) => {
    const key = `${route}:${stop}`;
    let ahead = onward.get(key);
    if (!ahead) {
      // Only where this route can drop us near the destination.
      const end = ends.get(route);
      ahead = stopsAhead(routes[route]!, stop, 1).filter((j) => end?.has(j));
      onward.set(key, ahead);
    }
    return ahead;
  };

  const options: TripOption[] = [];
  const option = (
    legs: Leg[],
    walkToM: number,
    transferWalkM: number,
    walkFromM: number,
  ): TripOption => ({
    legs,
    walkToM,
    toBy: origin.by,
    transferWalkM,
    walkFromM,
    fromBy: destination.by,
    totalS:
      access(walkToM, origin.by) +
      transferWalkM / WALK_MPS +
      access(walkFromM, destination.by) +
      legs.reduce((sum, l) => sum + l.waitS + l.rideS, 0),
    fare: legs.reduce((sum, l) => sum + l.fare, 0),
    fareDiscounted: legs.reduce((sum, l) => sum + l.fareDiscounted, 0),
  });

  // Walking there beats any jeepney for a short trip.
  const direct = Math.hypot(to.x - from.x, to.z - from.z);

  for (const start of starts) {
    const atStop = clockS + access(start.walkM, origin.by);
    const ahead = stopsAhead(routes[start.route]!, start.stop, 1);
    // Direct: the same jeepney all the way.
    const endsHere = ends.get(start.route);
    if (endsHere)
      for (const j of ahead) {
        const walkFrom = endsHere.get(j);
        if (walkFrom === undefined) continue;
        options.push(
          option(
            [leg(start.route, start.stop, j, atStop, false, start.flag)],
            start.walkM,
            0,
            walkFrom,
          ),
        );
      }
  }
  // A change has to beat riding straight through: anything else can go now,
  // not after sorting the million or so a busy downtown trip can make.
  const beat =
    options.reduce((fastest, o) => Math.min(fastest, o.totalS), Infinity) - TRANSFER_MUST_SAVE_S;
  for (const start of starts) {
    const atStop = clockS + access(start.walkM, origin.by);
    const ahead = stopsAhead(routes[start.route]!, start.stop, 1);
    // One change: ride to a stop near another route that ends near the destination.
    for (const a of ahead) {
      let first: Leg | null = null;
      for (const b of crossingAt(start.route, a)) {
        if (b.route === start.route) continue;
        const endsThere = ends.get(b.route);
        if (!endsThere) continue;
        for (const j of onwardOf(b.route, b.stop)) {
          const walkFrom = endsThere.get(j)!;
          first ??= leg(start.route, start.stop, a, atStop, false, start.flag);
          const atSecond = atStop + first.waitS + first.rideS + b.distanceM / WALK_MPS;
          const two = option(
            [first, leg(b.route, b.stop, j, atSecond, true)],
            start.walkM,
            b.distanceM,
            walkFrom,
          );
          if (two.totalS <= beat) options.push(two);
        }
      }
    }
  }

  // The best few, fastest first. Options that are the same trip by other
  // routes are one option, "or any of …": a commuter takes whichever jeepney
  // comes first. Direct: the same boarding stop. With a change: the same
  // first ride, then any route for the second. A change of jeepney has to
  // save real time over riding straight through.
  options.sort((x, y) => x.totalS - y.totalS);
  const fastestDirect = options.find((o) => o.legs.length === 1)?.totalS ?? Infinity;
  const kept = new Map<string, TripOption>();
  const best: TripOption[] = [];
  // The same two jeepneys, only changing at another stop, is the same trip.
  const sameJeepneys = (a: TripOption, b: TripOption) =>
    a.legs.length === 2 &&
    b.legs.length === 2 &&
    a.legs.every((l, k) => {
      const m = b.legs[k]!;
      return (
        l.route === m.route &&
        (k === 0 ? l.board === m.board : l.jeepney?.plate === m.jeepney?.plate)
      );
    });
  for (const o of options) {
    if (o.legs.length > 1 && o.totalS > fastestDirect - TRANSFER_MUST_SAVE_S) continue;
    if (best.some((b) => sameJeepneys(b, o))) continue;
    const first = o.legs[0]!;
    const key =
      o.legs.length === 1
        ? `direct:${first.boardName}`
        : `change:${first.route}:${first.board}:${first.alight}`;
    const same = kept.get(key);
    if (same) {
      const leg = same.legs.at(-1)!;
      const other = o.legs.at(-1)!;
      if (other.route !== leg.route && !leg.alsoBy.includes(other.routeName))
        leg.alsoBy.push(other.routeName);
      continue;
    }
    // The same jeepney line from a stop further on is only a longer walk.
    if (
      o.legs.length === 1 &&
      best.some(
        (b) =>
          b.legs.length === 1 &&
          (b.legs[0]!.route === first.route || b.legs[0]!.alsoBy.includes(first.routeName)),
      )
    )
      continue;
    if (best.length === MAX_OPTIONS) continue;
    kept.set(key, o);
    best.push(o);
  }
  // A route met first from a further stop can turn out to do another option's
  // ride after all: one option, not two.
  for (let i = best.length - 1; i > 0; i--) {
    const { legs } = best[i]!;
    if (
      legs.length === 1 &&
      best
        .slice(0, i)
        .some((b) => b.legs.length === 1 && b.legs[0]!.alsoBy.includes(legs[0]!.routeName))
    )
      best.splice(i, 1);
  }
  // A jeepney all the way is always among them when there is one: no change,
  // no second fare, even if changing could be a little faster.
  const straight = options.find((o) => o.legs.length === 1);
  if (straight && !best.some((o) => o.legs.length === 1)) {
    if (best.length === MAX_OPTIONS) best.pop();
    best.push(straight);
    best.sort((x, y) => x.totalS - y.totalS);
  }
  keepCheapest(best, options);
  // The second jeepney of the trips kept, for real now.
  const exact = best
    .map((o) => {
      if (o.legs.length === 1) return o;
      const [one, two] = o.legs as [Leg, Leg];
      const atSecond =
        clockS + access(o.walkToM, o.toBy) + one.waitS + one.rideS + o.transferWalkM / WALK_MPS;
      const second = leg(two.route, two.board, two.alight, atSecond);
      return option(
        [one, { ...second, alsoBy: two.alsoBy }],
        o.walkToM,
        o.transferWalkM,
        o.walkFromM,
      );
    })
    .sort((x, y) => x.totalS - y.totalS);
  return direct < WALK_TO_STOP_M ? exact.filter((o) => o.totalS < direct / WALK_MPS) : exact;
}
