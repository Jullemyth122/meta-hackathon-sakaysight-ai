/**
 * Overlay on the twin viewport: camera shots, ride-along, the operator's data
 * for every jeepney, map status and the map data credit (required by
 * OpenStreetMap's licence and OpenFreeMap's terms).
 */

import { clockText } from '@/app/earnings';
import { useRuntimes } from '@/app/runtimeContext';
import { jeepneyStatus } from '@/app/status';
import { KIND_NAME } from '@/core/vehicles/specs';
import { SPEEDS, useApp } from '@/app/store';
import { MAX_DAYS } from '@/app/twinRuntime';
import { FleetData } from './FleetData';
import { Menu, MenuItem } from './Menu';
import { useTicker } from './useTicker';

export function ViewControls() {
  const { twin } = useRuntimes();
  const follow = useApp((s) => s.follow);
  const setFollow = useApp((s) => s.setFollow);
  const requestShot = useApp((s) => s.requestShot);
  const fleetData = useApp((s) => s.fleetData);
  const hasMap = useApp((s) => s.map.state !== 'off');
  const count = twin.fleet.vehicles.length;
  const looks = [
    ['chase', 'Outside'],
    ['pov', 'Front'],
    ['inside', 'Inside'],
  ] as const;

  const view = follow?.view ?? 'chase';
  // The next jeepney out on the road: a parked one is not drawn, so riding it
  // would show an empty street. At night, when all are parked, any will do.
  const rideNext = () => {
    const from = follow?.kind === 'sim' ? follow.index + 1 : 0;
    const order = Array.from({ length: count }, (_, k) => (from + k) % count);
    const index = order.find((i) => twin.fleet.vehicles[i]?.duty !== 'parked') ?? order[0] ?? 0;
    setFollow({ kind: 'sim', index, view });
  };

  return (
    <>
      <div className="view-hud">
        <div className="view-controls" role="toolbar" aria-label="Camera">
          {!follow && (
            <div className="seg" role="group" aria-label="Camera">
              <button type="button" onClick={() => requestShot('overview')}>
                Whole route
              </button>
              <button type="button" onClick={() => requestShot('street')}>
                Street
              </button>
            </div>
          )}
          <select
            className="btn view-controls__select"
            aria-label="Choose a vehicle to monitor"
            value={follow?.kind === 'sim' ? String(follow.index) : ''}
            onChange={(e) => {
              const val = e.target.value;
              if (val === '') setFollow(null);
              else setFollow({ kind: 'sim', index: Number(val), view });
            }}
          >
            <option value="">Choose a vehicle…</option>
            {twin.fleet.vehicles.map((v, i) => (
              <option key={v.id} value={i}>
                {v.plate}
                {v.kind !== 'jeepney' && ` · ${KIND_NAME[v.kind]}`} (
                {v.duty === 'parked' ? 'parked' : `${v.occupancy}/${v.capacity}`})
              </option>
            ))}
          </select>
          <button
            type="button"
            className={`btn ${follow ? '' : 'btn--primary'}`}
            onClick={rideNext}
          >
            {follow?.kind === 'sim' ? 'Next' : 'Ride along'}
          </button>
          {follow && (
            <div className="seg" role="group" aria-label="Camera view">
              {looks.map(([look, name]) => (
                <button
                  key={look}
                  type="button"
                  aria-pressed={view === look}
                  onClick={() => setFollow({ ...follow, view: look })}
                >
                  {name}
                </button>
              ))}
            </div>
          )}
          {follow && (
            <button
              type="button"
              className="btn"
              aria-label="Stop following"
              title="Stop following"
              onClick={() => setFollow(null)}
            >
              ✕
            </button>
          )}
        </div>
        {follow?.kind === 'sim' && <RideCard index={follow.index} />}
      </div>
      <SimDock operator cone={follow?.kind === 'sim' && view === 'chase'} />
      {fleetData && <FleetData />}
      {hasMap && (
        <div className="map-credit">
          ©{' '}
          <a href="https://openfreemap.org" target="_blank" rel="noreferrer">
            OpenFreeMap
          </a>{' '}
          ©{' '}
          <a href="https://www.openmaptiles.org/" target="_blank" rel="noreferrer">
            OpenMapTiles
          </a>{' '}
          Data ©{' '}
          <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">
            OpenStreetMap contributors
          </a>
        </div>
      )}
    </>
  );
}

/**
 * The simulated day, bottom left of the map: the day and time, how fast it
 * runs (up to 300×), skipping nights; for the operator (and the driver,
 * `fuel`) who is going for diesel; for the operator also the other routes
 * and every jeepney's data. The phone apps (driver, commuter) show
 * it too, so a ride can be fast-forwarded there as well.
 */
