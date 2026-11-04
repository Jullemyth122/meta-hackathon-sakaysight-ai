/**
 * Same-browser transport over BroadcastChannel. Open /track in one tab and the
 * dashboard in another: no accounts, no network, no cost.
 */

import { areaOf } from '@/core/tracking/area';
import type { SessionUpdate } from '@/core/tracking/types';
import { isSessionUpdate, type Transport } from './transport';

const CHANNEL = 'sakaysightai.telemetry';

export function createLoopbackTransport(): Transport {
  const channel = new BroadcastChannel(CHANNEL);
  // The latest from each session heard, for fetch.
  const latest = new Map<string, SessionUpdate>();
  channel.addEventListener('message', (e: MessageEvent) => {
    if (isSessionUpdate(e.data)) latest.set(e.data.meta.sessionId, e.data);
  });

  return {
    kind: 'loopback',
    async publish(update: SessionUpdate) {
      channel.postMessage(update);
    },
    async clear(sessionId) {
      latest.delete(sessionId);
    },
    subscribe(areas, onUpdate) {
      const wanted = new Set(areas);
      const listener = (e: MessageEvent) => {
        if (isSessionUpdate(e.data) && wanted.has(areaOf(e.data))) onUpdate(e.data);
      };
      channel.addEventListener('message', listener);
      return () => channel.removeEventListener('message', listener);
    },
    async fetch(areas) {
      const wanted = new Set(areas);
      return [...latest.values()].filter((u) => wanted.has(areaOf(u)));
    },
  };
}
