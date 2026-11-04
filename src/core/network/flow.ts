/**
 * Jeepneys on the routes nobody is looking at closely: a flow, not a
 * simulation. Positions and loads are worked out from the clock alone, so
 * tens of thousands of jeepneys across Metro Manila cost nothing until they
 * are drawn or asked about, and they are the same whichever frame asks.
 *
 *   speed     commercial speed (stops included) by time of day: slower in
 *             the rush hours, faster at night.
 *   fleet     one jeepney every headway (GTFS) round the loop.
 *   day       as the twin's jeepneys. Some boundary drivers collect the
 *             jeepney at the operator's terminal, sent out by the dispatcher
 *             one after another between 5:30 and 6:30 AM; the rest, and the
 *             owner-drivers, set out from a garage or home along the route at
 *             a time of their own. Terminal to terminal they drive; at each
 *             terminal they wait in the line 2 to 5 minutes before the trip
 *             back. Between 9 and 11 PM each knocks off: the trip under way is
 *             finished, then one kept at a terminal stays at that terminal and
 *             the rest drive back to their garage or home the short way
 *             (wherever the route next passes it). Times change day to day.
 *   load      by time of day (the commute peaks), varying smoothly per
 *             jeepney over ten minutes or so.
 *   seats     for someone arriving at a stop: free seats less the people
 *             already queued there, who board first.
 *
 * These are estimates of how a route usually runs, not live data, and the
 * app says so wherever it shows them.
 */

import { passesNear } from '../geo/near';
import type { Route } from '../geo/routes';
import { aheadOf } from '../geo/routes';
import { fleetKinds, placesOf, seatsOf, type FleetKind } from '../vehicles/specs';
import {
  expectedArrivals,
  HOME_FROM_S,
  HOME_TO_S,
  OWNER_SHARE,
  RIDERS_PER_JEEPNEY_PER_DAY,
  SERVICE_FROM_S,
  TERMINAL_KEPT_SHARE,
} from '../fleet/scenario';

/** More would not change what anyone sees, and a focused route simulates them all. */
export const MAX_FLOW_VEHICLES = 80;
const MIN_FLOW_VEHICLES = 2;
const LETTERS = 'ABCDEFGHJKLMNPRSTUVWXYZ';
const DAY_S = 86_400;
/** Drivers set out over this long from SERVICE_FROM_S (as the twin's). */
const SET_OUT_OVER_S = 60 * 60;
/** A home or garage along the route is at least this far from a terminal (as the twin's)… */
const HOME_CLEAR_M = 800;
/** …and the route passing within this of it is a way home (as the twin's). */
const HOME_ROAD_M = 80;
/** A terminal's morning dispatch never takes longer than this (seconds). */
const DISPATCH_MAX_S = 2 * 3600;
/** At a terminal, the line: 2 to 5 minutes before the trip back (as the twin's). */
const PILA_MIN_S = 120;
const PILA_MAX_S = 300;
/**
 * The line moves up as the head of it leaves (metres a second): those who
 * came first are further on, so the line stands along the road, not all on
 * one spot, and carries on from where it got to.
 */
const PILA_CREEP_MPS = 0.1;

/**
 * Average jeepney speed including stops, km/h, by hour of day: about two
 * thirds of the moving pace the twin's vehicles make (trafficShare), as a
 * stop every few hundred metres takes, so the other routes keep up with them.
 */
export function flowSpeedKmh(hour: number): number {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  if (h >= 22 || h < 5) return 32; // night: empty roads
  if ((h >= 6 && h < 9) || (h >= 16 && h < 20)) return 17; // rush hours
  return 22;
}

/**
 * How much of their clear-road pace vehicles make in the hour's traffic:
 * all of it at night (47–58 km/h), about two thirds through the day (32–39),
 * half in the rush hours (23–29). The flows above are averages with their
 * stops in; this is the moving pace of the vehicles the twin drives.
 */
