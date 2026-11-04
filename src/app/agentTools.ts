/**
 * The Sakay Agent's hands (core/agent/tools.ts): each tool reads the live
 * twin or acts on the app, and returns what Muse may say. They run here, in
 * the browser, because that is where the twin is.
 */

import { dispatch } from '@/core/advisory/dispatch';
import { driverView } from '@/core/advisory/driver';
import { ADVISORY, distanceTo, litresPerKm } from '@/core/advisory/model';
import { boardGoesTo } from '@/core/agent/board';
import {
  handOver,
  lateRiders,
  leaveOrWait,
  nextRides,
  seatsForNextStops,
  trafficAhead,
  vehiclesAhead,
  waitForRiders,
  walkOrStay,
  whoIsWaiting,
} from '@/core/agent/road';
import { commuterView } from '@/core/advisory/commuter';
import { fuelPlan } from '@/core/fuel/plan';
import { DIESEL_WEEK, fuelAhead, stationsFor } from '@/core/fuel/stations';
import type { LocalPoint } from '@/core/geo/projection';
import { planTrips, type TripOption } from '@/core/network/plan';
import { searchPlaces, type Place } from '@/core/network/search';
import { newRiderPose } from '@/core/people/riderMotion';
import { curveWay } from '@/core/geo/curveWay';
import { Polyline } from '@/core/geo/polyline';
import { roadSeconds, type Round, type RoundAsk } from '@/core/people/wayRound';
import { discountedKind, FARE_BY_VEHICLE, fareFor } from '@/core/fare';
import { fleetPose, kerbLanePose } from '@/scene/world/lanes';
import { FUEL, stopsByTheRoad } from '@/core/vehicles/specs';
import type { ToolRunner } from '@/net/agent';
import { boundaryLeft } from './earnings';
import { arrivalsAt, getNetwork, loadPlaces } from './network';
import { phonesNear } from './phonesNear';
import { useApp } from './store';
import { findRound } from './streetWays';
import { legsOf, takeTrip, tripPoints } from './trips';
import { twinState } from './twinState';
import type { TwinRuntime } from './twinRuntime';

/** How far ahead a way round is looked for, and how closely the road is followed (metres). */
const ROUND_LOOK_M = 2400;
const ROUND_STEP_M = 10;
/** Slow road with no jam known of: this much of it, this many times slower. */
const SLOW_ROAD_M = 800;
/** A station or a rider this close to the way is on it (metres). */
const BY_THE_WAY_M = 120;
const ON_THE_WAY_RIDER_M = 80;

const min = (s: number) => Math.round(s / 6) / 10;
const near = (a: LocalPoint, b: LocalPoint) => Math.hypot(a.x - b.x, a.z - b.z);
const nearestOn = (way: readonly LocalPoint[], p: LocalPoint) =>
  Math.min(...way.map((q) => near(p, q)));

/** Find `name` among the places, the one by the route on the map first. */
async function placeNamed(twin: TwinRuntime, name: string): Promise<Place | null> {
  const places = await loadPlaces();
  const line = twin.route.polyline;
  return searchPlaces(places, name, 1, (p: Place) => line.project(p.at).offset < 3000)[0] ?? null;
}

function showArea(points: LocalPoint[]): void {
  useApp.getState().requestShot('area', points);
}

function showOnMap(twin: TwinRuntime, args: Record<string, unknown>): object {
  const plate = typeof args.plate === 'string' ? args.plate.toUpperCase() : null;
  if (plate) {
    const index = twin.fleet.vehicles.findIndex((v) => v.plate.toUpperCase() === plate);
    if (index < 0) return { shown: false, why: 'That vehicle is not on this route.' };
    useApp.getState().setFollow({ kind: 'sim', index, view: 'chase' });
    return { shown: true };
  }
  const name = typeof args.stop === 'string' ? args.stop.toLowerCase() : '';
  const stop = twin.route.stops.find((s) => s.name.toLowerCase().includes(name));
  if (!name || !stop) return { shown: false, why: 'No such stop on this route.' };
  const p = twin.route.polyline.pointAt(stop.s);
  showArea([
    { x: p.x - 150, z: p.z - 150 },
    { x: p.x + 150, z: p.z + 150 },
  ]);
  return { shown: true, stop: stop.name };
}

// ---- Driver ----------------------------------------------------------------

/** What a way round the traffic ahead of vehicle `index` is asked for; null on a clear road. */
function roundAsk(twin: TwinRuntime, index: number) {
  const state = twinState(twin);
  const route = twin.route;
  const view = driverView(state, index, dispatch(state));
  const v = state.vehicles[index]!;
  const line = route.polyline;
  const L = line.length;
  const pace = v.paceMps ?? ADVISORY.cruiseMps;
  const traffic = trafficAhead(state, index);
  const known = (state.slowRoad ?? []).map((z) => {
    const middle = distanceTo(route, v, z.s);
    return { fromM: middle - z.halfM, toM: middle + z.halfM, mps: z.mps };
  });
  const jam =
    known.find((z) => z.toM > 0) ??
    (traffic.level === 'clear'
      ? null
      : { fromM: 0, toM: SLOW_ROAD_M, mps: pace / Math.max(traffic.timesLonger, 1.5) });
  if (!jam) return null;
  // Riders on board come first: the way is back on the road before the first of their stops.
  const stops = route.stops
    .map((st, i) => ({ i, st, d: distanceTo(route, v, st.s) }))
    .filter((x) => x.d > 0)
    .sort((a, b) => a.d - b.d);
  const offAt = stops.find((x) => view.ahead.some((s) => s.stop === x.i && s.dropOffs > 0));
  const road: LocalPoint[] = [];
  for (let m = 0; m <= ROUND_LOOK_M; m += ROUND_STEP_M)
    road.push(line.pointAt((((v.s + m * v.direction) % L) + L) % L));
  return {
    state,
    view,
    stops,
    offAt,
    /** Where the vehicle was when asked: the way's metres ahead are from here. */
    fromS: v.s,
    ask: {
      road,
      stepM: ROUND_STEP_M,
      jam,
      paceMps: pace,
      stopAtM: offAt?.d ?? Infinity,
    },
  };
}

/** Ways weighed against each other, the letters compare_ways gives them, and their colours on the map. */
const WAY_LETTERS = ['A', 'B', 'C'] as const;
const WAY_COLOURS = ['#475569', '#0e7490', '#7e22ce'];
/** Someone this close to a way's side streets is by it, to be picked up (metres). */
const BY_THE_STREET_M = 12;
/** Staged riders of one way wait at least this far from the others' streets (metres). */
const APART_FROM_OTHERS_M = 30;
/**
 * Spreading the fleet: each jeepney already on a way counts this much against
 * it (₱), as it holds the way up and is first to anyone new by it. So of two
 * ways that pay about the same, the emptier is taken.
 */
