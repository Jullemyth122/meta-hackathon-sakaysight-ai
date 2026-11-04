/**
 * Over the 3D view: how fast the vehicle being followed is going, whichever
 * one was clicked, and the way between it and the shortcut Muse found.
 */

import { useRuntimes } from '@/app/runtimeContext';
import { useApp } from '@/app/store';
import type { TwinRuntime } from '@/app/twinRuntime';
import { KIND_NAME } from '@/core/vehicles/specs';
import { useTicker } from './useTicker';

interface Riding {
  name: string;
  mps: number;
}

/** The simulated vehicle `index`; standing still at the pumps or parked. */
function simulated(twin: TwinRuntime, index: number): Riding | null {
  const v = twin.fleet.vehicles[index];
  if (!v) return null;
  const still = v.duty === 'parked' || v.currentStop !== null;
  return { name: `${v.plate} · ${KIND_NAME[v.kind]}`, mps: still ? 0 : v.speedMps };
}

export function RideHud() {
  useTicker(4);
  const { twin } = useRuntimes();
  const view = useApp((s) => s.view);
  const follow = useApp((s) => s.follow);
  const tracked = useApp((s) => s.trackedRiderId);
  const agentWay = useApp((s) => s.agentWay);
  const agentWays = useApp((s) => s.agentWays);
  const driverVehicle = useApp((s) => s.driverVehicle);
  const setFollow = useApp((s) => s.setFollow);
  const requestShot = useApp((s) => s.requestShot);

  const onBoard = tracked === null ? null : twin.crew.passengers.get(tracked)?.vehicleId;
  const live = follow?.kind === 'live' ? twin.live.get(follow.id) : undefined;
  const riding: Riding | null =
    follow?.kind === 'sim'
      ? simulated(twin, follow.index)
      : live
        ? { name: 'Live vehicle', mps: live.speedMps }
        : onBoard !== null && onBoard !== undefined
          ? simulated(twin, onBoard)
          : null;
  const backToVehicle = view === 'driver' && !follow;
  if (!riding && !backToVehicle) return null;

  return (
    <div className="ride-hud" role="status">
      {riding && (
        <div className="ride-hud__speed">
          <strong className="mono">{Math.round(riding.mps * 3.6)}</strong>
          <span>km/h</span>
          <small>{riding.name}</small>
        </div>
      )}
      {backToVehicle && (
        <button
          type="button"
          className="btn"
          onClick={() => setFollow({ kind: 'sim', index: driverVehicle, view: 'chase' })}
        >
          Back to my vehicle
        </button>
      )}
      {view === 'driver' && follow && (agentWays || agentWay) && (
        <button
          type="button"
          className="btn"
          onClick={() =>
            requestShot('area', agentWays ? agentWays.flatMap((w) => w.points) : agentWay!.points)
          }
        >
          {agentWays ? 'See the ways on the map' : 'See the way on the map'}
        </button>
      )}
    </div>
  );
}
