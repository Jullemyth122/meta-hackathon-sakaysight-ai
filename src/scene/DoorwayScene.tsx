/**
 * Sensor lab: one parked jeepney at a stop. Riders walk up, step in, walk the
 * aisle, sit down, and later stand up and leave; a virtual ESP32-S3-CAM on
 * the cabin ceiling at the front watches the whole cabin and counts them.
 *
 *   camera mount, 4:3 QVGA frame        → doorway/cabinCamera.ts, PipRenderer
 *   rider motion (walk, step, sit)      → core/people/riderMotion.ts
 *   ground truth                        → core/doorway/doorwaySim.ts
 *   detection, tracking, counting       → core/doorway/pipeline.ts, occupancy.ts
 */

import { OrbitControls } from '@react-three/drei';
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef } from 'react';
import { BufferGeometry, LineBasicMaterial, LineSegments, Matrix4, Vector3 } from 'three';
import { useRuntimes } from '@/app/runtimeContext';
import { useApp } from '@/app/store';
import { VEHICLES, type VehicleKind } from '@/core/vehicles/specs';
import type { VisiblePerson } from '@/core/doorway/pipeline';
import { newRiderPose } from '@/core/people/riderMotion';
import { CABIN_CAM, createCabinCamera, projectPerson } from './doorway/cabinCamera';
import { PipRenderer } from './doorway/PipRenderer';
import { createDoorCamera, doorCameras } from './vehicles/doorCamera';
import { VehicleShowcase } from './vehicles/VehicleShowcase';
import { BODY_LIFT, HALF_WIDTH, REAR_X } from './jeepney/jeepneyGeometry';
import { JeepneyInstances, type GroundPose } from './jeepney/JeepneyInstances';
import { PeopleInstances, type PeopleHandle } from './people/PeopleInstances';
import {
  appearance,
  HEAD_CENTRE_Y,
  holdRails,
  poseFromMotion,
  rootFor,
  STANDING,
  type PersonPose,
} from './people/personRig';

/** Riders on board plus a few walking up: comfortably above a full jeepney. */
const MAX_PEOPLE = 40;
const PARKED: readonly ['red'] = ['red'];
/** Seeds for lab riders, clear of the twin's crew seeds. */
const RIDER_SEED = 200_000;

export function DoorwayScene() {
  const vehicle = useApp((s) => s.labVehicle);
  const door = useApp((s) => s.labDoor);
  return vehicle === 'jeepney' ? <JeepneyLab /> : <VehicleLab kind={vehicle} door={door} />;
}

/**
 * The modern jeepney, UV Express or bus at the kerb, riders getting on and
 * off; the picture-in-picture is the chosen door's camera, and every door's
 * pipeline counts them (only from what the cameras see).
 */
function VehicleLab({ kind, door }: { kind: VehicleKind; door: number }) {
  const { doorway } = useRuntimes();
  const lab = doorway.vehicleLab(kind);
  const people = useRef<PeopleHandle>(null);
  const scratch = useMemo(
    () => ({ person: { ...STANDING } as PersonPose, root: new Matrix4(), still: new Matrix4() }),
    [],
  );
  const camera = useMemo(() => {
    const cams = doorCameras(kind);
    return createDoorCamera(cams[Math.min(door, cams.length - 1)]!);
  }, [kind, door]);

  useFrame((state, dtRaw) => {
    lab.door = door;
    lab.step(Math.min(dtRaw, 0.1));
    const crowd = people.current;
    if (!crowd) return;
    const { person, root, still } = scratch;
    crowd.begin();
    lab.sim.forEachRider((id, motion, place, size) => {
      const seed = RIDER_SEED + id;
      rootFor(motion, size, root);
      poseFromMotion(motion, appearance(seed), state.clock.elapsedTime, person);
      holdRails(person, motion.hold, place.holds, still);
      crowd.emit(root, person, seed);
    });
    crowd.end();
  });

  return (
    <>
      <LabStage
        target={kind === 'bus' ? [0, 1.6, 0] : [0, 1.2, 0]}
        maxDistance={kind === 'bus' ? 30 : 22}
      />
      <VehicleShowcase kind={kind} />
      <PeopleInstances ref={people} capacity={VEHICLES[kind].seats + VEHICLES[kind].standing + 8} />
      <PipRenderer espCamera={camera} />
    </>
  );
}

/** Light, ground and kerb, and the orbit camera, for any vehicle in the lab. */
function LabStage({
  target,
  maxDistance = 22,
}: {
  target: [number, number, number];
  maxDistance?: number;
}) {
  return (
    <>
      <color attach="background" args={['#e8e9e9']} />
      <hemisphereLight args={['#ffffff', '#dcdcd8', 1.6]} />
      <directionalLight
        position={[5, 10, 6]}
        intensity={1.8}
        castShadow
        shadow-mapSize={[2048, 2048]}
      />
      <OrbitControls
        makeDefault
        target={target}
        maxPolarAngle={Math.PI / 2.05}
        minDistance={2}
        maxDistance={maxDistance}
      />
      <mesh rotation-x={-Math.PI / 2} position-y={-0.01} receiveShadow>
        <planeGeometry args={[60, 60]} />
        <meshStandardMaterial color="#efefed" />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} receiveShadow>
        <planeGeometry args={[40, 5]} />
        <meshStandardMaterial color="#d0d2d4" />
      </mesh>
    </>
  );
}

