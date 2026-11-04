/**
 * The Metro Manila network inside the app: loaded once (public/data, built
 * by scripts/build-network.mjs), kept outside React like the runtimes, with
 * one flow per route made the first time it is asked for.
 *
 * Focusing a route hands it from its flow to the full twin: the twin starts
 * with the flow's jeepneys where they are, as full as they are, under the
 * same plates, at the same time of day, so nothing jumps.
 */

import { mixTotal, OWNER_SHARE, pickFleet, type SimulationScenario } from '@/core/fleet/scenario';
import { aheadOf, type Route } from '@/core/geo/routes';
import { FARE_BY_VEHICLE, fareFor } from '@/core/fare';
import { setStationData } from '@/core/fuel/stations';
import { useApp, type TripLeg } from './store';
import {
  networkOf,
  networkRoute,
  shownRoutes,
  type Network,
  type NetworkFile,
} from '@/core/network/network';
import { fleetPlan } from '@/core/network/fleetSize';
import { RouteFlow, ridersPerDay } from '@/core/network/flow';
import { roadShares } from '@/core/network/roadLoad';
import type { ArrivalsAt } from '@/core/network/plan';
import { landmarks, placesOf, withAliases, type Place } from '@/core/network/search';
import { dispatch, type Dispatch } from '@/core/advisory/dispatch';
import { distanceTo, type TwinState } from '@/core/advisory/model';
import type { FleetStart, TwinRuntime } from './twinRuntime';
import { twinState } from './twinState';

const NETWORK_URL = '/data/metro-manila-network.json';
const PLACES_URL = '/data/metro-manila-places.json';
const FUEL_URL = '/data/metro-manila-fuel.json';
/** The twin answers for arrivals within this many seconds of now; later ones come from the flow. */
const LIVE_WITHIN_S = 120;
/** Building the network's routes: this much of the main thread at a time (ms)… */
const BUILD_SLICE_MS = 8;
/** …and this much behind the loading screen, where no frame is being watched. */
const HIDDEN_SLICE_MS = 120;
/** Of the time that takes, the share that is routes; the rest is their flows. */
const ROUTES_SHARE = 0.85;
/** The most of a route's vehicles the twin takes over from its flow. */
export const MAX_SIMULATED = 120;

let network: Network | null = null;
let placesLoading: Promise<Place[]> | null = null;
let loading: Promise<Network> | null = null;
const flows: RouteFlow[] = [];

export const getNetwork = (): Network | null => network;

const sliceMs = () => (useApp.getState().started ? BUILD_SLICE_MS : HIDDEN_SLICE_MS);

/** Load the network once; `first` (the bundled route) leads it and sets the projection. */
export function loadNetwork(first: Route, progress?: (share: number) => void): Promise<Network> {
  if (network) return Promise.resolve(network);
  loading ??= fetch(NETWORK_URL)
    .then((res) => {
      if (!res.ok) throw new Error(`Network data: HTTP ${res.status}`);
      return res.json() as Promise<NetworkFile>;
    })
    .then(async (file) => {
      const projection = first.projection;
      if (!projection) throw new Error('The first route has no map projection');
      // A few at a time, between frames: all at once would stop the view for seconds.
      const routes = [];
      let startedAt = performance.now();
      const shown = shownRoutes(file);
      for (const meta of shown) {
        routes.push({ meta, route: networkRoute(meta, projection, !file.spursRemoved) });
        if (performance.now() - startedAt < sliceMs()) continue;
        progress?.((ROUTES_SHARE * routes.length) / shown.length);
        await new Promise((resume) => setTimeout(resume));
        startedAt = performance.now();
      }
      network = networkOf(file, routes, first);
      // The real fleet shared out by where people are, not one figure for every route.
      const roads = network.routes.map((r) => ({ route: r.route, roads: r.meta.roads }));
      fleetPlan(roads, projection).forEach((plan, i) => {
        const { route, meta } = network!.routes[i]!;
        meta.fleet = plan.fleet;
        route.mix = plan.mix;
      });
      // Tens of thousands of vehicles: their flows a few at a time too.
      startedAt = performance.now();
      for (let i = 0; i < network.routes.length; i++) {
        flowOf(i);
        if (performance.now() - startedAt < sliceMs()) continue;
        progress?.(ROUTES_SHARE + ((1 - ROUTES_SHARE) * i) / network.routes.length);
        await new Promise((resume) => setTimeout(resume));
        startedAt = performance.now();
      }
      return network;
    })
    .catch((err: unknown) => {
      loading = null; // let the next attempt retry
      throw err;
    });
  return loading;
}

/** Route i's flow (made on first use). */
export function flowOf(i: number): RouteFlow {
  const n = network;
  if (!n) throw new Error('Network not loaded');
  const { route, meta } = n.routes[i]!;
  return (flows[i] ??= new RouteFlow(route, meta.headwayS, meta.fleet));
}

let shares: Float32Array | null = null;

/** The share of route i's fleet its roads have room to show (core/network/roadLoad.ts). */
export function roadShareOf(i: number): number {
  const n = network;
  if (!n) return 1;
  shares ??= roadShares(
    n.routes.map(({ route, meta }) => ({
      route,
      vehicles: meta.fleet ?? flows[n.routes.findIndex((r) => r.route === route)]?.count ?? 20,
    })),
  );
  return shares[i] ?? 1;
}

/** Index of a route in the network by id, or -1. */
export function routeIndex(id: string): number {
  return network?.routes.findIndex((r) => r.route.id === id) ?? -1;
}

