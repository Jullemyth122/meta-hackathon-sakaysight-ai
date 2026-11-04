/**
 * How a phone's GPS reaches the dashboard.
 *
 *   firebase  phone and laptop on different networks (the real demo).
 *   loopback  two tabs in one browser, no setup (development).
 *
 * Both implement the same interface, so nothing above this layer knows or
 * cares which one is in use.
 */

import type { SessionUpdate } from '@/core/tracking/types';

export type TransportKind = 'firebase' | 'loopback';

export interface Transport {
  readonly kind: TransportKind;
  publish(update: SessionUpdate): Promise<void>;
  /** Forget a session's last place. */
  clear(sessionId: string): Promise<void>;
  /**
   * Called for every update of a session filed under one of `areas` (areaOf
   * in core/tracking/area.ts): only what the map shows, not every phone.
   * Returns an unsubscribe function.
   */
  subscribe(areas: readonly string[], onUpdate: (update: SessionUpdate) => void): () => void;
  /** The sessions filed under `areas` now, once: for Muse, when it is asked. */
  fetch(areas: readonly string[]): Promise<SessionUpdate[]>;
}

/** Basic shape check: anything from the network is untrusted until it passes. */
export function isSessionUpdate(v: unknown): v is SessionUpdate {
  const u = v as SessionUpdate | null;
  return (
    !!u &&
    typeof u.meta?.sessionId === 'string' &&
    typeof u.meta.vehicleId === 'string' &&
    typeof u.fix?.lat === 'number' &&
    typeof u.fix.lng === 'number' &&
    typeof u.fix.timestamp === 'number' &&
    typeof u.trip === 'string'
  );
}
