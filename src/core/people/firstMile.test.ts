import { describe, expect, it } from 'vitest';
import { twinState } from '@/app/twinState';
import type { TwinRuntime } from '@/app/twinRuntime';
import { incomingAtStop } from '../advisory/approach';
import { FleetSim, DEFAULT_FLEET } from '../fleet/fleetSim';
import { Polyline } from '../geo/polyline';
import type { Route } from '../geo/routes';
import { JEEPNEY_PASSENGER_LAYOUT } from '@/scene/jeepney/crewState';
import { fleetPose } from '@/scene/world/lanes';
import { PassengerSystem } from './passengerSystem';

const route: Route = {
  id: 'first-mile',
  name: 'First mile test',
  source: 'synthetic',
  projection: null,
  stopsSource: 'placeholder',
  loop: false,
  polyline: new Polyline([
    { x: 0, z: 0 },
    { x: 600, z: 0 },
    { x: 600, z: 600 },
  ]),
  stops: [
    { name: 'Start', s: 0, terminal: true },
    { name: 'Middle', s: 600 },
    { name: 'End', s: 1200, terminal: true },
  ],
};

function setup() {
  const fleet = new FleetSim(route, { ...DEFAULT_FLEET, count: 1, demandPerStopPerMin: 0 });
  fleet.vehicles[0]!.occupancy = 0;
  fleet.waiting.fill(0);
  const crew = new PassengerSystem(fleet, [JEEPNEY_PASSENGER_LAYOUT], (i, out) =>
    fleetPose(fleet, i, out),
  );
  const snapshot = () => twinState({ fleet, crew, route } as TwinRuntime);
  return { fleet, crew, snapshot };
}

describe('personal first-mile journeys', () => {
  it('starts an already-at-stop commuter in the real waiting queue', () => {
    const { crew, fleet, snapshot } = setup();
    const id = crew.join(1, 2, 0);
    expect(crew.passengers.get(id)!.phase).toBe('waiting');
    expect(crew.passengers.get(id)!.motion).toBeNull();
    expect(fleet.waiting[1]).toBe(1);
    expect(snapshot().passengers[0]).toMatchObject({
      arrivalInS: 0,
      distanceToStopM: 0,
      queuedAt: 0,
    });
    expect(incomingAtStop(snapshot(), 1)).toEqual([]);
  });

  it('reports and animates a full 500 m tricycle approach, then joins the queue on arrival', () => {
    const { crew, snapshot } = setup();
    const id = crew.join(1, 2, 500, 'tricycle');
    const start = snapshot().passengers[0]!;
    expect(start.distanceToStopM).toBeCloseTo(500);
    expect(start.arrivalInS).toBeCloseTo(100);
    expect(start.queuedAt).toBe(Infinity);
    expect(incomingAtStop(snapshot(), 1)[0]).toMatchObject({ passenger: id, mode: 'tricycle' });
    crew.update(10);
    const moved = snapshot().passengers[0]!;
    expect(moved.distanceToStopM).toBeCloseTo(450);
    expect(moved.arrivalInS).toBeCloseTo(90);
    expect(Math.hypot(moved.x - start.x, moved.z - start.z)).toBeGreaterThan(40);
    crew.update(91);
    expect(snapshot().passengers[0]).toMatchObject({
      phase: 'waiting',
      arrivalInS: 0,
      distanceToStopM: 0,
    });
    expect(crew.passengers.get(id)!.pose.sit).toBe(0);
    expect(incomingAtStop(snapshot(), 1)).toEqual([]);
  });

  it('uses walking time and preserves first-mile distance at a line terminal', () => {
    const { crew, snapshot } = setup();
    crew.join(0, 1, 500, 'walk');
    const p = snapshot().passengers[0]!;
    expect(p.distanceToStopM).toBeCloseTo(500);
    expect(p.arrivalInS).toBeCloseTo(500 / 1.4);
    crew.update(100);
    expect(snapshot().passengers[0]!.distanceToStopM).toBeCloseTo(360);
  });

  it('keeps distant approaches hidden until they are within 500 m and excludes cancelled trips', () => {
    const { crew, fleet, snapshot } = setup();
    const id = crew.join(1, 2, 600, 'tricycle');
    expect(incomingAtStop(snapshot(), 1)).toEqual([]);
    crew.update(21);
    expect(incomingAtStop(snapshot(), 1)).toHaveLength(1);
    expect(crew.cancel(id)).toBe(true);
    expect(fleet.waiting[1]).toBe(0);
    expect(incomingAtStop(snapshot(), 1)).toEqual([]);
    expect(crew.cancel(id)).toBe(false);
  });

  it('does not cancel someone boarding a jeepney', () => {
    const { crew, fleet } = setup();
    const id = crew.join(1, 2, 0);
    const p = crew.passengers.get(id)!;
    p.phase = 'boarding';
    p.vehicleId = 0;
    expect(crew.cancel(id)).toBe(false);
    expect(crew.passengers.has(id)).toBe(true);
    expect(fleet.waiting[1]).toBe(1);
  });

  it('brings some generated riders from 100–500 m away, on foot or by tricycle', () => {
    const { crew, fleet, snapshot } = setup();
    // Out of the way: it stands still here, and nobody crosses through a vehicle.
    fleet.vehicles[0]!.s = 100;
    crew.demand(1, 200);
    // Both directions: a line's middle stop is served both ways.
    const incoming = incomingAtStop(snapshot(), 1);
    // About a third come from further away; the rest walk in the last few metres.
    expect(incoming.filter((p) => p.distanceM >= 99).length).toBeGreaterThan(40);
    expect(incoming.filter((p) => p.distanceM >= 99).length).toBeLessThan(110);
    expect(incoming.every((p) => p.distanceM <= 500.5)).toBe(true);
    const tricycles = incoming.filter((p) => p.mode === 'tricycle');
    expect(tricycles.length).toBeGreaterThan(5);
    expect(tricycles.every((p) => p.distanceM > 250)).toBe(true);
    // Everyone reaches the queue: the furthest walker, 500 m, in well under 10 minutes.
    for (let t = 0; t < 600; t++) crew.update(1);
    expect([...crew.passengers.values()].every((p) => p.phase === 'waiting')).toBe(true);
  });

  it('boards by arrival at the stop rather than when the first-mile trip was started', () => {
    const { crew, fleet } = setup();
    const stillComing = crew.join(1, 2, 100);
    const alreadyHere = crew.join(1, 2, 0);
    crew.update(80);
    const vehicle = fleet.vehicles[0]!;
    Object.assign(vehicle, { s: 600, direction: 1, currentStop: 1, speedMps: 0 });
    crew.arrive(vehicle, 1);
    crew.update(0.1);
    expect(crew.passengers.get(alreadyHere)!.phase).toBe('boarding');
    expect(crew.passengers.get(stillComing)!.phase).toBe('waiting');
  });
});
