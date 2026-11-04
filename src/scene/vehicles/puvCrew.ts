/**
 * Riders in a modern jeepney, UV Express or bus: their seats (from the
 * model, vehicleGeometry.ts), the order they take them, which door they use,
 * and how they move inside. The same PassengerLayout the jeepney has
 * (jeepney/crewState.ts), so the passenger system runs all of them alike.
 *
 *   modern jeepney  in and out at its one door; benches along the walls,
 *                   sat on from the aisle, as in a jeepney (with headroom)
 *   bus             in at the front door, out at the middle one; rows of
 *                   two, window seats first, then the aisle seats
 *   UV Express      the two seats beside the driver from the cab door; the
 *                   rows from the sliding door, crouched and squeezing
 *                   ("siksikan"): ducking through the low doorway, bent
 *                   double under the 1.55 m roof, a hand on the seat backs,
 *                   shuffling sideways along a row; the back row first and
 *                   the far seat of each row first, so nobody climbs over
 *                   anyone already sitting
 *
 * Packed, the modern jeepney and the bus take riders standing in the aisle
 * (vehicleGeometry's `standing`), from the far end first ("usog sa likod"),
 * and only once every seat is gone. They sit as soon as a seat comes free.
 */

import type { PassengerLayout } from '@/core/people/passengerSystem';
import {
  RiderMotion,
  standingAt,
  type CabinStyle,
  type RiderPose,
  type Seat,
  type SideDoor,
} from '@/core/people/riderMotion';
import { VEHICLES, type VehicleKind } from '@/core/vehicles/specs';
import { footholds, WALL } from './bodyKit';
import { BUS_AISLE_Z, vehicleGeometry } from './vehicleGeometry';

/** Boarders stand this far out from the side, facing the door. */
const OUTSIDE_M = 0.45;

interface Style {
  stoop: number;
  lean: number;
  aisleMps: number;
  shuffleMps: number;
  reach: number;
  /** Ducking through each door (as listed in the spec). */
  duck: readonly number[];
  /** Where people walk along the inside from each door. */
  aisleZ: (halfW: number) => readonly number[];
}

const STYLE: Record<VehicleKind, Style> = {
  // 2.1 m of headroom: upright, a hand on the rail.
  bus: {
    stoop: 1,
    lean: 0.04,
    aisleMps: 0.9,
    shuffleMps: 0.55,
    reach: 0.35,
    duck: [1, 1],
    aisleZ: () => [BUS_AISLE_Z, BUS_AISLE_Z],
  },
  // 1.75 m: a tall rider stoops a little.
  modern: {
    stoop: 0.96,
    lean: 0.08,
    aisleMps: 0.8,
    shuffleMps: 0.5,
    reach: 0.35,
    duck: [0.95],
    aisleZ: () => [0],
  },
  // 1.55 m and seats close together: bent double, slow, holding on.
  uv: {
    stoop: 0.74,
    lean: 0.38,
    aisleMps: 0.42,
    shuffleMps: 0.28,
    reach: 0.75,
    duck: [0.72, 0.78],
    aisleZ: (halfW) => [halfW - 0.39, halfW - 0.44],
  },
};

/**
 * The order seats are taken. A modern jeepney: spread along both benches, as
 * on a jeepney. A bus: window seats first, spread over the rows, then the
 * aisle seats. A UV Express: from the back row forward and from the far
 * side of each row, the seats beside the driver last.
 */
function seatOrder(kind: VehicleKind, seats: readonly Seat[]): number[] {
  const ids = seats.map((_, i) => i);
  const n = seats.length;
  if (kind === 'uv')
    return ids.sort(
      (a, b) =>
        Number(seats[a]!.x > 1) - Number(seats[b]!.x > 1) ||
        seats[a]!.x - seats[b]!.x ||
        seats[a]!.z - seats[b]!.z,
    );
  const spread = (i: number) => (i * 7) % n;
  if (kind === 'bus')
    return ids.sort((a, b) =>
      Math.abs(seats[b]!.z) - Math.abs(seats[a]!.z) > 0.2
        ? 1
        : Math.abs(seats[a]!.z) - Math.abs(seats[b]!.z) > 0.2
          ? -1
          : spread(a) - spread(b),
    );
  return ids.sort((a, b) => spread(a) - spread(b));
}

const layouts = new Map<VehicleKind, PassengerLayout>();

export function puvLayout(kind: VehicleKind): PassengerLayout {
  let layout = layouts.get(kind);
  if (layout) return layout;
  const S = VEHICLES[kind];
  const built = vehicleGeometry(kind);
  const places = [...built.seats, ...built.standing];
  const halfW = S.widthM / 2;
  const style = STYLE[kind];
  const cabin: CabinStyle = {
    floorY: S.floorM,
    seatedRootY: built.seats[0]!.y!,
    stoop: style.stoop,
    lean: style.lean,
    aisleMps: style.aisleMps,
    shuffleMps: style.shuffleMps,
    reach: style.reach,
  };
  const aisles = style.aisleZ(halfW);
  const doors: SideDoor[] = S.doors.map((d, k) => ({
    x: (d.x0 + d.x1) / 2,
    outsideZ: halfW + OUTSIDE_M,
    steps: footholds(d, halfW, S.floorM),
    aisleZ: aisles[k]!,
    duck: style.duck[k]!,
  }));
  const cab = S.doors.findIndex((d) => d.opens === 'hinged');
  // Which door each seat is reached by: on a van the seats beside the
  // driver from the cab door; on a bus in at the front, out at the middle.
  const doorIn = (seat: number) => (cab >= 0 && places[seat]!.x > 1 ? cab : 0);
  const doorOut = (seat: number) =>
    kind === 'bus' ? 1 : cab >= 0 && places[seat]!.x > 1 ? cab : 0;
  const fromDoor = (k: number) => Math.abs(places[k]!.x - doors[0]!.x);
  const standingOrder = places
    .map((_, k) => k)
    .slice(built.seats.length)
    .sort((a, b) => fromDoor(b) - fromDoor(a));
  const xr = -S.lengthM / 2;
  const xf = S.lengthM / 2;
  layout = {
    seats: places,
    seatOrder: [...seatOrder(kind, built.seats), ...standingOrder],
    seated: (k, out) =>
      places[k]!.stands ? standingAt(places[k]!, style.stoop, out) : seatedPose(places[k]!, out),
    board: (k, start) => RiderMotion.throughSideDoor(doors[doorIn(k)]!, cabin, places[k]!, start),
    alight: (k) => RiderMotion.outOfSideDoor(doors[doorOut(k)]!, cabin, places[k]!),
    takeSeat: (from, k) => RiderMotion.standToSeat(doors[0]!, cabin, places[from]!, places[k]!),
    // Inside: past the door's plane, within the body's length.
    isInside: (pose) => Math.abs(pose.z) < halfW - WALL && pose.x > xr && pose.x < xf,
  };
  layouts.set(kind, layout);
  return layout;
}

/** Sitting still in `seat`. */
function seatedPose(seat: Seat, out: RiderPose): RiderPose {
  out.x = seat.x;
  out.y = seat.y!;
  out.z = seat.z;
  out.yaw = seat.standX !== undefined ? 0 : seat.yaw;
  out.sit = 1;
  out.walk = 0;
  out.phase = 0;
  out.stoop = 1;
  out.lean = 0;
  out.lift = 0;
  out.liftLeg = 0;
  out.reach = 0;
  out.hold = 0;
  return out;
}
