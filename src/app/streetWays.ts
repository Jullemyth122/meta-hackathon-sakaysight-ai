/**
 * The ways by street a planned trip needs, kept by their two ends: asked of
 * a worker once (map/streetWayWorker.ts), then read from here by the map and
 * the planner alike, so both say the same metres.
 */

import { useSyncExternalStore } from 'react';
import type { LatLng, LocalPoint } from '@/core/geo/projection';
import type { RoadRisk } from '@/core/map/streets';
import type { StreetWay, WayMode } from '@/core/people/streetWay';
import type { RoundAnswer, RoundAsk } from '@/core/people/wayRound';
import type { RoadEdge, StationFit } from '@/core/map/streets';
import type {
  BesideRequest,
  FitsRequest,
  RoundRequest,
  SpotRequest,
  StreetWayReply,
  StreetWayRequest,
} from '@/map/streetWayWorker';

/** Ways kept; the oldest goes first. */
const MAX_WAYS = 80;

/** A way, or null when there is none by street. Not here yet: asked, or not asked. */
const ways = new Map<string, StreetWay | null>();
const asked = new Map<number, string>();
/** What is known against waiting at a spot, by the spot, and those asked about. */
const risks = new Map<string, RoadRisk | null>();
const askedSpots = new Map<number, string>();
/** Those waiting to hear where a pin belongs, by request. */
const besides = new Map<number, (at: LocalPoint | undefined) => void>();
const fitAsks = new Map<number, (fits: Array<StationFit | null> | undefined) => void>();
/** Those waiting on a one-off way (findWay), by request. */
const waiting = new Map<number, (way: StreetWay | null) => void>();
const rounds = new Map<number, (answer: RoundAnswer | undefined) => void>();
const listeners = new Set<() => void>();
let version = 0;
let nextId = 1;
let worker: Worker | null = null;

const keyOf = (a: LocalPoint, b: LocalPoint, mode: WayMode) =>
  `${mode}:${a.x.toFixed(0)},${a.z.toFixed(0)}>${b.x.toFixed(0)},${b.z.toFixed(0)}`;

function settle(key: string, way: StreetWay | null): void {
  ways.set(key, way);
  if (ways.size > MAX_WAYS) ways.delete(ways.keys().next().value!);
  version++;
  listeners.forEach((fn) => fn());
}

function theWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('../map/streetWayWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<StreetWayReply>) => {
    const round = rounds.get(e.data.id);
    if (round) {
      rounds.delete(e.data.id);
      round(e.data.round);
      return;
    }
    const fits = fitAsks.get(e.data.id);
    if (fits) {
      fitAsks.delete(e.data.id);
      fits(e.data.fits);
      return;
    }
    const pin = besides.get(e.data.id);
    if (pin) {
      besides.delete(e.data.id);
      pin(e.data.beside);
      return;
    }
    const spot = askedSpots.get(e.data.id);
    if (spot !== undefined) {
      askedSpots.delete(e.data.id);
      risks.set(spot, e.data.risk ?? null);
      version++;
      listeners.forEach((fn) => fn());
      return;
    }
    waiting.get(e.data.id)?.(e.data.way);
    waiting.delete(e.data.id);
    const key = asked.get(e.data.id);
    asked.delete(e.data.id);
    if (key !== undefined) settle(key, e.data.way);
  };
  worker.onerror = (e) => {
    e.preventDefault();
    console.warn('Trip ways not found by street.', e.message);
    worker?.terminate();
    worker = null;
    const pending = [...asked.values()];
    asked.clear();
    askedSpots.clear();
    besides.forEach((resolve) => resolve(undefined));
    besides.clear();
    fitAsks.forEach((resolve) => resolve(undefined));
    fitAsks.clear();
    waiting.forEach((resolve) => resolve(null));
    waiting.clear();
    pending.forEach((key) => settle(key, null));
  };
  return worker;
}

/** The way from `a` to `b`: a StreetWay, null if there is none, undefined until it is known. */
export function knownWay(
  a: LocalPoint,
  b: LocalPoint,
  mode: WayMode = 'walk',
): StreetWay | null | undefined {
  return ways.get(keyOf(a, b, mode));
}