const SPREAD_PHP = 15;
/** Diesel when no station ahead has a price (₱ a litre). */
const DIESEL_FALLBACK_PHP = 60;

interface Weighed {
  way: (typeof WAY_LETTERS)[number];
  /** Null: the route itself. */
  round: Round | null;
  /** Where the vehicle was when it was weighed: the way's metres ahead are from here. */
  fromS: number;
}
/** The ways last weighed for each vehicle, for take_way. */
const weighed = new WeakMap<TwinRuntime, Map<number, Weighed[]>>();

/** At most this many vehicles are sent round the same way at once (metres apart, its ends). */
const MOST_ON_A_WAY = 2;
const SAME_WAY_M = 150;
/** Off the road and back on over this much of it, in the kerb lane (metres). */
const TURN_RUN_M = 14;
/** How tight a corner it takes: the curve starts this far before it (metres). */
const CORNER_REACH_M = 14;

/** The curve a vehicle drives: from its lane, along the streets, back into its lane. */
function drivenWay(twin: TwinRuntime, index: number, way: Round, fromS: number) {
  const route = twin.route;
  const v = twin.fleet.vehicles[index]!;
  const L = route.polyline.length;
  // From where the vehicle was when the way was found, not where it is now
  // (Muse takes its time to answer; meanwhile it drives on): off at the junction itself.
  const along = (m: number) => {
    const s = fromS + m * v.direction;
    return route.loop ? ((s % L) + L) % L : s;
  };
  const lane = (m: number): LocalPoint => {
    const p = kerbLanePose(route, along(m), v.direction, { x: 0, z: 0, heading: 0 });
    return { x: p.x, z: p.z };
  };
  const firstM = Math.max(1, way.leaveM - TURN_RUN_M);
  const lastM = way.rejoinM + TURN_RUN_M;
  const line = new Polyline(
    curveWay(
      [
        lane(firstM),
        lane(firstM + TURN_RUN_M),
        ...way.street,
        lane(lastM - TURN_RUN_M),
        lane(lastM),
      ],
      CORNER_REACH_M,
    ),
  );
  const toTurn: LocalPoint[] = [];
  for (let m = 0; m < firstM; m += ROUND_STEP_M) toTurn.push(lane(m));
  return { line, toTurn, enterS: along(firstM), exitS: along(lastM) };
}

/** A U-turn is made this far past the stop the riders get off at, and past the crowd across (metres). */
const U_TURN_PAST_M = 30;
/** The other side of the road is at most this far across (metres). */
const OTHER_SIDE_M = 60;
/** The crowd's stop is at least this far on from where it is back on the road (metres). */
const ROOM_TO_STOP_M = 12;
const U_TURN_STEPS = 24;
const LOOK_M = 5;
/** Looked this far on for where this side passes the crowd (metres). */
const CROSS_LOOK_M = 1500;

/**
 * The U-turn back to a crowd across the road: on past the stop where the riders
 * get off, and past the crowd (so it is ahead once turned), then round onto the
 * other side's kerb lane. Null on a route that is not a loop, or where no other
 * side is near.
 */
function uTurnWay(twin: TwinRuntime, index: number, dropStop: number, crowdStop: number) {
  const route = twin.route;
  const v = twin.fleet.vehicles[index]!;
  if (!route.loop) return null;
  const L = route.polyline.length;
  const wrap = (s: number) => ((s % L) + L) % L;
  const ahead = (s: number) => wrap((s - v.s) * v.direction);
  const lane = (s: number): LocalPoint => {
    const p = kerbLanePose(route, wrap(s), v.direction, { x: 0, z: 0, heading: 0 });
    return { x: p.x, z: p.z };
  };
  const forward = (s: number) => {
    const a = lane(s - v.direction);
    const b = lane(s + v.direction);
    const len = Math.hypot(b.x - a.x, b.z - a.z) || 1;
    return { x: (b.x - a.x) / len, z: (b.z - a.z) / len };
  };
  // Where this side passes the crowd: the nearest spot to it in the next stretch.
  const crowdAt = lane(route.stops[crowdStop]!.s);
  let crossS = v.s;
  for (let m = 0, best = Infinity; m <= CROSS_LOOK_M; m += LOOK_M) {
    const p = lane(v.s + m * v.direction);
    const d = Math.hypot(p.x - crowdAt.x, p.z - crowdAt.z);
    if (d < best) [best, crossS] = [d, v.s + m * v.direction];
  }
  const dropS = route.stops[dropStop]!.s;
  const turnS = wrap((ahead(dropS) > ahead(crossS) ? dropS : crossS) + U_TURN_PAST_M * v.direction);
  const from = lane(turnS);
  const out = forward(turnS);
  // Back on: the nearest spot on the other side, going the other way.
  let backS = -1;
  for (let s = 0, best = OTHER_SIDE_M; s < L; s += LOOK_M) {
    const p = lane(s);
    const d = Math.hypot(p.x - from.x, p.z - from.z);
    const f = forward(s);
    if (d < best && f.x * out.x + f.z * out.z < -0.7) [best, backS] = [d, s];
  }
  if (backS < 0) return null;
  const crowdS = route.stops[crowdStop]!.s;
  if (wrap((crowdS - backS) * v.direction) < ROOM_TO_STOP_M) return null;
  // Round from one kerb lane to the other: out ahead, and back.
  const to = lane(backS);
  const back = forward(backS);
  const reach = Math.max(10, 0.6 * Math.hypot(to.x - from.x, to.z - from.z));
  const c1 = { x: from.x + out.x * reach, z: from.z + out.z * reach };
  const c2 = { x: to.x - back.x * reach, z: to.z - back.z * reach };
  const points: LocalPoint[] = [];
  for (let k = 0; k <= U_TURN_STEPS; k++) {
    const t = k / U_TURN_STEPS;
    const [a, b, c, d] = [(1 - t) ** 3, 3 * t * (1 - t) ** 2, 3 * t * t * (1 - t), t ** 3];
    points.push({
      x: a * from.x + b * c1.x + c * c2.x + d * to.x,
      z: a * from.z + b * c1.z + c * c2.z + d * to.z,
    });
  }
  const toTurn: LocalPoint[] = [];
  for (let m = 0; m < ahead(turnS); m += ROUND_STEP_M) toTurn.push(lane(v.s + m * v.direction));
  return { line: new Polyline(points), toTurn, enterS: turnS, exitS: backS };
}

