/**
 * The commuter app's jeepney, labelled on the map: the one they are riding,
 * or the one that takes them (the first with a seat left for them after the
 * people queued ahead). Without it the phone names a plate and the map shows
 * a road full of identical jeepneys.
 *
 * Which jeepney is worked out twice a second (dispatch is not free); where
 * its label goes, every frame, so it stays on the moving roof.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { behindCamera } from './Labels';
import { useEffect, useMemo, useRef } from 'react';
import { Vector3 } from 'three';
import type { TwinRuntime } from '@/app/twinRuntime';
import { useApp } from '@/app/store';
import { yourJeepney, type YourJeepney } from '@/app/yourJeepney';
import { fleetPose } from './lanes';

/** Seconds between working out which jeepney is theirs. */
const REFRESH_S = 0.5;
/** Above the roof (a jeepney is about 3 m tall). */
const LABEL_Y = 4.2;

export function YourJeepneyLabel({ twin }: { twin: TwinRuntime }) {
  const query = useApp((s) => s.commuter);
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const el = useMemo(() => {
    const span = document.createElement('span');
    span.hidden = true;
    return span;
  }, []);
  const target = useRef<YourJeepney | null>(null);
  const sinceRefresh = useRef(Infinity);
  const pose = useMemo(() => ({ x: 0, z: 0, heading: 0 }), []);
  const v = useMemo(() => new Vector3(), []);

  useEffect(() => {
    const layer = document.createElement('div');
    layer.className = 'scene-labels';
    layer.appendChild(el);
    gl.domElement.parentElement?.appendChild(layer);
    return () => layer.remove();
  }, [gl, el]);

  // A new trip or rider: find their jeepney straight away.
  useEffect(() => {
    sinceRefresh.current = Infinity;
  }, [query, twin]);

  useFrame((_, dt) => {
    sinceRefresh.current += dt;
    if (sinceRefresh.current >= REFRESH_S) {
      sinceRefresh.current = 0;
      // Only on a trip: while planning, no jeepney is anyone's yet.
      target.current = 'passenger' in query ? yourJeepney(twin, query) : null;
      const t = target.current;
      if (t) {
        if (el.textContent !== t.text) el.textContent = t.text;
        el.className = `scene-label scene-label--yours${t.full ? ' scene-label--yours-full' : ''}`;
      }
    }
    const t = target.current;
    if (!t || !twin.fleet.vehicles[t.vehicle]) {
      el.hidden = true;
      return;
    }
    fleetPose(twin.fleet, t.vehicle, pose);
    v.set(pose.x, LABEL_Y, pose.z);
    const behind = behindCamera(camera, v);
    v.project(camera);
    const off = behind || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05;
    el.hidden = off;
    if (off) return;
    const px = (v.x * 0.5 + 0.5) * size.width;
    const py = (-v.y * 0.5 + 0.5) * size.height;
    el.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) translate(-50%, -100%)`;
  });

  return null;
}
