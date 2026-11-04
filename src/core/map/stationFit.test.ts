import { describe, expect, it } from 'vitest';
import { roadEdge, stationFit, type StreetLines } from './streets';

const LENGTH = 46;
const DEPTH = 30;

/** Roads, each two points and a width. */
function roads(...lines: Array<[[number, number], [number, number], number]>): StreetLines {
  return {
    points: new Float32Array(lines.flatMap(([a, b]) => [...a, ...b])),
    starts: new Uint32Array(lines.map((_, i) => i * 2).concat(lines.length * 2)),
    widths: new Float32Array(lines.map(([, , w]) => w)),
    national: new Uint8Array(lines.length),
    risky: new Uint8Array(lines.length),
    hazards: { points: new Float32Array(), starts: new Uint32Array([0]), kinds: new Uint8Array() },
  };
}

const highway: [[number, number], [number, number], number] = [[-500, 0], [500, 0], 14];

describe('where a gas station fits', () => {
  it('stands at the side of the road, facing it, full size where there is room', () => {
    const fit = stationFit([roads(highway)], { x: 0, z: 20 }, undefined, LENGTH, DEPTH)!;
    expect(fit.z).toBeCloseTo(8);
    expect(fit.nz).toBeCloseTo(1);
    expect(Math.abs(fit.ux)).toBeCloseTo(1);
    expect(fit.length).toBe(LENGTH);
    expect(fit.over).toBe(0);
  });

  it('slides along the road, clear of a side street', () => {
    const side: [[number, number], [number, number], number] = [[0, 0], [0, 500], 8];
    const fit = stationFit([roads(highway, side)], { x: 15, z: 12 }, undefined, LENGTH, DEPTH)!;
    expect(fit.over).toBeLessThanOrEqual(0.4);
    expect(fit.nz).toBeCloseTo(1);
    expect(fit.x - LENGTH / 2).toBeGreaterThanOrEqual(4);
  });

  it('is smaller in a tight block, not on a street', () => {
    const left: [[number, number], [number, number], number] = [[-20, 0], [-20, 500], 8];
    const right: [[number, number], [number, number], number] = [[20, 0], [20, 500], 8];
    const behind: [[number, number], [number, number], number] = [[-500, 32], [500, 32], 8];
    const parts = [roads(highway, left, right, behind)];
    const fit = stationFit(parts, { x: 0, z: 14 }, undefined, LENGTH, DEPTH)!;
    expect(fit.length).toBeLessThan(LENGTH);
    expect(fit.over).toBeLessThanOrEqual(0.4);
  });

  it('takes no notice of its own driveway', () => {
    const driveway: [[number, number], [number, number], number] = [[-20, 8], [20, 20], 4.6];
    const fit = stationFit([roads(highway, driveway)], { x: 0, z: 20 }, undefined, LENGTH, DEPTH)!;
    expect(fit.length).toBe(LENGTH);
    expect(fit.slide).toBe(0);
  });

  it('keeps its pump lanes for a road vehicles drive in from, however it has to fit', () => {
    const parts = [roads(highway, [[-500, 30], [500, 30], 8])];
    const on = roadEdge(parts, { x: 0, z: 9 })!;
    const fit = stationFit(parts, { x: 0, z: 20 }, on, LENGTH, DEPTH)!;
    expect(fit.lanes).toBe(1);
    expect(fit.depth).toBeLessThan(DEPTH);
    expect(fit.depth).toBeGreaterThanOrEqual(DEPTH * 0.6);
    expect(Math.abs(fit.slide)).toBeLessThanOrEqual(16);
  });

  it('says so when nowhere near is clear', () => {
    const streets = Array.from(
      { length: 60 },
      (_, i): [[number, number], [number, number], number] => [
        [-300 + i * 10, -500],
        [-300 + i * 10, 500],
        8,
      ],
    );
    const fit = stationFit([roads(...streets)], { x: 3, z: 14 }, undefined, LENGTH, DEPTH)!;
    expect(fit.over).toBeGreaterThan(1);
  });

  it('has nowhere to stand with no road near', () => {
    expect(stationFit([roads(highway)], { x: 0, z: 400 }, undefined, LENGTH, DEPTH)).toBeNull();
  });
});
