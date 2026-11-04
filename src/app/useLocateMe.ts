/**
 * The phone's own GPS, in the app. A commuter (Locate me) is drawn where they
 * are, their trip starts from there, and the operator's live map shows them as
 * a person. A driver (ShareVehicle) goes on that map as the vehicle they drive,
 * and their camera follows it. Lives above the panels, so it goes on through a
 * change of tab, and ends when they stop it: their last place is then removed.
 */

import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { GpsFix, SessionMeta, SessionUpdate } from '@/core/tracking/types';
import { getTransport } from '@/net';
import { useGeolocation, useWakeLock } from '@/tracker/useGeolocation';
import { KIND_NAME } from '@/core/vehicles/specs';
import { aroundSpot, homeMoved, LAST_LOCATION, MY_LOCATION } from './locate';
import { useApp } from './store';
import type { TwinRuntime } from './twinRuntime';

/** At most this often to the live map, however fast the GPS reports (ms). */
const SEND_EVERY_MS = 3000;
/** A phone lying still reports nothing: this often it says it is still there (ms). */
const STILL_HERE_MS = 6000;

/**
 * `twinRef` is the twin on screen (a scene's, during one), for the map's
 * projection; `dayRef` the live day, where this phone's own place goes.
 */
export function useLocateMe(
  twinRef: RefObject<TwinRuntime | null>,
  dayRef: RefObject<TwinRuntime | null>,
) {
  const on = useApp((s) => s.locating);
  const as = useApp((s) => s.sharingAs);
  const session = useRef<SessionMeta | null>(null);
  const latest = useRef<GpsFix | null>(null);
  const sentAt = useRef(0);
  const found = useRef(false);

  const send = useCallback(
    (fix: GpsFix) => {
      const meta = session.current;
      if (!meta) return;
      sentAt.current = performance.now();
      const update: SessionUpdate = { meta, fix, trip: 'WAITING' };
      // On this phone's own map straight away: it listens to nobody else's place
      // to see its own (a driver's map listens to no phones at all).
      dayRef.current?.ingest(update);
      useApp.getState().upsertSession({ meta, trip: update.trip, lastFixAt: fix.timestamp });
      void getTransport()
        .then((t) => t.publish(update))
        .catch((err: unknown) => console.warn('Could not share location:', err));
    },
    [dayRef],
  );

  const onFix = useCallback(
    (fix: GpsFix) => {
      const projection = twinRef.current?.route.projection;
      if (!projection) return;
      const at = projection.toLocal(fix);
      const app = useApp.getState();
      latest.current = fix;
      // During a demo scene the camera and the trip are the scene's.
      if (app.demoScene) return;
      app.setLocated({ at, accuracyM: fix.accuracyM });
      const first = !found.current;
      found.current = true;
      if (performance.now() - sentAt.current >= SEND_EVERY_MS) send(fix);
      if (app.sharingAs !== 'commuter') {
        const id = session.current?.sessionId;
        if (first && id) app.setFollow({ kind: 'live', id, view: 'chase' });
        return;
      }
      // A trip already under way keeps the start it was planned from.
      if (!app.tripLegs && homeMoved(app.tripEnds.home?.at ?? null, at, fix.accuracyM))
        app.setTripEnd('home', { name: MY_LOCATION, at });
      if (first && !app.tripLegs) app.requestShot('area', aroundSpot(at));
    },
    [twinRef, send],
  );

  const error = useGeolocation(on, onFix);
  useWakeLock(on);
  useEffect(() => useApp.getState().setLocateError(error), [error]);

  useEffect(() => {
    if (!on) return;
    const sessionId = `${as === 'commuter' ? 'me' : 'drv'}-${crypto.randomUUID().slice(0, 8)}`;
    session.current = {
      sessionId,
      startedAt: Date.now(),
      ...(as === 'commuter'
        ? { vehicleId: 'COMMUTER', source: 'passenger-consented', role: 'commuter' }
        : { vehicleId: KIND_NAME[as], source: 'driver-device', role: 'driver', vehicleKind: as }),
    };
    found.current = false;
    useApp.getState().setMySessionId(sessionId);
    const still = window.setInterval(() => {
      const fix = latest.current;
      if (fix && performance.now() - sentAt.current >= STILL_HERE_MS)
        send({ ...fix, timestamp: Date.now() });
    }, 1000);
    return () => {
      window.clearInterval(still);
      session.current = null;
      latest.current = null;
      const app = useApp.getState();
      app.setLocated(null);
      app.setMySessionId(null);
      dayRef.current?.live.delete(sessionId);
      app.dropSession(sessionId);
      void getTransport().then((t) => t.clear(sessionId));
      const home = app.tripEnds.home;
      if (home?.name === MY_LOCATION) app.setTripEnd('home', { ...home, name: LAST_LOCATION });
      // Back in the simulated vehicle.
      if (app.follow?.kind === 'live' && app.follow.id === sessionId)
        app.setDriverVehicle(app.driverVehicle);
    };
  }, [on, as, send, dayRef]);
}
