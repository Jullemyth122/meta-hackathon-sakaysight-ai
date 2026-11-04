/**
 * The simulated fleet and its riders, drawn from FleetSim state every frame:
 * the traditional jeepneys, and the few modern jeepneys, UV Express vans and
 * buses among them, each kind with its own model.
 */

import { useCallback, useMemo } from 'react';
import { MAX_SIMULATED } from '@/app/network';
import { useApp } from '@/app/store';
import type { FleetSim } from '@/core/fleet/fleetSim';
import type { CrewState } from '../jeepney/crewState';
import { JeepneyInstances, type GroundPose } from '../jeepney/JeepneyInstances';
import { PuvInstances } from '../vehicles/PuvInstances';
import { fleetPose } from './lanes';

export function Fleet({ fleet, crew }: { fleet: FleetSim; crew: CrewState }) {
  const setFollow = useApp((s) => s.setFollow);
  // The same slots for every route: focusing another one builds nothing again.
  const capacity = Math.max(MAX_SIMULATED, fleet.vehicles.length);
  const liveries = useMemo(() => fleet.vehicles.map((v) => v.livery), [fleet]);
  const poseAt = useCallback((i: number, out: GroundPose) => fleetPose(fleet, i, out), [fleet]);
  // The other kinds draw themselves (PuvInstances). Parked ones are drawn
  // where they are kept (lanes.fleetPose), with nobody at the wheel.
  const hidden = useCallback((i: number) => fleet.vehicles[i]?.kind !== 'jeepney', [fleet]);
  const driverless = useCallback((i: number) => fleet.vehicles[i]?.duty === 'parked', [fleet]);
  const handleSelect = useCallback(
    (index: number, part: 'front' | 'body') => {
      const cur = useApp.getState().follow;
      const same = cur?.kind === 'sim' && cur.index === index;
      const view = part === 'front' && (same || cur !== null) ? 'pov' : 'chase';
      setFollow({ kind: 'sim', index, view });
    },
    [setFollow],
  );

  return (
    <>
      <JeepneyInstances
        count={fleet.vehicles.length}
        capacity={capacity}
        liveries={liveries}
        poseAt={poseAt}
        crew={crew}
        scaleWithView
        onSelect={handleSelect}
        hidden={hidden}
        driverless={driverless}
      />
      {(['modern', 'uv', 'bus'] as const).map((kind) => (
        <PuvInstances
          key={kind}
          fleet={fleet}
          crew={crew}
          kind={kind}
          capacity={capacity}
          onSelect={handleSelect}
        />
      ))}
    </>
  );
}