/** Stations planned on, for the rounds still to drive (fuelPlan). */
const MOST_STATIONS = 40;

/**
 * Where vehicle `index` should buy diesel for `rounds` more rounds of its
 * route: its tank, the diesel a kilometre with the riders on board, and the
 * stations on its side of the road, every round passing them again.
 */
function dieselPlan(twin: TwinRuntime, index: number, rounds: number) {
  const v = twin.fleet.vehicles[index]!;
  const route = twin.route;
  const L = route.polyline.length;
  const kmToGo = (rounds * L) / 1000;
  const p = fleetPose(twin.fleet, index, { x: 0, z: 0, heading: 0 });
  const once = fuelAhead(
    route,
    stationsFor(route),
    { s: v.s, direction: v.direction, x: p.x, z: p.z },
    L,
    MOST_STATIONS,
  );
  const stations = Array.from({ length: Math.ceil(rounds) }, (_, k) =>
    once.map((f) => ({
      name: `${f.station.name ?? f.station.brand}${k > 0 ? ` (round ${k + 1})` : ''}`,
      metresAhead: f.distanceM + k * L,
      pesoPerL: f.expectedPhpPerL,
    })),
  ).flat();
  // This vehicle's own diesel a kilometre: its type, and the riders on board.
  const perKm = litresPerKm(v.kind, v.occupancy);
  const plan = fuelPlan({
    tankL: v.tankL,
    tankCapacityL: v.tankCapacityL,
    litresPerKm: perKm,
    kmToGo,
    stations,
  });
  // Planned is done, as with a shortcut: it turns in at the first stop of the
  // plan, for the litres planned, not at whichever station comes first.
  const first = plan.stops[0];
  const there = first && once.find((f) => Math.abs(f.distanceM - first.metresAhead) < 1);
  const turningIn = !!there && twin.fleet.refuelAt(index, there.station.s, first.litres);
  return {
    tankLitres: Math.round(v.tankL),
    tankPercent: Math.round((100 * v.tankL) / v.tankCapacityL),
    ridersOnBoard: v.occupancy,
    litresPerKm: Math.round(perKm * 1000) / 1000,
    kmToGo: Math.round(kmToGo * 10) / 10,
    ...plan,
    turningInAt: turningIn ? first.name : null,
  };
}

/** People by a way's street: `at` that share along it, or where it is furthest from the main road. */
type StreetGroup = { at: number | 'deepest'; count: number; to: number };

/**
 * People waiting by the side streets of the best way round the jam ahead of
 * vehicle `index` (a staged scene): each group `count` strong, `at` that
 * share of the way along its streets, going to stop `to`. Only a vehicle
 * driving that street takes them on (Passenger.byStreet).
 */
export function streetRiders(
  twin: TwinRuntime,
  index: number,
  groups: readonly StreetGroup[],
): Promise<number> {
  return stageWays(twin, index, [groups]);
}

/**
 * A staged moment of the fleet sharing the ways round a jam (demo scenes):
 * the ways round ahead of vehicle `index` (the best first), people by the
 * side streets of each (`byWay[k]` by way k), and vehicle `first.vehicle`
 * already sent down way `first.way`, as if its driver had asked a moment
 * before (first come, first served). How many were placed.
 */
export async function stageWays(
  twin: TwinRuntime,
  index: number,
  byWay: ReadonlyArray<readonly StreetGroup[]>,
  first?: { vehicle: number; way: number },
  /** "You" (a commuter scene), waiting by way `way` with its first group, going to stop `to`. */
  me?: { way: number; to: number },
): Promise<number> {
  const origin = twin.route.projection?.origin;
  const round = roundAsk(twin, index);
  if (!origin || !round || typeof Worker === 'undefined') return 0;
  // Held still while the streets come in (a new part of the map takes a
  // while): nobody drives past the corner before the scene is set.
  const app = useApp.getState();
  const speed = app.simulationSpeed;
  app.setSimulationSpeed(0);
  const answer = await findRound(round.ask, origin).finally(() =>
    useApp.getState().setSimulationSpeed(speed || 1),
  );
  const ways = [answer?.round, ...(answer?.others ?? [])].filter((r): r is Round => !!r);
  const v = twin.fleet.vehicles[index]!;
  const L = twin.route.polyline.length;
  let placed = 0;
  byWay.forEach((groups, w) => {
    const way = ways[w];
    if (!way || way.street.length < 2) return;
    const street = new Polyline(way.street);
    // The stop after the way is back on the road: theirs, as for anyone by the road.
    const back = round.stops.find((x) => x.d >= way.rejoinM);
    if (!back) return;
    // Away from every other way's streets, so they wait by this way alone.
    const others = ways
      .filter((o) => o !== way && o.street.length > 1)
      .map((o) => new Polyline(o.street));
    const clear = (q: LocalPoint) =>
      others.every((o) => o.project(q).offset >= APART_FROM_OTHERS_M);
    const spot = (at: number) => {
      for (let k = 0; k <= 20; k++)
        for (const share of [at + k * 0.03, at - k * 0.03]) {
          if (share < 0.05 || share > 0.95) continue;
          const q = street.pointAt(street.length * share);
          if (clear(q)) return { p: q, at: share };
        }
      return { p: street.pointAt(street.length * at), at };
    };
    // Where the street is furthest from the main road (in a barangay, a tricycle ride from it).
    const deepest = () => {
      let best = 0.5;
      let far = -1;
      for (let share = 0.1; share <= 0.9; share += 0.02) {
        const off = twin.route.polyline.project(street.pointAt(street.length * share)).offset;
        if (off > far) [best, far] = [share, off];
      }
      return best;
    };
    const shareOf = (at: StreetGroup['at']) => (at === 'deepest' ? deepest() : at);
    for (const g of groups) {
      const { p, at } = spot(shareOf(g.at));
      const along = way.leaveM + (way.rejoinM - way.leaveM) * at;
      const flagS = (((round.fromS + v.direction * along) % L) + L) % L;
      for (let k = 0; k < g.count; k++) {
        // Side by side by the street, a step apart.
        const across = 3 + 0.7 * (k % 2);
        const step = 0.8 * Math.floor(k / 2);
        twin.crew.join(back.i, g.to, 0, 'walk', {
          kind: 'regular',
          flagS,
          flagAt: {
            x: p.x + Math.sin(p.heading) * across + Math.cos(p.heading) * step,
            z: p.z + Math.cos(p.heading) * across - Math.sin(p.heading) * step,
          },
          byStreet: true,
        });
        placed++;
      }
    }
  });
  // "You", a step from the first group by your way: the commuter the scene follows.
  const mine = me && ways[me.way];
  const group = me && byWay[me.way]?.[0];
  if (mine && group && mine.street.length > 1) {
    const street = new Polyline(mine.street);
    const back = round.stops.find((x) => x.d >= mine.rejoinM);
    if (back) {
      let share = 0.5;
      if (group.at === 'deepest') {
        let far = -1;
        for (let k = 0.1; k <= 0.9; k += 0.02) {
          const off = twin.route.polyline.project(street.pointAt(street.length * k)).offset;
          if (off > far) [share, far] = [k, off];
        }
      } else share = group.at;
      const p = street.pointAt(street.length * share);
      const along = mine.leaveM + (mine.rejoinM - mine.leaveM) * share;
      const id = twin.crew.join(back.i, me.to, 0, 'walk', {
        kind: 'regular',
        flagS: (((round.fromS + v.direction * along) % L) + L) % L,
        flagAt: {
          x: p.x + Math.sin(p.heading) * 3.4 - Math.cos(p.heading) * 1.4,
          z: p.z + Math.cos(p.heading) * 3.4 + Math.sin(p.heading) * 1.4,
        },
        byStreet: true,
      });
      useApp.getState().setCommuter({ passenger: id });
      useApp.getState().setMe({ kind: 'regular' });
      placed++;
    }
  }
  const sent = first && ways[first.way];
  if (sent) {
    const driven = drivenWay(twin, first.vehicle, sent, round.fromS);
    twin.fleet.takeWay(first.vehicle, driven.line, driven.enterS, driven.exitS);
  }
  return placed;
}

