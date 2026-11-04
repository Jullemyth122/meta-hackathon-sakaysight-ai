/**
 * Vehicles driven by real phones. Each gets:
 *   - the model of what it is (jeepney, modern jeepney, UV Express, bus) at its
 *     interpolated pose,
 *   - a beacon above it coloured by link status (live / stale / lost),
 *   - a breadcrumb line of the raw GPS fixes (the evidence behind the pose).
 *
 * A stale or lost jeepney is shown as such. We never animate a vehicle we
 * have not heard from.
 *
 * However many phones are about, only the nearest to the view are drawn, in
 * slots kept from the start (SLOTS): a crowd of phones costs the same to draw
 * as a few, and one joining or leaving builds nothing again.
 */

import { useFrame } from '@react-three/fiber';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BufferAttribute,
  BufferGeometry,
  Color,
  Line,
  LineBasicMaterial,
  Object3D,
  type InstancedMesh,
  type Vector3,
} from 'three';
import { useApp } from '@/app/store';
import type { Livery } from '@/core/fleet/fleetSim';
import type { LinkStatus, LiveVehicle } from '@/core/tracking/liveVehicle';
import type { FleetKind } from '@/core/vehicles/specs';
import { JeepneyInstances, type GroundPose } from '../jeepney/JeepneyInstances';
import { PuvBodies, type PuvState } from '../vehicles/PuvBodies';
import { useScaledPose } from './viewScale';

const STATUS_COLOR: Record<LinkStatus, Color> = {
  live: new Color('#3a9d5d'),
  stale: new Color('#efbe2c'),
  lost: new Color('#8a929b'),
};
const TRACE_CAPACITY = 4_000;
const PUV_KINDS = ['modern', 'uv', 'bus'] as const;
/** At most this many of each kind are drawn, the nearest the view first. */
const SLOTS: Record<FleetKind, number> = { jeepney: 48, modern: 8, uv: 8, bus: 8 };
const ALL_SLOTS = Object.values(SLOTS).reduce((a, b) => a + b, 0);
/** Breadcrumb lines for this many, the nearest. */
const TRACES = 12;
/** The nearest are picked again this often (seconds). */
const PICK_EVERY_S = 0.5;
const JEEPNEY_LIVERIES: Livery[] = Array<Livery>(SLOTS.jeepney).fill('red');

interface Shown {
  vehicle: LiveVehicle;
  id: string | undefined;
  /** From the view's spot (metres), when picked. */
  d: number;
}
type Drawn = Record<FleetKind, Shown[]>;
const NONE: Drawn = { jeepney: [], modern: [], uv: [], bus: [] };

/** Of each kind, the nearest to (x, z), up to its slots. */
function nearest(
  vehicles: readonly LiveVehicle[],
  ids: readonly string[] | undefined,
  kinds: readonly FleetKind[] | undefined,
  x: number,
  z: number,
): Drawn {
  const out: Drawn = { jeepney: [], modern: [], uv: [], bus: [] };
  vehicles.forEach((vehicle, i) => {
    const d = Math.hypot(vehicle.pose.x - x, vehicle.pose.z - z);
    out[kinds?.[i] ?? 'jeepney'].push({ vehicle, id: ids?.[i], d });
  });
  for (const kind of Object.keys(out) as FleetKind[])
    out[kind] = out[kind].sort((a, b) => a.d - b.d).slice(0, SLOTS[kind]);
  return out;
}

const sameDrawn = (a: Drawn, b: Drawn) =>
  (Object.keys(a) as FleetKind[]).every(
    (k) => a[k].length === b[k].length && a[k].every((s, i) => s.vehicle === b[k][i]!.vehicle),
  );

