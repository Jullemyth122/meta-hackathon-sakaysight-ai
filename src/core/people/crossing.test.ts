import { describe, expect, it } from 'vitest';
import { fleetPose } from '@/scene/world/lanes';
import { JEEPNEY_PASSENGER_LAYOUT } from '@/scene/jeepney/crewState';
import { FleetSim, DEFAULT_FLEET, JEEPNEY_LENGTH_M, type FleetVehicle } from '../fleet/fleetSim';
import { Polyline } from '../geo/polyline';
import { TwinRuntime } from '@/app/twinRuntime';
import { FIELD_SCENARIO } from '../fleet/scenario';
import { defaultRoute, kerbAt, type Route } from '../geo/routes';
import { VEHICLES } from '../vehicles/specs';
import { crossingsOf, RoadIndex, type Crossing } from './crossing';
import { PassengerSystem, type Passenger } from './passengerSystem';
import { RiderMotion } from './riderMotion';

/** Out along z = 0 and back along the same road: traffic both ways. */
const route: Route = {
  id: 'crossing',
  name: 'Crossing test',
  source: 'synthetic',
  projection: null,
  stopsSource: 'placeholder',
  loop: true,
  polyline: new Polyline([
    { x: 0, z: 0 },
    { x: 3000, z: 0 },
    { x: 3000, z: 0.5 },
    { x: 0, z: 0.5 },
    { x: 0, z: 0 },
  ]),
  stops: [
    { name: 'Start', s: 0, terminal: true },
    { name: 'A', s: 800 },
    { name: 'Far', s: 3000, terminal: true },
    { name: 'B', s: 5000 },
  ],
};

type P3 = readonly [number, number, number];
const over = (x: number): P3[] => [
  [x, 0, -30],
  [x, 0, 30],
];

function setup(count: number) {
  const fleet = new FleetSim(route, { ...DEFAULT_FLEET, count, demandPerStopPerMin: 0 });
  fleet.waiting.fill(0);
  fleet.vehicles.forEach((v, i) =>
    Object.assign(v, {
      duty: 'service',
      s: (i * route.polyline.length) / count,
      speedMps: 8,
      direction: 1,
      currentStop: null,
      occupancy: 0,
      nextStop: route.stops.findIndex((st) => st.s > (i * route.polyline.length) / count),
    }),
  );
  const crew = new PassengerSystem(
    fleet,
    fleet.vehicles.map(() => JEEPNEY_PASSENGER_LAYOUT),
    (i, out) => fleetPose(fleet, i, out),
  );
  for (const r of [...crew.passengers.values()]) crew.passengers.delete(r.id);
  const pose = { x: 0, z: 0, heading: 0 };
  /** Someone walking over the road at `x`. */
  const walker = (x: number): Passenger => {
    const id = crew.join(1, 2, 100);
    const r = crew.passengers.get(id)!;
    fleet.waiting[1] = 0;
    r.phase = 'walking';
    r.motion = RiderMotion.walking(over(x));
    r.t = 0;
    return r;
  };
  /** Whether any vehicle's body is on `r`, while they are on the road. */
  const hit = (r: Passenger) => {
    if (Math.abs(r.pose.z) > 7) return false;
    return fleet.vehicles.some((_, i) => {
      const p = fleetPose(fleet, i, pose);
      const half = JEEPNEY_LENGTH_M / 2;
      return Math.abs(p.x - r.pose.x) < half + 0.3 && Math.abs(p.z - r.pose.z) < 1.5;
    });
  };
  const step = (dt: number) => {
    fleet.step(dt);
    crew.update(dt);
  };
  return { fleet, crew, walker, hit, step };
}

describe('finding where a way crosses the road', () => {
  const road = new RoadIndex(route);

  it('finds the crossing, and both ways of the road', () => {
    const [c] = crossingsOf(RiderMotion.walking(over(1500)), road);
    expect(c).toBeDefined();
    expect(c!.passes).toHaveLength(2);
    expect(c!.t0).toBeGreaterThan(10);
    expect(c!.t1).toBeLessThan(40);
  });

  it('does not take walking along the road, or to the kerb and back, for a crossing', () => {
    const along = RiderMotion.walking([
      [100, 0, 2],
      [900, 0, 2],
    ]);
    expect(crossingsOf(along, road)).toEqual([]);
    const back = RiderMotion.walking([
      [100, 0, 20],
      [100, 0, 2],
      [120, 0, 20],
    ]);
    expect(crossingsOf(back, road)).toEqual([]);
    const beside = RiderMotion.walking([
      [100, 0, 20],
      [900, 0, 20],
    ]);
    expect(crossingsOf(beside, road)).toEqual([]);
  });
});

