/**
 * The fleet board of each twin (core/fleet/board.ts): one for every driver's
 * Muse to read, so two drivers who ask at once are not sent after the same
 * riders.
 */
import type { TwinRuntime } from '@/app/twinRuntime';
import { FleetBoard } from '@/core/fleet/board';

const boards = new WeakMap<TwinRuntime, FleetBoard>();

export function boardOf(twin: TwinRuntime): FleetBoard {
  let board = boards.get(twin);
  if (!board) boards.set(twin, (board = new FleetBoard()));
  return board;
}

/** The plate `rider` is held for, if a driver asked for them first. */
export function heldPlate(twin: TwinRuntime, rider: number): string | null {
  const h = boards.get(twin)?.heldFor(rider);
  return h && !twin.fleet.vehicles[h.vehicle]?.detour ? h.plate : null;
}
