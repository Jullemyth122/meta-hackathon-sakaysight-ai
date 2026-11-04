/**
 * People at the stops (fading in as they walk up, out once arrived) and the
 * marked stop area on the pavement beside each stop's kerb.
 */
import { useFrame } from '@react-three/fiber';
import { useEffect, useMemo, useRef, useState } from 'react';
import { BufferAttribute, BufferGeometry, Matrix4, type Mesh } from 'three';
import { useApp } from '@/app/store';
import type { FleetSim } from '@/core/fleet/fleetSim';
import type { LocalPoint } from '@/core/geo/projection';
import { kindOf } from '@/core/people/passengerSystem';
import { newRiderPose } from '@/core/people/riderMotion';
import { areaCentre, stopAreaQuads } from '@/core/people/stopLayout';
import type { CrewState } from '../jeepney/crewState';
import { riderSeed } from '../jeepney/crew';
import { PeopleInstances, type PeopleHandle } from '../people/PeopleInstances';
import { appearance, poseFromMotion, rootFor, seatedPose, STANDING } from '../people/personRig';
import {
  TRICYCLE_DRIVER,
  TricycleInstances,
  type TricycleHandle,
} from '../people/TricycleInstances';
import { Labels } from './Labels';

const AREA_COLOUR = '#bbc9e7';
/** Tricycles drawn at once (only those near the camera are). */
const TRICYCLES = 256;
/** People outside jeepneys are drawn this far from the camera, more when it is high (metres). */
const DRAW_NEAR_M = 250;
const DRAW_FAR_M = 4000;
/** Tricycle drivers' looks: their own range of seeds, apart from riders'. */
const DRIVER_SEED = 3_000_000;
/** Just above the ground, so the area is drawn over the map's pavement. */
const AREA_Y = 0.01;

/** The stop areas' quads (from stopAreaQuads) as one flat mesh facing up. */
function stopAreaGeometry(quads: readonly LocalPoint[][]): BufferGeometry {
  const position: number[] = [];
  // Wound counter-clockwise seen from above, whichever side of the road the
  // quad is on: a triangle facing down is lit from behind and shows black.
  const triangle = (a: LocalPoint, b: LocalPoint, c: LocalPoint) => {
    const up = (b.z - a.z) * (c.x - a.x) - (b.x - a.x) * (c.z - a.z) > 0;
    for (const p of up ? [a, b, c] : [a, c, b]) position.push(p.x, AREA_Y, p.z);
  };
  for (const [a, b, c, d] of quads) {
    triangle(a!, b!, c!);
    triangle(a!, c!, d!);
  }
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array(position), 3));
  const up = new Float32Array(position.length);
  for (let i = 1; i < up.length; i += 3) up[i] = 1;
  g.setAttribute('normal', new BufferAttribute(up, 3));
  g.computeBoundingSphere();
  return g;
}

