import { describe, expect, it } from 'vitest';
import type { LocalPoint } from '../geo/projection';
import { wayLine } from './streetGraph';

const W = 14;
/** How far a point is on the far side of the highway along z = 0 (the spot is at z > 0). */
const farSide = (line: ReadonlyArray<readonly [number, number, number]>) =>
  Math.min(...line.map((p) => p[2]));

/** The sharpest single turn of a line, in degrees. */
function sharpest(line: ReadonlyArray<readonly [number, number, number]>): number {
  let most = 0;
  for (let i = 1; i + 1 < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const c = line[i + 1]!;
    const u = [b[0] - a[0], b[2] - a[2]] as const;
    const v = [c[0] - b[0], c[2] - b[2]] as const;
    const cos = (u[0] * v[0] + u[1] * v[1]) / (Math.hypot(...u) * Math.hypot(...v) || 1);
    most = Math.max(most, (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI);
  }
  return most;
}

/** A side road running in at a slant to a highway along z = 0, then back along the highway. */
const slant: LocalPoint[] = [
  { x: -300, z: 150 },
  { x: 0, z: 0 },
  { x: -100, z: 0 },
];
const kerb: LocalPoint = { x: -100, z: 8 };

describe('the line a way is gone and drawn by', () => {
  for (const mode of ['walk', 'tricycle'] as const) {
    it(`${mode}: stays on the side of the road the spot is on`, () => {
      const line = wayLine(slant, [W, W], mode, kerb);
      expect(farSide(line)).toBeGreaterThan(0);
      expect(line.at(-1)).toEqual([kerb.x, 0, kerb.z]);
    });

    it(`${mode}: does not go out to the junction and back`, () => {
      const line = wayLine(slant, [W, W], mode, kerb);
      expect(Math.max(...line.map((p) => p[0]))).toBeLessThan(-10);
    });

    it(`${mode}: has no sharp corner`, () => {
      expect(sharpest(wayLine(slant, [W, W], mode, kerb))).toBeLessThan(45);
    });
  }

  it('goes to the side the spot is on, whichever that is', () => {
    const left = wayLine(
      [
        { x: 0, z: 0 },
        { x: 500, z: 0 },
      ],
      [W],
      'walk',
      { x: 500, z: -8 },
    );
    expect(Math.max(...left.map((p) => p[2]))).toBeLessThan(0);
    const right = wayLine(
      [
        { x: 0, z: 0 },
        { x: 500, z: 0 },
      ],
      [W],
      'walk',
      { x: 500, z: 8 },
    );
    expect(Math.min(...right.map((p) => p[2]))).toBeGreaterThanOrEqual(0);
  });

  it('keeps a tricycle in its lane until the last road', () => {
    const line = wayLine(
      [
        { x: 0, z: 0 },
        { x: 500, z: 0 },
        { x: 500, z: 500 },
      ],
      [W, W],
      'tricycle',
      { x: 492, z: 500 },
    );
    expect(line[0]![2]).toBeCloseTo(W / 4);
  });

  it('goes on to a spot well off the road from its kerb', () => {
    const line = wayLine(
      [
        { x: 0, z: 0 },
        { x: 500, z: 0 },
        { x: 500, z: 60 },
      ],
      [W, 0],
      'walk',
    );
    expect(line.at(-1)).toEqual([500, 0, 60]);
  });

  it('is a plain line with no road at all', () => {
    const line = wayLine(
      [
        { x: 0, z: 0 },
        { x: 10, z: 0 },
      ],
      [0],
      'walk',
    );
    expect(line[0]).toEqual([0, 0, 0]);
    expect(line.at(-1)).toEqual([10, 0, 0]);
  });
});