/** Ready in the worker before it is asked for: a driver in a jam cannot wait for the map. */
export function warmShortcut(twin: TwinRuntime, index: number): void {
  const origin = twin.route.projection?.origin;
  const round = roundAsk(twin, index);
  if (origin && round && typeof Worker !== 'undefined') void findRound(round.ask, origin);
}

export function driverTools(twin: TwinRuntime, index: number): ToolRunner {
  const look = () => {
    const state = twinState(twin);
    const plan = dispatch(state);
    return { state, plan, view: driverView(state, index, plan) };
  };
  const whereNow = () => {
    const jeep = twin.fleet.vehicles[index]!;
    const p = fleetPose(twin.fleet, index, { x: 0, z: 0, heading: 0 });
    return { s: jeep.s, direction: jeep.direction, x: p.x, z: p.z };
  };

  /** A way round the road ahead by side streets, drawn on the map. */
  async function findShortcut(fuel: string | null): Promise<object> {
    const route = twin.route;
    const origin = route.projection?.origin;
    if (!origin) return { found: false, why: 'No map for this route.' };
    const { state: now } = look();
    if (!stopsByTheRoad(now.vehicles[index]!.kind ?? 'jeepney'))
      return { found: false, why: 'A bus or UV Express stays on its route.' };
    if (twin.fleet.vehicles[index]!.detour)
      return {
        found: true,
        alreadyOnIt: true,
        why: 'This vehicle is already taking the way round.',
      };
    const round = roundAsk(twin, index);
    if (!round) return { found: false, why: 'The road ahead is clear: stay on the route.' };
    const { state, view, stops, offAt, ask } = round;
    const answer = await findRound(ask, origin);
    const way = answer?.round;
    if (!way)
      return {
        found: false,
        why:
          answer?.skipsTheirStop && offAt
            ? `Every way round comes back after ${offAt.st.name}, where riders on board get off. Stay on the route.`
            : 'No side street here is direct enough to be worth leaving the road for.',
      };

    const skipped = stops.filter((x) => x.d > way.leaveM && x.d < way.rejoinM);
    const stations = stationsFor(route)
      .filter((st) => nearestOn(way.points, st.at) <= BY_THE_WAY_M)
      .map((st) => ({
        brand: st.brand,
        name: st.name,
        sells: st.fuels.length ? st.fuels : 'not listed on the map',
        matches: fuel && st.fuels.length ? st.fuels.some((f) => f.includes(fuel)) : null,
      }));
    const coming = state.passengers.filter(
      (p) =>
        p.phase === 'approaching' &&
        nearestOn(way.points, { x: p.x, z: p.z }) <= ON_THE_WAY_RIDER_M,
    ).length;
    // Found is taken: the driver asked, and the vehicle goes that way. Unless
    // enough are on it already: sending everyone would only jam it instead.
    const driven = drivenWay(twin, index, way, round.fromS);
    const onIt = twin.fleet.vehicles.filter(
      (o, i) =>
        i !== index &&
        o.detour &&
        Math.abs(o.detour.enterS - driven.enterS) < SAME_WAY_M &&
        Math.abs(o.detour.exitS - driven.exitS) < SAME_WAY_M,
    ).length;
    if (onIt >= MOST_ON_A_WAY)
      return {
        found: false,
        why: `${onIt} jeepneys are already taking the street round; sending more would jam it. Stay on the route.`,
      };
    twin.fleet.takeWay(index, driven.line, driven.enterS, driven.exitS);
    useApp.getState().setAgentWay({
      points: [...driven.toTurn, ...driven.line.points],
      label: `Shortcut ${(way.metres / 1000).toFixed(1)} km`,
    });

    const skippedIds = new Set(skipped.map((x) => x.i));
    return {
      found: true,
      km: Math.round(way.metres / 100) / 10,
      minutes: way.minutes,
      minutesByTheRouteInThisTraffic: way.roadMinutes,
      turnOffInMetres: way.leaveM,
      backOnTheRouteBefore: stops.find((x) => x.d >= way.rejoinM)?.st.name ?? null,
      takingItNow: true,
      leavesFranchiseRoute: true,
      warning: 'Off the franchise route: the driver risks an out-of-line violation.',
      stopsSkipped: skipped.map((x) => x.st.name),
      ridersWaitingSkipped: state.passengers.filter(
        (p) => p.phase === 'waiting' && skippedIds.has(p.originStop),
      ).length,
      ridersOnBoardGettingOffThere: view.ahead
        .filter((s) => skippedIds.has(s.stop))
        .reduce((n, s) => n + s.dropOffs, 0),
      ridersComingAlongIt: coming,
      gasStationsOnIt: stations,
      source: 'map streets; riders on side streets are simulated',
    };
  }

  /**
   * The ways on from here, weighed in pesos over the same stretch of road (to
   * where the furthest way round is back on it): staying on the route, and
   * up to two ways round by side streets. Each picks up those it passes,
   * as far as the seats go: at its stops, or by its side streets.
   */
  async function compareWays(): Promise<object> {
    const route = twin.route;
    const origin = route.projection?.origin;
    if (!origin) return { compared: false, why: 'No map for this route.' };
    const v = twin.fleet.vehicles[index]!;
    if (!stopsByTheRoad(v.kind ?? 'jeepney'))
      return { compared: false, why: 'A bus or UV Express stays on its route.' };
    if (v.detour) return { compared: false, why: 'This vehicle is already on a way round.' };
    const round = roundAsk(twin, index);
    if (!round) return { compared: false, why: 'The road ahead is clear: stay on the route.' };
    const { stops, ask, fromS } = round;
    const answer = await findRound(ask, origin);
    // Who is waiting now, the ways in hand: finding them can take a while
    // (a new part of the map), and people come meanwhile.
    const state = twinState(twin);
    const rounds = [answer?.round, ...(answer?.others ?? [])].filter((r): r is Round => !!r);
    if (rounds.length === 0)
      return {
        compared: false,
        why: 'No side street here goes round and back in time: stay on the route.',
      };

    const kind = v.kind ?? 'jeepney';
    const rule = FARE_BY_VEHICLE[kind];
    const seats = Math.max(0, v.capacity - v.occupancy);
    const endM = Math.max(...rounds.map((r) => r.rejoinM));
    const L = route.polyline.length;
    const kmBetween = (a: number, b: number) =>
      (route.loop
        ? (((route.stops[b]!.s - route.stops[a]!.s) % L) + L) % L
        : Math.abs(route.stops[b]!.s - route.stops[a]!.s)) / 1000;
    const fareOf = (p: (typeof state.passengers)[number]) =>
      fareFor(kmBetween(p.originStop, p.destinationStop), !!p.kind && discountedKind(p.kind), rule);
    const stopAt = new Map(stops.map((x) => [x.i, x.d]));
    const me = state.vehicles[index]!;
    const waiting = state.passengers.filter(
      (p) => p.phase === 'waiting' && p.vehicle === null && p.direction === v.direction,
    );
    /** Metres ahead to someone waiting by the road; undefined by a side street. */
    const metresTo = (p: (typeof waiting)[number]) =>
      p.byStreet
        ? undefined
        : p.flagS !== undefined
          ? distanceTo(route, me, p.flagS)
          : stopAt.get(p.originStop);
    // First come, first served. Someone by a side street is for the vehicle
    // already on its way down it (as far as its seats go); someone by the road
    // for a vehicle ahead with a seat, which gets to them first. Nobody is
    // counted twice, across the fleet.
    const rivals = twin.fleet.vehicles
      .map((o, i) => ({ o, i }))
      .filter(({ o, i }) => i !== index && o.duty !== 'parked' && o.direction === v.direction);
    const claimed = new Set<number>();
    for (const { o } of rivals) {
      const d = o.detour;
      if (!d) continue;
      // In the order it comes to them, as far as its seats go.
      let room = Math.max(0, o.capacity - o.occupancy);
      const byIt = waiting
        .filter((p) => p.byStreet && !claimed.has(p.id))
        .map((p) => ({ p, at: d.line.project(p) }))
        .filter(({ at }) => at.offset <= BY_THE_STREET_M && at.s > (d.on ? d.atM : 0))
        .sort((x, y) => x.at.s - y.at.s);
      for (const { p } of byIt) {
        if (room-- <= 0) break;
        claimed.add(p.id);
      }
    }
    const aheadOnRoad = rivals
      .filter(({ o }) => !o.detour && o.capacity > o.occupancy)
      .map(({ o }) => ({ d: distanceTo(route, me, o.s), room: o.capacity - o.occupancy }))
      .filter((x) => x.d > 0 && x.d < L / 2)
      .sort((a, b) => b.d - a.d);
    for (const p of waiting
      .filter((p) => metresTo(p) !== undefined)
      .sort((a, b) => metresTo(a)! - metresTo(b)!)) {
      const first = aheadOnRoad.find((x) => x.room > 0 && x.d < metresTo(p)!);
      if (!first) continue;
      first.room--;
      claimed.add(p.id);
    }
    // Waiting for this vehicle's way, not taken first by another: at a stop on
    // the road it drives, or by its side streets.
    const ours = waiting.filter((p) => !claimed.has(p.id));
    const onRoad = (fromM: number, toM: number, who = ours) =>
      who.filter((p) => {
        const d = metresTo(p);
        return d !== undefined && d > fromM && d <= toM;
      });
    const takenByOthers = waiting.filter((p) => claimed.has(p.id));
    // By a way's streets: near the line of them, not only their corners (a long block's are far apart).
    const streetLines = new Map(
      rounds.map((r) => [r, r.street.length > 1 ? new Polyline(r.street) : null]),
    );
    const byStreets = (r: Round, who = ours) =>
      who.filter((p) => {
        const line = streetLines.get(r);
        return p.byStreet && !!line && line.project(p).offset <= BY_THE_STREET_M;
      });
    // A way two are already taking is full: sending more would jam it.
    const onTheWay = (r: Round) => {
      const driven = drivenWay(twin, index, r, fromS);
      return rivals.filter(
        ({ o }) =>
          o.detour &&
          Math.abs(o.detour.enterS - driven.enterS) < SAME_WAY_M &&
          Math.abs(o.detour.exitS - driven.exitS) < SAME_WAY_M,
      ).length;
    };
    const prices = fuelAhead(route, stationsFor(route), whereNow())
      .map((f) => f.expectedPhpPerL)
      .filter((x): x is number => x !== null);
    const phpPerL = prices.length
      ? prices.reduce((a, b) => a + b, 0) / prices.length
      : DIESEL_FALLBACK_PHP;
    const perKm = litresPerKm(kind, v.occupancy);
    const pace = ask.paceMps;
    const weigh = (metres: number, seconds: number, riders: typeof ours) => {
      const taken = riders.slice(0, seats);
      // Diesel for the distance, and for the time beyond it at its pace (crawling, idling).
      const extraH = Math.max(0, seconds - metres / pace) / 3600;
      const litres = (metres / 1000) * perKm + extraH * FUEL[kind].idleLPerH;
      const fares = taken.reduce((sum, p) => sum + fareOf(p), 0);
      const diesel = litres * phpPerL;
      return {
        km: Math.round(metres / 100) / 10,
        minutes: Math.round(seconds / 6) / 10,
        ridersToPickUp: taken.length,
        ridersLeftForNoSeat: riders.length - taken.length,
        faresPhp: Math.round(fares),
        dieselLitres: Math.round(litres * 100) / 100,
        dieselPhp: Math.round(diesel),
        netPhp: Math.round(fares - diesel),
      };
    };
    const roadS = (a: number, b: number) => roadSeconds(ask as RoundAsk, a, b);
    const onIt = (fromM: number, toM: number) =>
      stops.filter((x) => x.d > fromM && x.d <= toM).map((x) => x.st.name);
    const options = [
      {
        way: WAY_LETTERS[0],
        name: 'Stay on the route',
        ...weigh(endM, roadS(0, endM), onRoad(0, endM)),
        stopsOnIt: onIt(0, endM),
        ridersWaitingByTheStreets: 0,
        ridersTakenFirstByOthers: onRoad(0, endM, takenByOthers).length,
        vehiclesAlreadyOnIt: 0,
        full: false,
        leavesTheRoute: false,
      },
      ...rounds.map((r, k) => {
        const metres = r.leaveM + r.metres + (endM - r.rejoinM);
        const seconds = roadS(0, r.leaveM) + r.minutes * 60 + roadS(r.rejoinM, endM);
        const street = byStreets(r);
        const already = onTheWay(r);
        return {
          way: WAY_LETTERS[k + 1]!,
          name: `Side streets, off the road in ${Math.round(r.leaveM)} m`,
          ...weigh(metres, seconds, [
            ...onRoad(0, r.leaveM),
            ...street,
            ...onRoad(r.rejoinM, endM),
          ]),
          stopsOnIt: [...onIt(0, r.leaveM), ...onIt(r.rejoinM, endM)],
          stopsSkipped: onIt(r.leaveM, r.rejoinM),
          ridersWaitingByTheStreets: street.length,
          ridersTakenFirstByOthers:
            byStreets(r, takenByOthers).length +
            onRoad(0, r.leaveM, takenByOthers).length +
            onRoad(r.rejoinM, endM, takenByOthers).length,
          vehiclesAlreadyOnIt: already,
          full: already >= MOST_ON_A_WAY,
          leavesTheRoute: true,
        };
      }),
    ];
    // The best of the ways still open, the emptier where they pay about the
    // same: the fleet spreads over them.
    const score = (o: (typeof options)[number]) => o.netPhp - SPREAD_PHP * o.vehiclesAlreadyOnIt;
    const best = options
      .filter((o) => !o.full)
      .reduce((a, b) =>
        score(b) > score(a) || (score(b) === score(a) && b.minutes < a.minutes) ? b : a,
      );
    const fastest = options.reduce((a, b) => (b.minutes < a.minutes ? b : a));

    let byTwin = weighed.get(twin);
    if (!byTwin) weighed.set(twin, (byTwin = new Map()));
    byTwin.set(index, [
      { way: 'A', round: null, fromS },
      ...rounds.map((r, k) => ({ way: WAY_LETTERS[k + 1]!, round: r, fromS })),
    ]);
    // Drawn, each in its colour: the route to the same end, the others round.
    const line = route.polyline;
    const ahead = (m: number) => line.pointAt((((fromS + m * v.direction) % L) + L) % L);
    const roadFrom = (fromM: number, toM: number) => {
      const pts: LocalPoint[] = [];
      for (let m = fromM; m <= toM; m += 10) pts.push(ahead(m));
      return pts;
    };
    // A way round drawn as the vehicle will drive it (drivenWay), corners and
    // all, then on along the road to the same end as the others.
    const drawnWay = (r: Round) => {
      const d = drivenWay(twin, index, r, fromS);
      return [...d.toTurn, ...d.line.points, ...roadFrom(r.rejoinM + TURN_RUN_M, endM)];
    };
    useApp.getState().setAgentWays(
      options.map((o, k) => ({
        points: k === 0 ? roadFrom(0, endM) : drawnWay(rounds[k - 1]!),
        label: o.full
          ? `${o.way} · full: ${o.vehiclesAlreadyOnIt} on it`
          : `${o.way} · ${o.netPhp >= 0 ? '+' : '−'}₱${Math.abs(o.netPhp)} · ${o.minutes} min${o === best ? ' · best' : ''}`,
        colour: WAY_COLOURS[k]!,
      })),
    );
    // Drawn, not flown to: the camera stays on the vehicle (RideHud: "See the ways on the map").
    useApp.getState().setAgentWay(null);
    return {
      compared: true,
      to: stops.find((x) => x.d >= endM)?.st.name ?? null,
      options,
      bestForTheDriver: best.way,
      fastest: fastest.way,
      dieselPhpPerL: Math.round(phpPerL * 100) / 100,
      seatsFree: seats,
      note: 'Fares are each rider’s whole trip at the LTFRB rate; diesel for the km and the extra minutes crawling, at this week’s pump price. First come, first served: riders another jeepney reaches first are theirs, and a way two jeepneys already take is full.',
      source: 'map streets and simulated riders; prices DOE',
    };
  }

  /** Drive way `letter` of the ways last weighed. */
  function takeWeighed(letter: string): object {
    const ways = weighed.get(twin)?.get(index);
    const w = ways?.find((x) => x.way === letter.trim().toUpperCase());
    if (!w) return { taken: false, why: 'Compare the ways first (compare_ways).' };
    const app = useApp.getState();
    // All still drawn, the one taken ticked: the choice stays readable on the map.
    const tick = () =>
      app.agentWays &&
      app.setAgentWays(
        app.agentWays.map((d, k) =>
          k === ways!.indexOf(w) ? { ...d, label: `✓ ${d.label.replace(/^✓ /, '')}` } : d,
        ),
      );
    if (!w.round) {
      tick();
      return { taken: true, way: w.way, staysOnTheRoute: true };
    }
    const driven = drivenWay(twin, index, w.round, w.fromS);
    // Others may have taken it while this driver was deciding.
    const onIt = twin.fleet.vehicles.filter(
      (o, i) =>
        i !== index &&
        o.detour &&
        Math.abs(o.detour.enterS - driven.enterS) < SAME_WAY_M &&
        Math.abs(o.detour.exitS - driven.exitS) < SAME_WAY_M,
    ).length;
    if (onIt >= MOST_ON_A_WAY)
      return {
        taken: false,
        why: `${onIt} jeepneys took it first: compare the ways again.`,
      };
    const turning = twin.fleet.takeWay(index, driven.line, driven.enterS, driven.exitS);
    if (!turning) return { taken: false, why: 'Too late to turn off for it: stay on the route.' };
    tick();
    return {
      taken: true,
      way: w.way,
      turnOffInMetres: Math.round(w.round.leaveM),
      km: Math.round(w.round.metres / 100) / 10,
      leavesFranchiseRoute: true,
    };
  }

  /**
   * Asked is done: the jeepney stops at the next stop and waits there for the
   * riders on their way, a minute or two at most (waitForRiders), then goes.
   */
  const waitHere = (
    state: ReturnType<typeof look>['state'],
    view: ReturnType<typeof look>['view'],
  ) => {
    const wait = waitForRiders(state, view, index);
    if (!wait) return null;
    twin.fleet.waitFor(index, wait.stop, wait.untilS);
    return {
      at: wait.name,
      riders: wait.riders,
      waitAboutMin: Math.max(0.5, Math.round(wait.waitS / 30) / 2),
      mostMin: wait.mostS / 60,
      tooLate: wait.tooLate,
    };
  };

  /** Real phones sharing round the driver, looked up once (phonesNear.ts). */
  const realPhones = (view: ReturnType<typeof look>['view']) => {
    const next = view.ahead[0];
    const stop = next ? twin.route.polyline.pointAt(twin.route.stops[next.stop]!.s) : null;
    return phonesNear(twin, whereNow(), stop);
  };

  return async (name, args) => {
    const { state, plan, view } = look();
    switch (name) {
      case 'traffic_ahead':
        return trafficAhead(state, index);
      case 'vehicles_ahead':
        return { ...vehiclesAhead(state, plan, view, index), realPhones: await realPhones(view) };
      case 'seats_for_next_stops':
        return seatsForNextStops(plan, view, index);
      case 'late_riders':
        return {
          stops: lateRiders(state, view, index, Number(args.within_min) || 3),
          waitingNow: waitHere(state, view),
        };
      case 'find_shortcut':
        return findShortcut(typeof args.fuel === 'string' ? args.fuel.toLowerCase() : null);
      case 'compare_ways':
        return compareWays();
      case 'take_way':
        return takeWeighed(typeof args.way === 'string' ? args.way : '');
      case 'fuel_ahead': {
        const wanted = typeof args.fuel === 'string' ? args.fuel.toLowerCase() : null;
        const stops = fuelAhead(twin.route, stationsFor(twin.route), whereNow());
        return {
          priceWeek: DIESEL_WEEK,
          plan: dieselPlan(twin, index, Math.max(0.5, Number(args.rounds) || 1)),
          stations: stops.map((f) => ({
            brand: f.station.brand,
            metresAhead: Math.round(f.distanceM),
            expectedPhpPerL: f.expectedPhpPerL,
            sells: f.station.fuels.length ? f.station.fuels : 'not listed on the map',
            matches:
              wanted && f.station.fuels.length
                ? f.station.fuels.some((x) => x.includes(wanted))
                : null,
            cheapest: f.cheapest,
          })),
        };
      }
      case 'leave_or_wait': {
        const sum = leaveOrWait(state, view, index);
        return sum.advice === 'wait' ? { ...sum, waitingNow: waitHere(state, view) } : sum;
      }
      case 'my_day':
        return boundaryLeft(twin.fleet.vehicles[index]!, twin.route.polyline.length / 1000);
      case 'who_is_waiting': {
        const who = whoIsWaiting(state, view, index);
        return who ? { ...who, realPhones: await realPhones(view) } : { error: 'No stop ahead.' };
      }
      case 'hand_over': {
        // Asked is done, as with a shortcut: they get off at the next stop for the
        // one behind, and the jeepney U-turns there for the crowd across.
        const sum = handOver(state, index);
        if (!sum.possible || !sum.crowd) return sum;
        const { at, ...crowd } = sum.crowd;
        const { riders, stop } = twin.crew.passOn(index);
        const turn = uTurnWay(twin, index, stop, at);
        const turning = !!turn && twin.fleet.takeWay(index, turn.line, turn.enterS, turn.exitS);
        if (turning)
          useApp.getState().setAgentWay({
            points: [...turn.toTurn, ...turn.line.points],
            label: `U-turn for ${crowd.waiting} at ${crowd.stop}`,
          });
        return {
          ...sum,
          crowd,
          done: true,
          passedOn: riders,
          getOffAt: twin.route.stops[stop]!.name,
          uTurnNow: turning ? `after ${twin.route.stops[stop]!.name}, back to ${crowd.stop}` : null,
        };
      }
      case 'show_on_map':
        return showOnMap(twin, args);
      default:
        return { error: `No tool ${name}` };
    }
  };
}

