import { describe, expect, it } from 'vitest';
import { TwinRuntime } from '@/app/twinRuntime';
import { FIELD_SCENARIO, SERVICE_FROM_S } from '../fleet/scenario';
import { Polyline } from '../geo/polyline';
import type { LocalPoint } from '../geo/projection';
import type { Route } from '../geo/routes';
import { stopSides } from './stopLayout';
import { kindOf, riderKindOf } from './passengerSystem';
import { newRiderPose } from './riderMotion';
import { Catchments, inLane, StreetGraph, type Point3 } from './streetGraph';

/**
 * A main road along z = 0 (a line route, x 0 to 1200) through a small town:
 * side streets every 200 m running 400 m off both sides, from 10 m off the
 * road, joined by cross streets 150 and 300 m out. Highways are not in the
 * street network, so the side streets meet only at the road.
 */
const route: Route = {
  id: 'town',
  name: 'Town',
  source: 'synthetic',
  projection: null,
  stopsSource: 'placeholder',
  loop: false,
  polyline: new Polyline([
    { x: 0, z: 0 },
    { x: 1200, z: 0 },
  ]),
  stops: [
    { name: 'West', s: 0, terminal: true },
    { name: 'Market', s: 400 },
    { name: 'School', s: 800 },
    { name: 'East', s: 1200, terminal: true },
  ],
};

function townStreets(): LocalPoint[][] {
  const lines: LocalPoint[][] = [];
  for (const side of [1, -1])
    for (let x = 100; x <= 1100; x += 200) {
      lines.push([
        { x, z: 10 * side },
        { x, z: 150 * side },
        { x, z: 300 * side },
        { x, z: 400 * side },
      ]);
      for (const z of [150, 300])
        if (x + 200 <= 1100)
          lines.push([
            { x, z: z * side },
            { x: x + 200, z: z * side },
          ]);
    }
  return lines;
}

const offRoad = (p: { x: number; z: number }) => Math.abs(p.z);

/** The town's streets as the map has them: minor streets, 6.5 m kerb to kerb. */
const MINOR_M = 6.5;
function townStreetsWide() {
  return townStreets().map((line) => Object.assign(line, { width: MINOR_M }));
}

/** Metres from `p` to the nearest street centre line of `lines`. */
function toStreet(lines: LocalPoint[][], p: { x: number; z: number }): number {
  let best = Infinity;
  for (const line of lines)
    for (let i = 1; i < line.length; i++) {
      const a = line[i - 1]!;
      const b = line[i]!;
      const ex = b.x - a.x;
      const ez = b.z - a.z;
      const t = Math.max(
        0,
        Math.min(1, ((p.x - a.x) * ex + (p.z - a.z) * ez) / (ex * ex + ez * ez)),
      );
      best = Math.min(best, Math.hypot(a.x + ex * t - p.x, a.z + ez * t - p.z));
    }
  return best;
}

/** Points every metre along `path`. */
function along(path: readonly Point3[]): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  for (let i = 1; i < path.length; i++) {
    const [ax, , az] = path[i - 1]!;
    const [bx, , bz] = path[i]!;
    const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, bz - az)));
    for (let k = 0; k <= n; k++)
      out.push({ x: ax + ((bx - ax) * k) / n, z: az + ((bz - az) * k) / n });
  }
  return out;
}

