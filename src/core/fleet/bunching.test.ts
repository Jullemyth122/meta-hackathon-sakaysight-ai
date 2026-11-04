import { describe, expect, it } from 'vitest';
import { TwinRuntime } from '@/app/twinRuntime';
import { FARE_BY_VEHICLE, fareFor } from '../fare';
import { aheadOf, defaultRoute } from '../geo/routes';
import { DEFAULT_SCENARIO, RIDERS_PER_JEEPNEY_PER_DAY } from './scenario';

/** 40 jeepneys on the Tungko–SM Fairview loop for `minutes`, sampled every second. */
function run(minutes: number, sample: (twin: TwinRuntime) => void) {
  const twin = new TwinRuntime(defaultRoute(), undefined, {
    ...DEFAULT_SCENARIO,
    vehicles: 40,
    dailyTrips: 40 * RIDERS_PER_JEEPNEY_PER_DAY,
  });
  for (let tick = 0; tick < minutes * 600; tick++) {
    twin.step(0.1, tick * 100);
    if (tick % 10 === 0) sample(twin);
  }
  return twin;
}

describe('jeepneys on a busy route', () => {
  it(
    'never sit inside one another, and do not drive in long platoons',
    { timeout: 300_000 },
    () => {
      const route = defaultRoute();
      const L = route.polyline.length;
      const terminals = route.stops.filter((s) => s.terminal).map((s) => s.s);
      // The terminal's line is a queue, as at the real terminal: judged elsewhere.
      const onOpenRoad = (s: number) =>
        terminals.every((t) => Math.min(Math.abs(t - s), L - Math.abs(t - s)) > 250);
      let overlaps = 0;
      let longest = 1;
      run(60, (twin) => {
        const vs = twin.fleet.vehicles;
        for (let i = 0; i < vs.length; i++)
          for (let j = i + 1; j < vs.length; j++) {
            const a = vs[i]!;
            const b = vs[j]!;
            const along = Math.min(aheadOf(route, a.s, b.s), aheadOf(route, b.s, a.s));
            // 7.5 m long, 2 m wide: closer along and across than that is inside.
            const across = Math.abs(twin.fleet.acrossOf(a) - twin.fleet.acrossOf(b));
            if (along < 7 && across < 1.9) overlaps++;
          }
        if (twin.fleet.elapsedS < 1800) return; // the first half hour settles
        // Nose to tail in one lane: side by side across a wide road is no platoon.
        for (let lane = 0; lane < 4; lane++) {
          const open = vs
            .filter((v) => onOpenRoad(v.s) && Math.round(v.cruiseLaneM / 3.5) === lane)
            .map((v) => v.s)
            .sort((a, b) => a - b);
          let platoon = 1;
          for (let k = 1; k < open.length; k++) {
            platoon = open[k]! - open[k - 1]! < 60 ? platoon + 1 : 1;
            longest = Math.max(longest, platoon);
          }
        }
      });
      expect(overlaps).toBe(0);
      // Twos and threes happen on a real road, and a busy stop's queue reaches six
      // for a few seconds (Amparo). Seven or more nose to tail did not.
      expect(longest).toBeLessThanOrEqual(6);
    },
  );

  it(
    'logs every stop, and the log adds up to the fares the jeepneys collected',
    {
      timeout: 120_000,
    },
    () => {
      const twin = run(20, () => {});
      const log = twin.crew.log;
      expect(log.length).toBeGreaterThan(0);
      const collected = twin.fleet.vehicles.reduce((n, v) => n + v.day.fareCentavos, 0);
      const riders = twin.fleet.vehicles.reduce((n, v) => n + v.day.riders, 0);
      // Stops still being served when the run ended are not in the log yet.
      const logged = log.reduce((n, e) => n + e.fareCentavos, 0);
      expect(logged).toBeLessThanOrEqual(collected);
      expect(logged).toBeGreaterThan(collected * 0.9);
      expect(log.reduce((n, e) => n + e.off, 0)).toBeLessThanOrEqual(riders);
      for (const e of log) {
        // Nobody rides free: each rider off paid at least the discounted
        // minimum of the vehicle (a UV Express has none: its first km).
        const rule = FARE_BY_VEHICLE[twin.fleet.vehicles[e.vehicle]!.kind];
        expect(e.fareCentavos).toBeGreaterThanOrEqual(e.off * fareFor(0.5, true, rule) * 100);
        expect(e.off + e.on).toBeGreaterThan(0);
      }
    },
  );
});
