import { describe, expect, it } from 'vitest';
import { dispatch } from '../advisory/dispatch';
import { driverView } from '../advisory/driver';
import { commuterView } from '../advisory/commuter';
import { twinState } from '@/app/twinState';
import type { TwinRuntime } from '@/app/twinRuntime';
import { FleetSim, DEFAULT_FLEET } from '../fleet/fleetSim';
import { Polyline } from '../geo/polyline';
import type { Route } from '../geo/routes';
import { JEEPNEY_PASSENGER_LAYOUT } from '@/scene/jeepney/crewState';
import { fleetPose } from '@/scene/world/lanes';
import { PassengerSystem } from './passengerSystem';

const route: Route = {
  id: 'roadside',
  name: 'Roadside test',
  source: 'synthetic',
  projection: null,
  stopsSource: 'placeholder',
  loop: true,
  polyline: new Polyline([
    { x: 0, z: 0 },
    { x: 2000, z: 0 },
    { x: 2000, z: 100 },
    { x: 0, z: 100 },
    { x: 0, z: 0 },
  ]),
  stops: [
    { name: 'Start', s: 0, terminal: true },
    { name: 'Next', s: 900 },
    { name: 'Later', s: 1500 },
    { name: 'Far', s: 2100, terminal: true },
    { name: 'Back', s: 3000 },
  ],
};

/** One jeepney at s = 100; `aboard` riders on it, going all the way. */
function setup(aboard = 0) {
  const fleet = new FleetSim(route, { ...DEFAULT_FLEET, count: 1, demandPerStopPerMin: 0 });
  const v = fleet.vehicles[0]!;
  fleet.waiting.fill(0);
  Object.assign(v, { s: 100, nextStop: 1, currentStop: null, occupancy: 0, direction: 1 });
  const crew = new PassengerSystem(fleet, [JEEPNEY_PASSENGER_LAYOUT], (i, out) =>
    fleetPose(fleet, i, out),
  );
  for (const r of [...crew.passengers.values()]) crew.passengers.delete(r.id);
  for (let k = 0; k < aboard; k++) {
    const id = crew.join(0, 3, 0);
    const r = crew.passengers.get(id)!;
    fleet.waiting[0] = 0;
    Object.assign(r, { phase: 'seated', vehicleId: 0, lastVehicleId: 0, seat: k, inside: true });
  }
  const snapshot = () => twinState({ fleet, crew, route } as TwinRuntime);
  const run = (seconds: number, until: () => boolean = () => false) => {
    for (let t = 0; t < seconds && !until(); t += 0.1) {
      fleet.step(0.1);
      crew.update(0.1);
    }
  };
  return { fleet, crew, v, snapshot, run };
}