describe('the street network', () => {
  it('joins streets the tiles cut apart, and finds the shortest way along them', () => {
    // One street cut at a tile edge: its two halves end 2 m apart.
    const g = new StreetGraph([
      [
        { x: 0, z: 0 },
        { x: 100, z: 0 },
      ],
      [
        { x: 102, z: 0 },
        { x: 200, z: 0 },
      ],
      [
        { x: 0, z: 0 },
        { x: 0, z: 50 },
        { x: 200, z: 50 },
        { x: 200, z: 0 },
      ],
    ]);
    const from = g.nearest({ x: 0, z: 0 }, 1);
    const to = g.nearest({ x: 200, z: 0 }, 1);
    const reach = g.reach([[from, 0]], 1000);
    // Straight along the joined street (~200 m), not round the 300 m block.
    expect(reach.dist[to]).toBeCloseTo(200, 0);
    expect(g.pathTo(reach, to).map((n) => g.x[n]!)).toEqual([200, 102, 100, 0]);
  });

  it('joins a side street drawn up to another without a point in common (a T-junction)', () => {
    const g = new StreetGraph([
      [
        { x: 0, z: 0 },
        { x: 200, z: 0 },
      ],
      // Its end 0.4 m off the street, 100 m from either end of that segment.
      [
        { x: 100, z: 100 },
        { x: 100, z: 0.4 },
      ],
    ]);
    const from = g.nearest({ x: 100, z: 100 }, 1);
    const reach = g.reach([[from, 0]], 1000);
    expect(reach.dist[g.nearest({ x: 0, z: 0 }, 1)]).toBeCloseTo(200, 0);
    expect(reach.dist[g.nearest({ x: 200, z: 0 }, 1)]).toBeCloseTo(200, 0);
    expect(g.piece[from]).toBe(g.piece[g.nearest({ x: 0, z: 0 }, 1)]);
  });

  it('puts people at the street’s edge, tricycles in the right-hand lane, footpaths walked on', () => {
    const east = [
      { x: 0, z: 0 },
      { x: 100, z: 0 },
    ];
    // Going +x, the right is +z (as the stops' pavements: stopLayout.ts).
    expect(inLane(east, [MINOR_M], 'right')).toEqual([
      [0, 0, 4.75],
      [100, 0, 4.75],
    ]);
    expect(inLane(east, [MINOR_M], 'left')[0]![2]).toBeCloseTo(-4.75);
    expect(inLane(east, [MINOR_M], 'drive')[0]![2]).toBeCloseTo(MINOR_M / 4);
    expect(inLane(east, [1.6], 'right')[0]![2]).toBe(0);
    // Round a corner: where the two edges meet, not across the block.
    const corner = inLane([...east, { x: 100, z: 100 }], [MINOR_M, MINOR_M], 'right');
    expect(corner).toHaveLength(3);
    expect(corner[1]![0]).toBeCloseTo(95.25);
    expect(corner[1]![2]).toBeCloseTo(4.75);
    expect(corner[2]![0]).toBeCloseTo(95.25);
  });

  it('walks people beside the streets, not down the middle; tricycles drive on them', () => {
    const lines = townStreetsWide();
    const c = new Catchments(new StreetGraph(lines), route, stopSides(route));
    for (let k = 0; k < 20; k++) {
      const place = c.place(1, 1, k / 20)!;
      // Off the main road (people cross it to the stop, and walk its pavement).
      const side = k % 2 ? 'left' : 'right';
      const walked = along(c.toStop(place.node, 1, { x: 400, z: 9 }, side)!).filter(
        (p) => offRoad(p) > 30,
      );
      const drive = along(c.toStop(place.node, 1, { x: 400, z: 9 }, 'drive')!).filter(
        (p) => offRoad(p) > 30,
      );
      expect(walked.length).toBeGreaterThan(0);
      for (const p of walked) expect(toStreet(lines, p)).toBeLessThan(MINOR_M / 2 + 2);
      // Only crossing a side street are they in the road.
      const inRoad = walked.filter((p) => toStreet(lines, p) < MINOR_M / 2).length;
      expect(inRoad / walked.length).toBeLessThan(0.1);
      for (const p of drive) expect(toStreet(lines, p)).toBeLessThanOrEqual(MINOR_M / 2);
    }
  });

  it('brings people to a stop from homes on the side streets, either side of the road', () => {
    const c = new Catchments(new StreetGraph(townStreets()), route, stopSides(route));
    expect(c.has(1, 1)).toBe(true);
    const sides = new Set<number>();
    for (let k = 0; k < 40; k++) {
      const place = c.place(1, 1, k / 40)!;
      // Their stop is the one their streets lead to.
      expect(c.stopOf(place.node, 1)).toMatchObject({ stop: 1, direction: 1 });
      const path = c.toStop(place.node, 1, { x: 400, z: 9 })!;
      // From a house well off the main road, to the stop itself.
      expect(offRoad({ x: path[0]![0], z: path[0]![2] })).toBeGreaterThan(25);
      expect(path.at(-1)).toEqual([400, 0, 9]);
      sides.add(Math.sign(path[0]![2]));
    }
    // From both sides: those across the road cross it to the stop.
    expect(sides).toEqual(new Set([1, -1]));
  });

  it('reaches neighbourhoods far up the side streets, a tricycle ride from the stop', () => {
    // A subdivision 2 km up the street at x = 500, its own streets every 100 m.
    const far: LocalPoint[][] = [
      [
        { x: 500, z: 400 },
        { x: 500, z: 2000 },
        { x: 500, z: 2400 },
      ],
    ];
    for (let z = 2000; z <= 2400; z += 100)
      far.push([
        { x: 300, z },
        { x: 500, z },
        { x: 700, z },
      ]);
    const c = new Catchments(new StreetGraph([...townStreets(), ...far]), route, stopSides(route));
    const distances = Array.from({ length: 200 }, (_, k) => c.place(1, 1, k / 200)!.metres);
    // Most live near, but the far subdivision rides in too: 2 km and more by street.
    expect(distances.filter((d) => d > 1900).length).toBeGreaterThan(5);
    expect(distances.filter((d) => d < 900).length).toBeGreaterThan(100);
    expect(Math.max(...distances)).toBeLessThanOrEqual(3000);
    // And `placeAbout` finds a home about as far as asked (the toy grid has few that far).
    expect(c.placeAbout(1, 1, 2200, 0.99)!.metres).toBeGreaterThan(2000);
  });
});

