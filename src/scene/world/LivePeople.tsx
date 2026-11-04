/**
 * People on the map at their real GPS spot: commuters sharing their location
 * on the operator's map, and "you" on your own phone. The same 3D person as
 * everyone else in the twin, standing or walking, not snapped to any road.
 * Grown with the view, with a ring on the ground, so one person can be found
 * on a whole map. Gone once nothing has been heard from them. However many
 * are about, only the SLOTS nearest the view are drawn.
 */

import { useFrame } from '@react-three/fiber';
import { useMemo, useRef } from 'react';
import { Matrix4, Quaternion, Vector3, type Group } from 'three';
import { useApp } from '@/app/store';
import type { LocalPoint } from '@/core/geo/projection';
import type { LiveVehicle } from '@/core/tracking/liveVehicle';
import { PeopleInstances, type PeopleHandle } from '../people/PeopleInstances';
import { appearance, STANDING, type PersonPose } from '../people/personRig';

const RING_COLOUR = '#12b5a6';
/** Drawn at true size within this of the camera, and grown further out (metres). */
const TRUE_SIZE_WITHIN_M = 25;
const SLOTS = 12;
/** The nearest are picked again this often (seconds). */
const PICK_EVERY_S = 0.5;
/** Faster than this they are walking (m/s). */
const WALKING_MPS = 0.6;
const STRIDES_PER_S = 8;
const FIRST_SEED = 7100;
const UP = new Vector3(0, 1, 0);

export function LivePeople({
  people,
  showYou,
}: {
  people: readonly LiveVehicle[];
  /** Also draw this phone's own located person. */
  showYou: boolean;
}) {
  const crowd = useRef<PeopleHandle>(null);
  const rings = useRef<Array<Group | null>>([]);
  const scratch = useMemo(
    () => ({
      root: new Matrix4(),
      turn: new Quaternion(),
      at: new Vector3(),
      size: new Vector3(),
      pose: { ...STANDING } as PersonPose,
    }),
    [],
  );

  const picked = useRef<readonly LiveVehicle[]>([]);
  const pickedAt = useRef(-Infinity);

  useFrame((state) => {
    const c = crowd.current;
    if (!c) return;
    const { root, turn, at, size, pose } = scratch;
    const target = (state.controls as { target?: Vector3 } | null)?.target;
    const now = Date.now();
    if (
      state.clock.elapsedTime - pickedAt.current >= PICK_EVERY_S ||
      picked.current.length > people.length
    ) {
      pickedAt.current = state.clock.elapsedTime;
      const from = target ?? state.camera.position;
      picked.current = people
        .filter((p) => p.trace.length > 0 && p.status(now) !== 'lost')
        .map((p) => ({ p, d: Math.hypot(p.pose.x - from.x, p.pose.z - from.z) }))
        .sort((a, b) => a.d - b.d)
        .slice(0, SLOTS)
        .map(({ p }) => p);
    }
    const away = target ? state.camera.position.distanceTo(target) : TRUE_SIZE_WITHIN_M;
    const k = Math.max(1, away / TRUE_SIZE_WITHIN_M);
    const t = performance.now() / 1000;
    let n = 0;
    const draw = (spot: LocalPoint, heading: number, walking: boolean) => {
      const seed = FIRST_SEED + n;
      const body = k * appearance(seed).size;
      at.set(spot.x, 0, spot.z);
      turn.setFromAxisAngle(UP, heading);
      c.emit(root.compose(at, turn, size.setScalar(body)), walkingPose(pose, walking, t), seed);
      const ring = rings.current[n];
      if (ring) {
        ring.visible = true;
        ring.position.copy(at);
        ring.scale.setScalar(k);
      }
      n++;
    };
    c.begin();
    const you = showYou ? useApp.getState().located : null;
    if (you) draw(you.at, 0, false);
    for (const person of picked.current) {
      const spot = person.trace[person.trace.length - 1];
      if (n >= SLOTS || !spot || person.status(now) === 'lost') continue;
      draw(spot, person.pose.heading, person.speedMps > WALKING_MPS);
    }
    c.end();
    for (let i = n; i < SLOTS; i++) if (rings.current[i]) rings.current[i]!.visible = false;
  });

  return (
    <>
      <PeopleInstances ref={crowd} capacity={SLOTS} />
      {Array.from({ length: SLOTS }, (_, i) => (
        <group
          key={i}
          ref={(g) => {
            rings.current[i] = g;
          }}
          visible={false}
        >
          <mesh rotation-x={-Math.PI / 2} position={[0, 0.05, 0]}>
            <ringGeometry args={[0.7, 0.95, 32]} />
            <meshBasicMaterial color={RING_COLOUR} />
          </mesh>
        </group>
      ))}
    </>
  );
}

function walkingPose(out: PersonPose, walking: boolean, t: number): PersonPose {
  out.walk = walking ? 1 : 0;
  out.phase = walking ? t * STRIDES_PER_S : 0;
  return out;
}