/**
 * What focusing route i starts the twin with, at the twin's current clock.
 * `clicked`: a vehicle of its flow that has to be in the twin, the same one in
 * the same place; `clickedAt` says which it is there.
 */
export function focusRoute(
  i: number,
  twin: TwinRuntime,
  clicked?: number,
): { route: Route; scenario: SimulationScenario; start: FleetStart[]; clickedAt: number } {
  const n = network;
  if (!n) throw new Error('Network not loaded');
  const flow = flowOf(i);
  // A route's whole fleet can be hundreds: as many as can be simulated one by one.
  // The fleet chosen by hand goes with you from route to route.
  const mix = twin.scenario?.mix;
  const vehicles = mix ? mixTotal(mix) : Math.min(flow.count, MAX_SIMULATED);
  const clock = twin.clockS;
  const hour = Math.floor(clock / 3600) % 24;
  const chosen = pickFleet(flow.vehicles(clock), vehicles, mix, clicked);
  return {
    route: n.routes[i]!.route,
    clickedAt: Math.max(
      0,
      chosen.findIndex((v) => v.index === clicked),
    ),
    scenario: {
      vehicles,
      ...(mix ? { mix } : {}),
      dailyTrips: ridersPerDay(n.routes[i]!.route, vehicles),
      startHour: hour,
      startOffsetS: Math.floor(clock % 3600),
      profile: 'commute',
      seed: twin.scenario?.seed ?? 11,
      ownerShare: OWNER_SHARE,
    },
    start: chosen.map((v) => ({
      s: v.s,
      occupancy: v.occupancy,
      plate: v.plate,
      inService: v.inService,
      kind: v.kind,
    })),
  };
}

/**
 * Next jeepneys at a stop of any route: on the focused route from the twin
 * itself, exactly as the commuter app counts them (arrival with the stops
 * made on the way, seats left after the people queued there); from flows
 * elsewhere, and for times later than now (a second leg).
 */
export function arrivalsAt(twin: TwinRuntime): ArrivalsAt {
  const focused = routeIndex(twin.route.id);
  let state: TwinState | null = null;
  let plan: Dispatch | null = null;
  return (r, stop, t) => {
    const route = network!.routes[r]!.route;
    if (r === focused && Math.abs(t - twin.clockS) < LIVE_WITHIN_S) {
      state ??= twinState(twin);
      plan ??= dispatch(state);
      const p = plan;
      const at = route.stops[stop]!.s;
      return state.vehicles
        .filter((v) => v.inService !== false && distanceTo(route, v, at) > -5)
        .map((v) => ({
          vehicle: v.index,
          plate: v.plate,
          etaS: p.etaS(v.index, stop),
          freeSeats: Math.max(0, p.freeSeatsAt(v.index, stop) - p.claimedAt(v.index, stop)),
        }))
        .sort((a, b) => a.etaS - b.etaS)
        .slice(0, 3);
    }
    return flowOf(r).arrivals(route.stops[stop]!.s, t);
  };
}

/**
 * A planned trip in a few words for the assistant (sent as SCREEN): each
 * leg's route, stops and fare; for the legs after the first, the next
 * jeepney there as estimated from its route's flow.
 */
export function tripSummary(legs: readonly TripLeg[], twin: TwinRuntime) {
  const n = network;
  if (!n) return undefined;
  return legs.map((leg, k) => {
    const route = n.routes[leg.route]!.route;
    const rideM = aheadOf(route, route.stops[leg.board]!.s, route.stops[leg.alight]!.s);
    const next =
      k > 0 ? flowOf(leg.route).arrivals(route.stops[leg.board]!.s, twin.clockS, 1)[0] : undefined;
    return {
      route: route.name,
      board: route.stops[leg.board]!.name,
      alight: route.stops[leg.alight]!.name,
      rideKm: Math.round(rideM / 100) / 10,
      fare: fareFor(rideM / 1000, false, FARE_BY_VEHICLE[route.kind ?? 'jeepney']),
      ...(next && {
        nextJeepneyEstimate: {
          plate: next.plate,
          etaMin: Math.round(next.etaS / 60),
          freeSeats: next.freeSeats,
        },
      }),
    };
  });
}

/**
 * Landmarks to plan trips from and to (scripts/fetch-places.mjs), with every
 * stop name of the network after them. Loaded the first time it is asked.
 */
export function loadPlaces(): Promise<Place[]> {
  const n = network;
  if (!n) return Promise.reject(new Error('Network not loaded'));
  const projection = n.routes[0]!.route.projection!;
  placesLoading ??= fetch(PLACES_URL)
    .then((res) => {
      if (!res.ok) throw new Error(`Places: HTTP ${res.status}`);
      return res.json() as Promise<{ places: Array<[string, string, number, number]> }>;
    })
    .then((file) =>
      withAliases([...landmarks(file.places, (p) => projection.toLocal(p)), ...placesOf(n)]),
    )
    .catch((err: unknown) => {
      placesLoading = null;
      console.warn('Landmarks not loaded, stops only:', err);
      return withAliases(placesOf(n));
    });
  return placesLoading;
}

/** Every gas station in Metro Manila (scripts/fetch-fuel.mjs --metro-manila), for every route. */
export async function loadFuel(): Promise<boolean> {
  const res = await fetch(FUEL_URL);
  if (!res.ok) throw new Error(`Fuel stations: HTTP ${res.status}`);
  const file = (await res.json()) as { stations: Parameters<typeof setStationData>[0] };
  setStationData(file.stations);
  return true;
}