describe('someone crossing the road', () => {
  it('stops the traffic both ways, and everyone goes on afterwards', () => {
    const { fleet, crew, walker, step } = setup(2);
    const [out, back] = fleet.vehicles as [FleetVehicle, FleetVehicle];
    const r = walker(1500);
    let stillOut = false;
    let stillBack = false;
    let done = false;
    let placed = false;
    for (let t = 0; t < 300 && !done; t += 0.1) {
      step(0.1);
      // As they come to the kerb, one coming up to the line each way along the road.
      if (!placed && crew.crossingsNow.length > 0) {
        placed = true;
        Object.assign(out, { s: 1500 - 30, speedMps: 5, nextStop: 2, currentStop: null });
        Object.assign(back, {
          s: route.polyline.length - 1500 - 30,
          speedMps: 5,
          nextStop: 0,
          currentStop: null,
        });
      }
      if (Math.abs(r.pose.z) < 3) {
        stillOut ||= out.speedMps < 0.1;
        stillBack ||= back.speedMps < 0.1;
      }
      done = r.pose.z > 15;
    }
    expect(done).toBe(true);
    expect(stillOut).toBe(true);
    expect(stillBack).toBe(true);
    const before = fleet.vehicles.map((v) => v.s);
    for (let t = 0; t < 30; t += 0.1) step(0.1);
    expect(fleet.vehicles.some((v, i) => v.s !== before[i])).toBe(true);
    expect(crew.crossingsNow).toEqual([]);
  });

  it('lets the traffic go once they are past its lane, before they are off the road', () => {
    // (Here both ways run nearly on one line: they are past both lanes at once.)
    const { fleet, crew, walker, step, hit } = setup(2);
    const [out, back] = fleet.vehicles as [FleetVehicle, FleetVehicle];
    const r = walker(1500);
    let placed = false;
    let stopped = false;
    let wentWhileOnRoad = false;
    let touched = false;
    for (let t = 0; t < 300 && r.pose.z <= 15; t += 0.1) {
      step(0.1);
      if (!placed && crew.crossingsNow.length > 0) {
        placed = true;
        Object.assign(out, { s: 1500 - 30, speedMps: 5, nextStop: 2, currentStop: null });
        Object.assign(back, {
          s: route.polyline.length - 1500 - 30,
          speedMps: 5,
          nextStop: 0,
          currentStop: null,
        });
      }
      stopped ||= out.speedMps < 0.1 && back.speedMps < 0.1;
      // Still on the road (it runs out to 5 m or so), but clear of the vehicles' lanes.
      if (stopped && r.pose.z < 4 && out.speedMps > 0.3 && back.speedMps > 0.3)
        wentWhileOnRoad = true;
      touched ||= hit(r);
    }
    expect(stopped).toBe(true);
    expect(wentWhileOnRoad).toBe(true);
    expect(touched).toBe(false);
  });

  it('holds them at the kerb for a vehicle too close to stop', () => {
    const { fleet, walker, step } = setup(1);
    const v = fleet.vehicles[0]!;
    const r = walker(1500);
    // Just about to reach the line as they reach the kerb.
    Object.assign(v, { s: 1490 - 8 * 16, speedMps: 8, nextStop: 2 });
    let least = Infinity;
    for (let t = 0; t < 60; t += 0.05) {
      step(0.05);
      if (Math.abs(r.pose.z) < kerbAt(route, 1500)) least = Math.min(least, Math.abs(v.s - 1500));
      if (r.pose.z > 15) break;
    }
    expect(r.pose.z).toBeGreaterThan(15);
    // Never with the jeepney's body on their line.
    expect(least).toBeGreaterThan(JEEPNEY_LENGTH_M / 2);
  });

  for (const dt of [1 / 60, 1 / 30, 0.1, 0.25])
    it(`nothing ever touches anyone, ${Math.round(1 / dt)} ticks a second, 12 vehicles, 30 people`, () => {
      const { fleet, crew, walker, hit, step } = setup(12);
      const riders: Passenger[] = [];
      let touched = 0;
      let next = 0;
      const start = fleet.vehicles.reduce((n, v) => n + v.day.metres, 0);
      for (let t = 0; t < 600; t += dt) {
        if (t >= next && riders.length < 30) {
          next = t + 10;
          riders.push(walker(100 + riders.length * 97));
        }
        step(dt);
        for (const r of riders) if (hit(r)) touched++;
      }
      expect(touched).toBe(0);
      // All of them got over, and the road was not left standing.
      expect(riders.filter((r) => r.pose.z > 25).length).toBe(30);
      expect(crew.crossingsNow).toEqual([]);
      expect(fleet.vehicles.reduce((n, v) => n + v.day.metres, 0) - start).toBeGreaterThan(12_000);
    });

  it('never leaves two people waiting on vehicles held for each other', () => {
    const { fleet, walker, step } = setup(20);
    const riders = [1500, 1510, 1520, 1530, 1540, 1550].map(walker);
    for (let t = 0; t < 400; t += 0.1) step(0.1);
    expect(riders.filter((r) => r.pose.z > 25).length).toBe(6);
    expect(fleet.vehicles.some((v) => v.speedMps > 1)).toBe(true);
  });

  it('is on the road, not at the kerb, only once it is safe, and stays safe at a stop', () => {
    const { fleet, crew, walker, hit, step } = setup(8);
    // A crossing right where jeepneys stop to let people off.
    const atStop = walker(800);
    const seated = crew.join(0, 1, 0);
    fleet.waiting[0] = 0;
    const onBoard = crew.passengers.get(seated)!;
    Object.assign(onBoard, {
      phase: 'seated',
      vehicleId: 0,
      lastVehicleId: 0,
      seat: 0,
      inside: true,
      destinationStop: 1,
    });
    let touched = 0;
    for (let t = 0; t < 400; t += 0.1) {
      step(0.1);
      if (hit(atStop)) touched++;
    }
    expect(touched).toBe(0);
    expect(atStop.pose.z).toBeGreaterThan(25);
  });

  it('walks along the kerb to a gap when a vehicle stands on their line', () => {
    const { fleet, crew, walker, hit, step } = setup(1);
    const v = fleet.vehicles[0]!;
    // Stopped right on the line, for as long as it takes.
    Object.assign(v, { s: 1500, speedMps: 0, currentStop: 1, dwellS: 100_000, nextStop: 1 });
    const r = walker(1500);
    let touched = 0;
    for (let t = 0; t < 120 && r.pose.z < 25; t += 0.1) {
      step(0.1);
      if (hit(r)) touched++;
    }
    expect(touched).toBe(0);
    expect(r.pose.z).toBeGreaterThan(25);
    expect(v.s).toBe(1500);
    expect(crew.crossingsNow).toEqual([]);
  });

  it('holds a whole slanted crossing clear, not only its middle', () => {
    const { fleet, crew, hit, step } = setup(10);
    const id = crew.join(1, 2, 100);
    const r = crew.passengers.get(id)!;
    fleet.waiting[1] = 0;
    r.phase = 'walking';
    r.motion = RiderMotion.tricycle([
      [1500, 0, -30],
      [1500, 0, -12],
      [1512, 0, 12],
      [1512, 0, 30],
    ]);
    r.t = 0;
    let touched = 0;
    for (let t = 0; t < 200 && r.pose.z < 25; t += 0.05) {
      step(0.05);
      if (hit(r)) touched++;
    }
    expect(touched).toBe(0);
    expect(r.pose.z).toBeGreaterThan(25);
  });
});

