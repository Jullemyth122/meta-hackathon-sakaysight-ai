/**
 * What the person's phone shows right now, in a few numbers, sent with
 * every question (/api/assist "screen"). The assistant must agree with the
 * screen: "the jeepney in front" is the one the driver sees within sight,
 * not one 3 km down the road the planner also knows about; a commuter's ETA
 * is the one on their screen.
 */

import {
  DIESEL_WEEK,
  DRIVER_MAP_RADIUS_M,
  fuelAdvice,
  TOP_UP_LITRES,
  type FuelStop,
} from '../fuel/stations';
import type { Route } from '../geo/routes';
import { commuterView, type CommuterView } from './commuter';
import type { Dispatch } from './dispatch';
import type { DriverView } from './driver';
import { ADVISORY, type TwinState } from './model';
import { incomingAtStop } from './approach';
import { KIND_WORD } from '../vehicles/specs';

/** Commute words a general speech model may mishear, in Tagalog and English. */
const COMMUTE_WORDS = [
  'jeepney',
  'jeep',
  'para',
  'pamasahe',
  'bayad',
  'sakay',
  'estudyante',
  'PWD',
];

/** Meta's transcriber refuses a request with any keyword longer than this. */
export const MAX_KEYWORD_CHARS = 30;

/**
 * How people say a stop: "Tungko - San Jose Jeepney Station" is "Tungko",
 * "SM City Fairview Jeepney Terminal" is "SM City Fairview".
 */
function spoken(name: string): string {
  return name
    .replace(/\s+-\s+.*$/, '')
    .replace(/\s+jeepney\s+(terminal|station)$/i, '')
    .trim();
}

/**
 * Words to listen for when someone asks by voice: this route's stop names
 * (as spoken, and only ones short enough for the transcriber), then
 * commute words.
 */
export function voiceKeywords(route: Route): string[] {
  const names = route.stops.flatMap((s) => [s.name, spoken(s.name)]);
  // The commute words first: the transcriber takes so many words, and a long
  // route's stops would otherwise crowd "pamasahe" and "bayad" out.
  return [...new Set([...COMMUTE_WORDS, ...names])].filter(
    (w) => w.length > 0 && w.length <= MAX_KEYWORD_CHARS,
  );
}

const min = (s: number) => Math.round(s / 6) / 10;
const m = (x: number) => Math.round(x);

export function driverScreen(v: DriverView, fuel: readonly FuelStop[] = []) {
  return {
    arrivalSource: 'simulation estimates; approaching riders have not joined the queue',
    /** Stations the driver can pull straight into ahead (own side, no U-turn). */
    dieselAhead: fuel.map((f) => ({
      brand: f.station.brand,
      name: f.station.name,
      distanceM: m(f.distanceM),
      priceRangePhpPerL: f.price ? [f.price.min, f.price.max] : 'not listed by the DOE',
      expectedPhpPerL: f.expectedPhpPerL,
      cheapestAhead: f.cheapest,
      /** Drawn on the driver's map (within DRIVER_MAP_RADIUS_M), or further on. */
      onYourMap: f.onMap,
    })),
    mapRadiusM: DRIVER_MAP_RADIUS_M,
    /** The refuelling decision: the next station, or a cheaper one further on. */
    refuel: (() => {
      const a = fuelAdvice(fuel);
      return {
        fillUpNow: a.nearest && {
          brand: a.nearest.station.brand,
          distanceM: m(a.nearest.distanceM),
        },
        ifTheTankCanWait: a.cheaper && {
          brand: a.cheaper.station.brand,
          distanceM: m(a.cheaper.distanceM),
          savesPhpOnTopUp: a.savingPhp,
          topUpLitres: TOP_UP_LITRES,
          onYourMap: a.cheaper.onMap,
        },
      };
    })(),
    dieselPrices: `DOE NCR monitoring, week ${DIESEL_WEEK}: the brand's lowest–highest pump price in Caloocan and Quezon City, not this station's own price; expected = middle of that range`,
    /** Waiting by the side of the road ahead, not at a stop: stop for them where they stand. */
    waitingByTheRoad: v.roadside.map((r) => ({
      metresAhead: m(r.distanceM),
      etaMin: min(r.etaS),
      canTake: r.canTake,
    })),
    plate: v.plate,
    vehicle: KIND_WORD[v.kind],
    seats: v.seats,
    sightM: ADVISORY.horizonM,
    nextStops: v.ahead.map((s) => ({
      name: s.name,
      distanceM: m(s.distanceM),
      etaMin: min(s.etaS),
      action: s.action,
      reason: s.reason,
      waiting: s.waiting,
      approaching: s.incoming.length,
      approachingBeforeYou: s.arrivingBeforeYou,
      walking: s.incoming.filter((p) => p.mode === 'walk').length,
      byTricycle: s.incoming.filter((p) => p.mode === 'tricycle').length,
      firstArrival: s.incoming[0]
        ? {
            etaMin: min(s.incoming[0].etaS),
            distanceToStopM: m(s.incoming[0].distanceM),
            mode: s.incoming[0].mode,
          }
        : null,
      forYou: s.forYou,
      gettingOff: s.dropOffs,
      para: s.para,
    })),
    jeepneyInFront: v.leader
      ? { ...v.leader, distanceM: m(v.leader.distanceM) }
      : `none within ${ADVISORY.horizonM} m`,
    peopleNearYou: v.eyesight.length,
    fuelToTerminal: {
      km: Math.round(v.fuel.km * 10) / 10,
      litres: Math.round(v.fuel.litres * 100) / 100,
      savedMl: m(v.fuel.savedLitres * 1000),
      savedPhp: Math.round(v.fuel.savedPhp * 100) / 100,
    },
  };
}