describe('a commuting day on the streets', () => {
  it(
    'nobody waits before the day starts; people come from home, ride to work, and go home in the evening',
    { timeout: 120_000 },
    () => {
      const twin = new TwinRuntime(route, undefined, {
        ...FIELD_SCENARIO,
        vehicles: 4,
        dailyTrips: 4 * 300,
      });
      const { crew, fleet } = twin;
      const c = new Catchments(new StreetGraph(townStreets()), route, stopSides(route));
      crew.setStreets(c);
      // 5 AM: nobody at the stops yet.
      expect([...crew.passengers.values()].filter((p) => p.phase === 'waiting')).toHaveLength(0);

      const firstSeen = new Set<number>();
      let morningFromHome = 0;
      let morningOnRoad = 0;
      let leftWorkEarly = 0;
      const goingHome = new Map<number, { x: number; z: number }>();
      let reachedHome = 0;
      while (fleet.timeOfDay < 23.5 * 3600 && fleet.dayNumber === 1) {
        twin.step(1, 0);
        const now = fleet.timeOfDay;
        for (const r of crew.passengers.values()) {
          if (r.phase === 'approaching' && !firstSeen.has(r.id)) {
            firstSeen.add(r.id);
            if (now < 12 * 3600) {
              if (r.tour === 'out' && offRoad(r.pose) > 25) morningFromHome++;
              else morningOnRoad++;
            }
            if (r.tour === 'back' && now < 16 * 3600) leftWorkEarly++;
          }
          if (r.tour === 'back' && r.phase === 'walking' && r.homeNode !== undefined)
            goingHome.set(r.id, { x: c.graph.x[r.homeNode]!, z: c.graph.z[r.homeNode]! });
          const home = goingHome.get(r.id);
          if (home && r.phase === 'arrived') {
            expect(Math.hypot(r.pose.x - home.x, r.pose.z - home.z)).toBeLessThan(1);
            goingHome.delete(r.id);
            reachedHome++;
          }
        }
        expect(now).toBeGreaterThanOrEqual(SERVICE_FROM_S - 3600 * 0.6);
      }
      // Everyone in the morning came from a home on the side streets.
      expect(morningFromHome).toBeGreaterThan(100);
      expect(morningOnRoad).toBe(0);
      // Nobody leaves work before 4 PM; many are home by 11:30 PM, by their own streets.
      expect(leftWorkEarly).toBe(0);
      expect(reachedHome).toBeGreaterThan(morningFromHome * 0.4);
    },
  );
});