// ---- Commuter --------------------------------------------------------------

let lastOptions: TripOption[] = [];

/** Options as Muse is told them. */
const said = (o: TripOption, i: number) => ({
  option: i + 1,
  doorToDoorMin: min(o.totalS),
  fare: o.fare,
  fareDiscounted: o.fareDiscounted,
  getToStop: `${o.toBy} ${Math.round(o.walkToM)} m to ${o.legs[0]!.boardName}`,
  rides: o.legs.map((l) => ({
    route: l.routeName,
    from: l.boardName,
    to: l.alightName,
    nextIn: min(l.waitS),
    plate: l.jeepney?.plate ?? null,
  })),
});

async function planFrom(
  twin: TwinRuntime,
  from: { name: string; at: LocalPoint },
  to: { name: string; at: LocalPoint },
): Promise<object> {
  const network = getNetwork();
  if (!network) return { found: false, why: 'The network is still loading.' };
  const app = useApp.getState();
  app.setTripEnd('home', from);
  app.setTripEnd('to', to);
  const by = app.me.mode === 'auto' ? undefined : app.me.mode;
  lastOptions = planTrips(network, from.at, to.at, twin.clockS, arrivalsAt(twin), by);
  const best = lastOptions[0];
  if (!best)
    return { found: false, why: 'No jeepney or bus trip with at most one change goes there.' };
  const legs = legsOf(best, from.at, undefined);
  app.setTripPreview(legs);
  showArea(tripPoints(network, legs, [from, to]));
  return { found: true, from: from.name, to: to.name, options: lastOptions.map(said) };
}

