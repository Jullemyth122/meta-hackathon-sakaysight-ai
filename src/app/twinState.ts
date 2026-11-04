/**
 * The twin, as the driver and commuter apps see it (core/advisory/model.ts).
 *
 * The simulation keeps its own richer state; this copies out the few numbers
 * the advisory code needs. A real deployment fills the same shape from GPS
 * phones and cabin cameras instead.
 */

import type { PassengerState, TwinState, VehicleState } from '@/core/advisory/model';
import { kindOf } from '@/core/people/passengerSystem';
import { newRiderPose } from '@/core/people/riderMotion';
import { fleetPose } from '@/scene/world/lanes';
import type { TwinRuntime } from './twinRuntime';

const pose = { x: 0, z: 0, heading: 0 };
const rider = newRiderPose();

export function twinState(runtime: TwinRuntime): TwinState {
  const { fleet, crew, route } = runtime;

  const stopToStopS = fleet.stopToStopS;
  const vehicles = fleet.vehicles.map((v, index): VehicleState => {
    fleetPose(fleet, index, pose);
    return {
      index,
      plate: v.plate,
      kind: v.kind,
      s: v.s,
      direction: v.direction,
      speedMps: v.speedMps,
      occupancy: v.occupancy,
      capacity: v.capacity,
      atStop: v.currentStop,
      // On its last trip it still takes riders, to the terminal; then it parks.
      inService: v.duty !== 'parked',
      // The pace it makes in this hour's traffic: what its arrival times run at.
      paceMps: fleet.pace(index),
      x: pose.x,
      z: pose.z,
      heading: pose.heading,
    };
  });

  const passengers: PassengerState[] = [];
  for (const r of crew.passengers.values()) {
    crew.worldPose(r.id, rider);
    passengers.push({
      id: r.id,
      kind: kindOf(r),
      phase: r.phase,
      originStop: r.originStop,
      destinationStop: r.destinationStop,
      direction: r.direction,
      vehicle: r.vehicleId,
      x: rider.x,
      z: rider.z,
      queuedAt: r.history.find((h) => h.phase === 'waiting')?.at ?? Infinity,
      approachMode: r.approachMode ?? 'walk',
      ...(r.flagS !== undefined && { flagS: r.flagS }),
      ...(r.byStreet && { byStreet: true }),
      ...(r.phase === 'approaching' && r.motion
        ? {
            distanceToStopM: r.motion.remainingDistance(r.t),
            arrivalInS: Math.max(0, r.motion.duration - r.t),
          }
        : r.phase === 'waiting'
          ? { distanceToStopM: 0, arrivalInS: 0 }
          : {}),
    });
  }

  return { route, vehicles, passengers, stopToStopS, slowRoad: fleet.slowRoad };
}