function JeepneyLab() {
  const { doorway } = useRuntimes();
  const camera = useMemo(createCabinCamera, []);
  const people = useRef<PeopleHandle>(null);
  const scratch = useMemo(
    () => ({ motion: newRiderPose(), person: { ...STANDING } as PersonPose, root: new Matrix4() }),
    [],
  );

  useFrame((state, dtRaw) => {
    const dt = Math.min(dtRaw, 0.1);
    const { sim, pipeline } = doorway;
    sim.step(dt);
    doorway.clockMs += dt * 1000;

    const { motion, person, root } = scratch;
    const crowd = people.current;
    if (crowd) {
      crowd.begin();
      for (const r of sim.riders) {
        sim.pose(r, motion);
        const seed = RIDER_SEED + r.id;
        const look = appearance(seed);
        rootFor(motion, r.heightScale, root);
        crowd.emit(root, poseFromMotion(motion, look, state.clock.elapsedTime, person), seed);
      }
      crowd.end();
    }

    // The camera only "captures" at its frame rate; projection runs then.
    pipeline.tick(doorway.clockMs, () => {
      const seen: VisiblePerson[] = [];
      for (const r of sim.riders) {
        sim.pose(r, motion);
        const headY = motion.y + HEAD_CENTRE_Y * r.heightScale * motion.stoop;
        const p = projectPerson(camera, r.id, motion.x, headY, motion.z);
        if (p) seen.push(p);
      }
      return seen;
    });
  });

  return (
    <>
      <LabStage target={[-1.6, 1.1, 0]} />
      <JeepneyInstances count={1} liveries={PARKED} poseAt={parkedPose} />
      <PeopleInstances ref={people} capacity={MAX_PEOPLE} />
      <CabinCameraModel />

      <PipRenderer espCamera={camera} />
    </>
  );
}

function parkedPose(_i: number, out: GroundPose): void {
  out.x = 0;
  out.z = 0;
  out.heading = 0;
}

/**
 * The ESP32 module on the ceiling, and a faint outline of what it sees (to
 * the rear entrance), so the camera's coverage is visible in the scene.
 */
export function CabinCameraModel({ showFrustum = true }: { showFrustum?: boolean } = {}) {
  const showFov = useApp((s) => s.showFov);
  const frustum = useMemo(() => {
    // Extend from the front ceiling lens all the way to the rear end of the jeepney cabin (REAR_X),
    // bounded cleanly within the cabin walls and floor/ceiling so it never pokes outside the body.
    const y0 = BODY_LIFT + 0.08;
    const y1 = BODY_LIFT + 1.54;
    const zMax = HALF_WIDTH - 0.08;
    const corners = [
      new Vector3(REAR_X, y0, -zMax),
      new Vector3(REAR_X, y0, zMax),
      new Vector3(REAR_X, y1, zMax),
      new Vector3(REAR_X, y1, -zMax),
    ];
    const pts: Vector3[] = [];
    corners.forEach((c, i) => pts.push(CABIN_CAM.position, c, c, corners[(i + 1) % 4]!));
    return new LineSegments(
      new BufferGeometry().setFromPoints(pts),
      new LineBasicMaterial({ color: '#ff3b30', transparent: true, opacity: 0.45 }),
    );
  }, []);

  useEffect(
    () => () => {
      frustum.geometry.dispose();
      (frustum.material as LineBasicMaterial).dispose();
    },
    [frustum],
  );

  const quaternion = useMemo(() => createCabinCamera().quaternion.clone(), []);
  const p = CABIN_CAM.position;
  return (
    <group>
      {/* Ceiling mounting stem */}
      <mesh position={[p.x + 0.02, p.y + 0.055, p.z]}>
        <cylinderGeometry args={[0.012, 0.012, 0.11, 10]} />
        <meshStandardMaterial color="#c8cdd4" metalness={0.6} roughness={0.3} />
      </mesh>
      <group position={[p.x, p.y, p.z]} quaternion={quaternion}>
        {/* Board/enclosure slightly behind the lens origin (+Z) so the 5 cm near plane never clips it into the PiP */}
        <mesh position={[0, 0, 0.018]} castShadow>
          <boxGeometry args={[0.14, 0.095, 0.036]} />
          <meshStandardMaterial color="#1f2328" roughness={0.5} />
        </mesh>
        {/* Lens barrel and glowing red ESP32-CAM indicator looking down -Z */}
        <mesh position={[0, 0, -0.006]} rotation-x={Math.PI / 2}>
          <cylinderGeometry args={[0.026, 0.03, 0.018, 20]} />
          <meshStandardMaterial color="#c8cdd4" metalness={0.5} roughness={0.35} />
        </mesh>
        <mesh position={[0, 0, -0.012]} rotation-x={Math.PI / 2}>
          <cylinderGeometry args={[0.018, 0.018, 0.016, 20]} />
          <meshStandardMaterial color="#ff3b30" emissive="#ff3b30" emissiveIntensity={0.85} />
        </mesh>
      </group>
      {showFrustum && showFov && <primitive object={frustum} />}
    </group>
  );
}