export function SimDock({
  operator = false,
  fuel = operator,
  cone = false,
}: {
  operator?: boolean;
  fuel?: boolean;
  /** Offer the cabin camera's cone: riding along, seen from outside. */
  cone?: boolean;
}) {
  const speed = useApp((s) => s.simulationSpeed);
  const setSpeed = useApp((s) => s.setSimulationSpeed);
  const skipNight = useApp((s) => s.skipNight);
  const setSkipNight = useApp((s) => s.setSkipNight);
  const otherRoutes = useApp((s) => s.otherRoutes);
  const setOtherRoutes = useApp((s) => s.setOtherRoutes);
  const fleetData = useApp((s) => s.fleetData);
  const setFleetData = useApp((s) => s.setFleetData);
  const showFov = useApp((s) => s.showFov);
  const setShowFov = useApp((s) => s.setShowFov);
  return (
    <div className="view-dock">
      <MapStatusChip />
      <div className="view-dock__row" role="toolbar" aria-label="Simulation">
        <DayClock />
        <select
          className="btn"
          aria-label="Simulation speed"
          title="How fast the simulated day runs"
          value={speed}
          onChange={(e) => setSpeed(Number(e.target.value))}
        >
          {SPEEDS.map((n) => (
            <option key={n} value={n}>
              {n === 0 ? 'Paused' : `Speed ${n}×`}
            </option>
          ))}
        </select>
        <Menu label="More">
          <MenuItem
            label="Skip nights"
            state={skipNight ? 'On' : 'Off'}
            title="While every vehicle is parked at night, run the clock fast to the morning"
            onClick={() => setSkipNight(!skipNight)}
          />
          {operator && (
            <MenuItem
              label="Other routes"
              state={otherRoutes ? 'Shown' : 'Hidden'}
              title="The other routes' vehicles (estimated) on the map, around the route simulated in full"
              onClick={() => setOtherRoutes(!otherRoutes)}
            />
          )}
          {cone && (
            <MenuItem
              label="Camera cone"
              state={showFov ? 'Shown' : 'Hidden'}
              onClick={() => setShowFov(!showFov)}
            />
          )}
          {operator && (
            <MenuItem
              label="All vehicles data"
              state={fleetData ? 'Open' : ''}
              onClick={() => setFleetData(!fleetData)}
            />
          )}
          {fuel && <FuelItem />}
        </Menu>
      </div>
    </div>
  );
}

/**
 * The fleet's diesel at a glance: how many vehicles are at a station now (in
 * line or at the pumps), and how many are on their way to one. Clicking
 * rides along with one (at a station first), to watch it pull in, fill up
 * and go on.
 */
function FuelItem() {
  useTicker(2);
  const { twin } = useRuntimes();
  const setFollow = useApp((s) => s.setFollow);
  const out = twin.fleet.vehicles.filter((v) => (v.refuel || v.yard) && v.duty !== 'parked');
  const there = out.filter((v) => v.yard && !v.yard.full);
  const going = out.filter((v) => !v.yard).length;
  const next =
    [...there].sort((a, b) => a.yard!.u - b.yard!.u)[0] ??
    [...out].sort((a, b) => a.tankL - b.tankL)[0];
  return (
    <MenuItem
      label="Ride with one getting diesel"
      state={next ? `${there.length} there · ${going} going` : 'None yet'}
      disabled={!next}
      title="Below a quarter of a tank, a vehicle fills up at the next station on its side of the road."
      onClick={() => next && setFollow({ kind: 'sim', index: next.id, view: 'chase' })}
    />
  );
}

/** What the followed simulated jeepney is doing right now. */
function RideCard({ index }: { index: number }) {
  useTicker(4);
  const { twin } = useRuntimes();
  const v = twin.fleet.vehicles[index];
  if (!v) return null;
  const next = twin.route.stops[v.nextStop];
  const feed = twin.cabinFeed;
  const camera = feed.pipeline?.telemetry(feed.clockMs);
  return (
    <div className="ride-card">
      <span className="ride-card__title">
        <i className={`livery livery--${v.livery}`} aria-hidden="true" />
        <b className="mono">{v.plate}</b>
        {v.kind !== 'jeepney' && <span className="chip">{KIND_NAME[v.kind]}</span>}
      </span>
      <span className="kv">
        <span>Speed</span>
        <span className="mono">{(v.speedMps * 3.6).toFixed(0)} km/h</span>
        <span>On board</span>
        <span className="mono">
          {v.occupancy} / {v.capacity}
          {v.occupancy > v.seats &&
            ` · ${v.occupancy - v.seats} ${v.kind === 'jeepney' ? 'sabit' : 'standing'}`}
        </span>
        <span>Camera estimate</span>
        <span className={`mono ${camera && camera.counts.current !== v.occupancy ? 'warn' : ''}`}>
          {camera
            ? `${camera.counts.current} (sees ${camera.tracks.length} ${'door' in camera.view ? 'heads' : 'at the door'})`
            : '–'}
        </span>
        <span>Status</span>
        <span>{jeepneyStatus(twin, v)}</span>
        <span>Diesel in tank</span>
        <span className="mono">
          {v.tankL.toFixed(0)} of {v.tankCapacityL.toFixed(0)} L
        </span>
        <span>{v.currentStop === null ? 'Next stop' : 'At stop'}</span>
        <span>
          {v.currentStop === null ? (next?.name ?? '–') : twin.route.stops[v.currentStop]?.name}
        </span>
      </span>
    </div>
  );
}

/** Which day of the month it is in the simulation, and the time: what the ledger runs on. */
function DayClock() {
  useTicker(2);
  const { twin } = useRuntimes();
  const skipNight = useApp((s) => s.skipNight);
  const speed = useApp((s) => s.simulationSpeed);
  const day = Math.min(twin.fleet.dayNumber, MAX_DAYS);
  const note = twin.finished
    ? ` · all ${MAX_DAYS} days done`
    : twin.night
      ? skipNight && speed > 0
        ? ' · night, skipping to morning'
        : ' · night, all parked'
      : '';
  return (
    <span className="chip day-clock" title="Simulated day of the month and time">
      Day {day} · {clockText(twin.clockS).slice(0, 5)}
      {note}
    </span>
  );
}

function MapStatusChip() {
  const map = useApp((s) => s.map);
  if (map.state === 'ready' || map.state === 'off') return null;
  const text =
    map.state === 'loading'
      ? `Loading 3D map ${map.loaded}/${map.total}`
      : map.state === 'partial'
        ? `Map partly loaded (${map.loaded}/${map.total})`
        : 'Map unavailable (offline?). The route and fleet still work.';
  return (
    <div className={`chip ${map.state === 'loading' ? '' : 'chip--warn'}`} title={map.message}>
      {text}
    </div>
  );
}
