import { describe, expect, it } from 'vitest';
import { TwinRuntime } from '@/app/twinRuntime';
import { defaultRoute } from '../geo/routes';
import { VEHICLES, type FleetKind } from '../vehicles/specs';
import { fleetPose } from '@/scene/world/lanes';
import { FIELD_SCENARIO } from './scenario';

const lengthOf = (k: FleetKind) => (k === 'jeepney' ? 6.9 : VEHICLES[k].lengthM);
const widthOf = (k: FleetKind) => (k === 'jeepney' ? 2.2 : VEHICLES[k].widthM);

/** Pairs of vehicles whose bodies overlap right now, by their real poses. */
function overlaps(twin: TwinRuntime): Array<[string, string]> {
  const { fleet } = twin;
  const poses = fleet.vehicles.map((_, i) => fleetPose(fleet, i, { x: 0, z: 0, heading: 0 }));
  const hits: Array<[string, string]> = [];
  fleet.vehicles.forEach((a, i) => {
    const p = poses[i]!;
    for (let j = i + 1; j < poses.length; j++) {
      const b = fleet.vehicles[j]!;
      const q = poses[j]!;
      const dx = q.x - p.x;
      const dz = q.z - p.z;
      if (Math.abs(dx) > 14 || Math.abs(dz) > 14) continue;
      // In `a`'s own frame: along it and across it.
      const along = Math.abs(dx * Math.cos(p.heading) - dz * Math.sin(p.heading));
      const across = Math.abs(dx * Math.sin(p.heading) + dz * Math.cos(p.heading));
      // Heading the same way (give or take) means a real clash; opposite lanes pass.
      const same = Math.cos(q.heading - p.heading) > 0.5;
      const long = (lengthOf(a.kind) + lengthOf(b.kind)) / 2;
      const wide = (widthOf(a.kind) + widthOf(b.kind)) / 2;
      if (same && along < long - 0.2 && across < wide - 0.3)
        hits.push([`${a.plate} ${a.kind} ${a.duty}`, `${b.plate} ${b.kind} ${b.duty}`]);
    }
  });
  return hits;
}

describe('vehicles do not drive through each other', () => {
  it.each([
    ['parked and setting out, 4:30 AM', 4.5, 0.25, 1800],
    ['the morning rush at 1×', 7, 1 / 30, 1200],
    ['the morning rush at 300×', 7, 0.5, 3600],
  ] as const)('%s', { timeout: 200_000 }, (_, startHour, tick, seconds) => {
    const twin = new TwinRuntime(defaultRoute(), undefined, { ...FIELD_SCENARIO, startHour });
    let samples = 0;
    let bad = 0;
    const seen = new Map<string, number>();
    for (let t = 0, n = 0; t < seconds; t += tick, n++) {
      twin.step(tick, 0);
      if (n % Math.round(1 / tick) !== 0) continue;
      samples += twin.fleet.vehicles.length;
      for (const [a, b] of overlaps(twin)) {
        bad++;
        const key = `${a.split(' ').slice(2).join(' ')} + ${b.split(' ').slice(2).join(' ')}`;
        seen.set(key, (seen.get(key) ?? 0) + 1);
      }
    }
    console.log(`CLASH ${_}: ${bad} in ${samples} ${JSON.stringify([...seen])}`);
    expect(bad / samples).toBeLessThan(0.001);
  });
});