describe('the commuter app’s own rider', () => {
  const town = () => {
    const twin = new TwinRuntime(route, undefined, {
      ...FIELD_SCENARIO,
      vehicles: 2,
      startHour: 7,
    });
    return twin;
  };

  it('is who they say: their type sets their fare; everyone else keeps the usual mix', () => {
    const twin = town();
    const id = twin.crew.join(1, 3, 0, 'walk', { kind: 'student' });
    expect(kindOf(twin.crew.passengers.get(id)!)).toBe('student');
    const mix = { regular: 0, student: 0, senior: 0, pwd: 0, pregnant: 0 };
    for (let i = 0; i < 10_000; i++) mix[riderKindOf(i)]++;
    expect(mix.regular / 100).toBeCloseTo(65, -1);
    expect(mix.student / 100).toBeCloseTo(20, -1);
    expect(mix.pregnant).toBeGreaterThan(100);
  });

  it('sets out from the spot picked on the map, along the streets to the stop they lead to', () => {
    const twin = town();
    twin.crew.setStreets(new Catchments(new StreetGraph(townStreets()), route, stopSides(route)));
    // Up the side street at x = 300, 250 m off the road: Market (x = 400) is the way in.
    const spot = { x: 310, z: 250 };
    const m = twin.crew.firstMileFrom(spot, 3)!;
    expect(m.stop).toBe(1);
    expect(m.direction).toBe(1);
    expect(m.metres).toBeGreaterThan(300);
    const id = twin.crew.join(0, 3, 0, 'tricycle', { from: spot });
    const r = twin.crew.passengers.get(id)!;
    expect(r.originStop).toBe(1);
    expect(r.phase).toBe('approaching');
    expect(Math.hypot(r.pose.x - spot.x, r.pose.z - spot.z)).toBeLessThan(0.5);
    // Going the other way, they board across the road.
    expect(twin.crew.firstMileFrom(spot, 0)).toMatchObject({ stop: 1, direction: -1 });
  });

  /** Where rider `id` will be over their whole way to the stop, a point every half second. */
  const wayOf = (twin: TwinRuntime, id: number) => {
    const r = twin.crew.passengers.get(id)!;
    const pose = newRiderPose();
    const out: Array<{ x: number; z: number }> = [];
    const { duration } = r.motion!;
    for (let t = 0; t < duration + 0.5; t += 0.5) {
      r.motion!.poseAt(Math.min(t, duration), pose);
      out.push({ x: pose.x, z: pose.z });
    }
    return out;
  };

  it('from a spot whose streets lead to no stop going there, rides by the streets, not across blocks', () => {
    const twin = town();
    const lines = townStreetsWide();
    twin.crew.setStreets(new Catchments(new StreetGraph(lines), route, stopSides(route)));
    // Up the street at x = 1100: its stop is East, the end of the line. To
    // get there they board at School, by the streets.
    const spot = { x: 1108, z: 250 };
    expect(twin.crew.firstMileFrom(spot, 3)).toMatchObject({ stop: 2, direction: 1 });
    const id = twin.crew.join(0, 3, 0, 'tricycle', { from: spot });
    const r = twin.crew.passengers.get(id)!;
    expect(r.originStop).toBe(2);
    expect(Math.hypot(r.pose.x - spot.x, r.pose.z - spot.z)).toBeLessThan(0.5);
    const way = wayOf(twin, id);
    // Past the few steps out to the street: on the streets, or by the main road.
    for (const p of way.slice(4))
      if (offRoad(p) > 30) expect(toStreet(lines, p)).toBeLessThanOrEqual(MINOR_M / 2);
    expect(Math.hypot(way.at(-1)!.x - r.spot!.x, way.at(-1)!.z - r.spot!.z)).toBeLessThan(0.5);
  });

  it('on a planned trip, sets out from where it starts to the stop the planner chose', () => {
    const twin = town();
    const lines = townStreetsWide();
    twin.crew.setStreets(new Catchments(new StreetGraph(lines), route, stopSides(route)));
    // The streets here lead to East; the planner chose Market (x = 400).
    const spot = { x: 1108, z: 250 };
    const id = twin.crew.join(1, 3, 900, 'tricycle', { from: spot, keepStop: true });
    const r = twin.crew.passengers.get(id)!;
    expect(r.originStop).toBe(1);
    expect(Math.hypot(r.pose.x - spot.x, r.pose.z - spot.z)).toBeLessThan(0.5);
    const way = wayOf(twin, id);
    expect(Math.hypot(way.at(-1)!.x - r.spot!.x, way.at(-1)!.z - r.spot!.z)).toBeLessThan(0.5);
    for (const p of way.slice(4))
      if (offRoad(p) > 30) expect(toStreet(lines, p)).toBeLessThanOrEqual(MINOR_M / 2);
  });

  it('started before the streets are in, goes by them from where they are once they are', () => {
    const twin = town();
    const spot = { x: 310, z: 250 };
    const id = twin.crew.join(0, 3, 0, 'walk', { from: spot });
    const r = twin.crew.passengers.get(id)!;
    expect(r.offStreets).toBe(true);
    for (let i = 0; i < 20; i++) twin.step(0.5, 0);
    const there = { x: r.pose.x, z: r.pose.z };
    const lines = townStreetsWide();
    twin.crew.setStreets(new Catchments(new StreetGraph(lines), route, stopSides(route)));
    expect(r.offStreets).toBeUndefined();
    expect(r.phase).toBe('approaching');
    // On from where they were, not back to the start.
    expect(Math.hypot(r.pose.x - there.x, r.pose.z - there.z)).toBeLessThan(0.5);
    for (const p of wayOf(twin, id).slice(40))
      if (offRoad(p) > 30) expect(toStreet(lines, p)).toBeLessThan(MINOR_M / 2 + 2);
  });

  it('without streets, goes straight to the nearest stop that takes them there, up to 3 km', () => {
    const twin = town();
    expect(twin.crew.firstMileFrom({ x: 790, z: 120 }, 3)).toMatchObject({ stop: 2, direction: 1 });
    expect(twin.crew.firstMileFrom({ x: 600, z: 5000 }, 3)).toBeNull();
    expect(() => twin.crew.join(0, 3, 0, 'walk', { from: { x: 600, z: 5000 } })).toThrow();
  });
});

