import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { flowPose } from '@/scene/world/lanes';
import { LANE_M } from '../map/style';
import { buildNetwork, type NetworkFile } from '../network/network';
import { bendSpeed, driveLine, drivePose } from './driveLine';
import { Polyline } from './polyline';
import { defaultRoute, syntheticDemoRoute, type Route } from './routes';

const pose = { x: 0, z: 0, heading: 0 };

/** A loop round a block, its corners square, on a road with kerbs 8 m out. */
const block: Route = {
  ...syntheticDemoRoute(),
  loop: true,
  polyline: new Polyline([
    { x: 0, z: 0 },
    { x: 200, z: 0 },
    { x: 200, z: 200 },
    { x: 0, z: 200 },
    { x: 0, z: 0 },
  ]),
  stops: [{ name: 'A', s: 0, terminal: true }],
  kerbs: { s: [0, 800], m: [8, 8], room: [3, 3] },
};

/** The angle between where a vehicle is pointing and where it really goes, and how it turns. */
function goAround(route: Route, across: number, step = 1) {
  const L = route.polyline.length;
  let prev = { ...flowPose(route, 0, across, pose) };
  let way: number | null = null;
  let sideways = 0;
  let sharpest = 0;
  for (let s = step; s < L; s += step) {
    const q = { ...flowPose(route, s, across, pose) };
    const dx = q.x - prev.x;
    const dz = q.z - prev.z;
    if (Math.hypot(dx, dz) > 0.02) {
      const dir = Math.atan2(-dz, dx);
      const off = Math.abs(Math.atan2(Math.sin(dir - q.heading), Math.cos(dir - q.heading)));
      sideways = Math.max(sideways, (off * 180) / Math.PI);
      if (way !== null) {
        const turn = Math.abs(Math.atan2(Math.sin(dir - way), Math.cos(dir - way)));
        sharpest = Math.max(sharpest, (turn * 180) / Math.PI);
      }
      way = dir;
    }
    prev = q;
  }
  return { sideways, sharpest };
}

describe('the line vehicles drive', () => {
  it('goes round square corners in a curve, pointing the way it goes, in any lane', () => {
    for (const across of [0, LANE_M]) {
      const { sideways, sharpest } = goAround(block, across);
      // Square, and not smoothed as every real route is: the hardest case.
      expect(sideways).toBeLessThan(15);
      expect(sharpest).toBeLessThan(15);
    }
  });

  it('stays true to the lane on the straight, and is a closed loop', () => {
    drivePose(block, 100, 1, 0, pose);
    expect(pose.x).toBeCloseTo(100, 0);
    expect(pose.z).toBeCloseTo(8 - 1.75, 1);
    const { x, z } = driveLine(block);
    const n = x.length;
    expect(Math.hypot(x[0]! - x[n - 1]!, z[0]! - z[n - 1]!)).toBeLessThan(5);
  });

  it('keeps going at the same pace round a bend: no racing, no stalling', () => {
    const { x, z } = driveLine(block);
    const n = x.length;
    let longest = 0;
    let shortest = Infinity;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(x[(i + 1) % n]! - x[i]!, z[(i + 1) % n]! - z[i]!);
      longest = Math.max(longest, d);
      shortest = Math.min(shortest, d);
    }
    expect(shortest).toBeGreaterThan(0.8);
    expect(longest).toBeLessThan(4.5);
  });

  it('slows for a tight bend, and not on the straight', () => {
    const straight = bendSpeed(block, 100);
    const corner = bendSpeed(block, 200);
    expect(corner).toBeLessThan(5);
    expect(straight).toBeGreaterThan(8);
    // Braking for it beforehand, not at it.
    expect(bendSpeed(block, 190)).toBeLessThan(straight);
  });

  it('every route in Metro Manila, in both lanes', { timeout: 300_000 }, () => {
    const file = JSON.parse(
      readFileSync('public/data/metro-manila-network.json', 'utf8'),
    ) as NetworkFile;
    const first = defaultRoute();
    const network = buildNetwork(file, first.projection!, first);
    let metres = 0;
    let sideways = 0;
    let badly = 0;
    let kinks = 0;
    for (const { route } of network.routes) {
      const L = route.polyline.length;
      for (const across of [0, LANE_M]) {
        let prev = { ...flowPose(route, 0, across, pose) };
        let way: number | null = null;
        for (let s = 2; s < L; s += 2) {
          const q = { ...flowPose(route, s, across, pose) };
          const dx = q.x - prev.x;
          const dz = q.z - prev.z;
          metres += 2;
          if (Math.hypot(dx, dz) > 0.05) {
            const dir = Math.atan2(-dz, dx);
            // The step's direction belongs to the heading half way along it: against
            // the heading at its end, any tight bend would pass for sliding.
            const turned = Math.atan2(
              Math.sin(q.heading - prev.heading),
              Math.cos(q.heading - prev.heading),
            );
            const mid = prev.heading + turned / 2;
            const off = Math.abs(Math.atan2(Math.sin(dir - mid), Math.cos(dir - mid)));
            if (off > (5 * Math.PI) / 180) sideways += 2;
            if (off > (10 * Math.PI) / 180) badly += 2;
            if (way !== null) {
              const t = Math.abs(Math.atan2(Math.sin(dir - way), Math.cos(dir - way)));
              if (t > (40 * Math.PI) / 180) kinks++;
            }
            way = dir;
          }
          prev = q;
        }
      }
    }
    // Only the turnarounds at the ends of routes: a few thousandths of a percent.
    expect(sideways / metres).toBeLessThan(0.0005);
    expect(badly / metres).toBeLessThan(0.0002);
    expect(kinks).toBeLessThan(2500);
  });
});
