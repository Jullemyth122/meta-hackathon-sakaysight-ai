import { describe, expect, it } from 'vitest';
import { createProjection, type LocalPoint } from '../geo/projection';
import { aheadOf } from '../geo/routes';
import { fareFor } from '../fare';
import {
  buildNetwork,
  decodePath,
  encodePath,
  MAX_DETOUR,
  MAX_WANDER,
  networkRoute,
  routeTitle,
  shortStopName,
  type NetworkFile,
  type NetworkRouteFile,
} from './network';
import { flowLoad, flowSpeedKmh, RouteFlow } from './flow';
import { keepCheapest, planTrips, TRANSFER_WALK_M, type ArrivalsAt, type TripOption } from './plan';
import { landmarks, placesOf, searchPlaces, searchRoutes } from './search';

const projection = createProjection({ lat: 14.6, lng: 121.0 });

/**
 * A loop route in local metres: out along `out`, back along `back`, a stop
 * every `every` metres each way, terminals at the start and where the way
 * back begins.
 */
function loopFile(
  id: string,
  out: LocalPoint[],
  back: LocalPoint[],
  every = 300,
): NetworkRouteFile {
  const pts = [...out, ...back, out[0]!];
  const cum = [0];
  for (let i = 1; i < pts.length; i++)
    cum.push(cum[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.z - pts[i - 1]!.z));
  const outLength = cum[out.length - 1]!;
  const backStart = cum[out.length]!;
  const backEnd = cum[out.length + back.length - 1]!;
  const stops: Array<[string, number]> = [];
  for (let s = 0; s <= outLength + 1e-6; s += every)
    stops.push([`${id} out ${s}, Somewhere City`, s]);
  const far = stops.length;
  for (let s = backStart; s <= backEnd + 1e-6; s += every) stops.push([`${id} back ${s}`, s]);
  return {
    id,
    name: `${id.toUpperCase()} - TERMINAL`,
    from: stops[0]![0],
    to: stops[far]![0],
    length: Math.round(cum[cum.length - 1]!),
    detour: 1.2,
    headwayS: 120,
    path: encodePath(pts.map((p) => projection.toGeo(p))),
    stops,
    terminals: [0, far],
  };
}

// Route A runs east–west (out along z = 0, back along z = 20); route B runs
// north–south across it at x = 1500 (out along x = 1500, back along x = 1520).
const A = loopFile(
  'a',
  [
    { x: 0, z: 0 },
    { x: 3000, z: 0 },
  ],
  [
    { x: 3000, z: 20 },
    { x: 0, z: 20 },
  ],
);
const B = loopFile(
  'b',
  [
    { x: 1500, z: -1500 },
    { x: 1500, z: 1500 },
  ],
  [
    { x: 1520, z: 1500 },
    { x: 1520, z: -1500 },
  ],
);
const file: NetworkFile = { origin: projection.origin, source: 'test', routes: [A, B] };
const network = buildNetwork(file, projection);

