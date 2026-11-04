import { describe, expect, it } from 'vitest';
import { DEFAULT_FLEET, FleetSim } from '@/core/fleet/fleetSim';
import { DEFAULT_SCENARIO, mixKinds, normalizeScenario } from '@/core/fleet/scenario';
import { defaultRoute } from '@/core/geo/routes';
import { VEHICLES, type FleetKind } from '@/core/vehicles/specs';
import { fleetPose } from './lanes';
import { overlapping } from './NetworkLayer';

/** Faster than anything on the road, per 1/20 s tick (metres): more is a jump. */
const MOST_IN_A_TICK_M = 2;
/** A little under its real size: vehicles passing close by do not count as touching. */
const SIZE = 0.9;
const size = (kind: FleetKind) =>
  kind === 'jeepney' ? [6.9, 2.2] : [VEHICLES[kind].lengthM, VEHICLES[kind].widthM];

describe('a packed route at the rush', () => {
  it('no two vehicles on the road drive through each other', { timeout: 120_000 }, () => {
    const mix = { jeepney: 60, modern: 20, uv: 20, bus: 20 };
    const scenario = normalizeScenario({
      ...DEFAULT_SCENARIO,
      startHour: 7,
      mix,
      dailyTrips: 67_200,
    });
    const fleet = new FleetSim(defaultRoute(), {
      ...DEFAULT_FLEET,
      count: 120,
      seed: 11,
      scenario,
      dayCycle: true,
      kinds: mixKinds(mix),
    });
    const hits: string[] = [];
    for (let tick = 0; tick < 6000; tick++) {
      fleet.step(0.1);
      if (tick % 10) continue;
      const placed = fleet.vehicles.flatMap((v, i) => {
        if (v.duty === 'parked') return [];
        const [length, width] = size(v.kind);
        const pose = fleetPose(fleet, i, { x: 0, z: 0, heading: 0 });
        return [{ ...pose, length: length! * SIZE, width: width! * SIZE, v }];
      });
      for (let i = 0; i < placed.length; i++)
        for (let j = i + 1; j < placed.length; j++)
          if (overlapping(placed[i]!, placed[j]!))
            hits.push(`${placed[i]!.v.kind}/${placed[j]!.v.kind} at ${tick / 10} s`);
    }
    expect(hits).toEqual([]);
  });

  it(
    'no vehicle jumps: lanes end gradually, wherever the road narrows',
    { timeout: 120_000 },
    () => {
      const mix = { jeepney: 30, modern: 15, uv: 5, bus: 15 };
      const scenario = normalizeScenario({
        ...DEFAULT_SCENARIO,
        startHour: 7,
        mix,
        dailyTrips: 36_400,
      });
      const fleet = new FleetSim(defaultRoute(), {
        ...DEFAULT_FLEET,
        count: 65,
        seed: 11,
        scenario,
        dayCycle: true,
        kinds: mixKinds(mix),
      });
      const last = new Map<number, { x: number; z: number }>();
      const jumps: string[] = [];
      for (let tick = 0; tick < 12_000; tick++) {
        fleet.step(1 / 20);
        fleet.vehicles.forEach((v, i) => {
          const p = fleetPose(fleet, i, { x: 0, z: 0, heading: 0 });
          const o = last.get(i);
          if (o && Math.hypot(p.x - o.x, p.z - o.z) > MOST_IN_A_TICK_M)
            jumps.push(`${v.kind} at ${v.s.toFixed(0)} m`);
          last.set(i, p);
        });
      }
      expect(jumps).toEqual([]);
    },
  );
});