export function LiveVehicles({
  vehicles,
  ids,
  kinds,
}: {
  vehicles: LiveVehicle[];
  ids?: readonly string[];
  /** What each one is; a jeepney when not given. */
  kinds?: readonly FleetKind[];
}) {
  const setFollow = useApp((s) => s.setFollow);
  const [drawn, setDrawn] = useState<Drawn>(NONE);
  const pickedAt = useRef(-Infinity);
  // A phone joined or left: picked again at once.
  useEffect(() => {
    pickedAt.current = -Infinity;
  }, [vehicles]);
  useFrame((state) => {
    const t = state.clock.elapsedTime;
    if (t - pickedAt.current < PICK_EVERY_S) return;
    pickedAt.current = t;
    const at = (state.controls as { target?: Vector3 } | null)?.target ?? state.camera.position;
    const next = nearest(vehicles, ids, kinds, at.x, at.z);
    setDrawn((prev) => (sameDrawn(prev, next) ? prev : next));
  });
  const shown = useMemo(() => (Object.values(drawn) as Shown[][]).flat(), [drawn]);
  const traced = useMemo(() => [...shown].sort((a, b) => a.d - b.d).slice(0, TRACES), [shown]);
  const beacons = useRef<InstancedMesh>(null);
  const scratch = useMemo(() => new Object3D(), []);
  const handleSelect = useCallback(
    (one: Shown | undefined, part: 'front' | 'body') => {
      const id = one?.id;
      if (!id) return;
      const cur = useApp.getState().follow;
      const same = cur?.kind === 'live' && cur.id === id;
      setFollow({ kind: 'live', id, view: part === 'front' && same ? 'pov' : 'chase' });
    },
    [setFollow],
  );

  const poseOf = (one: Shown | undefined, out: GroundPose) =>
    one ? Object.assign(out, one.vehicle.pose) : out;

  // Placed per render pass: true size for the cabin camera, enlarged for the
  // zoomed-out main view (see viewScale.ts).
  useScaledPose((k) => {
    const mesh = beacons.current;
    if (!mesh) return;
    const now = Date.now();
    scratch.scale.setScalar(k);
    shown.forEach(({ vehicle }, i) => {
      // Beacon over the roof, scaled with the jeepney.
      scratch.position.set(vehicle.pose.x, 4.2 * k, vehicle.pose.z);
      scratch.updateMatrix();
      mesh.setMatrixAt(i, scratch.matrix);
      mesh.setColorAt(i, STATUS_COLOR[vehicle.status(now)]);
    });
    mesh.count = shown.length;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  });

  if (vehicles.length === 0) return null;
  const jeepneys = drawn.jeepney;
  return (
    <group>
      {jeepneys.length > 0 && (
        <JeepneyInstances
          count={jeepneys.length}
          capacity={SLOTS.jeepney}
          liveries={JEEPNEY_LIVERIES}
          poseAt={(i, out) => poseOf(jeepneys[i], out)}
          scaleWithView
          onSelect={(i, part) => handleSelect(jeepneys[i], part)}
        />
      )}
      {PUV_KINDS.map((kind) => {
        const own = drawn[kind];
        return (
          own.length > 0 && (
            <PuvBodies
              key={kind}
              kind={kind}
              count={own.length}
              capacity={SLOTS[kind]}
              poseAt={(i, out) => poseOf(own[i], out)}
              stateAt={drivenByPhone}
              onSelect={(i, part) => handleSelect(own[i], part)}
            />
          )
        );
      })}
      <instancedMesh ref={beacons} args={[undefined, undefined, ALL_SLOTS]} frustumCulled={false}>
        <coneGeometry args={[0.45, 1.1, 18]} />
        <meshStandardMaterial color="#ffffff" roughness={0.4} />
      </instancedMesh>
      {traced.map(({ vehicle, id }, i) => (
        <Trace key={id ?? i} vehicle={vehicle} />
      ))}
    </group>
  );
}

/** A phone says where it is, not whether its doors are open. */
function drivenByPhone(_: number, out: PuvState) {
  out.shown = true;
  out.open = false;
  out.spin = 0;
}

/** Breadcrumb trail. Uploads new points only when the trace grows. */
function Trace({ vehicle }: { vehicle: LiveVehicle }) {
  const line = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute('position', new BufferAttribute(new Float32Array(TRACE_CAPACITY * 3), 3));
    g.setDrawRange(0, 0);
    return new Line(g, new LineBasicMaterial({ color: '#24407a' }));
  }, []);
  const uploaded = useRef(0);

  useEffect(
    () => () => {
      line.geometry.dispose();
      (line.material as LineBasicMaterial).dispose();
    },
    [line],
  );

  useFrame(() => {
    const trace = vehicle.trace;
    if (trace.length === uploaded.current) return;
    const attr = line.geometry.getAttribute('position') as BufferAttribute;
    const n = Math.min(trace.length, TRACE_CAPACITY);
    for (let i = 0; i < n; i++) attr.setXYZ(i, trace[i]!.x, 0.3, trace[i]!.z);
    attr.needsUpdate = true;
    line.geometry.setDrawRange(0, n);
    line.geometry.computeBoundingSphere();
    uploaded.current = trace.length;
  });

  return <primitive object={line} />;
}