export function trafficShare(hour: number): number {
  const h = ((Math.floor(hour) % 24) + 24) % 24;
  if (h >= 22 || h < 5) return 1;
  if ((h >= 6 && h < 9) || (h >= 16 && h < 20)) return 0.5;
  return 0.68;
}

/** Metres a jeepney has driven since midnight at the flow speeds, for clock t (seconds). */
const CUMULATIVE = (() => {
  const out = [0];
  for (let h = 0; h < 24; h++) out.push(out[h]! + (flowSpeedKmh(h) / 3.6) * 3600);
  return out;
})();
function drivenSinceMidnight(t: number): number {
  const day = Math.floor(t / DAY_S);
  const inDay = t - day * DAY_S;
  const h = Math.floor(inDay / 3600);
  const within = inDay - h * 3600;
  return day * CUMULATIVE[24]! + CUMULATIVE[h]! + (flowSpeedKmh(h) / 3.6) * within;
}

/** The clock at which a jeepney that left at `t` has driven `metres` more. */
function clockAfter(t: number, metres: number): number {
  const x = drivenSinceMidnight(t) + metres;
  const day = Math.floor(x / CUMULATIVE[24]!);
  const r = x - day * CUMULATIVE[24]!;
  let h = 0;
  while (h < 23 && CUMULATIVE[h + 1]! <= r) h++;
  return day * DAY_S + h * 3600 + (r - CUMULATIVE[h]!) / (flowSpeedKmh(h) / 3.6);
}

/**
 * How full vehicles run at this hour, 0–1: about 85% in the morning and
 * evening rushes, half full or more through the day (late morning and
 * early afternoon are busy too), as the twin runs a route (drivers lining
 * up at the terminals to fill).
 */
export function flowLoad(hour: number): number {
  const peak = (centre: number, width: number) => Math.exp(-(((hour - centre) / width) ** 2));
  return Math.min(0.95, 0.25 + 0.6 * Math.max(peak(7, 1.4), peak(18.5, 2.2)) + 0.3 * peak(12, 3));
}

/** Hours a day a route's vehicles run (5:30 AM to about 10 PM). */
const SERVICE_HOURS = 16;
/** A bus or UV Express run carries about this share of its seats end to end… */
const LONG_LOAD = 0.8;
/** …and a bus takes on this many more along the way (its seats turn over a little). */
const BUS_TURNOVER = 1.3;

/**
 * Riders a day for a route's fleet of `count`. A jeepney route:
 * RIDERS_PER_JEEPNEY_PER_DAY each (short rides, the seats turn over all
 * day). A bus or UV Express route: long rides (SM Tungko to Cubao, Quiapo,
 * Makati), so each one-way run carries about LONG_LOAD of its seats, over as
 * many runs as its loop allows in SERVICE_HOURS.
 */
export function ridersPerDay(route: Route, count: number): number {
  const kind = route.kind ?? 'jeepney';
  if (kind === 'jeepney' || kind === 'modern') return count * RIDERS_PER_JEEPNEY_PER_DAY;
  const loopH = route.polyline.length / 1000 / flowSpeedKmh(12);
  const runs = (2 * SERVICE_HOURS) / loopH;
  return Math.round(count * seatsOf(kind) * runs * LONG_LOAD * (kind === 'bus' ? BUS_TURNOVER : 1));
}