describe('streets built in a worker', () => {
  it('come back to the page the same, through a copy as postMessage makes', async () => {
    const { buildStreets, fromStreetsState, streetsRoute, streetsState } =
      await import('./streetsBuild');
    const lines = townStreetsWide();
    const flat = (ls: typeof lines) => {
      const points: number[] = [];
      const starts = [0];
      for (const l of ls) {
        for (const p of l) points.push(p.x, p.z);
        starts.push(points.length / 2);
      }
      return {
        points: new Float32Array(points),
        starts: new Uint32Array(starts),
        widths: new Float32Array(ls.map(() => MINOR_M)),
        national: new Uint8Array(ls.length),
        risky: new Uint8Array(ls.length),
        hazards: {
          points: new Float32Array(),
          starts: new Uint32Array([0]),
          kinds: new Uint8Array(),
        },
      };
    };
    const built = buildStreets(streetsRoute(route), [flat(lines)]);
    const direct = new Catchments(new StreetGraph(lines), route, stopSides(route));
    const { state, transfer } = streetsState(built);
    const copy = structuredClone(state, { transfer });
    const back = fromStreetsState(route, copy);
    expect(back.graph.size).toBe(direct.graph.size);
    for (let k = 0; k < 10; k++) {
      const a = direct.place(1, 1, k / 10)!;
      expect(back.place(1, 1, k / 10)).toEqual(a);
      expect(back.toStop(a.node, 1, { x: 400, z: 9 }, 'left')).toEqual(
        direct.toStop(a.node, 1, { x: 400, z: 9 }, 'left'),
      );
      expect(back.stopOf(a.node, -1)).toEqual(direct.stopOf(a.node, -1));
    }
    const spot = { x: 1108, z: 250 };
    expect(back.wayFrom(spot, 2, 1, { x: 800, z: 9 }, 'drive', 250)).toEqual(
      direct.wayFrom(spot, 2, 1, { x: 800, z: 9 }, 'drive', 250),
    );
  });
});