/**
 * A tricycle to the main road from a side street, a special trip for one (₱):
 * an assumption, what a short one costs in Quezon City and Caloocan.
 */
const TRICYCLE_TO_ROAD_PHP = 20;
/** Further than this from the main road (metres), two or three blocks, people take a tricycle or pedicab to it. */
const TRICYCLE_FROM_M = 200;
/** Along side streets, stops and all (m/s), as a vehicle drives a way round (fleetSim.ts). */
const SIDE_STREET_PACE_MPS = 5.6;
/** Neighbours this close (metres) are waiting with you. */
const WITH_YOU_M = 15;

/**
 * Whether a jeepney taking a way round is coming down the street this
 * commuter waits on, off the main road: when, its seats, who else waits
 * there, and the walk or tricycle to the main road it saves.
 */
function rideDownMyStreet(twin: TwinRuntime): object {
  const { commuter } = useApp.getState();
  const me = 'passenger' in commuter ? twin.crew.passengers.get(commuter.passenger) : undefined;
  if (!me?.spot) return { known: false, why: 'Where you are waiting is not known.' };
  const spot = me.spot;
  const route = twin.route;
  const toRoadM = Math.round(route.polyline.project(spot).offset);
  const state = twinState(twin);
  const withYou = [...twin.crew.passengers.values()].filter(
    (p) =>
      p !== me &&
      p.phase === 'waiting' &&
      p.vehicleId === null &&
      !!p.spot &&
      Math.hypot(p.spot.x - spot.x, p.spot.z - spot.z) <= WITH_YOU_M,
  ).length;
  const coming = twin.fleet.vehicles.flatMap((v, i) => {
    const d = v.detour;
    if (!d || v.duty === 'parked') return [];
    const at = d.line.project(spot);
    if (at.offset > BY_THE_STREET_M) return [];
    const along = at.s - (d.on ? d.atM : 0);
    if (along < 0) return [];
    // Still on the main road: on to where it turns off, at its pace now (in the jam).
    const toTurn = d.on ? 0 : Math.max(0, distanceTo(route, state.vehicles[i]!, d.enterS));
    const seconds = toTurn / Math.max(v.speedMps, 1) + along / SIDE_STREET_PACE_MPS;
    return [
      {
        plate: v.plate,
        kind: v.kind ?? 'jeepney',
        minutes: Math.max(1, Math.round(seconds / 60)),
        seatsFree: Math.max(0, v.capacity - v.occupancy),
        onTheStreetAlready: d.on,
      },
    ];
  });
  const tricycle = toRoadM > TRICYCLE_FROM_M;
  return {
    comingDownYourStreet: coming.sort((a, b) => a.minutes - b.minutes),
    neighboursWaitingWithYou: withYou,
    walkToMainRoadM: toRoadM,
    savedIfYouWaitHere:
      coming.length === 0
        ? null
        : tricycle
          ? {
              tricyclePhp: TRICYCLE_TO_ROAD_PHP,
              forYouAndNeighboursPhp: TRICYCLE_TO_ROAD_PHP * (withYou + 1),
            }
          : { walkM: toRoadM },
    note: 'A jeepney going round the jam by your street stops for you there. The tricycle fare is an assumption: a short special trip in Metro Manila.',
    source: 'simulated vehicles; streets from OpenStreetMap',
  };
}

