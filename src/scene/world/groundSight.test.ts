import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { flowsToDraw, overlapping, seeTraffic, whoWaits } from './NetworkLayer';
import { GroundSight } from './groundSight';

function cameraAt(eye: [number, number, number], look: [number, number, number]) {
  const c = new PerspectiveCamera(50, 16 / 9, 1, 150_000);
  c.position.set(...eye);
  c.lookAt(new Vector3(...look));
  c.updateMatrixWorld();
  c.updateProjectionMatrix();
  return c;
}

describe('the ground a camera sees', () => {
  it('follows the camera wherever it goes, not a target left behind', () => {
    const sight = new GroundSight();
    sight.update(cameraAt([9000, 400, 9000], [9000, 0, 8000]));
    expect(sight.sees(9000, 8000)).toBe(true);
    expect(sight.sees(9000, 12_000)).toBe(false); // behind it: where a stale target can be left
  });

  it('a low view sees kilometres ahead and nothing behind', () => {
    const sight = new GroundSight();
    sight.update(cameraAt([0, 300, 0], [0, 0, -2500])); // about 7° below the horizon
    expect(sight.sees(0, -600)).toBe(true);
    expect(sight.sees(0, -6000)).toBe(true);
    expect(sight.sees(0, 800)).toBe(false);
    expect(sight.minZ).toBeLessThan(-6000);
    expect(sight.maxZ).toBeGreaterThanOrEqual(0);
  });

  it('straight down, it sees about what is under it', () => {
    const sight = new GroundSight();
    sight.update(cameraAt([100, 1000, 100.01], [100, 0, 100]));
    expect(sight.sees(100, 100)).toBe(true);
    expect(sight.sees(100, 4000)).toBe(false);
  });
});

describe('two vehicles on the road', () => {
  const v = (x: number, z: number, heading = 0) => ({ x, z, heading });

  it('touch at any angle, by their real sizes', () => {
    expect(overlapping(v(0, 0), v(5, 0))).toBe(true);
    expect(overlapping(v(0, 0), v(9, 0))).toBe(false);
    expect(overlapping(v(0, 0), v(0, 3))).toBe(false);
    // Across each other, corner to side.
    expect(overlapping(v(0, 0), v(5.5, 0, Math.PI / 2))).toBe(false);
    expect(overlapping(v(0, 0), v(4, 0, Math.PI / 2))).toBe(true);
    expect(overlapping(v(0, 0), v(3, 3, Math.PI / 4))).toBe(true);
    // The other way about gives the same answer.
    expect(overlapping(v(3, 3, Math.PI / 4), v(0, 0))).toBe(true);
    expect(overlapping(v(0, 0), { ...v(9, 0), length: 12 })).toBe(true);
  });
});

describe('traffic near the view gives way', () => {
  const v = (x: number, z: number, share: number, heading = 0) => ({ x, z, heading, share });

  it('the one behind waits for the one ahead, not the other way about', () => {
    const behind = v(0, 0, 0.1);
    const ahead = v(10, 0, 0.9);
    expect([...whoWaits([behind, ahead], [])]).toEqual([0.1]);
  });

  it('a clear road, or the next lane, holds nobody up', () => {
    expect(whoWaits([v(0, 0, 0.1), v(30, 0, 0.2)], []).size).toBe(0);
    expect(whoWaits([v(0, 0, 0.1), v(8, 3.5, 0.2)], []).size).toBe(0);
  });

  it('where roads cross, the higher number waits, whoever gets there first', () => {
    // Forward is +x at heading 0, and +z a quarter turn the other way.
    const across = v(9, -3, 0.1, -Math.PI / 2);
    const along = v(0, 0, 0.5);
    expect(whoWaits([along, across], []).has(0.5)).toBe(true);
    expect(whoWaits([along, across], []).has(0.1)).toBe(false);
  });

  it('everyone waits for the simulated route, however low their number', () => {
    expect(whoWaits([v(0, 0, 0.001)], [{ x: 10, z: 0, heading: Math.PI / 2 }]).has(0.001)).toBe(
      true,
    );
  });

  it('a bus ahead is a longer wait than a jeepney', () => {
    const behind = v(0, 0, 0.1);
    expect(whoWaits([behind, v(17, 0, 0.9)], []).size).toBe(0);
    expect(whoWaits([behind, { ...v(17, 0, 0.9), length: 12 }], []).size).toBe(1);
  });
});

describe('the simulated route sees the traffic', () => {
  const own = (x: number, z: number) => ({ id: 0, x, z, heading: 0 });
  const see = (traffic: Array<{ x: number; z: number; heading: number }>) => {
    const ahead = new Float32Array(1);
    const beside = new Uint8Array(1);
    seeTraffic([own(0, 0)], traffic, ahead, beside);
    return { ahead: ahead[0], beside: beside[0] };
  };

  it('knows how far off what is ahead of it in its lane is', () => {
    expect(see([{ x: 20, z: 0, heading: 0 }]).ahead).toBeCloseTo(20);
  });

  it('takes no notice of what is behind, in the next lane, or crossing', () => {
    expect(see([{ x: -20, z: 0, heading: 0 }]).ahead).toBe(Infinity);
    expect(see([{ x: 20, z: 3.5, heading: 0 }]).ahead).toBe(Infinity);
    expect(see([{ x: 20, z: 0, heading: Math.PI / 2 }]).ahead).toBe(Infinity);
  });

  it('knows when the lane towards the middle of the road is taken', () => {
    // Right of the way of travel is +z at heading 0.
    expect(see([{ x: 5, z: -3.5, heading: 0 }]).beside).toBe(1);
    expect(see([{ x: 5, z: 3.5, heading: 0 }]).beside).toBe(0);
    expect(see([{ x: 40, z: -3.5, heading: 0 }]).beside).toBe(0);
  });
});

describe('which flow vehicles are drawn', () => {
  /** A city of them: one every 50 m over 20 × 20 km, the camera at one corner. */
  const city = Array.from({ length: 160_000 }, (_, n) => ({
    r: n % 300,
    i: Math.floor(n / 300),
    d: Math.hypot(n % 400, Math.floor(n / 400)) * 50,
  }));

  it('dense up close, thinning with distance, and never empty', () => {
    const drawn = flowsToDraw(city, 600);
    expect(drawn).toHaveLength(600);
    const within = (a: number, b: number) => drawn.filter((f) => f.d >= a && f.d < b).length;
    expect(within(0, 1000)).toBeGreaterThan(100);
    for (const [a, b] of [
      [1000, 2000],
      [2000, 4000],
      [4000, 8000],
      [8000, 16000],
    ] as const)
      expect(within(a, b), `${a}–${b} m`).toBeGreaterThan(30);
  });

  it('keeps the nearest first, for the ones drawn in full', () => {
    const drawn = flowsToDraw(city, 600);
    expect(drawn.map((f) => f.d)).toEqual(drawn.map((f) => f.d).sort((a, b) => a - b));
  });

  it('picks the same vehicles as the view moves a little: nothing flickers', () => {
    const before = flowsToDraw(city, 600);
    const after = flowsToDraw(
      city.map((f) => ({ ...f, d: f.d * 1.01 })),
      600,
    );
    const key = (f: { r: number; i: number }) => `${f.r}:${f.i}`;
    const kept = new Set(before.map(key));
    expect(after.filter((f) => kept.has(key(f))).length).toBeGreaterThan(570);
  });
});