export function Stops({ fleet, crew }: { fleet: FleetSim; crew: CrewState }) {
  const people = useRef<PeopleHandle>(null);
  const tricycles = useRef<TricycleHandle>(null);
  const marker = useRef<Mesh>(null);
  const tracked = useApp((s) => s.trackedRiderId);
  const inside = useApp((s) => s.follow?.view === 'inside');
  // A commuter on a trip is told where to board and get off: not every stop.
  const onTrip = useApp((s) => s.view === 'commuter' && !!(s.tripPreview ?? s.tripLegs));
  const [capacity, setCapacity] = useState(512);
  const scratch = useMemo(
    () => ({
      root: new Matrix4(),
      person: { ...STANDING },
      motion: newRiderPose(),
      driver: newRiderPose(),
    }),
    [],
  );
  // One area per stop, for waiting and getting off alike (as on a real
  // Philippine kerb); a loop stop is served one way only, on its kerb.
  const directions = useMemo(
    () => (fleet.route.loop ? ([1] as const) : ([1, -1] as const)),
    [fleet],
  );
  const areaGeometry = useMemo(
    () =>
      stopAreaGeometry(
        fleet.route.stops.flatMap((_, i) =>
          directions.flatMap((d) => stopAreaQuads(fleet.route, i, d)),
        ),
      ),
    [fleet, directions],
  );
  useEffect(() => () => areaGeometry.dispose(), [areaGeometry]);
  const labels = useMemo(
    () =>
      fleet.route.stops.flatMap((stop, i) =>
        directions.map((d) => ({
          ...areaCentre(fleet.route, i, d),
          text: `${stop.name} · Stop`,
          kind: 'passenger-area',
          y: 0.2,
        })),
      ),
    [fleet, directions],
  );

  useFrame((state) => {
    // Room for every rider, and a driver for each tricycle drawn.
    const needed = crew.passengers.size + TRICYCLES;
    if (needed > capacity) setCapacity(Math.ceil(needed / 256) * 256);
    const crowd = people.current;
    const trikes = tricycles.current;
    if (!crowd || !trikes) return;
    crowd.begin();
    trikes.begin();
    // Everyone in view: further out the higher the camera, so commuters coming
    // from the far barangays (by tricycle, up to 3 km) show from above too.
    const reach = Math.min(DRAW_FAR_M, Math.max(DRAW_NEAR_M, state.camera.position.y * 3));
    crew.forEachOutside((r) => {
      if (
        r.id !== tracked &&
        Math.hypot(r.pose.x - state.camera.position.x, r.pose.z - state.camera.position.z) > reach
      )
        return;
      const seed = riderSeed(r.id);
      const look = appearance(seed);
      // In a sidecar to the stop, or on from it: the tricycle, and its driver astride beside them.
      const byTricycle =
        (r.phase === 'approaching' && r.approachMode === 'tricycle') ||
        (r.phase === 'walking' && r.leaveMode === 'tricycle');
      if (byTricycle && r.pose.sit > 0.5) {
        trikes.emit(r.pose, r.id);
        const d = scratch.driver;
        const c = Math.cos(r.pose.yaw);
        const s = Math.sin(r.pose.yaw);
        Object.assign(d, r.pose, { walk: 0, sit: 1 });
        d.x = r.pose.x + TRICYCLE_DRIVER.x * c + TRICYCLE_DRIVER.z * s;
        d.y = r.pose.y + TRICYCLE_DRIVER.y;
        d.z = r.pose.z - TRICYCLE_DRIVER.x * s + TRICYCLE_DRIVER.z * c;
        const driverLook = appearance(DRIVER_SEED + r.id);
        crowd.emit(
          rootFor(d, driverLook.size, scratch.root),
          seatedPose(driverLook, state.clock.elapsedTime, scratch.person),
          DRIVER_SEED + r.id,
          driverLook,
          crew.visibility(r),
        );
      }
      crowd.emit(
        rootFor(r.pose, look.size, scratch.root),
        poseFromMotion(r.pose, look, state.clock.elapsedTime, scratch.person),
        seed,
        look,
        crew.visibility(r),
        kindOf(r) === 'pregnant',
      );
    });
    crowd.end();
    trikes.end();
    if (marker.current) {
      const p = tracked === null ? null : crew.worldPose(tracked, scratch.motion);
      marker.current.visible = !!p;
      if (p) marker.current.position.set(p.x, p.y + 0.03, p.z);
    }
  });

  return (
    <group>
      <mesh geometry={areaGeometry} receiveShadow>
        <meshStandardMaterial color={AREA_COLOUR} roughness={0.9} />
      </mesh>
      <Labels labels={labels} hidden={inside || onTrip} />
      <PeopleInstances ref={people} capacity={capacity} fading />
      <TricycleInstances ref={tricycles} capacity={TRICYCLES} />
      <mesh ref={marker} rotation-x={-Math.PI / 2} visible={false}>
        <ringGeometry args={[0.45, 0.6, 32]} />
        <meshBasicMaterial color="#f5c542" depthTest={false} />
      </mesh>
    </group>
  );
}