describe('the network file', () => {
  it('round-trips encoded paths to within a centimetre', () => {
    const pts = [
      { lat: 14.5995, lng: 120.9842 },
      { lat: 14.6507, lng: 121.0493 },
      { lat: 14.55, lng: 121.02 },
    ];
    decodePath(encodePath(pts)).forEach((p, i) => {
      expect(p.lat).toBeCloseTo(pts[i]!.lat, 6);
      expect(p.lng).toBeCloseTo(pts[i]!.lng, 6);
    });
  });

  it('builds a closed loop with its stops, terminals and directions', () => {
    const route = networkRoute(A, projection);
    expect(route.loop).toBe(true);
    const first = route.polyline.points[0]!;
    const last = route.polyline.points.at(-1)!;
    expect(Math.hypot(first.x - last.x, first.z - last.z)).toBeLessThan(0.5);
    // A little shorter: its corners are curves now, not right angles.
    expect(route.polyline.length).toBeLessThan(A.length);
    expect(route.polyline.length).toBeGreaterThan(A.length * 0.97);
    expect(route.stops[0]!.terminal).toBe(true);
    expect(route.stops.filter((s) => s.terminal)).toHaveLength(2);
    // Stops before the far terminal head towards it; stops after head home.
    const far = route.stops.findIndex((s, i) => i > 0 && s.terminal);
    expect(route.stops[1]!.towards).toBe(route.stops[far]!.name);
    expect(route.stops[far + 1]!.towards).toBe(route.stops[0]!.name);
    // Stop positions match the road: the first stop on the way back is at x = 3000.
    expect(route.polyline.pointAt(route.stops[far]!.s).x).toBeGreaterThan(2960);
    expect(route.stopsSource).toBe('gtfs');
  });

  it('puts the far terminal where the road turns round, not at a stop of the same name', () => {
    // The feed's far terminal name matched a stop 1 km out (as Novaliches – Tala's
    // "City of San Jose del Monte" did by SM Fairview); the road turns at x = 3000.
    const misplaced = { ...A, terminals: [0, 3] as [number, number] };
    const route = networkRoute(misplaced, projection);
    const terminals = route.stops.filter((s) => s.terminal);
    expect(terminals).toHaveLength(2);
    expect(route.polyline.pointAt(terminals[1]!.s).x).toBeGreaterThan(2700);
    // No stop near the turn: a terminal of its own there, named for the far end.
    const bare: NetworkRouteFile = {
      ...misplaced,
      stops: misplaced.stops.filter(([, s]) => s < 1500 || s > A.length - 1500),
    };
    const ended = networkRoute(bare, projection);
    const far = ended.stops.find((s, i) => i > 0 && s.terminal)!;
    // Where the road turns round, its curve starting a little before the end.
    expect(ended.polyline.pointAt(far.s).x).toBeGreaterThan(2960);
    expect(far.name).toBe(shortStopName(A.to));
    expect(ended.stops.every((s, i) => i === 0 || s.s >= ended.stops[i - 1]!.s)).toBe(true);
  });

  it('shortens GTFS stop names and fixes all-caps route names', () => {
    expect(shortStopName('Quirino Highway / La Mesa Road Intersection, Caloocan City')).toBe(
      'Quirino Highway / La Mesa Road',
    );
    expect(routeTitle('HULO - P. VICTORINO/KALENTONG')).toBe('Hulo - P. Victorino/Kalentong');
    expect(routeTitle('Alabang Fairview')).toBe('Alabang Fairview');
  });

  it('leaves out routes whose road path wandered or missed their stops', () => {
    const wandered = { ...B, id: 'c', wander: MAX_WANDER + 0.05 };
    const missed = { ...B, id: 'd', wander: 0.01, stopsTotal: B.stops.length * 2 };
    const old = { ...B, id: 'e', detour: MAX_DETOUR + 0.5 }; // no wander measure: detour decides
    const fine = { ...B, id: 'f', wander: 0.02, detour: 4 }; // a one-way grid, not a wander
    const net = buildNetwork({ ...file, routes: [A, wandered, missed, old, fine] }, projection);
    expect(net.routes.map((r) => r.route.id)).toEqual(['a', 'f']);
  });

  it('finds the stops of both routes where they cross, nearest first', () => {
    const near = network.stops.near({ x: 1505, z: 5 }, 120);
    expect(new Set(near.map((s) => s.route))).toEqual(new Set([0, 1]));
    for (let i = 1; i < near.length; i++)
      expect(near[i]!.distanceM).toBeGreaterThanOrEqual(near[i - 1]!.distanceM);
  });
});

describe('jeepney flows', () => {
  const route = network.routes[0]!.route;
  const flow = new RouteFlow(route, 120);

  it('runs as many jeepneys as the headway needs, each on the loop', () => {
    // 6 km loop at 22 km/h is about 16 min; one every 2 min is 8 jeepneys.
    expect(flow.count).toBe(8);
    for (const v of flow.vehicles(8 * 3600)) {
      expect(v.s).toBeGreaterThanOrEqual(0);
      expect(v.s).toBeLessThan(route.polyline.length);
      expect(v.occupancy).toBeGreaterThanOrEqual(0);
      expect(v.occupancy).toBeLessThanOrEqual(v.capacity);
    }
  });

  it('is the same whenever it is asked, and moves at the flow speed', () => {
    const t = 13 * 3600;
    expect(flow.vehicle(3, t)).toEqual(flow.vehicle(3, t));
    const moved = aheadOf(route, flow.vehicle(3, t).s, flow.vehicle(3, t + 10).s);
    expect(moved).toBeCloseTo((flowSpeedKmh(13) / 3.6) * 10, 3);
  });

  it('is slower and fuller in the rush hour than at midday', () => {
    expect(flowSpeedKmh(8)).toBeLessThan(flowSpeedKmh(13));
    expect(flowLoad(7.5)).toBeGreaterThan(flowLoad(13));
    const avg = (h: number) =>
      flow.vehicles(h * 3600).reduce((a, v) => a + v.occupancy, 0) / flow.count;
    expect(avg(7.5)).toBeGreaterThan(avg(14));
  });

  it('lists the next jeepneys to a stop, soonest first', () => {
    const arrivals = flow.arrivals(route.stops[3]!.s, 9 * 3600, 3);
    expect(arrivals).toHaveLength(3);
    for (let i = 1; i < arrivals.length; i++)
      expect(arrivals[i]!.etaS).toBeGreaterThanOrEqual(arrivals[i - 1]!.etaS);
  });
});