/** Deterministic pseudo-random number in [0, 1) from integers. */
function hash(a: number, b: number, c = 0): number {
  let h =
    Math.imul(a ^ 0x9e3779b9, 0x85ebca6b) ^
    Math.imul(b + 0x632be59b, 0xc2b2ae35) ^
    Math.imul(c + 0x27d4eb2f, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return ((h ^ (h >>> 15)) >>> 0) / 4_294_967_296;
}

/** Smooth noise in [0, 1) over time, changing over about `periodS`. */
function smooth(a: number, b: number, t: number, periodS: number): number {
  const k = Math.floor(t / periodS);
  const f = t / periodS - k;
  const e = f * f * (3 - 2 * f);
  return hash(a, b, k) * (1 - e) + hash(a, b, k + 1) * e;
}

function idNumber(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  return h >>> 0;
}

export interface FlowVehicle {
  index: number;
  plate: string;
  /** Metres along the loop. */
  s: number;
  occupancy: number;
  capacity: number;
  speedMps: number;
  /** Out on the road now; parked where it is kept (s there, nobody aboard) when not. */
  inService: boolean;
  /** What it is: a jeepney (or modern jeepney) on a jeepney route; a bus or UV Express on theirs. */
  kind: FleetKind;
}

/** How a route's jeepneys run: how many, and where each starts on the loop. */
export class RouteFlow {
  readonly count: number;
  /** What each of them is (fleetKinds). */
  readonly kinds: readonly FleetKind[];
  private readonly seed: number;
  readonly plates: string[];
  /** Where each jeepney is kept, metres along the loop. */
  private readonly homeS: number[];
  /**
   * Kept at a terminal by the operator (boundary drivers, TERMINAL_KEPT_SHARE
   * of them), else at a garage or the owner's home along the route.
   */
  private readonly atTerminal: boolean[];
  /** Each jeepney's place in the morning's dispatch at its first terminal, 0–1… */
  private readonly dispatch: number[];
  /**
   * …over this long (seconds): half a round trip from each of two terminals,
   * so once all are out they are spread round the whole route, as a
   * dispatcher spaces them (at least SET_OUT_OVER_S, at most DISPATCH_MAX_S).
   */
  private readonly dispatchOverS: number;
  /** Every place the route passes a garage or home: ways back at night. */
  private readonly homeSpots: number[][];
  /** The terminals, metres along the loop, in order. */
  private readonly terminals: number[];
  /**
   * Where each jeepney's current leg began (day, place, clock, trips so far):
   * the clock only moves on, so the next call carries on from there.
   */
  private readonly legs: Array<{ day: number; s: number; at: number; trip: number } | null>;

  constructor(
    readonly route: Route,
    private readonly headwayS: number,
    /** How many vehicles it has (core/network/fleetSize.ts); else what the headway needs. */
    fleet?: number,
  ) {
    this.seed = idNumber(route.id);
    const L = route.polyline.length;
    const cycleS = L / (flowSpeedKmh(12) / 3.6);
    this.count =
      fleet ??
      Math.max(
        MIN_FLOW_VEHICLES,
        Math.min(MAX_FLOW_VEHICLES, Math.round(cycleS / Math.max(30, headwayS))),
      );
    this.kinds = fleetKinds(this.count, route.kind, route.mix);
    // Some boundary drivers' jeepneys are kept at a terminal (the
    // operator's); the rest, and owners', along the route away from the terminals.
    const terminals = route.stops.filter((s) => s.terminal).map((s) => s.s);
    const depots = terminals.length > 0 ? terminals : [0];
    this.terminals = [...depots].sort((a, b) => a - b);
    const away = (s: number) =>
      terminals.every((t) => Math.min(Math.abs(t - s), L - Math.abs(t - s)) >= HOME_CLEAR_M);
    this.atTerminal = Array.from(
      { length: this.count },
      (_, i) => hash(this.seed, i, 4) >= OWNER_SHARE && hash(this.seed, i, 5) < TERMINAL_KEPT_SHARE,
    );
    // Each one kept at a terminal: which (depots index), in turn.
    let kept = 0;
    const keptAt = this.atTerminal.map((t) => (t ? kept++ % depots.length : -1));
    this.homeS = Array.from({ length: this.count }, (_, i) => {
      if (this.atTerminal[i]) return depots[keptAt[i]!]!;
      let s = hash(this.seed, i, 3) * L;
      for (let k = 0; k < 20 && !away(s); k++) s = hash(this.seed, i, 30 + k) * L;
      return s;
    });
    // The dispatcher sends a terminal's jeepneys out one after another: those
    // kept there, and those that drove in from a garage or home up the road
    // (the first terminal ahead of it), so the route fills evenly.
    const depotOf = this.homeS.map((h, i) => {
      if (this.atTerminal[i]) return keptAt[i]!;
      let best = 0;
      depots.forEach((d, k) => {
        const ahead = (x: number) => (aheadOf(route, h, x) > 1 ? aheadOf(route, h, x) : L);
        if (ahead(d) < ahead(depots[best]!)) best = k;
      });
      return best;
    });
    const queued = depots.map(() => 0);
    const place = depotOf.map((d) => queued[d]!++);
    this.dispatch = place.map((k, i) => k / Math.max(1, queued[depotOf[i]!]!));
    this.homeSpots = this.homeS.map((h, i) =>
      this.atTerminal[i] ? [] : passesNear(route.polyline, route.polyline.pointAt(h), HOME_ROAD_M),
    );
    this.legs = this.homeS.map(() => null);
    const lapS = L / (flowSpeedKmh(6) / 3.6);
    this.dispatchOverS = Math.min(DISPATCH_MAX_S, Math.max(SET_OUT_OVER_S, lapS / depots.length));
    this.plates = Array.from({ length: this.count }, (_, i) => {
      const letter = (k: number) =>
        LETTERS[Math.floor(hash(this.seed, i, 10 + k) * LETTERS.length)];
      const digits = String(Math.floor(hash(this.seed, i, 20) * 10_000)).padStart(4, '0');
      return `${letter(0)}${letter(1)}${letter(2)} ${digits}`;
    });
  }

  /** Jeepney i at clock t (seconds since midnight of day 0). */
  vehicle(i: number, t: number, out?: FlowVehicle): FlowVehicle {
    const hour = (t / 3600) % 24;
    const now = this.where(i, t);
    const load = flowLoad(hour) * (0.45 + 1.1 * smooth(this.seed, i, t, 600));
    const v = out ?? ({} as FlowVehicle);
    v.index = i;
    v.plate = this.plates[i]!;
    v.kind = this.kinds[i]!;
    v.capacity = placesOf(v.kind);
    v.inService = now !== null;
    const L = this.route.polyline.length;
    v.s = (((now?.s ?? this.homeS[i]!) % L) + L) % L;
    v.occupancy = v.inService
      ? Math.max(0, Math.min(v.capacity, Math.round(seatsOf(v.kind) * load)))
      : 0;
    v.speedMps = now?.moving ? flowSpeedKmh(hour) / 3.6 : 0;
    return v;
  }

  /** When driver i sets out and knocks off on `day` (seconds since that midnight). */
  private outAt(i: number, day: number): number {
    const draw = hash(this.seed ^ day, i, 1);
    // The dispatcher's order, each departure nudged by up to a third of a gap.
    const gap = 1 / Math.max(1, this.count);
    const dispatched =
      SERVICE_FROM_S +
      Math.max(0, this.dispatch[i]! + (draw - 0.5) * 0.66 * gap) * this.dispatchOverS;
    if (this.atTerminal[i]) return dispatched;
    // From up the road: out in time to drive to the terminal and wait in its
    // line (as where() has it) until then, but not before the day starts.
    const line = PILA_MIN_S + hash(this.seed ^ day, i, 100) * (PILA_MAX_S - PILA_MIN_S);
    const drive = this.toTerminal(this.homeS[i]!);
    return Math.max(SERVICE_FROM_S, clockAfter(dispatched - line, -drive));
  }
  private homeAt(i: number, day: number): number {
    return HOME_FROM_S + hash(this.seed ^ day, i, 2) * (HOME_TO_S - HOME_FROM_S);
  }

  /** How far the next terminal is ahead of along-route position `s` (not the one it is at). */
  private toTerminal(s: number): number {
    let best = Infinity;
    for (const t of this.terminals) {
      const d = aheadOf(this.route, s, t);
      if (d > 1 && d < best) best = d;
    }
    return best < Infinity ? best : this.route.polyline.length;
  }

  /**
   * Where jeepney i is at clock t, and whether it is moving, or null when
   * it is not out (before its morning departure, or parked for the night).
   * Leg by leg from its departure: to the next terminal, the wait there, on
   * to the next; after knocking off, the trip under way, then home. A day
   * that started yesterday may run past midnight.
   */
  private where(i: number, t: number): { s: number; moving: boolean } | null {
    const today = Math.floor(t / DAY_S);
    for (const day of [today, today - 1]) {
      const out = day * DAY_S + this.outAt(i, day);
      if (t < out) continue;
      const knockOff = day * DAY_S + this.homeAt(i, day);
      // Carry on from the leg the last call reached, when it is this day's and not later.
      const known = this.legs[i];
      let leg =
        known && known.day === day && known.at <= t
          ? known
          : { day, s: this.homeS[i]!, at: out, trip: 0 };
      for (let guard = 0; guard < 400; guard++) {
        this.legs[i] = leg;
        const toNext = this.toTerminal(leg.s);
        const arrive = clockAfter(leg.at, toNext);
        if (t < arrive)
          return { s: leg.s + drivenSinceMidnight(t) - drivenSinceMidnight(leg.at), moving: true };
        const at = leg.s + toNext;
        if (arrive >= knockOff) {
          // The last trip done. One kept at a terminal stays here; the rest drive back.
          if (this.atTerminal[i]) return null;
          const ways = this.homeSpots[i]!.length > 0 ? this.homeSpots[i]! : [this.homeS[i]!];
          const home = Math.min(...ways.map((w) => aheadOf(this.route, at, w)));
          const back = clockAfter(arrive, home);
          return t < back
            ? { s: at + drivenSinceMidnight(t) - drivenSinceMidnight(arrive), moving: true }
            : null;
        }
        // In the terminal's line before the trip back.
        const wait =
          PILA_MIN_S + hash(this.seed ^ day, i, 100 + leg.trip) * (PILA_MAX_S - PILA_MIN_S);
        if (t < arrive + wait) return { s: at + (t - arrive) * PILA_CREEP_MPS, moving: false };
        leg = { day, s: at + wait * PILA_CREEP_MPS, at: arrive + wait, trip: leg.trip + 1 };
      }
      return null;
    }
    return null;
  }

  /** All jeepneys at clock t. */
  vehicles(t: number): FlowVehicle[] {
    return Array.from({ length: this.count }, (_, i) => this.vehicle(i, t));
  }

  /**
   * The next jeepneys to reach along-route position `stopS` at clock t,
   * soonest first: plate, seconds away, estimated free seats.
   */
  arrivals(
    stopS: number,
    t: number,
    max = 3,
  ): Array<{ plate: string; etaS: number; freeSeats: number; vehicle: number }> {
    const speed = flowSpeedKmh((t / 3600) % 24) / 3.6;
    // People already at the stop board first: about the riders who arrive
    // there between two jeepneys at this hour (as the twin's demand does).
    const queue = Math.round(
      expectedArrivals(
        {
          vehicles: this.count,
          dailyTrips: ridersPerDay(this.route, this.count),
          startHour: 0,
          profile: 'commute',
          seed: 1,
        },
        t % 86_400,
        this.headwayS,
      ) / Math.max(1, this.route.stops.length),
    );
    return this.vehicles(t)
      .filter((v) => v.inService)
      .map((v) => ({
        vehicle: v.index,
        plate: v.plate,
        etaS: aheadOf(this.route, v.s, stopS) / speed,
        // Seats left for someone arriving now, after that queue.
        freeSeats: Math.max(0, v.capacity - v.occupancy - queue),
      }))
      .sort((a, b) => a.etaS - b.etaS)
      .slice(0, max);
  }
}
