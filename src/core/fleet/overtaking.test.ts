import { describe, expect, it } from 'vitest';
import { Polyline } from '../geo/polyline';
import { aheadOf, defaultRoute, type Route } from '../geo/routes';
import { DEFAULT_FLEET, FleetSim } from './fleetSim';
import { DEFAULT_SCENARIO } from './scenario';
import { TwinRuntime } from '@/app/twinRuntime';

/** 3 km of straight road, a terminal at each end. */
const straight: Route = {
  id: 'overtaking-test',
  name: 'Straight road',
  source: 'synthetic',
  projection: null,
  stopsSource: 'placeholder',
  loop: false,
  polyline: new Polyline([
    { x: 0, z: 0 },
    { x: 3000, z: 0 },
  ]),
  stops: [
    { name: 'Start', s: 0, terminal: true },
    { name: 'End', s: 3000, terminal: true },
  ],
};

/**
 * A slow jeepney at 200 m with a quicker one 30 m behind it, both heading
 * for End; `boldness` is the quicker one's driver. Returns what happened.
 */
function chase(boldness: number) {
  // Overtaking alone: no hanging back behind the one that passed.
  const fleet = new FleetSim(straight, { ...DEFAULT_FLEET, count: 2, hangBack: false });
  const [slow, quick] = fleet.vehicles as [
    (typeof fleet.vehicles)[number],
    (typeof fleet.vehicles)[number],
  ];
  for (const [v, s, cruise] of [
    [slow, 200, 5],
    [quick, 170, 10],
  ] as const) {
    Object.assign(v, { s, direction: 1, cruiseMps: cruise, speedMps: cruise, nextStop: 1 });
  }
  slow.boldness = 0;
  quick.boldness = boldness;
  let slowest = Infinity;
  let swungOut = 0;
  for (let i = 0; i < 600; i++) {
    fleet.step(0.1);
    slowest = Math.min(slowest, slow.speedMps);
    swungOut = Math.min(swungOut, quick.laneShiftM);
  }
  return { slow, quick, slowest, swungOut };
}

describe('drivers overtaking slower jeepneys', () => {
  it('lets a bold driver pull out, pass, and cut back in', () => {
    const { slow, quick, swungOut } = chase(1);
    expect(quick.s).toBeGreaterThan(slow.s + 14);
    expect(swungOut).toBeLessThan(-2);
    // Back in its lane once past.
    expect(quick.laneShiftM).toBeCloseTo(0, 1);
  });

  it('never makes the one overtaken brake for it', () => {
    expect(chase(1).slowest).toBeGreaterThan(4.5);
  });

  it('leaves a timid driver sitting behind', () => {
    const { slow, quick, swungOut } = chase(0);
    expect(quick.s).toBeLessThan(slow.s);
    expect(swungOut).toBe(0);
  });

  it(
    'keeps jeepneys in the same lane apart on the real route, 120 of them',
    { timeout: 120_000 },
    () => {
      const twin = new TwinRuntime(defaultRoute(), undefined, {
        ...DEFAULT_SCENARIO,
        vehicles: 120,
        dailyTrips: 108_000,
      });
      const route = twin.route;
      let overtaking = 0;
      let closest = Infinity;
      for (let tick = 0; tick < 6000; tick++) {
        twin.step(0.1, tick * 100);
        if (tick % 10) continue;
        const vs = twin.fleet.vehicles;
        overtaking = Math.max(
          overtaking,
          vs.filter((v) => v.laneShiftM < -1 && v.currentStop === null).length,
        );
        // In its lane (not swinging out, nor in a station's forecourt, where
        // jeepneys stand side by side at the pumps): never inside another.
        const inLane = vs.filter((v) => v.laneShiftM > -0.5 && !v.yard);
        for (const a of inLane)
          for (const b of inLane)
            // The same lane: side by side across a wide road is not close.
            if (
              a !== b &&
              b.laneShiftM > -0.5 &&
              Math.abs(twin.fleet.acrossOf(a) - twin.fleet.acrossOf(b)) < 2
            ) {
              const d = aheadOf(route, a.s, b.s);
              if (d < route.polyline.length / 2) closest = Math.min(closest, d);
            }
      }
      expect(overtaking).toBeGreaterThan(0);
      // A jeepney is about 7.5 m long.
      expect(closest).toBeGreaterThan(8);
    },
  );
});
