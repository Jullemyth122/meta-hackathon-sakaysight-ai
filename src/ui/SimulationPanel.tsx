import { useState } from 'react';
import { useRuntimes } from '@/app/runtimeContext';
import { useApp } from '@/app/store';
import { MAX_DAYS } from '@/app/twinRuntime';
import {
  FLEET_KINDS,
  MAX_SCENARIO_TRIPS,
  MAX_SCENARIO_VEHICLES,
  mixTotal,
  normalizeScenario,
  RIDERS_PER_JEEPNEY_PER_DAY,
  SCENARIOS,
  type FleetMix,
  type SimulationScenario,
} from '@/core/fleet/scenario';
import { fleetKinds, type FleetKind } from '@/core/vehicles/specs';
import { Fold } from './Tabs';
import { useTicker } from './useTicker';

const KIND_NAMES: Record<FleetKind, string> = {
  jeepney: 'Jeepneys',
  modern: 'Modern jeepneys',
  uv: 'UV Express',
  bus: 'Buses',
};

const TRAFFIC_SHARES = [
  [1, 'All of it'],
  [0.5, 'Half'],
  [0.25, 'A quarter'],
  [0.1, 'A tenth'],
  [0, 'None'],
] as const;

export function SimulationPanel() {
  useTicker(2);
  const { twin } = useRuntimes();
  const active = useApp((s) => s.scenario);
  const apply = useApp((s) => s.setScenario);
  const trafficShare = useApp((s) => s.trafficShare);
  const setTrafficShare = useApp((s) => s.setTrafficShare);
  const [draft, setDraft] = useState<SimulationScenario>(active);
  // Until one is chosen by hand, the route's usual mix for that many vehicles.
  const shownMix: FleetMix =
    draft.mix ??
    fleetKinds(draft.vehicles, twin.route.kind, twin.route.mix).reduce(
      (mix, kind) => ({ ...mix, [kind]: mix[kind] + 1 }),
      { jeepney: 0, modern: 0, uv: 0, bus: 0 },
    );
  const setKind = (kind: FleetKind, value: string) => {
    const mix = { ...shownMix, [kind]: Math.max(0, Math.round(Number(value) || 0)) };
    const vehicles = mixTotal(mix);
    setDraft({ ...draft, mix, vehicles, dailyTrips: vehicles * RIDERS_PER_JEEPNEY_PER_DAY });
  };
  const change = (key: 'dailyTrips' | 'startHour' | 'seed', value: string) =>
    // A start hour typed in starts on the hour (the presets may start at 4:30).
    setDraft({ ...draft, [key]: Number(value), ...(key === 'startHour' && { startOffsetS: 0 }) });
  const clock = Math.floor(twin.fleet.timeOfDay);
  const waiting = twin.fleet.waiting.reduce((a, b) => a + b, 0);
  const onboard = twin.fleet.vehicles.reduce((n, v) => n + v.occupancy, 0);
  const seats = twin.fleet.vehicles.reduce((n, v) => n + v.capacity, 0);
  const stats = twin.crew.metrics;
  const longest = [...twin.crew.passengers.values()].reduce(
    (max, r) =>
      r.phase === 'waiting'
        ? Math.max(
            max,
            twin.fleet.elapsedS - (r.history.find((h) => h.phase === 'waiting')?.at ?? 0),
          )
        : max,
    0,
  );
  return (
    <section className="section simulation-panel" aria-label="Simulation scenario">
      <h3 className="section__title">Run a scenario</h3>
      <p className="fine">
        These numbers are for the route you are on, {twin.route.name}. A fleet you choose goes with
        you to every route you open. Up to {MAX_SCENARIO_VEHICLES} vehicles and{' '}
        {MAX_SCENARIO_TRIPS.toLocaleString()} trips; fewer vehicles run faster.
      </p>
      <div className="row">
        {SCENARIOS.map((p) => (
          <button key={p.name} className="btn" onClick={() => setDraft({ ...p.values })}>
            {p.name}
          </button>
        ))}
      </div>
      <div className="simulation-fields">
        {FLEET_KINDS.map((kind) => (
          <label key={kind}>
            {KIND_NAMES[kind]}
            <input
              type="number"
              min={0}
              max={MAX_SCENARIO_VEHICLES}
              value={shownMix[kind]}
              onChange={(e) => setKind(kind, e.target.value)}
            />
          </label>
        ))}
        <label className="simulation-fields__wide">
          Expected trips / day
          <input
            type="number"
            min={0}
            max={MAX_SCENARIO_TRIPS}
            step={1000}
            value={draft.dailyTrips}
            onChange={(e) => change('dailyTrips', e.target.value)}
          />
        </label>
        <label className="simulation-fields__wide">
          Demand pattern
          <select
            value={draft.profile}
            onChange={(e) =>
              setDraft({ ...draft, profile: e.target.value as SimulationScenario['profile'] })
            }
          >
            <option value="commute">Morning &amp; evening peaks</option>
            <option value="flat">Uniform all day</option>
          </select>
        </label>
        <label>
          Start hour (0–23)
          <input
            type="number"
            min={0}
            max={23}
            value={draft.startHour}
            onChange={(e) => change('startHour', e.target.value)}
          />
        </label>
        <label>
          Random seed
          <input
            type="number"
            min={1}
            max={2147483647}
            value={draft.seed}
            onChange={(e) => change('seed', e.target.value)}
          />
        </label>
      </div>
      <p className="fine">{mixTotal(shownMix)} vehicles in all.</p>
      <button
        className="btn btn--primary"
        onClick={() => {
          const next = normalizeScenario(draft);
          setDraft(next);
          apply(next);
        }}
      >
        Start / restart scenario
      </button>
      <div className="simulation-fields">
        <label className="simulation-fields__wide">
          Traffic on other routes
          <select value={trafficShare} onChange={(e) => setTrafficShare(Number(e.target.value))}>
            {TRAFFIC_SHARES.map(([share, name]) => (
              <option key={share} value={share}>
                {name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <h3 className="section__title">Results so far</h3>
      <div className="kv">
        <span>Simulation clock</span>
        <span className="mono">
          Day {Math.min(twin.fleet.dayNumber, MAX_DAYS)} ·{' '}
          {String(Math.floor(clock / 3600)).padStart(2, '0')}:
          {String(Math.floor(clock / 60) % 60).padStart(2, '0')}
        </span>
        <span>Active scenario</span>
        <span>
          {twin.fleet.vehicles.length} vehicles · {active.dailyTrips.toLocaleString()} trips/day
        </span>
        <span>New arrivals</span>
        <span>{twin.fleet.generatedDemand}</span>
        <span>Waiting / approaching</span>
        <span>{waiting}</span>
        <span>Longest current wait</span>
        <span>{(longest / 60).toFixed(1)} min</span>
        <span>Average wait to board</span>
        <span>
          {stats.boarded
            ? `${(stats.waitSeconds / stats.boarded / 60).toFixed(1)} min`
            : 'No boardings yet'}
        </span>
        <span>Boarded / got off</span>
        <span>
          {stats.boarded} / {stats.alighted}
        </span>
        <span>Reached destination</span>
        <span>{stats.completed}</span>
        <span>Seats occupied</span>
        <span>
          {onboard} / {seats} ({seats ? Math.round((onboard / seats) * 100) : 0}%)
        </span>
      </div>
      <Fold title="How this works">
        <p className="fine">
          Presets are synthetic assumptions, not measured traffic, sized to the 10–15 riders on
          board seen on Metro Manila jeepneys. Starting restarts trips and results. Arrivals follow
          the time of day, terminals draw three times an ordinary stop, and the first five minutes
          of riders are already waiting.
        </p>
        <p className="fine">
          Queues are not capped. Average wait covers boarded passengers; longest wait shows people
          still waiting. Live GPS stays on real time. Speed and pause are on the map, bottom left.
        </p>
      </Fold>
    </section>
  );
}
