/**
 * Phone tracker. A rider opens /track, consents, and starts a session. Each
 * GPS fix runs through the same filter and trip state machine the dashboard
 * understands, then is published with the session ID.
 *
 * No Three.js here: this page must load fast on mobile data.
 */

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { GpsFilter } from '@/core/tracking/gpsFilter';
import { initialTripState, stepTrip, type TripInput } from '@/core/tracking/tripState';
import type { GpsFix, SessionMeta } from '@/core/tracking/types';
import { getTransport, type Transport } from '@/net';
import { useGeolocation, useWakeLock, type GeoError } from './useGeolocation';
import { useSimulatedRide } from './useSimulatedRide';

const GEO_ERROR_TEXT: Record<Exclude<GeoError, null>, string> = {
  unsupported: 'This browser has no GPS access.',
  insecure:
    'GPS needs HTTPS. Use the deployed URL, or `npm run dev:phone` and accept the certificate.',
  denied: 'Location permission was denied. Allow it in the browser settings.',
  unavailable: 'No GPS signal yet. Step outside or wait a moment.',
  timeout: 'GPS timed out. Still trying…',
};

const PHASE_TEXT = {
  WAITING: 'Waiting / walking',
  POSSIBLE_VEHICLE: 'Possibly in a vehicle',
  CONFIRMED: 'Riding (confirmed)',
  ENDED: 'Trip ended',
} as const;

/** `sim-…` for a simulated ride, so it never passes for field data. */
function newSessionId(simulated: boolean): string {
  const day = new Date().toISOString().slice(0, 10);
  return `${simulated ? 'sim' : 'field'}-${day}-${crypto.randomUUID().slice(0, 6)}`;
}

