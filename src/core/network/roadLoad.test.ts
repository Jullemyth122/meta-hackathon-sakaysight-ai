import { describe, expect, it } from 'vitest';
import { defaultRoute } from '../geo/routes';
import { roadShares } from './roadLoad';

describe('how much of a fleet a road can show', () => {
  const route = defaultRoute();

  it('leaves a quiet route as it is', () => {
    expect(roadShares([{ route, vehicles: 20 }])[0]).toBe(1);
  });

  it('thins a route to what its road can hold', () => {
    const [share] = roadShares([{ route, vehicles: 20_000 }]);
    expect(share).toBeLessThan(0.2);
    expect(share).toBeGreaterThan(0);
  });

  it('shares a road between the routes on it, alike', () => {
    const alone = roadShares([{ route, vehicles: 400 }])[0]!;
    const shared = roadShares([
      { route, vehicles: 400 },
      { route, vehicles: 400 },
    ]);
    expect(shared[0]).toBeCloseTo(shared[1]!, 5);
    expect(shared[0]).toBeLessThan(alone);
  });

  it('never hides a fleet altogether', () => {
    expect(roadShares([{ route, vehicles: 10_000_000 }])[0]).toBeGreaterThan(0);
  });
});
