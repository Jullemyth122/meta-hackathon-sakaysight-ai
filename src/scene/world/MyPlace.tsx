/**
 * Where the commuter app's user is: picked by clicking the map (a click, not
 * a drag, so panning still works while picking), and shown as a pin there.
 * The same click sets either end of a trip being planned, named by where it
 * is (latitude, longitude), so it can be checked against another map; dropped
 * on a road, it moves to the side of it, where someone can stand.
 * The click lands where it meets the ground (y = 0), the plane the map's
 * streets are drawn on.
 */

import { useFrame, useThree } from '@react-three/fiber';
import { useEffect, useRef } from 'react';
import { Plane, Raycaster, Vector2, Vector3, type Group } from 'three';
import { useRuntimes } from '@/app/runtimeContext';
import { useApp } from '@/app/store';
import { besideRoads } from '@/app/streetWays';
import type { LocalPoint } from '@/core/geo/projection';
import { viewScale } from './viewScale';

/** A press is a click (not a pan) when it moves less than this (pixels)… */
const CLICK_MOVE_PX = 6;
/** …and is let go within this (milliseconds). */
const CLICK_MS = 500;
const PIN_COLOUR = '#d6336c';

export function MyPlace() {
  const { camera, gl } = useThree();
  const { twin } = useRuntimes();
  const picking = useApp((s) => s.pickingPlace);
  const place = useApp((s) => s.me.place);
  const located = useApp((s) => s.located !== null);
  const view = useApp((s) => s.view);
  const pin = useRef<Group>(null);

  useEffect(() => {
    if (!picking) return;
    const el = gl.domElement;
    const ground = new Plane(new Vector3(0, 1, 0), 0);
    const ray = new Raycaster();
    let down: { x: number; y: number; t: number } | null = null;
    const press = (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY, t: performance.now() };
    };
    const release = (e: PointerEvent) => {
      if (!down) return;
      const click =
        Math.hypot(e.clientX - down.x, e.clientY - down.y) < CLICK_MOVE_PX &&
        performance.now() - down.t < CLICK_MS;
      down = null;
      if (!click) return;
      const r = el.getBoundingClientRect();
      ray.setFromCamera(
        new Vector2(
          ((e.clientX - r.left) / r.width) * 2 - 1,
          -((e.clientY - r.top) / r.height) * 2 + 1,
        ),
        camera,
      );
      const hit = ray.ray.intersectPlane(ground, new Vector3());
      if (!hit) return;
      const at = { x: hit.x, z: hit.z };
      const app = useApp.getState();
      if (picking === 'me') app.setMe({ place: at });
      else {
        const projection = twin.route.projection;
        const set = (spot: LocalPoint) => {
          const g = projection?.toGeo(spot);
          const name = g ? `Map spot ${g.lat.toFixed(5)}, ${g.lng.toFixed(5)}` : 'Map spot';
          useApp.getState().setTripEnd(picking, { name, at: spot });
        };
        // Dropped on a road, it belongs at the side of it.
        if (projection) void besideRoads(at, projection.origin).then(set);
        else set(at);
      }
      app.setPickingPlace(false);
    };
    el.addEventListener('pointerdown', press);
    el.addEventListener('pointerup', release);
    const cursor = el.style.cursor;
    el.style.cursor = 'crosshair';
    return () => {
      el.removeEventListener('pointerdown', press);
      el.removeEventListener('pointerup', release);
      el.style.cursor = cursor;
    };
  }, [picking, camera, gl, twin]);

  // The pin grows with the view, like the jeepneys, so it shows from above.
  useFrame((state) => {
    if (pin.current) pin.current.scale.setScalar(viewScale(state));
  });

  // Located, they are drawn themselves (LivePeople).
  if (!place || located || (view !== 'commuter' && view !== 'twin')) return null;
  return (
    <group ref={pin} position={[place.x, 0, place.z]}>
      <mesh position={[0, 3.2, 0]}>
        <sphereGeometry args={[1.1, 20, 14]} />
        <meshStandardMaterial color={PIN_COLOUR} />
      </mesh>
      <mesh position={[0, 1.4, 0]}>
        <coneGeometry args={[0.6, 2.4, 16]} />
        <meshStandardMaterial color={PIN_COLOUR} />
      </mesh>
      <mesh rotation-x={-Math.PI / 2} position={[0, 0.05, 0]}>
        <ringGeometry args={[1.2, 1.7, 32]} />
        <meshBasicMaterial color={PIN_COLOUR} />
      </mesh>
    </group>
  );
}