describe('finding routes and places by name', () => {
  it('finds a route by any words of its name or ends, in any order', () => {
    expect(searchRoutes(network, 'terminal a')).toEqual([0]);
    expect(searchRoutes(network, 'B')).toEqual([1]);
    expect(searchRoutes(network, 'nowhere at all')).toEqual([]);
    expect(searchRoutes(network, '   ')).toEqual([]);
  });

  it('lists each stop name once as a place, busiest first', () => {
    const places = placesOf(network);
    const names = places.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
    const found = searchPlaces(places, 'a out 300');
    expect(found[0]!.name).toBe('a out 300');
    // The place is where that stop is on the road.
    expect(found[0]!.at.x).toBeCloseTo(300, 0);
  });
});

describe('landmarks people name', () => {
  const places = [
    ...landmarks(
      [
        ['Araneta Center - Cubao', 'station', 14.62, 121.05],
        ['Cubao', 'area', 14.619, 121.052],
        ['Divisoria Mall', 'mall', 14.6, 120.97],
      ],
      (p) => projection.toLocal(p),
    ),
    ...placesOf(network),
  ];

  it('puts names that start with the query first, then landmarks before stops', () => {
    expect(searchPlaces(places, 'cubao').map((p) => p.name)).toEqual([
      'Cubao',
      'Araneta Center - Cubao',
    ]);
    expect(searchPlaces(places, 'divi')[0]!.kind).toBe('mall');
  });

  it('puts the name itself first, and of those the one near the route on the map', () => {
    const local = projection.toLocal({ lat: 14.619, lng: 121.052 });
    const two = [
      ...landmarks([['Sampaguita', 'area', 14.6, 121.2]], (p) => projection.toLocal(p)),
      { name: 'Sampaguita', kind: 'stop', at: local, routes: 1 },
      ...landmarks([['Sampaguita Village', 'area', 14.62, 121.05]], (p) => projection.toLocal(p)),
    ];
    const near = (p: { at: { x: number; z: number } }) =>
      Math.hypot(p.at.x - local.x, p.at.z - local.z) < 3000;
    expect(searchPlaces(two, 'sampaguita', 8, near).map((p) => p.kind)).toEqual([
      'stop',
      'area',
      'area',
    ]);
    expect(searchPlaces(two, 'sampaguita', 8, near)[2]!.name).toBe('Sampaguita Village');
    // Without knowing where the person is, landmarks before stops as before.
    expect(searchPlaces(two, 'sampaguita')[0]!.kind).toBe('area');
  });

  it('places a landmark where it is on the map', () => {
    const cubao = searchPlaces(places, 'cubao')[0]!;
    const expected = projection.toLocal({ lat: 14.619, lng: 121.052 });
    expect(cubao.at.x).toBeCloseTo(expected.x, 3);
    expect(cubao.at.z).toBeCloseTo(expected.z, 3);
  });
});

describe('the cheapest trip', () => {
  let line = 0;
  const trip = (totalS: number, fare: number, route = line++) =>
    ({
      totalS,
      fare,
      legs: [{ route, routeName: `R${route}`, alsoBy: [] }],
    }) as unknown as TripOption;

  it('is kept in place of the slowest when the fastest three all cost more', () => {
    const a = trip(600, 40);
    const b = trip(700, 40);
    const c = trip(800, 40);
    const low = trip(1500, 14);
    const best = [a, b, c];
    keepCheapest(best, [a, b, c, trip(1200, 30), low]);
    expect(best).toEqual([a, b, low]);
  });

  it('takes the fastest at that fare, and adds nothing when it is already there', () => {
    const a = trip(600, 14);
    const best = [a];
    keepCheapest(best, [a, trip(900, 14)]);
    expect(best).toEqual([a]);
    const fast = trip(500, 40);
    const low = trip(900, 14);
    const list = [fast];
    keepCheapest(list, [fast, low, trip(950, 14)]);
    expect(list).toEqual([fast, low]);
  });

  it('is not the same jeepney getting off sooner', () => {
    const line7 = trip(600, 40, 7);
    const best = [line7];
    keepCheapest(best, [line7, trip(500, 14, 7)]);
    expect(best).toEqual([line7]);
  });
});

