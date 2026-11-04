import { describe, expect, it } from 'vitest';
import { TwinRuntime } from '@/app/twinRuntime';
import { defaultRoute, laneRoomAt } from '../geo/routes';
import { homeLane } from '../vehicles/specs';
import { FIELD_SCENARIO } from './scenario';

describe('lanes on a wide road', () => {
  it('a fleet spreads over the lanes', () => {
    const lanes = Array.from({ length: 60 }, (_, i) => homeLane(i));
    for (const lane of [0, 1, 2, 3])
      expect(lanes.filter((l) => l === lane).length, `lane ${lane}`).toBeGreaterThan(8);
  });

  it('knows a road’s lanes each way: never room over the middle of a two-way road', () => {
    const route = defaultRoute();
    for (let s = 0; s < route.polyline.length; s += 25) {
      const room = laneRoomAt(route, s);
      expect(room).toBeGreaterThanOrEqual(0);
      // Primary, the widest here, where divided: three lanes going this way, two past the kerb's.
      expect(room).toBeLessThanOrEqual(7.01);
    }
  });

  it(
    'vehicles spread across the road, and every one comes to the kerb to serve a stop',
    { timeout: 120_000 },
    () => {
      const twin = new TwinRuntime(defaultRoute(), undefined, { ...FIELD_SCENARIO, startHour: 7 });
      const { fleet, crew, route } = twin;
      // This route's widest road is three lanes a side; those further out stop at the third.
      const inLane = [0, 0, 0];
      let serving = 0;
      let outAtStop = 0;
      for (let t = 0; t < 1800; t += 0.25) {
        twin.step(0.25, 0);
        for (const v of fleet.vehicles) {
          if (v.duty === 'parked') continue;
          expect(v.cruiseLaneM).toBeGreaterThanOrEqual(0);
          expect(v.cruiseLaneM).toBeLessThanOrEqual(laneRoomAt(route, v.s) + 4);
          if (v.currentStop === null) inLane[Math.round(v.cruiseLaneM / 3.5)]!++;
          // Getting on or off: at the kerb.
          if (v.currentStop !== null && crew.busy(v.id)) {
            serving++;
            if (v.cruiseLaneM > 0.2) outAtStop++;
          }
        }
      }
      // Riders are out at this hour, so many are heading in to a stop; all lanes still in use.
      for (const [lane, n] of inLane.entries()) expect(n, `lane ${lane}`).toBeGreaterThan(300);
      expect(serving).toBeGreaterThan(500);
      expect(outAtStop / serving).toBeLessThan(0.02);
    },
  );
});
