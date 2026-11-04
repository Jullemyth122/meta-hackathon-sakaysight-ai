import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { defaultRoute, kerbAt } from '../geo/routes';
import { buildNetwork, type NetworkFile } from './network';
import { RouteFlow } from './flow';
import { planTrips, WALK_TO_STOP_M } from './plan';
import { landmarks, placesOf, searchPlaces, withAliases } from './search';

describe('the Quirino Highway corridor in the network file', () => {
  const file = JSON.parse(
    readFileSync('public/data/metro-manila-network.json', 'utf8'),
  ) as NetworkFile;
  const first = defaultRoute();
  const network = buildNetwork(file, first.projection!, first);
  const ids = new Set(network.routes.map((r) => r.meta.id));

  it('runs the routes riders name: Sapang Palay and SM Tungko to SM Fairview and Lagro', () => {
    for (const id of ['corr-sapang-fairview', 'corr-sapang-lagro', 'corr-tungko-lagro'])
      expect(ids.has(id)).toBe(true);
    for (const { meta, route } of network.routes.filter((r) => r.meta.id.startsWith('corr-'))) {
      // Terminal to terminal and back: two terminals, stops in order along the loop.
      expect(route.stops.filter((s) => s.terminal)).toHaveLength(2);
      expect(route.stops.every((s, i) => i === 0 || s.s >= route.stops[i - 1]!.s)).toBe(true);
      expect(meta.source).toMatch(/OpenStreetMap/);
      // The road under every stretch, for its kerbs.
      expect(route.kerbs).toBeDefined();
    }
  });

  it('runs from San Jose del Monte and SM Tungko down Commonwealth to Philcoa, kerbs where the map draws them', () => {
    for (const id of ['corr-sjdm-philcoa', 'corr-tungko-philcoa']) {
      const { route, meta } = network.routes.find((r) => r.meta.id === id)!;
      const far = route.stops.find((s, i) => i > 0 && s.terminal)!;
      expect(far.name).toBe('Philcoa');
      // A long ride: 20–30 km each way.
      expect(far.s / 1000).toBeGreaterThan(20);
      expect(far.s / 1000).toBeLessThan(30);
      expect(meta.roads!.length).toBeGreaterThan(5);
      // Commonwealth Avenue is two one-way carriageways (primary, 11 m as
      // drawn): its stops' kerbs are 5.5 m off the jeepney's line, so the
      // people waiting there stand beside the road, not on it.
      const commonwealth = route.stops.filter((s) =>
        /Commonwealth|Batasan|Don Antonio|Tandang Sora/.test(s.name),
      );
      expect(commonwealth.length).toBeGreaterThan(5);
      for (const s of commonwealth) expect(kerbAt(route, s.s)).toBeGreaterThan(4.5);
    }
  });

  it(
    'plans Malaria, Sampaguita or SM Tungko to Philcoa: the stop by the route, a jeepney all the way',
    { timeout: 60_000 },
    () => {
      const rows = JSON.parse(readFileSync('public/data/metro-manila-places.json', 'utf8')).places;
      const places = withAliases([
        ...landmarks(rows, (p) => first.projection!.toLocal(p)),
        ...placesOf(network),
      ]);
      const near = (p: { at: { x: number; z: number } }) =>
        first.polyline.project(p.at).offset < 3000;
      const flows = network.routes.map((r) => new RouteFlow(r.route, r.meta.headwayS));
      const arrivals = (r: number, stop: number, t: number) =>
        flows[r]!.arrivals(network.routes[r]!.route.stops[stop]!.s, t);
      const philcoa = searchPlaces(places, 'Philcoa', 1, near)[0]!;
      // Where it really is: the jeepney stop on Commonwealth Avenue by Philcoa Auditorium.
      const pin = first.projection!.toLocal({ lat: 14.654094, lng: 121.052831 });
      for (const from of ['Malaria', 'Sampaguita', 'SM Tungko']) {
        const place = searchPlaces(places, from, 1, near)[0]!;
        // The one by the route, not a namesake across the city (an area
        // called Sampaguita is on Marcos Highway).
        expect(first.polyline.project(place.at).offset).toBeLessThan(300);
        const options = planTrips(network, place.at, philcoa.at, 7 * 3600, arrivals);
        // Boarding on the way to Philcoa, not on the other side of the road going back.
        const direct = options.filter((o) => o.legs.length === 1);
        expect(direct.length).toBeGreaterThan(0);
        // Off near the place itself, whatever each line calls its stop there
        // ("Philcoa", "Philippine Coconut Authority", or "UP Wet & Dry Market"
        // across the footbridge).
        for (const o of direct) {
          const { route: line, alight } = o.legs[0]!;
          const r = network.routes[line]!.route;
          const off = r.polyline.pointAt(r.stops[alight]!.s);
          expect(Math.hypot(off.x - pin.x, off.z - pin.z)).toBeLessThan(WALK_TO_STOP_M);
        }
        // One option per jeepney line.
        const lines = direct.map((o) => o.legs[0]!.route);
        expect(new Set(lines).size).toBe(lines.length);
        // Said "by tricycle" (or "walking"): to the waiting area that way, near or not.
        for (const by of ['tricycle', 'walk'] as const)
          for (const o of planTrips(network, place.at, philcoa.at, 7 * 3600, arrivals, by))
            expect(o.toBy).toBe(by);
      }
    },
  );

  it(
    'never puts a place where the 2015 feed piled stops up: Malaria Road is not near SM Fairview',
    { timeout: 60_000 },
    () => {
      // Malaria Road, Purok II, Barangay 185, Caloocan (OpenStreetMap).
      const real = first.projection!.toLocal({ lat: 14.77071, lng: 121.07648 });
      for (const p of searchPlaces(placesOf(network), 'Malaria Road', 8))
        expect(Math.hypot(p.at.x - real.x, p.at.z - real.z)).toBeLessThan(1000);
    },
  );

  it('leaves out the 2015 routes that wind through San Jose del Monte, keeping them in the file', () => {
    const hidden = file.routes.filter((r) => r.hidden?.includes('GTFS path'));
    expect(hidden.length).toBe(8);
    for (const r of hidden) expect(ids.has(r.id)).toBe(false);
  });
});