describe('planning a trip across the network', () => {
  const flows = network.routes.map((r) => new RouteFlow(r.route, r.meta.headwayS));
  const arrivals: ArrivalsAt = (r, stop, t) =>
    flows[r]!.arrivals(network.routes[r]!.route.stops[stop]!.s, t);

  it('rides one jeepney when one goes all the way, with the right fare', () => {
    const options = planTrips(network, { x: 100, z: -30 }, { x: 2900, z: -30 }, 9 * 3600, arrivals);
    expect(options.length).toBeGreaterThan(0);
    const best = options[0]!;
    expect(best.legs).toHaveLength(1);
    expect(best.legs[0]!.route).toBe(0);
    expect(best.legs[0]!.fare).toBe(fareFor(best.legs[0]!.rideM / 1000));
    expect(best.walkToM).toBeLessThan(700);
  });

  it('changes jeepneys where two routes cross, with a short walk', () => {
    const options = planTrips(
      network,
      { x: 100, z: -30 },
      { x: 1530, z: 1450 },
      9 * 3600,
      arrivals,
    );
    const change = options.find((o) => o.legs.length === 2)!;
    expect(change).toBeDefined();
    expect(change.legs.map((l) => l.route)).toEqual([0, 1]);
    expect(change.transferWalkM).toBeLessThanOrEqual(TRANSFER_WALK_M);
    expect(change.fare).toBe(change.legs[0]!.fare + change.legs[1]!.fare);
    // The second jeepney is waited for after the first ride, not before it.
    expect(change.totalS).toBeGreaterThan(change.legs[0]!.rideS + change.legs[1]!.rideS);
  });

  it('takes a tricycle to the stop from too far to walk, and counts its time', () => {
    // 1.8 km north of route A, nowhere near a stop on foot.
    const options = planTrips(
      network,
      { x: 300, z: -1800 },
      { x: 2900, z: -30 },
      9 * 3600,
      arrivals,
    );
    const best = options[0]!;
    expect(best.toBy).toBe('tricycle');
    expect(best.fromBy).toBe('walk');
    // The tricycle (its wait and ride) is counted, and beats walking the 1.8 km.
    const ride = best.legs[0]!;
    expect(best.totalS).toBeGreaterThan(ride.waitS + ride.rideS + 180);
    expect(best.totalS).toBeLessThan(ride.waitS + ride.rideS + 1800 / 1.2 + 600);
  });

  it('offers routes doing the same ride as one option: whichever comes first', () => {
    // Route C runs exactly where A does, from the same stops.
    const C = { ...A, id: 'c', name: 'C - TERMINAL' };
    const net = buildNetwork({ ...file, routes: [A, B, C] }, projection);
    const fl = net.routes.map((r) => new RouteFlow(r.route, r.meta.headwayS));
    const arr: ArrivalsAt = (r, stop, t) => fl[r]!.arrivals(net.routes[r]!.route.stops[stop]!.s, t);
    const options = planTrips(net, { x: 100, z: -30 }, { x: 2900, z: -30 }, 9 * 3600, arr);
    const direct = options.filter((o) => o.legs.length === 1);
    expect(direct).toHaveLength(1);
    const names = [direct[0]!.legs[0]!.routeName, ...direct[0]!.legs[0]!.alsoBy];
    expect(names.sort()).toEqual(['A - Terminal', 'C - Terminal']);
  });

  it('suggests walking, not a jeepney, for a few steps', () => {
    expect(planTrips(network, { x: 100, z: -10 }, { x: 160, z: -10 }, 9 * 3600, arrivals)).toEqual(
      [],
    );
  });

  it('finds nothing when nowhere near a route, rather than inventing a trip', () => {
    expect(planTrips(network, { x: 9000, z: 9000 }, { x: 100, z: 0 }, 9 * 3600, arrivals)).toEqual(
      [],
    );
  });
});
