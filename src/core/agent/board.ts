/**
 * "Dadaan ba 'to sa Philcoa?": what a jeepney's signboard says, against the
 * network. Muse reads the words off the photo; this finds the routes those
 * words name and whether any passes near where the commuter is going. It
 * says so plainly when it does not know, or how close the route comes.
 */

import type { LocalPoint } from '../geo/projection';
import type { Network } from '../network/network';

/** A stop this close to the place counts as passing it (metres): a short walk. */
const PASSES_WITHIN_M = 500;
/** Boards say a few place names; a route must match at least this many. */
const MIN_WORDS = 1;
const ROUTES_REPORTED = 3;

/** The words on a board that can name a place. */
function wordsOf(text: string): string[] {
  const noise = new Set([
    'via',
    'to',
    'and',
    'the',
    'city',
    'route',
    'terminal',
    'sm',
    'puj',
    'bus',
  ]);
  return text
    .toLowerCase()
    .split(/[^a-z0-9ñ]+/)
    .filter((w) => w.length >= 3 && !noise.has(w));
}

export interface BoardAnswer {
  /** yes: a route on that board stops near the place. no: it does not. unknown: no such route. */
  answer: 'yes' | 'no' | 'unknown';
  route: string | null;
  /** The stop to get off at, and how far it is from the place (metres). */
  stop: string | null;
  metresFromPlace: number | null;
  /** Other routes the board could be. */
  alsoCouldBe: string[];
  note: string;
}

/** Which network routes the board's words name, best first, and how many words each has. */
export function routesOnBoard(network: Network, boardText: string): number[] {
  const words = wordsOf(boardText);
  if (words.length === 0) return [];
  const scored = network.routes.flatMap(({ route }, r) => {
    const name = route.name.toLowerCase();
    const hits = words.filter((w) => name.includes(w)).length;
    return hits >= MIN_WORDS ? [{ r, hits }] : [];
  });
  return scored.sort((a, b) => b.hits - a.hits || a.r - b.r).map((x) => x.r);
}

/** Whether the board's route goes near `place`. */
export function boardGoesTo(
  network: Network,
  boardText: string,
  place: { name: string; at: LocalPoint },
): BoardAnswer {
  const found = routesOnBoard(network, boardText);
  if (found.length === 0)
    return {
      answer: 'unknown',
      route: null,
      stop: null,
      metresFromPlace: null,
      alsoCouldBe: [],
      note: 'No route with those words is in the app’s data (Metro Manila only, from 2015 records). Say you do not know; ask the driver.',
    };
  let best: { r: number; stop: string; metres: number } | null = null;
  for (const r of found.slice(0, 12)) {
    const { route } = network.routes[r]!;
    for (const st of route.stops) {
      const p = route.polyline.pointAt(st.s);
      const metres = Math.hypot(p.x - place.at.x, p.z - place.at.z);
      if (!best || metres < best.metres) best = { r, stop: st.name, metres };
    }
  }
  const b = best!;
  const name = network.routes[b.r]!.route.name;
  const others = found
    .filter((r) => r !== b.r)
    .slice(0, ROUTES_REPORTED)
    .map((r) => network.routes[r]!.route.name);
  const near = b.metres <= PASSES_WITHIN_M;
  return {
    answer: near ? 'yes' : 'no',
    route: name,
    stop: b.stop,
    metresFromPlace: Math.round(b.metres),
    alsoCouldBe: others,
    note: near
      ? 'Routes are from 2015 records: ask the driver to confirm.'
      : `It does not pass ${place.name}; the closest it comes is that stop.`,
  };
}
