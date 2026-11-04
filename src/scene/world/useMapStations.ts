/**
 * Which gas stations the 3D map shows.
 *
 *   operator   (Live twin) all of them, the whole area around the route
 *   driver     (the Driver app, or riding in the front seat) only those
 *              within DRIVER_MAP_RADIUS_M of their jeepney, re-checked once
 *              a second as it drives, and which of those are across the
 *              road (no U-turns, so of no use to them right now)
 *   commuter   none (the scene passes no stations)
 *
 * Stations further away are not drawn for a driver, but the advice still
 * knows them (core/fuel/stations.ts fuelAhead: onMap false).
 */

import { useFrame } from '@react-three/fiber';
import { useEffect, useRef, useState } from 'react';
import { useApp } from '@/app/store';
import type { TwinRuntime } from '@/app/twinRuntime';
import { canPullIn, stationsNear, type FuelStation } from '@/core/fuel/stations';
import { fleetPose } from './lanes';

const RECHECK_S = 1;

export interface MapStations {
  shown: readonly FuelStation[];
  /** Ids of shown stations the driver cannot pull into; null for the operator. */
  across: ReadonlySet<string> | null;
}

/** The jeepney whose driver is looking at the map, or null for the operator. */
function useDriverIndex(): number | null {
  return useApp((s) => {
    if (s.view === 'driver') return s.driverVehicle;
    if (s.follow?.kind === 'sim' && s.follow.view === 'pov') return s.follow.index;
    return null;
  });
}

export function useMapStations(twin: TwinRuntime, all: readonly FuelStation[]): MapStations {
  const driver = useDriverIndex();
  const [map, setMap] = useState<MapStations>({ shown: all, across: null });
  const key = useRef('');
  const sinceS = useRef(Infinity);
  const pose = useRef({ x: 0, z: 0, heading: 0 });

  // Back to everything when nobody is driving; re-check at once when someone starts.
  useEffect(() => {
    key.current = '';
    sinceS.current = Infinity;
    if (driver === null) setMap({ shown: all, across: null });
  }, [driver, all]);

  useFrame((_, dt) => {
    if (driver === null) return;
    sinceS.current += dt;
    if (sinceS.current < RECHECK_S) return;
    sinceS.current = 0;
    const v = twin.fleet.vehicles[driver];
    if (!v) return;
    const p = fleetPose(twin.fleet, driver, pose.current);
    const near = stationsNear(all, p.x, p.z);
    const across = near.filter((st) => !canPullIn(st, v.direction)).map((st) => st.id);
    // Only re-render when the set changes, not every second.
    const next = `${near.map((st) => st.id).join(',')}|${across.join(',')}`;
    if (next === key.current) return;
    key.current = next;
    setMap({ shown: near, across: new Set(across) });
  });

  return map;
}