/** Find the way from `a` to `b`, if that is not already known or under way. */
export function askWay(a: LocalPoint, b: LocalPoint, origin: LatLng, mode: WayMode = 'walk'): void {
  const key = keyOf(a, b, mode);
  if (ways.has(key) || [...asked.values()].includes(key)) return;
  const id = nextId++;
  asked.set(id, key);
  theWorker().postMessage({ id, origin, from: a, to: b, mode } satisfies StreetWayRequest);
}

const spotKey = (p: LocalPoint) => `${p.x.toFixed(0)},${p.z.toFixed(0)}`;

/** What makes `p` no place to wait: a risk, null if nothing does, undefined until it is known. */
export const knownRisk = (p: LocalPoint): RoadRisk | null | undefined => risks.get(spotKey(p));

/** Find out what is known against waiting at `p`, if that is not already known or under way. */
export function askRisk(p: LocalPoint, origin: LatLng): void {
  const key = spotKey(p);
  if (risks.has(key) || [...askedSpots.values()].includes(key)) return;
  const id = nextId++;
  askedSpots.set(id, key);
  theWorker().postMessage({ id, origin, spot: p } satisfies SpotRequest);
}

/** Where a pin dropped at `p` belongs: off the road, when `p` is on one. */
export function besideRoads(p: LocalPoint, origin: LatLng): Promise<LocalPoint> {
  return new Promise((resolve) => {
    const id = nextId++;
    besides.set(id, (at) => resolve(at ?? p));
    theWorker().postMessage({ id, origin, beside: p } satisfies BesideRequest);
  });
}

/** Where gas stations `length` by `depth` fit, clear of the map's roads. */
export function stationFits(
  fits: Array<{ at: LocalPoint; on?: RoadEdge }>,
  length: number,
  depth: number,
  origin: LatLng,
): Promise<Array<StationFit | null>> {
  return new Promise((resolve) => {
    const id = nextId++;
    fitAsks.set(id, (found) => resolve(found ?? fits.map(() => null)));
    theWorker().postMessage({ id, origin, fits, length, depth } satisfies FitsRequest);
  });
}

/** A one-off way, not kept: round a road, say. */
export function findWay(
  a: LocalPoint,
  b: LocalPoint,
  origin: LatLng,
  opts: { mode?: WayMode; avoid?: LocalPoint[] } = {},
): Promise<StreetWay | null> {
  return new Promise((resolve) => {
    const id = nextId++;
    waiting.set(id, resolve);
    theWorker().postMessage({
      id,
      origin,
      from: a,
      to: b,
      mode: opts.mode ?? 'walk',
      avoid: opts.avoid,
    } satisfies StreetWayRequest);
  });
}

/** A way round the traffic ahead (core/people/wayRound.ts); undefined if the map cannot be had. */
export function findRound(round: RoundAsk, origin: LatLng): Promise<RoundAnswer | undefined> {
  return new Promise((resolve) => {
    const id = nextId++;
    rounds.set(id, resolve);
    theWorker().postMessage({ id, origin, round } satisfies RoundRequest);
  });
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** A number that changes whenever a way comes in: read knownWay again then. */
export const useStreetWaysVersion = (): number => useSyncExternalStore(subscribe, () => version);

/** Metres along `chain`, spot to spot by street; undefined until every way between is known. */
export function chainMetres(
  chain: readonly LocalPoint[],
  mode: WayMode = 'walk',
): number | undefined {
  return chainWay(chain, mode)?.metres;
}

/** The ways along `chain` end to end, as one; undefined until every one is known. */
export function chainWay(
  chain: readonly LocalPoint[],
  mode: WayMode = 'walk',
): StreetWay | undefined {
  const whole: StreetWay = { points: [], widths: [], metres: 0 };
  for (let i = 1; i < chain.length; i++) {
    const way = knownWay(chain[i - 1]!, chain[i]!, mode);
    if (!way) return undefined;
    // A joint: its first point is the last one's end.
    whole.points.push(...(i === 1 ? way.points : way.points.slice(1)));
    whole.widths.push(...way.widths);
    whole.metres += way.metres;
  }
  return whole;
}
