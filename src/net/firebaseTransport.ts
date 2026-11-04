/**
 * Firebase Realtime Database transport (free Spark plan is enough here).
 *
 * Layout:
 *   sessions/{sessionId}        latest { meta, fix, trip, area }   (what dashboards watch)
 *   traces/{sessionId}/{push}   every fix                    (replay / route recording)
 *
 * Each session is filed under its area (kind and map cell, core/tracking/area.ts),
 * indexed, so a phone downloads only the areas its map shows.
 *
 * Both sides sign in anonymously so the database rules can require auth.
 * See database.rules.json.
 */

import { initializeApp, type FirebaseApp } from 'firebase/app';
import { getAuth, signInAnonymously } from 'firebase/auth';
import {
  equalTo,
  get,
  getDatabase,
  onChildAdded,
  onChildChanged,
  onDisconnect,
  orderByChild,
  push,
  query,
  ref,
  remove,
  set,
} from 'firebase/database';
import type { FirebaseWebConfig } from '@/config';
import { areaOf } from '@/core/tracking/area';
import type { SessionUpdate } from '@/core/tracking/types';
import { isSessionUpdate, type Transport } from './transport';

/** How often a phone renews asking the database to drop it if it disappears (ms). */
const RENEW_DROP_MS = 30_000;

export function createFirebaseTransport(cfg: FirebaseWebConfig): Transport {
  const app: FirebaseApp = initializeApp(cfg);
  const db = getDatabase(app);
  // One sign-in shared by every call; failures surface on the first use.
  const ready = signInAnonymously(getAuth(app));
  const askedToDrop = new Map<string, number>();
  const inAreaQuery = (area: string) =>
    query(ref(db, 'sessions'), orderByChild('area'), equalTo(area));

  return {
    kind: 'firebase',
    async publish(update: SessionUpdate) {
      await ready;
      const id = update.meta.sessionId;
      // Closed without stopping, or out of signal: the database takes its place off by itself.
      if (Date.now() - (askedToDrop.get(id) ?? 0) > RENEW_DROP_MS) {
        askedToDrop.set(id, Date.now());
        await onDisconnect(ref(db, `sessions/${id}`)).remove();
      }
      await Promise.all([
        set(ref(db, `sessions/${id}`), { ...update, area: areaOf(update) }),
        // Where a vehicle went is the record of its route; where a person went is theirs.
        ...(update.meta.role === 'commuter' ? [] : [push(ref(db, `traces/${id}`), update.fix)]),
      ]);
    },
    async clear(sessionId) {
      await ready;
      askedToDrop.delete(sessionId);
      await onDisconnect(ref(db, `sessions/${sessionId}`)).cancel();
      await remove(ref(db, `sessions/${sessionId}`));
    },
    subscribe(areas, onUpdate) {
      let off: Array<() => void> = [];
      let cancelled = false;
      void ready.then(() => {
        if (cancelled) return;
        const handle = (snap: { val(): unknown }) => {
          const value = snap.val();
          if (isSessionUpdate(value)) onUpdate(value);
        };
        off = areas.flatMap((area) => {
          const inArea = inAreaQuery(area);
          return [onChildAdded(inArea, handle), onChildChanged(inArea, handle)];
        });
      });
      return () => {
        cancelled = true;
        off.forEach((fn) => fn());
      };
    },
    async fetch(areas) {
      await ready;
      const found: SessionUpdate[] = [];
      for (const snap of await Promise.all(areas.map((area) => get(inAreaQuery(area)))))
        snap.forEach((child) => {
          const value: unknown = child.val();
          if (isSessionUpdate(value)) found.push(value);
        });
      return found;
    },
  };
}
