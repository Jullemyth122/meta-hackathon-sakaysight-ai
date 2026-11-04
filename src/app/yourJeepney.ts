/**
 * Which jeepney the commuter app means: the one they ride, or the one that
 * takes them (the first with a seat left for them after the people queued
 * ahead), and what its map label says.
 */

import type { TwinRuntime } from './twinRuntime';
import { twinState } from './twinState';
import { commuterView, type CommuterQuery } from '@/core/advisory/commuter';
import { dispatch } from '@/core/advisory/dispatch';
import { KIND_WORD } from '@/core/vehicles/specs';

export interface YourJeepney {
  vehicle: number;
  text: string;
  /** No seat for them: a warning colour rather than "this one". */
  full: boolean;
}

const minutes = (s: number) => (s < 60 ? 'now' : `${Math.round(s / 60)} min`);

/** Their jeepney and what the label says, or null when none is in sight. */
export function yourJeepney(twin: TwinRuntime, query: CommuterQuery): YourJeepney | null {
  const state = twinState(twin);
  let view;
  try {
    view = commuterView(state, dispatch(state), query);
  } catch {
    return null; // a followed rider who has just finished their trip
  }
  if (view.riding)
    return {
      vehicle: view.riding.vehicle,
      text: `Your ${KIND_WORD[view.riding.kind]} · ${view.riding.plate} · ${minutes(view.riding.etaS)} to ${view.destination.name}`,
      full: false,
    };
  if (view.phase === 'alighting' || view.phase === 'walking' || view.phase === 'arrived')
    return null;
  const p = view.pickup;
  if (p) {
    const seats = p.seatsForYou === 1 ? '1 seat for you' : `${p.seatsForYou} seats for you`;
    return {
      vehicle: p.vehicle,
      text: `Your ${KIND_WORD[p.kind]} · ${p.plate} · ${minutes(p.etaS)} · ${seats}`,
      full: false,
    };
  }
  // None in sight has a seat for them: mark the next one so they know not to wait for it.
  const next = view.arrivals[0];
  return next
    ? {
        vehicle: next.vehicle,
        text: `${next.plate} · ${minutes(next.etaS)} · ${next.catchable ? 'full for you' : 'before you reach the stop'}`,
        full: true,
      }
    : null;
}
