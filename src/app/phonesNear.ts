/**
 * Real phones round a driver, looked up once when Muse is asked. A driver's
 * map listens to no other phone (scene/world/WatchArea.tsx), so knowing who
 * is about costs one look at the nearby areas, not a stream of every phone.
 */

import type { LocalPoint } from '@/core/geo/projection';
import { areasAround } from '@/core/tracking/area';
import { phoneGone } from '@/core/tracking/liveVehicle';
import { getTransport } from '@/net';
import { useApp } from './store';
import type { TwinRuntime } from './twinRuntime';

/** Looked this far round the driver (metres). */
const NEAR_M = 1500;
/** A commuter this close to a stop is waiting at it (metres). */
const AT_STOP_M = 80;
/** No answer this soon: Muse answers without them (ms). */
const LOOK_FOR_MS = 3000;

export interface PhonesNear {
  withinM: number;
  driversSharing: number;
  nearestDriverM: number | null;
  commutersSharing: number;
  commutersAtNextStop: number;
}

/** Null in a demo scene (no real phones are in it), with no map, or if the look takes too long. */
export async function phonesNear(
  twin: TwinRuntime,
  at: LocalPoint,
  nextStopAt: LocalPoint | null,
): Promise<PhonesNear | null> {
  const app = useApp.getState();
  const projection = twin.route.projection;
  if (app.demoScene || !projection) return null;
  const look = getTransport().then((t) =>
    t.fetch(areasAround(projection.toGeo(at), NEAR_M, ['v', 'p'])),
  );
  const late = new Promise<null>((done) => setTimeout(() => done(null), LOOK_FOR_MS));
  const found = await Promise.race([look.catch(() => null), late]);
  if (!found) return null;
  const now = Date.now();
  const apart = (p: LocalPoint, q: LocalPoint) => Math.hypot(p.x - q.x, p.z - q.z);
  const others = found.filter(
    (u) => u.meta.sessionId !== app.mySessionId && !phoneGone(u.fix.timestamp, now),
  );
  const drivers = others
    .filter((u) => u.meta.role !== 'commuter')
    .map((u) => apart(projection.toLocal(u.fix), at))
    .filter((m) => m <= NEAR_M);
  const commuters = others
    .filter((u) => u.meta.role === 'commuter')
    .map((u) => projection.toLocal(u.fix));
  return {
    withinM: NEAR_M,
    driversSharing: drivers.length,
    nearestDriverM: drivers.length > 0 ? Math.round(Math.min(...drivers)) : null,
    commutersSharing: commuters.filter((p) => apart(p, at) <= NEAR_M).length,
    commutersAtNextStop: nextStopAt
      ? commuters.filter((p) => apart(p, nextStopAt) <= AT_STOP_M).length
      : 0,
  };
}
