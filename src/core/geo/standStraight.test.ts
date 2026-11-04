import { describe, expect, it } from 'vitest';
import { Polyline } from './polyline';
import type { Route } from './routes';
import { standStraight } from './standStraight';

/** Out along z = 0, a U-turn at x = 200, and back along z = 8. */
const uTurn = {
  loop: false,
  stops: [],
  polyline: new Polyline([
    { x: 0, z: 0 },
    { x: 200, z: 0 },
    { x: 204, z: 4 },
    { x: 200, z: 8 },
    { x: 0, z: 8 },
  ]),
} as unknown as Route;

describe('standing still on a bend', () => {
  it('stays where it is on a straight', () => {
    expect(standStraight(uTurn, 100)).toBe(100);
  });

  it('waits short of a U-turn, not across the road in it', () => {
    const at = standStraight(uTurn, 203);
    expect(at).toBeLessThan(200);
    expect(at).toBeGreaterThan(140);
    const h = uTurn.polyline.headingAt(at, 4);
    expect(Math.abs(Math.sin(h))).toBeLessThan(0.1);
  });
});