export function commuterScreen(v: CommuterView) {
  return {
    phase: v.phase,
    stop: v.stop.name,
    /** Waiting by the side of the road before that stop, not at it: vehicles stop for them there. */
    byTheRoad: v.roadside,
    destination: v.destination.name,
    approachingStop: v.approach
      ? {
          mode: v.approach.mode,
          distanceM: m(v.approach.distanceM),
          etaMin: min(v.approach.etaS),
          source: 'simulation estimate; no seat reserved',
        }
      : null,
    queuedAheadOfYou: v.queueAhead,
    arrivals: v.arrivals.map((a) => ({
      plate: a.plate,
      vehicle: KIND_WORD[a.kind],
      etaMin: min(a.etaS),
      distanceM: m(a.distanceM),
      freeSeats: a.freeSeats,
      seatsLeftForYou: a.seatsForYou,
      catchable: a.catchable,
    })),
    yourJeepney: v.pickup?.plate ?? null,
    onBoard: v.riding
      ? {
          plate: v.riding.plate,
          vehicle: KIND_WORD[v.riding.kind],
          remainingM: m(v.riding.remainingM),
          etaMin: min(v.riding.etaS),
        }
      : null,
    fare: v.trip.fare,
    fareDiscounted: v.trip.fareDiscounted,
    arriveInMin: v.trip.arriveInS === null ? null : min(v.trip.arriveInS),
  };
}

/** Stops in the operator's overview: the busiest ones are what they act on. */
const BUSIEST_STOPS = 5;
/** Jeepneys named per busy stop: the next ones to get there. */
const NEXT_AT_STOP = 2;

/**
 * The Live twin with no jeepney selected: the whole fleet in a few
 * numbers, and the busiest stops with the next jeepneys coming to each.
 * The same size with 20 jeepneys or 120, so a fleet question costs the same.
 */
export function operatorScreen(state: TwinState, plan: Dispatch) {
  const { route, passengers } = state;
  // Out on the road: parked jeepneys are not part of the picture.
  const vehicles = state.vehicles.filter((v) => v.inService !== false);
  const waiting = route.stops.map(() => 0);
  const incoming = route.stops.map((_, stop) => incomingAtStop(state, stop));
  for (const p of passengers) if (p.phase === 'waiting') waiting[p.originStop]!++;
  const riders = vehicles.reduce((a, v) => a + v.occupancy, 0);
  const seats = vehicles.reduce((a, v) => a + v.capacity, 0);
  const n = route.stops.length;

  const busiest = route.stops
    .map((st, stop) => ({ st, stop, waiting: waiting[stop]! }))
    .filter((x) => x.waiting > 0 || incoming[x.stop]!.length > 0)
    .sort((a, b) => b.waiting - a.waiting)
    .slice(0, BUSIEST_STOPS)
    .map(({ st, stop, waiting }) => {
      // Any destination past the stop gives the jeepneys coming to it.
      const next = route.loop || stop < n - 1 ? (stop + 1) % n : stop - 1;
      const coming = commuterView(state, plan, { stop, destination: next }).arrivals;
      return {
        stop: st.name,
        waiting,
        approaching: incoming[stop]!.length,
        firstArrivalMin: incoming[stop]![0] ? min(incoming[stop]![0]!.etaS) : null,
        byTricycle: incoming[stop]!.filter((p) => p.mode === 'tricycle').length,
        next: coming.slice(0, NEXT_AT_STOP).map((a) => ({
          plate: a.plate,
          etaMin: min(a.etaS),
          freeSeats: a.freeSeats,
        })),
      };
    });

  return {
    view: 'operator: whole fleet, no jeepney selected',
    jeepneys: vehicles.length,
    riders,
    seatsUsedPct: seats ? Math.round((100 * riders) / seats) : 0,
    full: vehicles.filter((v) => v.occupancy >= v.capacity).length,
    atStops: vehicles.filter((v) => v.atStop !== null).length,
    stoppedInTraffic: vehicles.filter((v) => v.atStop === null && v.speedMps < 0.5).length,
    waiting: waiting.reduce((a, b) => a + b, 0),
    approachingWithin500m: incoming.reduce((a, p) => a + p.length, 0),
    arrivalSource: 'simulation estimates; approaching riders have not joined the queue',
    busiestStops: busiest,
  };
}
