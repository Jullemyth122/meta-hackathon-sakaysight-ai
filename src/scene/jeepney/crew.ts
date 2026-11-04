/**
 * The people side of the jeepney: where its seats are, the order riders take
 * them, and the cabin layout the rider motions use. Shared by the live twin
 * and the sensor lab, so a jeepney seats people the same way in both.
 */

import type { CabinLayout, Seat } from '@/core/people/riderMotion';
import { JEEPNEY_SABIT, JEEPNEY_SEATS } from '@/core/vehicles/specs';
import { benchSeat, BODY_LIFT, REAR_X, SEATED_ROOT_Y } from './jeepneyGeometry';

/** Seats per jeepney (two facing benches of 11). */
export const SEATS = JEEPNEY_SEATS;

export const CABIN: CabinLayout = {
  doorX: REAR_X,
  stepOutsideX: REAR_X - 0.5,
  insideX: REAR_X + 0.2,
  floorY: BODY_LIFT + 0.06, // top of the cabin floor
  seatedRootY: SEATED_ROOT_Y,
  // The rear boarding step (jeepneyGeometry: x -3.52…-3.1, top 0.46 m).
  step: { x: REAR_X - 0.21, y: BODY_LIFT - 0.16 },
};

/** Seat k, facing across the aisle (ground frame of the jeepney). */
export const SEATS_AT: readonly Seat[] = Array.from({ length: SEATS }, (_, k) => {
  const seat = benchSeat(k, SEATS);
  return { x: seat.x, z: seat.z, yaw: seat.side > 0 ? Math.PI / 2 : -Math.PI / 2 };
});

/**
 * The sabit, once the benches are full: two riders hanging on at the back
 * step, one to each side of the way in, each with both hands on the grab pole
 * on their side (jeepneyGeometry: x REAR_X - 0.06, z ±0.45, up to 2.05 m).
 */
export const SABIT_AT: readonly Seat[] = Array.from({ length: JEEPNEY_SABIT }, (_, k) => {
  const side = k % 2 ? -1 : 1;
  const high = [REAR_X - 0.06, 1.75, side * 0.45] as const;
  const low = [REAR_X - 0.06, 1.42, side * 0.45] as const;
  return {
    x: REAR_X - 0.24,
    y: CABIN.step!.y,
    z: side * 0.33,
    yaw: 0,
    stands: true,
    holds: side > 0 ? [high, low] : [low, high],
  };
});

/** Everywhere a rider can be: the seats, then the back step. */
export const PLACES: readonly Seat[] = [...SEATS_AT, ...SABIT_AT];

/**
 * The order riders take seats: spread along both benches, the way people
 * leave a gap to the next stranger, instead of filling strictly from the back.
 */
export const SEAT_ORDER: readonly number[] = (() => {
  const perSide = SEATS / 2;
  const rows = Array.from({ length: perSide }, (_, j) => j).sort(
    (a, b) => ((a * 7) % perSide) - ((b * 7) % perSide) || a - b,
  );
  return rows.flatMap((j) => [j * 2, j * 2 + 1]);
})();

/** The order places are taken: the benches, then the back step. */
export const PLACE_ORDER: readonly number[] = [...SEAT_ORDER, ...SABIT_AT.map((_, k) => SEATS + k)];

/** Stable identity for the person in vehicle i, seat k (k = SEATS: the driver). */
export const crewSeed = (i: number, k: number) => i * 64 + k;

/** Look seed for twin rider `riderId` (CrewState), clear of crewSeed and the lab's. */
export const riderSeed = (riderId: number) => 1_000_000 + riderId;