describe('the real route, the real crowd', () => {
  it(
    'a rush-hour quarter of an hour: everyone crosses, nothing touches them, the road keeps moving',
    {
      timeout: 120_000,
    },
    () => {
      const { fleet, crew } = new TwinRuntime(defaultRoute(), undefined, {
        ...FIELD_SCENARIO,
        startHour: 6.5,
      });
      const pose = { x: 0, z: 0, heading: 0 };
      const dt = 1 / 15;
      const seen = new Set<Crossing>();
      let touches = 0;
      const start = fleet.vehicles.reduce((n, v) => n + v.day.metres, 0);
      for (let t = 0; t < 1800; t += dt) {
        fleet.step(dt);
        crew.update(dt);
        for (const c of crew.crossingsNow) seen.add(c);
        for (const r of crew.passengers.values()) {
          if (!r.crossings?.[0]?.stepped || r.vehicleId !== null) continue;
          fleet.vehicles.forEach((v, i) => {
            if (v.duty === 'parked' || v.yard) return;
            const p = fleetPose(fleet, i, pose);
            const half = (v.kind === 'jeepney' ? JEEPNEY_LENGTH_M : VEHICLES[v.kind].lengthM) / 2;
            const dx = r.pose.x - p.x;
            const dz = r.pose.z - p.z;
            const along = dx * Math.cos(p.heading) - dz * Math.sin(p.heading);
            const across = dx * Math.sin(p.heading) + dz * Math.cos(p.heading);
            if (Math.abs(along) < half && Math.abs(across) < 1.4) touches++;
          });
        }
      }
      expect(seen.size).toBeGreaterThan(10);
      expect(touches).toBe(0);
      expect(Math.max(...[...seen].map((c) => c.heldS))).toBeLessThan(90);
      expect(fleet.vehicles.reduce((n, v) => n + v.day.metres, 0) - start).toBeGreaterThan(100_000);
    },
  );
});
