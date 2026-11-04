import { describe, expect, it } from 'vitest';
import { TwinRuntime } from '@/app/twinRuntime';
import { twinState } from '@/app/twinState';
import { DEFAULT_SCENARIO, normalizeScenario } from '../fleet/scenario';
import { aheadOf, defaultRoute } from '../geo/routes';
import { dispatch } from './dispatch';

const MIN = 60;

/** Say when vehicles will reach a stop further on, then see when they do. */
function backtest() {
  const mix = { jeepney: 30, modern: 15, uv: 5, bus: 15 };
  const route = defaultRoute();
  const twin = new TwinRuntime(
    route,
    undefined,
    normalizeScenario({ ...DEFAULT_SCENARIO, startHour: 6, mix, dailyTrips: 36_400 }),
  );
  const { fleet } = twin;
  const dt = 0.25;
  const waiting: Array<{ vehicle: number; stop: number; at: number }> = [];
  const errors: number[] = [];
  const last = new Map<number, number>();
  for (let tick = 0; tick < 2.5 * 3600 * 4; tick++) {
    twin.step(dt, tick * 250);
    const clock = twin.clockS;
    for (let k = waiting.length - 1; k >= 0; k--) {
      const o = waiting[k]!;
      const v = fleet.vehicles[o.vehicle]!;
      const was = last.get(o.vehicle) ?? v.s;
      if (aheadOf(route, was, route.stops[o.stop]!.s) <= aheadOf(route, was, v.s) + 3) {
        errors.push(clock - o.at);
        waiting.splice(k, 1);
      }
    }
    for (const v of fleet.vehicles) last.set(v.id, v.s);
    // Only once the fleet has driven the road, and said only about the next few stops.
    if (tick < 3600 * 4 || tick % 240 !== 0) continue;
    const plan = dispatch(twinState(twin));
    for (const v of fleet.vehicles) {
      if (v.duty !== 'service' || waiting.length > 300) continue;
      const stop = (v.nextStop + 6) % route.stops.length;
      const said = plan.etaS(v.id, stop);
      if (Number.isFinite(said) && said > 0)
        waiting.push({ vehicle: v.id, stop, at: clock + said });
    }
  }
  return errors.sort((a, b) => a - b);
}

describe('arrival times in traffic', () => {
  it('are about right six stops ahead, not minutes early', { timeout: 200_000 }, () => {
    const errors = backtest();
    expect(errors.length).toBeGreaterThan(100);
    const median = errors[errors.length >> 1]!;
    // One morning of a chaotic rush: across seeds the median runs from 1.5 to 5 minutes late.
    expect(Math.abs(median)).toBeLessThan(4 * MIN);
  });
});
