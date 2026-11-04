/** Where a located commuter is, for the trip and the camera (see useLocateMe). */

import type { LocalPoint } from '@/core/geo/projection';

/** A trip's start while it is where they are, and once they have stopped sharing. */
export const MY_LOCATION = 'My location';
export const LAST_LOCATION = 'My last location';

/** Nearer than this to where the trip starts, it stays put: trips cost a search (metres). */
const HOME_STAYS_M = 30;
/** How much ground the camera shows around someone (metres either side). */
const SHOT_AROUND_M = 50;

/**
 * Whether a trip's start should move to `at`: GPS wanders, and a first fix is
 * often far off, so it moves once it has really left, by more than the fix's
 * own uncertainty.
 */
export function homeMoved(home: LocalPoint | null, at: LocalPoint, accuracyM: number): boolean {
  if (!home) return true;
  return Math.hypot(home.x - at.x, home.z - at.z) > Math.max(HOME_STAYS_M, accuracyM);
}

/** Two corners to frame `at` by. */
export const aroundSpot = (at: LocalPoint): LocalPoint[] => [
  { x: at.x - SHOT_AROUND_M, z: at.z - SHOT_AROUND_M },
  { x: at.x + SHOT_AROUND_M, z: at.z + SHOT_AROUND_M },
];
