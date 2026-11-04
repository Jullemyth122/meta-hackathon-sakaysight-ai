import { describe, expect, it } from 'vitest';
import { defaultRoute } from '../geo/routes';
import { RoadIndex } from './crossing';
import { stripesOf, viaZebra, zebrasOf } from './zebra';

const route = defaultRoute();
const road = new RoadIndex(route);
const zebras = zebrasOf(route, road);
const MALARIA = route.stops.findIndex((s) => s.name === 'Malaria');

describe('pedestrian crossings', () => {
  it('has one at the stops, kerb to kerb, a stop each way sharing one', () => {
    expect(zebras.length).toBeGreaterThan(8);
    expect(zebras.length).toBeLessThan(route.stops.length);
    for (const z of zebras) {
      const width = Math.hypot(z.left.x - z.right.x, z.left.z - z.right.z);
      expect(width).toBeGreaterThan(3);
      expect(width).toBeLessThan(80);
    }
  });

  it('paints stripes on the road, not on the median', () => {
    const stripes = zebras.flatMap((z) => stripesOf(z, road));
    expect(stripes.length).toBeGreaterThan(zebras.length * 4);
    for (const quad of stripes) {
      const mid = { x: (quad[0]!.x + quad[2]!.x) / 2, z: (quad[0]!.z + quad[2]!.z) / 2 };
      expect(road.at(mid).length).toBeGreaterThan(0);
    }
  });

  it('takes a walk over the road to the nearest crossing', () => {
    const stop = route.polyline.pointAt(route.stops[MALARIA]!.s);
    const h = route.polyline.headingAt(route.stops[MALARIA]!.s, 8);
    const n = { x: Math.sin(h), z: Math.cos(h) };
    const from: [number, number, number] = [stop.x - n.x * 45, 0, stop.z - n.z * 45];
    const to: [number, number, number] = [stop.x + n.x * 14, 0, stop.z + n.z * 14];
    const steps = 40;
    const straight = Array.from({ length: steps + 1 }, (_, i): [number, number, number] => [
      from[0] + ((to[0] - from[0]) * i) / steps,
      0,
      from[2] + ((to[2] - from[2]) * i) / steps,
    ]);
    const way = viaZebra(straight, road, zebras);
    const crossing = zebras.find((z) =>
      way.some(([x, , zz]) => Math.hypot(x - z.left.x, zz - z.left.z) < 0.01),
    );
    expect(crossing).toBeDefined();
    expect(way[0]).toEqual(from);
    expect(way.at(-1)).toEqual(to);
  });

  it('takes a two-point walk over the road, too: no corner of it needs be on the road', () => {
    const stop = route.polyline.pointAt(route.stops[MALARIA]!.s);
    const h = route.polyline.headingAt(route.stops[MALARIA]!.s, 8);
    const n = { x: Math.sin(h), z: Math.cos(h) };
    const from: [number, number, number] = [stop.x - n.x * 45, 0, stop.z - n.z * 45];
    const to: [number, number, number] = [stop.x + n.x * 45, 0, stop.z + n.z * 45];
    const way = viaZebra([from, to], road, zebras);
    expect(way.length).toBeGreaterThan(2);
    expect(way[0]).toEqual(from);
    expect(way.at(-1)).toEqual(to);
  });

  it('far from any crossing, goes straight over, not slanting through the traffic', () => {
    // Between two stops, further than any crossing is used from.
    const at = (route.stops[MALARIA]!.s + route.stops[MALARIA + 1]!.s) / 2;
    const p = route.polyline.pointAt(at);
    const h = route.polyline.headingAt(at, 8);
    const n = { x: Math.sin(h), z: Math.cos(h) };
    const along = { x: Math.cos(h), z: -Math.sin(h) };
    // In at 60° to the road: 40 m along it for 70 m across.
    const from: [number, number, number] = [
      p.x - n.x * 35 - along.x * 20,
      0,
      p.z - n.z * 35 - along.z * 20,
    ];
    const to: [number, number, number] = [
      p.x + n.x * 35 + along.x * 20,
      0,
      p.z + n.z * 35 + along.z * 20,
    ];
    const way = viaZebra([from, to], road, zebras);
    // The leg on the road: from the one kerb to the other, square to the road.
    const legs = way.slice(1).map((b, i) => [way[i]!, b] as const);
    const over = legs.find(
      ([a, b]) => road.at({ x: (a[0] + b[0]) / 2, z: (a[2] + b[2]) / 2 }).length > 0,
    )!;
    expect(over).toBeDefined();
    const dx = over[1][0] - over[0][0];
    const dz = over[1][2] - over[0][2];
    const slant = Math.abs(dx * along.x + dz * along.z) / Math.hypot(dx, dz);
    expect(slant).toBeLessThan(0.1);
  });

  it('leaves a walk that stays on one side as it was', () => {
    const p = route.polyline.pointAt(1000);
    const h = route.polyline.headingAt(1000, 8);
    const side = (along: number): [number, number, number] => [
      p.x + Math.sin(h) * 30 + Math.cos(h) * along,
      0,
      p.z + Math.cos(h) * 30 - Math.sin(h) * along,
    ];
    const walk = [side(0), side(20), side(40)];
    expect(viaZebra(walk, road, zebras)).toEqual(walk);
  });
});
