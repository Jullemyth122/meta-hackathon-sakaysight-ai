import { describe, expect, it } from 'vitest';
import { TwinRuntime } from '@/app/twinRuntime';
import { aheadOf, defaultRoute } from '../geo/routes';
import { VEHICLES, type FleetKind } from '../vehicles/specs';
import { FIELD_SCENARIO } from './scenario';

const length = (k: FleetKind) => (k === 'jeepney' ? 6.9 : VEHICLES[k].lengthM);
const width = (k: FleetKind) => (k === 'jeepney' ? 2.0 : VEHICLES[k].widthM);

describe('a mixed fleet (jeepneys, modern jeepneys, UV Express, buses)', () => {
  it(
    'nobody drives through anybody, by each one’s real length and width, overtaking included',
    { timeout: 300_000 },
    () => {
      const twin = new TwinRuntime(defaultRoute(), undefined, { ...FIELD_SCENARIO, startHour: 5 });
      const { fleet, route } = twin;
      const through: string[] = [];
      for (let k = 0; k < 3 * 3600 * 4; k++) {
        twin.step(0.25, 0);
        if (k % 4) continue;
        const on = fleet.vehicles.filter((v) => v.duty !== 'parked' && !v.yard);
        for (let a = 0; a < on.length; a++)
          for (let b = a + 1; b < on.length; b++) {
            const x = on[a]!;
            const y = on[b]!;
            if (x.direction !== y.direction && !route.loop) continue;
            const along = Math.min(aheadOf(route, x.s, y.s), aheadOf(route, y.s, x.s));
            const across = Math.abs(fleet.acrossOf(x) - fleet.acrossOf(y));
            if (
              along < (length(x.kind) + length(y.kind)) / 2 - 0.3 &&
              across < (width(x.kind) + width(y.kind)) / 2 - 0.1
            )
              through.push(`${x.kind} ${x.plate} / ${y.kind} ${y.plate} at s ${x.s.toFixed(0)}`);
          }
      }
      expect(through.slice(0, 5)).toEqual([]);
    },
  );
});