/** Where this commuter is now: their rider in the twin, else the trip's start. */
function hereNow(twin: TwinRuntime): { name: string; at: LocalPoint } | null {
  const { commuter, tripEnds } = useApp.getState();
  if ('passenger' in commuter) {
    const pose = newRiderPose();
    if (twin.crew.passengers.has(commuter.passenger)) {
      twin.crew.worldPose(commuter.passenger, pose);
      return { name: 'where you are now', at: { x: pose.x, z: pose.z } };
    }
  }
  return tripEnds.home;
}

export function commuterTools(twin: TwinRuntime): ToolRunner {
  return async (name, args) => {
    switch (name) {
      case 'plan_trip': {
        const to = await placeNamed(twin, String(args.to ?? ''));
        if (!to) return { found: false, why: `No place called ${String(args.to)} on the map.` };
        const named = typeof args.from === 'string' ? await placeNamed(twin, args.from) : null;
        const from = named ?? hereNow(twin);
        if (!from) return { found: false, why: 'Ask where they are starting from.' };
        return planFrom(twin, from, to);
      }
      case 'reroute_me': {
        const { tripEnds } = useApp.getState();
        const from = hereNow(twin);
        if (!from || !tripEnds.to) return { found: false, why: 'There is no trip to change.' };
        return planFrom(twin, from, tripEnds.to);
      }
      case 'take_trip': {
        const o = lastOptions[(Number(args.option) || 1) - 1];
        if (!o) return { started: false, why: 'Plan a trip first.' };
        takeTrip(o, twin);
        return { started: true };
      }
      case 'next_rides': {
        const { commuter } = useApp.getState();
        const state = twinState(twin);
        const wanted = typeof args.stop === 'string' ? args.stop.toLowerCase() : null;
        const named = wanted
          ? twin.route.stops.findIndex((s) => s.name.toLowerCase().includes(wanted))
          : -1;
        if (wanted && named < 0) return { error: 'That stop is not on this route.' };
        const rider =
          'passenger' in commuter ? twin.crew.passengers.get(commuter.passenger) : undefined;
        const mine =
          'passenger' in commuter
            ? { stop: rider?.originStop ?? 0, destination: rider?.destinationStop ?? 0 }
            : commuter;
        const stop = named >= 0 ? named : mine.stop;
        const asking = rider && stop === rider.originStop ? rider.id : undefined;
        return nextRides(state, dispatch(state), stop, mine.destination, twin.clockS, asking);
      }
      case 'ride_down_my_street':
        return rideDownMyStreet(twin);
      case 'does_route_pass': {
        const network = getNetwork();
        if (!network) return { answer: 'unknown', note: 'The network is still loading.' };
        const place = await placeNamed(twin, String(args.place ?? ''));
        if (!place)
          return {
            answer: 'unknown',
            note: `No place called ${String(args.place)} on the map. Say you do not know that place.`,
          };
        return boardGoesTo(network, String(args.board_text ?? ''), place);
      }
      case 'walk_or_stay': {
        const { commuter } = useApp.getState();
        const state = twinState(twin);
        return walkOrStay(state, commuterView(state, dispatch(state), commuter));
      }
      case 'show_on_map':
        return showOnMap(twin, args);
      default:
        return { error: `No tool ${name}` };
    }
  };
}

/** The operator's: only moving the map, for now. */
export function operatorTools(twin: TwinRuntime): ToolRunner {
  return async (name, args) =>
    name === 'show_on_map' ? showOnMap(twin, args) : { error: `No tool ${name}` };
}