export function TrackerApp() {
  const [vehicleId, setVehicleId] = useState('DEMO-JEEP-001');
  const [consented, setConsented] = useState(false);
  /** Ticked before starting: a simulated ride instead of this phone's GPS. */
  const [simulate, setSimulate] = useState(false);
  const [running, setRunning] = useState(false);
  /** Whether the running session is simulated (fixed when it starts). */
  const [simulated, setSimulated] = useState(false);
  const [meta, setMeta] = useState<SessionMeta | null>(null);
  const [trip, dispatch] = useReducer(
    (s: typeof initialTripState, i: TripInput) => stepTrip(s, i),
    initialTripState,
  );
  const [last, setLast] = useState<{
    fix: GpsFix;
    speedMps: number;
    sent: number;
    rejected: number;
  } | null>(null);
  const [transport, setTransport] = useState<Transport | null>(null);
  const [sendError, setSendError] = useState<string | null>(null);

  const filter = useRef(new GpsFilter());
  const counters = useRef({ sent: 0, rejected: 0 });
  const tripRef = useRef(trip);
  tripRef.current = trip;

  useEffect(() => {
    void getTransport().then(setTransport);
  }, []);

  const onFix = useCallback(
    (fix: GpsFix) => {
      if (!meta || !transport) return;
      if (!filter.current.push(fix)) {
        counters.current.rejected++;
        return;
      }
      const motion = filter.current.estimate();
      // No route on the phone, so "on route" is unknown here (null).
      const input: TripInput = { kind: 'motion', now: fix.timestamp, motion, onRoute: null };
      dispatch(input);
      const phase = stepTrip(tripRef.current, input).phase;

      transport
        .publish({ meta, fix, trip: phase })
        .then(() => {
          counters.current.sent++;
          setSendError(null);
        })
        .catch((err: unknown) => setSendError(err instanceof Error ? err.message : String(err)));
      setLast({ fix, speedMps: motion.speedMps, ...counters.current });
    },
    [meta, transport],
  );

  const geoError = useGeolocation(running && !simulated, onFix);
  const ride = useSimulatedRide(running && simulated, onFix);
  useWakeLock(running);

  function start() {
    filter.current.reset();
    counters.current = { sent: 0, rejected: 0 };
    dispatch({ kind: 'reset' });
    setLast(null);
    setSimulated(simulate);
    setMeta({
      sessionId: newSessionId(simulate),
      vehicleId: vehicleId.trim() || 'UNKNOWN',
      source: 'passenger-consented',
      startedAt: Date.now(),
    });
    setRunning(true);
  }

  function stop() {
    setRunning(false);
    if (trip.phase === 'CONFIRMED') dispatch({ kind: 'end' });
  }

  return (
    <main className="tracker">
      <header className="tracker__bar">
        <b>SakaySightAI</b>
        <span className="tracker__tag">Phone tracker</span>
        <span className="mono">
          {transport ? (transport.kind === 'firebase' ? 'Firebase' : 'Loopback') : '…'}
        </span>
      </header>

      {!running && (
        <section className="tracker__card">
          <label className="field">
            <span>Jeepney / demo vehicle ID</span>
            <input
              value={vehicleId}
              onChange={(e) => setVehicleId(e.target.value)}
              autoComplete="off"
            />
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={consented}
              onChange={(e) => setConsented(e.target.checked)}
            />
            <span>
              I agree to share this phone’s location for this session only. It shows where the phone
              is; I confirm which jeepney I am on.
            </span>
          </label>
          <label className="toggle">
            <input
              type="checkbox"
              checked={simulate}
              onChange={(e) => setSimulate(e.target.checked)}
            />
            <span>
              Simulate a ride (for testing indoors): GPS that drives along Tungko – SM City Fairview
              at jeepney speed instead of this phone’s location.
            </span>
          </label>
          <button
            type="button"
            className="btn btn--primary btn--big"
            disabled={!consented && !simulate}
            onClick={start}
          >
            {simulate ? 'Start simulated ride' : 'Start session'}
          </button>
          {transport?.kind === 'loopback' && (
            <p className="fine">
              Firebase is not configured, so updates only reach a dashboard open in this same
              browser.
            </p>
          )}
        </section>
      )}

      {running && meta && (
        <section className="tracker__card">
          <div className={`phase phase--${trip.phase.toLowerCase()}`}>
            <span className="phase__label">{PHASE_TEXT[trip.phase]}</span>
            <span className="phase__reason">{trip.reason}</span>
          </div>

          <div className="kv">
            <span>Session</span>
            <span className="mono">{meta.sessionId}</span>
            <span>Speed</span>
            <span className="mono">{last ? `${(last.speedMps * 3.6).toFixed(0)} km/h` : '–'}</span>
            <span>Accuracy</span>
            <span className="mono">
              {last ? `±${last.fix.accuracyM.toFixed(0)} m` : 'waiting for GPS…'}
            </span>
            <span>Sent / rejected</span>
            <span className="mono">
              {last?.sent ?? 0} / {last?.rejected ?? 0}
            </span>
          </div>

          {simulated && (
            <p className="fine">
              <b>Simulated ride</b>, not this phone’s location
              {ride.status ? ` · ${ride.status}` : ''}. Keep this tab in view (its own window beside
              the dashboard): browsers slow down timers in background tabs.
            </p>
          )}
          {ride.error && <p className="error">Simulated ride failed: {ride.error}</p>}
          {!simulated && geoError && <p className="error">{GEO_ERROR_TEXT[geoError]}</p>}
          {sendError && <p className="error">Could not send: {sendError}</p>}

          {(trip.phase === 'WAITING' || trip.phase === 'POSSIBLE_VEHICLE') && (
            <button
              type="button"
              className="btn btn--primary btn--big"
              onClick={() => dispatch({ kind: 'confirm' })}
            >
              I’m on {meta.vehicleId}
            </button>
          )}
          {trip.phase === 'CONFIRMED' && (
            <button
              type="button"
              className="btn btn--big"
              onClick={() => dispatch({ kind: 'end' })}
            >
              I got off
            </button>
          )}
          <button type="button" className="btn btn--ghost" onClick={stop}>
            {simulated ? 'Stop simulated ride' : 'Stop sharing location'}
          </button>
          {!simulated && (
            <p className="fine">Keep this screen open: phones pause GPS for background tabs.</p>
          )}
        </section>
      )}
    </main>
  );
}
