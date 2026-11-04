import type { FleetKind } from '../vehicles/specs';

/** One GPS sample, shaped like the browser Geolocation API reports it. */
export interface GpsFix {
  lat: number;
  lng: number;
  /** Horizontal accuracy radius (about 68% confidence), metres. */
  accuracyM: number;
  /** Device-reported speed. Browsers may return null. */
  speedMps: number | null;
  /** Device-reported heading, degrees clockwise from north. May be null. */
  headingDeg: number | null;
  /** Epoch milliseconds when the fix was taken (not when it arrived). */
  timestamp: number;
}

export type TripPhase = 'WAITING' | 'POSSIBLE_VEHICLE' | 'CONFIRMED' | 'ENDED';

/**
 * What a phone publishes for one session.
 *
 * `source` records how much we actually know: a passenger's phone proves where
 * the phone is, not which physical jeepney it is sitting in.
 */
export interface SessionMeta {
  sessionId: string;
  vehicleId: string;
  source: 'passenger-consented' | 'driver-device';
  /** Who is sharing: a commuter is drawn as a person, a driver as their vehicle. */
  role?: 'commuter' | 'driver';
  /** What a driver drives (a tracker session is a jeepney). */
  vehicleKind?: FleetKind;
  startedAt: number;
}

export interface SessionUpdate {
  meta: SessionMeta;
  fix: GpsFix;
  trip: TripPhase;
}
