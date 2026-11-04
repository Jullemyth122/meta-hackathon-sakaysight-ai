import { describe, expect, it } from 'vitest';
import { TwinRuntime } from '@/app/twinRuntime';
import { twinState } from '@/app/twinState';
import { defaultRoute, stopsAhead } from '../geo/routes';
import { FIELD_SCENARIO } from '../fleet/scenario';
import { dispatch } from './dispatch';

/**
 * What the phones promise against what happens: the commuter app's "around
 * 7:11 AM" is the dispatch ETA, so it has to be how long the twin's
 * jeepneys really take, in the hour's traffic, stops and all.
 */
describe('arrival times', () => {
  it(
    'in the morning rush, are about how long the jeepneys really take to get there',
    { timeout: 300_000 },
    () => {
      const twin = new TwinRuntime(defaultRoute(), undefined, { ...FIELD_SCENARIO, startHour: 6 });
      const { fleet, route } = twin;
      while (fleet.timeOfDay < 7 * 3600) twin.step(1, 0);
      // Each jeepney out now: the ETA to the stop 6 ahead, then the time it really takes.
      const state = twinState(twin);
      const plan = dispatch(state);
      const watched = fleet.vehicles
        .filter((v) => v.duty === 'service' && v.currentStop === null)
        .slice(0, 12)
        .map((v) => {
          const ahead = stopsAhead(route, v.nextStop, v.direction);
          const stop = ahead[Math.min(5, ahead.length - 1)]!;
          return { v, stop, eta: plan.etaS(v.id, stop), start: fleet.timeOfDay, took: NaN };
        });
      for (let t = 0; t < 2 * 3600 && watched.some((w) => Number.isNaN(w.took)); t++) {
        const next = watched.map((w) => w.v.nextStop);
        twin.step(1, 0);
        // There: stopped at it, or gone past it (nobody to set down or pick up).
        watched.forEach((w, k) => {
          const passed = next[k] === w.stop && w.v.nextStop !== w.stop;
          if (Number.isNaN(w.took) && (w.v.currentStop === w.stop || passed))
            w.took = fleet.timeOfDay - w.start;
        });
      }
      const done = watched.filter((w) => !Number.isNaN(w.took));
      // All of them together: in an average of each one's ratio, a short trip
      // (a jeepney with nobody to stop for) would weigh as much as a long one.
      const ratio = done.reduce((a, w) => a + w.eta, 0) / done.reduce((a, w) => a + w.took, 0);
      console.log(
        `ETA / real, ${done.length} jeepneys: ${ratio.toFixed(2)}; e.g. ` +
          done
            .slice(0, 4)
            .map((w) => `${Math.round(w.eta / 60)} vs ${Math.round(w.took / 60)} min`)
            .join(', '),
      );
      expect(done.length).toBeGreaterThan(5);
      // Within a fifth of the real time, all together.
      expect(ratio).toBeGreaterThan(0.8);
      expect(ratio).toBeLessThan(1.2);
    },
  );
});
