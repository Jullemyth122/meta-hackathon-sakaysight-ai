/**
 * Which phones this view listens to: the map cells around what the camera
 * looks at, of the kinds it shows (core/tracking/area.ts). The operator's map
 * shows vehicles and people; a commuter's, vehicles only (not other
 * commuters); a driver's, nobody but themselves (Muse fetches the rest once,
 * when asked); a demo scene, nobody. Nothing else is downloaded.
 */

import { useFrame } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import type { Vector3 } from 'three';
import type { TwinRuntime } from '@/app/twinRuntime';
import { useApp, type View } from '@/app/store';
import { areasAround, type AreaKind } from '@/core/tracking/area';

/** The view is looked at again this often (seconds). */
const LOOK_EVERY_S = 1;
/** A commuter's phone listens this far round what it shows (metres). */
const COMMUTER_REACH_M = 1500;
/** The operator's map: twice the camera's height, within these (metres). */
const LEAST_REACH_M = 600;
const MOST_REACH_M = 4000;

const kindsFor = (view: View, inScene: boolean): AreaKind[] =>
  inScene ? [] : view === 'twin' ? ['v', 'p'] : view === 'commuter' ? ['v'] : [];

export function WatchArea({ twin }: { twin: TwinRuntime }) {
  const view = useApp((s) => s.view);
  const inScene = useApp((s) => s.demoScene !== null);
  const lookedAt = useRef(-Infinity);
  // A change of view or scene is looked at at once.
  useEffect(() => {
    lookedAt.current = -Infinity;
  }, [view, inScene]);

  useFrame((state) => {
    if (state.clock.elapsedTime - lookedAt.current < LOOK_EVERY_S) return;
    lookedAt.current = state.clock.elapsedTime;
    const projection = twin.route.projection;
    const kinds = kindsFor(view, inScene);
    let areas: string[] = [];
    if (projection && kinds.length > 0) {
      const at = (state.controls as { target?: Vector3 } | null)?.target ?? state.camera.position;
      const reach =
        view === 'commuter'
          ? COMMUTER_REACH_M
          : Math.max(LEAST_REACH_M, Math.min(MOST_REACH_M, state.camera.position.y * 2));
      areas = areasAround(projection.toGeo({ x: at.x, z: at.z }), reach, kinds);
    }
    const app = useApp.getState();
    if (areas.join() !== app.watchAreas.join()) app.setWatchAreas(areas);
  });

  return null;
}
