/**
 * What the driver and commuter apps know about the road, as plain data.
 *
 * The advisory code (dispatch, driver view, commuter view) works on this
 * snapshot only, never on the 3D scene or the simulation classes, so it is
 * the same code whether the numbers come from the twin or, later, from real
 * phones and cabin cameras.
 */

import { DIESEL_COMMON_PHP_PER_L } from '../fuel/stations';
import type { Route } from '../geo/routes';
import { aheadOf } from '../geo/routes';
import type { RiderKind } from '../fare';
import { FUEL, type FleetKind } from '../vehicles/specs';
import { stopRoles, stopsAheadFor } from '../vehicles/stops';

export interface VehicleState {
  index: number;
  plate: string;
  /** Along-route distance, metres. */
  s: number;
  direction: 1 | -1;
  speedMps: number;
  /** Riders on board (the cabin camera's count on a real jeepney). */
  occupancy: number;
  capacity: number;
  /** Stop being served right now, or null while driving. */
  atStop: number | null;
  /** World position and heading (metres, Three.js yaw). */
  x: number;
  z: number;
  heading: number;
  /** False while parked for the night. Default true. */
  inService?: boolean;
  /** A traditional jeepney (the default), modern jeepney, UV Express or bus. */
  kind?: FleetKind;
  /**
   * Its moving pace between stops now, in the hour's traffic (the twin's
   * own; a real deployment, the road's recent GPS speeds). Arrival times
   * further ahead run at it; without it, at ADVISORY.cruiseMps.
   */
  paceMps?: number;
}

/** Whether a jeepney is out taking riders: the only ones a rider can wait for. */
export const takingRiders = (v: VehicleState): boolean => v.inService !== false;

export type PassengerPhase =
  'approaching' | 'waiting' | 'boarding' | 'seated' | 'alighting' | 'walking' | 'arrived';

export type ApproachMode = 'walk' | 'tricycle';

export interface PassengerState {
  id: number;
  /** Who they are, as the app knows it; a real deployment knows this of app users only. */
  kind?: RiderKind;
  phase: PassengerPhase;
  originStop: number;
  /**
   * Where they get off. Known ahead of time for app users; for everyone else
   * it becomes known when they call "para", and the cabin camera confirms it.
   */
  destinationStop: number;
  direction: 1 | -1;
  /** Vehicle they are in (boarding, seated or getting off), else null. */
  vehicle: number | null;
  /** World position, metres. */
  x: number;
  z: number;
  /** When they joined the queue (seconds): earlier arrivals board first. */
  queuedAt: number;
  /** Set out to board by the road this far along the route, not at a stop. */
  flagS?: number;
  /** …by a side street off the route, there: only a vehicle driving that street takes them. */
  byStreet?: boolean;
  /** First-mile mode and remaining path estimates, when known. */
  approachMode?: ApproachMode;
  distanceToStopM?: number;
  arrivalInS?: number;
}

export interface TwinState {
  route: Route;
  /** How long the road to each stop has been taking lately (seconds, 0 unknown). */
  stopToStopS?: ArrayLike<number>;
  /** Stretches of road known to be crawling (a real deployment: its phones' speeds). */
  slowRoad?: ReadonlyArray<{ s: number; halfM: number; mps: number }>;
  vehicles: readonly VehicleState[];
  passengers: readonly PassengerState[];
}

/**
 * Tuning, in one place. The fuel figures match the server planner
 * (api/_lib/planner.ts) so the screens and the assistant agree:
 * a traditional diesel jeepney burns ~0.14 L/km empty, plus a little per
 * rider, and each stop-and-go (brake, idle while people board, pull away)
 * costs ~0.028 L. Estimates until measured on a real jeepney.
 */
export const ADVISORY = {
  /** The driver sees this far ahead along the route… */
  horizonM: 1500,
  /** …or this many stops, whichever comes first (always at least the next one). */
  horizonStops: 3,
  /** Someone this close to the jeepney (even just behind it) can still flag it down. */
  eyesightM: 60,
  /** "Para" is called this close to the stop. */
  paraM: 200,
  /** ETAs never assume crawling slower than this (a rush-hour crawl, pulling away). */
  minSpeedMps: 8 / 3.6,
  /** Moving speed on a clear Quirino Highway, for times further ahead when the pace is not known. */
  cruiseMps: 27 / 3.6,
  /** Time lost at a stop where people get on or off (the twin's morning rush averages 30.6 s). */
  dwellS: 30,
  fuel: {
    baseLPerKm: 0.14,
    perRiderLPerKm: 0.0025,
    stopGoL: 0.028,
    /** This week's DOE common pump price on the route (src/data/diesel-prices.json). */
    dieselPhpPerL: DIESEL_COMMON_PHP_PER_L,
  },
} as const;

/**
 * Diesel a kilometre for a vehicle of `kind` with `riders` on board: the
 * jeepney's figures (ADVISORY.fuel), scaled by how far each type goes on a
 * litre (FUEL in vehicles/specs.ts).
 */
export function litresPerKm(kind: FleetKind | undefined, riders: number): number {
  const scale = FUEL.jeepney.kmPerL / FUEL[kind ?? 'jeepney'].kmPerL;
  return (ADVISORY.fuel.baseLPerKm + ADVISORY.fuel.perRiderLPerKm * riders) * scale;
}

/** Whether vehicle `v` can pick up someone waiting to travel in `direction`. */
/**
 * Whether `v` takes riders on at `stop` (core/vehicles/stops.ts): a jeepney
 * or bus at every stop of its route, a UV Express at its terminals only.
 */
export function loadsAt(route: Route, v: VehicleState, stop: number): boolean {
  return stopRoles(route, v.kind ?? 'jeepney').loads[stop] === true;
}

/**
 * Whether `v`, taking riders on at `stop`, lets them off at `destination`:
 * a bus or UV Express only at its own stops up to its terminal.
 */
export function carries(route: Route, v: VehicleState, stop: number, destination: number): boolean {
  const kind = v.kind ?? 'jeepney';
  if (kind === 'jeepney' || kind === 'modern') return true;
  return stopsAheadFor(route, kind, stop, v.direction).includes(destination);
}

export function serves(route: Route, v: VehicleState, direction: 1 | -1): boolean {
  return route.loop || v.direction === direction;
}

/**
 * How far vehicle `v` still has to drive to reach along-route position `s`.
 * Negative means it is behind the vehicle (a line route); a loop always
 * wraps forward, so everything is ahead, the far side included.
 */
export function distanceTo(route: Route, v: VehicleState, s: number): number {
  return route.loop ? aheadOf(route, v.s, s) : (s - v.s) * v.direction;
}

/** Distance riding from stop `from` to stop `to` in `direction` (forward around a loop). */
export function rideDistance(route: Route, from: number, to: number, direction: 1 | -1): number {
  const a = route.stops[from]!.s;
  const b = route.stops[to]!.s;
  return route.loop ? aheadOf(route, a, b) : Math.max(0, (b - a) * direction);
}

/** Seconds to cover `metres` at a vehicle's speed, never slower than the floor. */
export function travelSeconds(metres: number, speedMps = ADVISORY.cruiseMps): number {
  return metres / Math.max(speedMps, ADVISORY.minSpeedMps);
}
