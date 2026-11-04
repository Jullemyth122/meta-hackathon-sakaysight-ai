/**
 * Cars at a station's pumps before a jeepney (FleetSim draws them as it
 * turns in: see its diesel notes): one at the pump, maybe one waiting
 * behind it, until each has filled up. Plain boxes, a body and a cabin,
 * in everyday car colours, posed like the jeepneys (view-scaled with them).
 */

import { useEffect, useMemo, useRef } from 'react';
import { BoxGeometry, Color, InstancedMesh, Matrix4, MeshStandardMaterial, Object3D } from 'three';
import { CAR_GAP_M, pumpAt, type FleetSim } from '@/core/fleet/fleetSim';
import { yardPose } from './lanes';
import { useScaledPose } from './viewScale';

/** Cars drawn at most. */
const MAX_CARS = 24;
/** Silver, white, black, red, grey-blue: what fills a Manila forecourt. */
const CAR_COLOURS = ['#c9ccd1', '#f2f2f0', '#26282c', '#a8262c', '#5b6b7d'];
const NOWHERE = new Matrix4().makeScale(0, 0, 0);

export function StationCars({ fleet }: { fleet: FleetSim }) {
  const bodies = useRef<InstancedMesh>(null);
  const cabins = useRef<InstancedMesh>(null);
  // A car 4.4 m long (along x, the way a pose faces), 1.8 m wide.
  const body = useMemo(() => new BoxGeometry(4.4, 0.8, 1.8).translate(0, 0.55, 0), []);
  const cabin = useMemo(() => new BoxGeometry(2.3, 0.6, 1.6).translate(-0.2, 1.25, 0), []);
  const material = useMemo(() => new MeshStandardMaterial({ roughness: 0.5 }), []);
  const glass = useMemo(() => new MeshStandardMaterial({ color: '#3d4652', roughness: 0.2 }), []);
  useEffect(
    () => () => {
      body.dispose();
      cabin.dispose();
      material.dispose();
      glass.dispose();
    },
    [body, cabin, material, glass],
  );

  const scratch = useMemo(
    () => ({ obj: new Object3D(), pose: { x: 0, z: 0, heading: 0 }, colour: new Color() }),
    [],
  );
  useScaledPose((k) => {
    const meshes = [bodies.current, cabins.current];
    if (!meshes[0] || !meshes[1]) return;
    const { obj, pose, colour } = scratch;
    let n = 0;
    for (const v of fleet.vehicles) {
      const y = v.yard;
      if (!y || y.cars === 0 || v.duty === 'parked') continue;
      for (let j = 0; j < y.cars && n < MAX_CARS; j++, n++) {
        // Each car keeps its colour: picked by the jeepney it is in front of, and its place.
        meshes[0]!.setColorAt(
          n,
          colour.set(CAR_COLOURS[(v.id * 2 + y.cars - j) % CAR_COLOURS.length]!),
        );
        yardPose(fleet.route, y.stop, y.bay, pumpAt(y.stop, v.kind, y.bay) - j * CAR_GAP_M, pose);
        obj.position.set(pose.x, 0, pose.z);
        obj.rotation.set(0, pose.heading, 0);
        obj.scale.setScalar(k);
        obj.updateMatrix();
        for (const m of meshes) m!.setMatrixAt(n, obj.matrix);
      }
    }
    for (const m of meshes) {
      for (let i = n; i < m!.count; i++) m!.setMatrixAt(i, NOWHERE);
      m!.instanceMatrix.needsUpdate = true;
    }
    if (meshes[0]!.instanceColor) meshes[0]!.instanceColor.needsUpdate = true;
  });

  return (
    <>
      <instancedMesh ref={bodies} args={[body, material, MAX_CARS]} frustumCulled={false}>
        {/* Colours from the first frame: a material is built for them only if they are there. */}
        <instancedBufferAttribute
          attach="instanceColor"
          args={[new Float32Array(MAX_CARS * 3).fill(1), 3]}
        />
      </instancedMesh>
      <instancedMesh ref={cabins} args={[cabin, glass, MAX_CARS]} frustumCulled={false} />
    </>
  );
}
