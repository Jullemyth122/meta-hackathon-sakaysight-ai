import { describe, expect, it } from 'vitest';
import { defaultRoute } from '../geo/routes';
import { RouteFlow } from './flow';

describe('a flow’s line at a terminal', () => {
  const route = defaultRoute();
  const flow = new RouteFlow(route, 120, 40);
  const L = route.polyline.length;
  const between = (a: number, b: number) => {
    const d = Math.abs(a - b) % L;
    return Math.min(d, L - d);
  };

  it('moves up without a jump, all day', () => {
    const STEP_S = 5;
    for (let i = 0; i < flow.count; i += 7) {
      let before = flow.vehicle(i, 6 * 3600);
      for (let t = 6 * 3600 + STEP_S; t < 20 * 3600; t += STEP_S) {
        const now = flow.vehicle(i, t);
        if (before.inService && now.inService)
          expect(between(now.s, before.s), `vehicle ${i} at ${t} s`).toBeLessThan(STEP_S * 7);
        before = now;
      }
    }
  });

  it('stands along the road, not all on one spot', () => {
    const waiting = new Set<number>();
    for (let t = 7 * 3600; t < 19 * 3600; t += 60) {
      const here = flow.vehicles(t).filter((v) => v.inService && v.speedMps === 0);
      if (here.length < 2) continue;
      for (const v of here) waiting.add(Math.round(v.s));
    }
    expect(waiting.size).toBeGreaterThan(20);
  });
});
