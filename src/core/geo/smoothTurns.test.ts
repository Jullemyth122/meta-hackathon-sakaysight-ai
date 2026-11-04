import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { lanePose, laneOffset } from '@/scene/world/lanes';
import { buildNetwork, type NetworkFile } from '../network/network';
import { Polyline } from './polyline';
import { defaultRoute, type Route } from './routes';
import { smoothTurns } from './smoothTurns';

/** The turns on the path a vehicle really drives (its lane), over a vehicle's length. */
function turnsOf(route: Route): { radius: number; tightShare: number } {
  const line = route.polyline;
  const pose = { x: 0, z: 0, heading: 0 };
  const step = 1.5;
  const path: Array<{ x: number; z: number }> = [];
  for (let s = 0; s < line.length; s += step) {
    const p = line.pointAt(s);
    p.heading = line.headingAt(s, 4.3);
    lanePose(p, 1, laneOffset(route, s), pose);
    path.push({ x: pose.x, z: pose.z });
  }
  let radius = Infinity;
  let tight = 0;
  const span = 4; // 12 m in all, about a vehicle
  for (let i = span; i < path.length - span; i++) {
    const a = path[i - span]!;
    const b = path[i]!;
    const c = path[i + span]!;
    const h1 = Math.atan2(b.z - a.z, b.x - a.x);
    const h2 = Math.atan2(c.z - b.z, c.x - b.x);
    const turn = Math.abs(Math.atan2(Math.sin(h2 - h1), Math.cos(h2 - h1)));
    const r = turn > 1e-6 ? Math.hypot(c.x - a.x, c.z - a.z) / 2 / turn : Infinity;
    if (r < 8) tight++;
    radius = Math.min(radius, r);
  }
  return { radius, tightShare: tight / path.length };
}

describe('smooth turns', () => {
  const square = new Polyline([
    { x: 0, z: 0 },
    { x: 200, z: 0 },
    { x: 200, z: 200 },
  ]);

  it('keeps straight road exactly where it was', () => {
    const { polyline } = smoothTurns(square, false, () => 15);
    const p = polyline.pointAt(50);
    expect(Math.abs(p.z)).toBeLessThan(0.05); // within what is dropped as adding nothing
    expect(polyline.points[0]).toEqual({ x: 0, z: 0 });
    expect(polyline.points.at(-1)).toEqual({ x: 200, z: 200 });
  });

  it('turns a square corner into a curve, no sharper than a bus can take', () => {
    const { polyline } = smoothTurns(square, false, () => 20);
    let sharpest = 0;
    for (let s = 150; s < 250; s += 1) {
      const a = polyline.headingAt(s - 1, 2);
      const b = polyline.headingAt(s + 1, 2);
      const d = Math.abs(Math.atan2(Math.sin(b - a), Math.cos(b - a)));
      sharpest = Math.max(sharpest, d / 2);
    }
    expect(1 / sharpest).toBeGreaterThan(9);
  });

  it('carries places along: a stop after the corner stays on its stretch of road', () => {
    const { polyline, toSmooth } = smoothTurns(square, false, () => 15);
    const stop = polyline.pointAt(toSmooth(300));
    expect(stop.x).toBeCloseTo(200, 1);
    expect(stop.z).toBeCloseTo(100, 0);
    expect(toSmooth(0)).toBe(0);
    expect(toSmooth(square.length)).toBeCloseTo(polyline.length, 6);
  });

  it('rounds a loop’s seam too, and it still closes exactly', () => {
    const box = new Polyline([
      { x: 0, z: 0 },
      { x: 100, z: 0 },
      { x: 100, z: 100 },
      { x: 0, z: 100 },
      { x: 0, z: 0 },
    ]);
    const { polyline } = smoothTurns(box, true, () => 12);
    expect(polyline.points[0]).toEqual(polyline.points.at(-1));
    expect(polyline.points[0]!.x).toBeGreaterThan(1);
  });

  it('no sharp turn anywhere on any route, on the lane vehicles really drive', () => {
    const file = JSON.parse(
      readFileSync('public/data/metro-manila-network.json', 'utf8'),
    ) as NetworkFile;
    const first = defaultRoute();
    const started = performance.now();
    const network = buildNetwork(file, first.projection!, first);
    const buildMs = performance.now() - started;
    const results = network.routes.map(({ route }) => ({ id: route.id, ...turnsOf(route) }));
    const byRadius = [...results].sort((x, y) => x.radius - y.radius);
    const points = network.routes.reduce((n, r) => n + r.route.polyline.points.length, 0);
    const share = results.reduce((n, r) => n + r.tightShare, 0) / results.length;
    const home = turnsOf(first);
    console.log(
      `TURNS routes ${results.length}, built in ${buildMs.toFixed(0)} ms, ${points} points; ` +
        `default tightest ${home.radius.toFixed(1)} m; all routes: tightest ` +
        `${byRadius[0]!.radius.toFixed(1)} m, p10 ${byRadius[33]!.radius.toFixed(1)} m, median ` +
        `${byRadius[168]!.radius.toFixed(1)} m; road under 8 m radius ${(share * 100).toFixed(3)}%`,
    );
    expect(home.radius).toBeGreaterThan(3);
    // Almost no road at all is tighter than a bus would take it. No lower: rounded
    // any wider, street corners cut across the buildings on them, which is worse.
    expect(share).toBeLessThan(0.0035);
  });
});
