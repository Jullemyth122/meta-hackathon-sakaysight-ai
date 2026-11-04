import { describe, expect, it } from 'vitest';
import { Polyline } from './polyline';

describe('the nearest point on a route', () => {
  // A road that winds, doubles back and crosses itself, as terminal loops do.
  const road = new Polyline(
    Array.from({ length: 2000 }, (_, i) => ({
      x: 400 * Math.cos(i / 90) + i * 0.4,
      z: 300 * Math.sin(i / 37) + 150 * Math.cos(i / 11),
    })),
  );

  it('finds the same point skipping far chunks as looking at every segment', () => {
    for (let n = 0; n < 400; n++) {
      const p = { x: ((n * 137.5) % 1500) - 400, z: ((n * 91.3) % 1100) - 550 };
      const quick = road.project(p);
      // With a window it looks at every segment.
      const whole = road.project(p, [0, road.length]);
      expect(quick.offset).toBeCloseTo(whole.offset, 9);
      expect(quick.s).toBeCloseTo(whole.s, 6);
    }
  });
});
