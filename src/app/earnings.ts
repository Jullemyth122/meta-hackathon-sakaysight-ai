/**
 * A jeepney's money today, from the twin's running totals (FleetVehicle.day):
 * the one rule the driver app, the fleet summary and the operator's table
 * all use, with the profit model's fuel and cost figures.
 */

import { ADVISORY } from '@/core/advisory/model';
import { DEFAULT_EXPERIMENT } from '@/core/economics/model';
import type { DayTotals } from '@/core/fleet/fleetSim';
import { FUEL, type FleetKind } from '@/core/vehicles/specs';

/**
 * The boundary a day, by kind, as operators charge in Metro Manila (the
 * user's figures, 2026-11-04): a bus ₱5,500 to ₱7,500; a modern jeepney
 * ₱3,500 to ₱4,000 (its loan of ₱1.4 to 3.3 million behind it); a UV Express
 * ₱1,500 to ₱2,500 (a van's daily rental). By operator, route and unit: each
 * vehicle its own, in ₱100 steps. A traditional jeepney DEFAULT_EXPERIMENT's.
 */
export const BOUNDARY_RANGE_PHP: Readonly<
  Record<Exclude<FleetKind, 'jeepney'>, readonly [number, number]>
> = {
  bus: [5500, 7500],
  modern: [3500, 4000],
  uv: [1500, 2500],
};
export const BUS_BOUNDARY_PHP = BOUNDARY_RANGE_PHP.bus;

/** The boundary the driver of vehicle `id`, a `kind`, pays its owner each day. */
export function boundaryFor(kind: FleetKind = 'jeepney', id = 0): number {
  if (kind === 'jeepney') return DEFAULT_EXPERIMENT.boundaryPhp;
  const [lo, hi] = BOUNDARY_RANGE_PHP[kind];
  return lo + ((id * 7919) % ((hi - lo) / 100 + 1)) * 100;
}

/** "₱3,500 to ₱4,000", the range for a `kind`; null for a traditional jeepney (one figure). */
export function boundaryRangeText(kind: FleetKind = 'jeepney'): string | null {
  if (kind === 'jeepney') return null;
  const [lo, hi] = BOUNDARY_RANGE_PHP[kind];
  return `₱${lo.toLocaleString()} to ₱${hi.toLocaleString()}`;
}

export interface DayMoney {
  km: number;
  idleMin: number;
  litres: number;
  /** All PHP. */
  fares: number;
  diesel: number;
  /** Boundary (or an owner's upkeep) and other daily costs: owed for the day from the start. */
  fixed: number;
  /** Of which the boundary, paid to the owner; 0 for an owner-driver. */
  boundary: number;
  net: number;
}

/**
 * Money from a day's totals: a vehicle today (FleetVehicle) or a closed day of
 * the ledger, with the vehicle's kind and id (its diesel and boundary).
 */
export function dayMoney(v: { day: DayTotals; kind?: FleetKind; id?: number }): DayMoney {
  const km = v.day.metres / 1000;
  // Its own kind's diesel: a bus burns two and a half times a jeepney's a km.
  const fuel = FUEL[v.kind ?? 'jeepney'];
  const litres = km / fuel.kmPerL + (v.day.idleS / 3600) * fuel.idleLPerH;
  const fares = v.day.fareCentavos / 100;
  const diesel = litres * ADVISORY.fuel.dieselPhpPerL;
  // A boundary driver pays the owner; an owner-driver pays their own upkeep.
  const boundary = v.day.owner ? 0 : boundaryFor(v.kind, v.id);
  const fixed =
    (v.day.owner ? DEFAULT_EXPERIMENT.ownerUpkeepPhp : boundary) + DEFAULT_EXPERIMENT.otherDailyPhp;
  return {
    km,
    idleMin: v.day.idleS / 60,
    litres,
    fares,
    diesel,
    fixed,
    boundary,
    net: fares - diesel - fixed,
  };
}

export interface BoundaryLeft {
  faresToday: number;
  dieselToday: number;
  /** Boundary (or upkeep) and other daily costs. */
  owedToday: number;
  /** Still to earn before the day's costs are covered; 0 once they are. */
  shortPhp: number;
  earnedAfterCosts: number;
  lapsDone: number;
  /** Laps at today's rate until the costs are covered. */
  lapsToCover: number;
  source: string;
}

/**
 * How far off covering the day's costs: the boundary tracker. In a real
 * jeepney nothing measures this: the driver says their fares and the diesel
 * they bought, and the phone's GPS gives the kilometres.
 */
export function boundaryLeft(v: { day: DayTotals }, lapKm: number): BoundaryLeft {
  const money = dayMoney(v);
  const lapsDone = money.km / lapKm;
  const perLap = lapsDone > 0 ? (money.fares - money.diesel) / lapsDone : 0;
  const shortPhp = Math.max(0, -money.net);
  return {
    faresToday: Math.round(money.fares),
    dieselToday: Math.round(money.diesel),
    owedToday: money.fixed,
    shortPhp: Math.round(shortPhp),
    earnedAfterCosts: Math.round(Math.max(0, money.net)),
    lapsDone: Math.round(lapsDone * 10) / 10,
    lapsToCover: perLap > 0 ? Math.ceil((shortPhp / perLap) * 10) / 10 : 0,
    source: 'this vehicle’s simulated ledger; a real driver says their fares and diesel',
  };
}

/** Seconds since midnight as "06:42:10". */
export function clockText(s: number): string {
  const t = Math.floor(((s % 86_400) + 86_400) % 86_400);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${two(Math.floor(t / 3600))}:${two(Math.floor((t % 3600) / 60))}:${two(t % 60)}`;
}
