import { describe, expect, it } from 'vitest';
import { TwinRuntime } from '@/app/twinRuntime';
import { twinState } from '@/app/twinState';
import { FIELD_SCENARIO } from '../fleet/scenario';
import { Polyline } from '../geo/polyline';
import { defaultRoute, type Route } from '../geo/routes';
import { commuterView, riderOf } from './commuter';
import { dispatch } from './dispatch';
import type { PassengerState, TwinState, VehicleState } from './model';

const route: Route = {
  id: 'first-mile',
  name: 'First mile',
  source: 'synthetic',
  projection: null,
  stopsSource: 'placeholder',
  loop: false,
  polyline: new Polyline([
    { x: 0, z: 0 },
    { x: 2000, z: 0 },
  ]),
  stops: [
    { name: 'Start', s: 0, terminal: true },
    { name: 'My stop', s: 1000 },
    { name: 'End', s: 2000, terminal: true },
  ],
};
const person: PassengerState = {
  id: 10,
  phase: 'approaching',
  originStop: 1,
  destinationStop: 2,
  direction: 1,
  vehicle: null,
  x: 700,
  z: 5,
  queuedAt: 0,
  approachMode: 'walk',
  distanceToStopM: 300,
  arrivalInS: 210,
};
function jeep(index: number, s: number): VehicleState {
  return {
    index,
    plate: `JEEP ${index}`,
    s,
    direction: 1,
    speedMps: 4,
    occupancy: 0,
    capacity: 4,
    atStop: null,
    x: s,
    z: 0,
    heading: 0,
  };
}
function state(p: PassengerState = person): TwinState {
  return {
    route,
    passengers: [p],
    vehicles: [jeep(0, 950), jeep(1, 800), jeep(2, 600), jeep(3, 0)],
  };
}

describe('whose ride a picked vehicle shows', () => {
  it('whoever on board has furthest to go, else the first waiting for it, else nobody', () => {
    const twin = new TwinRuntime(defaultRoute(), undefined, { ...FIELD_SCENARIO, startHour: 8 });
    for (let t = 0; t < 900; t++) twin.step(1, 0);
    const state = twinState(twin);
    const plan = dispatch(state);
    const v = state.vehicles.find(
      (x) => state.passengers.filter((p) => p.vehicle === x.index).length > 2,
    )!;
    const id = riderOf(state, plan, v.index);
    const rider = state.passengers.find((p) => p.id === id)!;
    expect(rider.vehicle).toBe(v.index);
    expect(riderOf(state, plan, 9999)).toBeNull();
  });
});

describe('personal first-mile pickup', () => {
  it('skips jeepneys arriving before the walker and shows the later catchable one', () => {
    const s = state();
    const v = commuterView(s, dispatch(s), { passenger: person.id });
    expect(v.approach).toEqual({ mode: 'walk', distanceM: 300, etaS: 210 });
    expect(v.pickup?.vehicle).toBe(3);
    expect(v.arrivals).toHaveLength(3);
    expect(v.arrivals[0]!.catchable).toBe(false);
    expect(v.arrivals.some((a) => a.vehicle === 3 && a.catchable)).toBe(true);
    expect(v.trip.arriveInS).toBeGreaterThan(210);
    expect(dispatch(s).vehicleFor(person.id)).toBeNull();
  });

  it('uses the tricycle arrival estimate when choosing a jeepney', () => {
    const s = state({ ...person, approachMode: 'tricycle', arrivalInS: 40 });
    const v = commuterView(s, dispatch(s), { passenger: person.id });
    expect(v.pickup?.vehicle).toBe(1);
    expect(v.approach?.mode).toBe('tricycle');
  });

  it('does not promise a pickup when all jeepneys pass too early', () => {
    const s = state({ ...person, arrivalInS: 1000 });
    const v = commuterView(s, dispatch(s), { passenger: person.id });
    expect(v.pickup).toBeNull();
    expect(v.trip.arriveInS).toBeNull();
  });

  it('joins FCFS on arrival and includes your own allocated seat', () => {
    const s = state({ ...person, phase: 'waiting', arrivalInS: 0, distanceToStopM: 0 });
    s.vehicles[0]!.capacity = 1;
    const v = commuterView(s, dispatch(s), { passenger: person.id });
    expect(v.approach).toBeNull();
    expect(v.pickup?.vehicle).toBe(0);
    expect(v.pickup?.seatsForYou).toBe(1);
  });
});
