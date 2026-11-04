/**
 * The twin's jeepneys and their diesel, on the map: one on its way to a
 * station ("⛽ ANZ 6253 · going to fill up at RePhil · 1.2 km"), one in line
 * or at the pumps ("⛽ ANZ 6253 · filling up at RePhil · 2 min left").
 * FleetSim does the refuelling (see its diesel notes); this only shows it.
 *
 * Who is labelled is worked out twice a second; where, every frame, so the
 * label rides on the roof.
 */

import { behindCamera, labelSight } from './Labels';
import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { Vector3 } from 'three';
import type { TwinRuntime } from '@/app/twinRuntime';
import type { FleetVehicle } from '@/core/fleet/fleetSim';
import { dieselDoing } from '@/app/status';
import { fleetPose } from './lanes';
import { viewScale } from './viewScale';

/** Labels at most (those at the pumps first, then the lowest tanks). */
const MAX_LABELS = 12;
/** Seconds between working out who is labelled. */
const REFRESH_S = 0.5;
/** Above the roof, at true scale (metres). */
const LABEL_Y = 4.2;
/** Beyond this from the camera, no label (metres). */
const MAX_DISTANCE_M = 6000;

/** What jeepney `v` is doing about diesel, or null when nothing. */
export function refuelText(twin: TwinRuntime, v: FleetVehicle): string | null {
  const doing = dieselDoing(twin.route, v);
  return doing && `⛽ ${v.plate} · ${doing.charAt(0).toLowerCase()}${doing.slice(1)}`;
}

export function RefuelLabels({ twin, hidden = false }: { twin: TwinRuntime; hidden?: boolean }) {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const layer = useMemo(() => {
    const div = document.createElement('div');
    div.className = 'scene-labels';
    return div;
  }, []);
  const spans = useMemo(
    () =>
      Array.from({ length: MAX_LABELS }, () => {
        const span = document.createElement('span');
        span.hidden = true;
        layer.appendChild(span);
        return span;
      }),
    [layer],
  );
  useEffect(() => {
    gl.domElement.parentElement?.appendChild(layer);
    return () => layer.remove();
  }, [gl, layer]);
  useEffect(() => {
    layer.hidden = hidden;
  }, [layer, hidden]);

  const shown = useRef<number[]>([]);
  const since = useRef(Infinity);
  const pose = useMemo(() => ({ x: 0, z: 0, heading: 0 }), []);
  const v = useMemo(() => new Vector3(), []);

  useFrame((state, dt) => {
    since.current += dt;
    if (since.current >= REFRESH_S) {
      since.current = 0;
      const list = twin.fleet.vehicles
        .map((veh) => ({ veh, text: refuelText(twin, veh) }))
        .filter((x): x is { veh: FleetVehicle; text: string } => x.text !== null)
        // At the station first, then the lowest tanks.
        .sort((a, b) => Number(!!b.veh.yard) - Number(!!a.veh.yard) || a.veh.tankL - b.veh.tankL)
        .slice(0, MAX_LABELS);
      shown.current = list.map((x) => x.veh.id);
      spans.forEach((span, k) => {
        const item = list[k];
        if (!item) return;
        if (span.textContent !== item.text) span.textContent = item.text;
        span.className = `scene-label scene-label--refuel${item.veh.yard ? ' scene-label--refuel-now' : ''}`;
      });
    }
    const k = viewScale(state);
    spans.forEach((span, n) => {
      const id = shown.current[n];
      if (id === undefined || !twin.fleet.vehicles[id]) {
        span.hidden = true;
        return;
      }
      fleetPose(twin.fleet, id, pose);
      v.set(pose.x, LABEL_Y * k, pose.z);
      const distance = v.distanceTo(camera.position);
      const far = distance > Math.min(MAX_DISTANCE_M, labelSight(camera.position.y));
      const behind = behindCamera(camera, v);
      v.project(camera);
      const off = far || behind || Math.abs(v.x) > 1.05 || Math.abs(v.y) > 1.05;
      span.hidden = off;
      if (off) return;
      const px = (v.x * 0.5 + 0.5) * size.width;
      const py = (-v.y * 0.5 + 0.5) * size.height;
      span.style.transform = `translate(${px.toFixed(1)}px, ${py.toFixed(1)}px) translate(-50%, -100%)`;
    });
  });

  return null;
}
