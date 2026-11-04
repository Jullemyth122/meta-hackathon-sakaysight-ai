/** Vehicle geometry adapters for the shared passenger journey system. */
import type { FleetSim } from '@/core/fleet/fleetSim';
import { kindOf, PassengerSystem, type PassengerLayout } from '@/core/people/passengerSystem';
import { RiderMotion, seatedAt, standingAt, type RiderPose } from '@/core/people/riderMotion';
import { puvLayout } from '../vehicles/puvCrew';
import { fleetPose } from '../world/lanes';
import { CABIN, PLACE_ORDER, PLACES } from './crew';
import { HALF_WIDTH } from './jeepneyGeometry';

/** Off to one side of the way in, up on the back step: hanging on, as good as on board. */
const hangingOn = (pose: RiderPose) =>
  pose.x < CABIN.doorX &&
  pose.y > CABIN.step!.y - 0.01 &&
  Math.abs(pose.z) > 0.2 &&
  Math.abs(pose.z) < HALF_WIDTH;

export const JEEPNEY_PASSENGER_LAYOUT: PassengerLayout = {
  seats: PLACES,
  seatOrder: PLACE_ORDER,
  seated: (seat, out) =>
    PLACES[seat]!.stands ? standingAt(PLACES[seat]!, 1, out) : seatedAt(CABIN, PLACES[seat]!, out),
  board: (seat, start) => {
    const place = PLACES[seat]!;
    const z = place.stands ? place.z : 0;
    return RiderMotion.boardingVia(CABIN, place, [
      start,
      [CABIN.stepOutsideX - 1, 0, start[2]],
      [CABIN.stepOutsideX - 1, 0, z],
      [CABIN.stepOutsideX, 0, z],
    ]);
  },
  alight: (seat) => RiderMotion.alighting(CABIN, PLACES[seat]!, CABIN.stepOutsideX),
  takeSeat: (from, seat) => RiderMotion.stepIn(CABIN, PLACES[from]!, PLACES[seat]!),
  // In the cabin: past the rear opening AND between the side walls. Someone
  // walking along the outside towards the back step is level with the cabin
  // but not in it, and the jeepney must not pull away with them.
  isInside: (pose) => (pose.x > CABIN.doorX && Math.abs(pose.z) < HALF_WIDTH) || hangingOn(pose),
};

export class CrewState extends PassengerSystem {
  constructor(fleet: FleetSim) {
    super(
      fleet,
      // Each vehicle as it is built: a jeepney, or a modern jeepney, UV Express or bus.
      fleet.vehicles.map((v) =>
        v.kind === 'jeepney' ? JEEPNEY_PASSENGER_LAYOUT : puvLayout(v.kind),
      ),
      (i, out) => fleetPose(fleet, i, out),
    );
  }
}

/** Whether rider `id` is pregnant: drawn so, seated or on the way. */
export function isPregnant(crew: PassengerSystem | undefined, id: number): boolean {
  const r = crew?.passengers.get(id);
  return !!r && kindOf(r) === 'pregnant';
}