describe('waiting by the road, not at a stop', () => {
  it('pulls over right there, takes them on, and still makes its next stop', () => {
    const { crew, v, run } = setup();
    const id = crew.join(1, 2, 0, 'walk', { flagS: 500 });
    const rider = crew.passengers.get(id)!;
    expect(rider.phase).toBe('waiting');
    run(120, () => crew.busy(v.id));
    // Stopped for them, 400 m short of the next stop.
    expect(v.s).toBe(500);
    expect(v.speedMps).toBe(0);
    run(30, () => rider.phase === 'seated');
    expect(rider.vehicleId).toBe(v.id);
    run(30, () => v.currentStop === null);
    // Nobody at the stop, nobody off there: on past it, and it was never skipped.
    expect(v.nextStop).toBe(1);
    run(120, () => v.nextStop !== 1);
    expect(rider.phase).toBe('seated');
  });

  it('lets them off where they were going, paying for the ride from their spot', () => {
    const { crew, v, run } = setup();
    const id = crew.join(1, 2, 0, 'walk', { flagS: 500 });
    const rider = crew.passengers.get(id)!;
    run(240, () => rider.phase === 'walking');
    expect(rider.phase).toBe('walking');
    expect(rider.destinationStop).toBe(2);
    expect(v.day.riders).toBe(1);
  });

  it('goes on to where they said they were going, over the road if it is across', () => {
    const { crew, v, run } = setup();
    // Off at Later, heading along the top of the map: to a spot on the far side, 100 m on.
    const off = route.polyline.pointAt(1500);
    const to = { x: off.x + 100, z: off.z - 9 };
    const id = crew.join(1, 2, 0, 'walk', {
      flagS: 500,
      onward: {
        way: {
          points: [{ x: off.x, z: off.z }, { x: off.x + 100, z: off.z }, to],
          widths: [12, 0],
          metres: 109,
        },
        mode: 'walk',
        to,
      },
    });
    const rider = crew.passengers.get(id)!;
    run(300, () => rider.phase === 'walking');
    expect(rider.phase).toBe('walking');
    expect(v.currentStop).toBe(2);
    run(180, () => rider.phase === 'arrived');
    expect(rider.phase).toBe('arrived');
    expect(Math.hypot(rider.pose.x - to.x, rider.pose.z - to.z)).toBeLessThan(0.5);
  });

  it('opens up for them just short of the spot when traffic holds it there', () => {
    const { crew, fleet, v, run } = setup();
    const rider = crew.passengers.get(crew.join(1, 2, 0, 'walk', { flagS: 500 }))!;
    Object.assign(v, { s: 480, speedMps: 0 });
    // A vehicle of another route stopped just ahead, in its lane.
    fleet.trafficAhead[v.id] = 14;
    run(60, () => rider.phase === 'seated');
    expect(rider.phase).toBe('seated');
    expect(v.s).toBeLessThan(481);
  });

  it('drives past when full', () => {
    const { crew, v, run } = setup(v0Capacity());
    const id = crew.join(1, 2, 0, 'walk', { flagS: 500 });
    run(60, () => v.s > 600);
    expect(v.s).toBeGreaterThan(600);
    expect(crew.passengers.get(id)!.phase).toBe('waiting');
  });

  it('is not stopped for once it has gone past', () => {
    const { crew, v, run } = setup();
    Object.assign(v, { s: 700 });
    const id = crew.join(1, 2, 0, 'walk', { flagS: 500 });
    run(40, () => v.s > 880);
    expect(v.s).toBeGreaterThan(880);
    expect(crew.passengers.get(id)!.phase).toBe('waiting');
  });

  it('does not stop at the stop after them on their account', () => {
    const { crew, v, run } = setup();
    Object.assign(v, { s: 700 });
    crew.join(1, 2, 0, 'walk', { flagS: 500 });
    run(30, () => v.currentStop !== null || v.s > 1000);
    expect(v.currentStop).toBeNull();
  });

  it('tells the driver, and the commuter, where it really is', () => {
    const { crew, snapshot } = setup();
    const id = crew.join(1, 2, 0, 'walk', { flagS: 500 });
    const state = snapshot();
    const plan = dispatch(state);
    const driver = driverView(state, 0, plan);
    expect(driver.roadside).toHaveLength(1);
    expect(driver.roadside[0]).toMatchObject({ distanceM: 400, canTake: true });
    expect(driver.ahead[0]!.waiting).toBe(0);
    const commuter = commuterView(state, plan, { passenger: id });
    expect(commuter.roadside).toBe(true);
    expect(commuter.stop.name).toBe('your spot by the road');
    expect(commuter.queueAhead).toBe(0);
    expect(commuter.arrivals[0]!.distanceM).toBe(400);
    expect(commuter.pickup?.vehicle).toBe(0);
  });

  it('never makes a rider at the stop wait for someone by the road', () => {
    const { crew, v, run } = setup();
    crew.join(1, 2, 0, 'walk', { flagS: 500 });
    const atStop = crew.join(1, 2, 0);
    run(240, () => crew.passengers.get(atStop)!.phase === 'seated');
    expect(crew.passengers.get(atStop)!.vehicleId).toBe(v.id);
    expect(v.s).toBeGreaterThanOrEqual(880);
  });
});

function v0Capacity(): number {
  return JEEPNEY_PASSENGER_LAYOUT.seats.length;
}
