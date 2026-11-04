/**
 * Side panel for the live map, one tab at a time: the route at a glance and
 * how to change it, the vehicles on it, its stops, a scenario to run, and the
 * assistant.
 */

import type { ChangeEvent } from 'react';
import { operatorTools } from '@/app/agentTools';
import { focusRoute } from '@/app/network';
import { useRuntimes } from '@/app/runtimeContext';
import { sameTarget, useApp } from '@/app/store';
import { twinState } from '@/app/twinState';
import { viewArea } from '@/app/viewArea';
import { dispatch } from '@/core/advisory/dispatch';
import { driverView } from '@/core/advisory/driver';
import { plannerRequest, type PlannerRequest } from '@/core/advisory/plannerSnapshot';
import { driverScreen, operatorScreen, voiceKeywords } from '@/core/advisory/screen';
import { fuelAhead, stationsFor } from '@/core/fuel/stations';
import {
  DEFAULT_ROUTE_ID,
  defaultRoute,
  geographicRoute,
  parseGeoJsonRoute,
  routeToGeoJson,
  syntheticDemoRoute,
} from '@/core/geo/routes';
import type { LiveVehicle } from '@/core/tracking/liveVehicle';
import { KIND_NAME } from '@/core/vehicles/specs';
import { AssistPanel } from './AssistPanel';
import { aroundSpot } from '@/app/locate';
import { AutoAI } from './AutoAI';
import { passengerName } from './PassengerPanel';
import { FleetEarnings } from './FleetEarnings';
import { useTicker } from './useTicker';
import { PassengerPanel } from './PassengerPanel';
import { SimulationPanel } from './SimulationPanel';
import { NetworkSection } from './network/NetworkSection';
import { RouteSearch } from './network/RouteSearch';
import { IncomingStopsPanel } from './IncomingStopsPanel';
import { Fold, PanelTabs, useTab } from './Tabs';

const ROUTE_SOURCE_LABEL = {
  synthetic: 'Synthetic, not a real road',
  osm: 'OpenStreetMap',
  recorded: 'Recorded GPS trace',
} as const;

const TABS = [
  ['overview', 'Overview'],
  ['fleet', 'Fleet'],
  ['stops', 'Stops'],
  ['simulate', 'Simulate'],
  ['ask', 'Ask'],
] as const;

export function TwinPanel() {
  useTicker(2);
  const { twin } = useRuntimes();
  const route = useApp((s) => s.route);
  const setRoute = useApp((s) => s.setRoute);
  const sessions = useApp((s) => s.sessions);
  const follow = useApp((s) => s.follow);
  const tracked = useApp((s) => s.trackedRiderId);
  const requestShot = useApp((s) => s.requestShot);
  const setFollow = useApp((s) => s.setFollow);
  const setView = useApp((s) => s.setView);
  const setFocus = useApp((s) => s.setFocus);
  const otherRoutes = useApp((s) => s.otherRoutes);
  const [tab, setTab] = useTab<(typeof TABS)[number][0]>('twin', 'overview');
  const now = Date.now();

  async function loadGeoJson(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      setRoute(parseGeoJsonRoute(JSON.parse(await file.text()), file.name));
    } catch (err) {
      alert(`Could not load route: ${err instanceof Error ? err.message : err}`);
    }
    e.target.value = '';
  }

  function adoptTraceAsRoute(id: string, v: LiveVehicle) {
    const proj = v.projectionInUse;
    if (!proj || v.trace.length < 2) return;
    // 4 m tolerance removes GPS wobble but keeps every real corner.
    setRoute(
      geographicRoute(
        `rec-${id}`,
        `Recorded: ${sessions[id]?.meta.vehicleId ?? id}`,
        'recorded',
        v.trace.map(proj.toGeo),
        4,
      ),
    );
  }

  const selected = follow?.kind === 'sim' ? twin.fleet.vehicles[follow.index] : undefined;
  // Real phones heard from just now, where they are.
  const sharing = Object.entries(sessions).flatMap(([id, s]) => {
    const v = twin.live.get(id);
    const spot = v?.trace[v.trace.length - 1];
    if (!spot || v.status(now) === 'lost') return [];
    const who =
      s.meta.role === 'commuter' ? 'Commuter' : KIND_NAME[s.meta.vehicleKind ?? 'jeepney'];
    return [{ who, spot }];
  });
  const onBoard = twin.fleet.vehicles.reduce((n, v) => n + v.occupancy, 0);
  const seats = twin.fleet.vehicles.reduce((n, v) => n + v.capacity, 0);
  const waiting = [...twin.crew.passengers.values()].filter((p) => p.phase === 'waiting').length;
  const out = twin.fleet.vehicles.filter((v) => v.duty !== 'parked').length;

  return (
    <div className="panel__body">
      <PanelTabs label="Live map" tabs={TABS} active={tab} onChange={setTab} />
      {/* Only with one vehicle or person selected. */}
      {follow?.kind === 'sim' && selected && (
        <AutoAI subject={{ kind: 'vehicle', index: follow.index }} name={selected.plate} />
      )}
      {tracked !== null && (
        <AutoAI subject={{ kind: 'person', id: tracked }} name={passengerName(tracked)} />
      )}
      {sharing.length > 0 && (
        <section className="section">
          <h3 className="section__title">
            {sharing.length === 1
              ? 'Someone is sharing their location'
              : `${sharing.length} people are sharing their location`}
          </h3>
          <div className="row">
            {sharing.map(({ who, spot }, i) => (
              <button
                key={i}
                type="button"
                className="chip"
                onClick={() => requestShot('area', aroundSpot(spot))}
              >
                {who}
              </button>
            ))}
          </div>
        </section>
      )}

      {tab === 'overview' && (
        <>
          <section className="section">
            {otherRoutes ? (
              <>
                <h3 className="section__title">On screen now: {viewArea.place ?? 'this area'}</h3>
                <div className="stats">
                  <div className="stat">
                    <span className="stat__value">~{viewArea.vehicles.toLocaleString()}</span>
                    <span className="stat__label">Vehicles on screen</span>
                  </div>
                  <div className="stat">
                    <span className="stat__value">~{viewArea.riders.toLocaleString()}</span>
                    <span className="stat__label">Riders on board</span>
                  </div>
                </div>
                <p className="fine">
                  {viewArea.ownVehicles} of your {twin.fleet.vehicles.length} vehicles, plus{' '}
                  {(viewArea.vehicles - viewArea.ownVehicles).toLocaleString()} from other routes.
                  This changes as the view moves. Your fleet does not.
                </p>
                <div className="kv">
                  <span>Jeepneys</span>
                  <span className="mono">~{viewArea.kinds.jeepney.toLocaleString()}</span>
                  <span>Modern jeepneys</span>
                  <span className="mono">~{viewArea.kinds.modern.toLocaleString()}</span>
                  <span>Buses</span>
                  <span className="mono">~{viewArea.kinds.bus.toLocaleString()}</span>
                  <span>UV Express</span>
                  <span className="mono">~{viewArea.kinds.uv.toLocaleString()}</span>
                </div>
                {viewArea.routes.length > 0 && (
                  <ul className="route-search__results" aria-label="Routes in view">
                    {viewArea.routes.map((r) => (
                      <li key={r.route}>
                        <button
                          type="button"
                          className="route-search__item route-search__item--stack"
                          onClick={() => setFocus(focusRoute(r.route, twin))}
                        >
                          <span>{r.name}</span>
                          <span className="mono">~{r.vehicles} vehicles here · simulate it</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </>
            ) : (
              <p className="fine">
                Other routes are hidden, so this panel cannot read the area in view. Turn them on
                under More, on the map.
              </p>
            )}
          </section>
          <section className="section">
            <h3 className="section__title">Your fleet: {route.name}</h3>
            <p className="fine">
              {(route.polyline.length / 1000).toFixed(1)} km{route.loop ? ' loop' : ''} ·{' '}
              {route.stops.length} stops
            </p>
            <div className="stats">
              <div className="stat">
                <span className="stat__value">
                  {out} / {twin.fleet.vehicles.length}
                </span>
                <span className="stat__label">Vehicles out</span>
              </div>
              <div className="stat">
                <span className="stat__value">{onBoard}</span>
                <span className="stat__label">Riders on board</span>
              </div>
              <div className="stat">
                <span className="stat__value">{waiting}</span>
                <span className="stat__label">Waiting at stops</span>
              </div>
              <div className="stat">
                <span className="stat__value">
                  {Math.round((100 * onBoard) / Math.max(1, seats))}%
                </span>
                <span className="stat__label">Full</span>
              </div>
            </div>
          </section>
          <section className="section">
            <h3 className="section__title">Change route</h3>
            <RouteSearch />
          </section>
          <NetworkSection />
          <section className="section">
            <button type="button" className="btn" onClick={() => setView('economics')}>
              Open the Profit &amp; service lab
            </button>
          </section>
        </>
      )}

      {tab === 'fleet' && (
        <>
          <section className="section">
            <h3 className="section__title">Vehicles on this route</h3>
            <div className="fleet-grid" role="list" aria-label="Simulated vehicles">
              {twin.fleet.vehicles.map((v, index) => {
                const active = follow?.kind === 'sim' && follow.index === index;
                return (
                  <button
                    key={v.id}
                    type="button"
                    className={`btn fleet-item ${active ? 'btn--primary' : ''}`}
                    aria-pressed={active}
                    title={KIND_NAME[v.kind]}
                    onClick={() =>
                      setFollow(
                        active ? null : { kind: 'sim', index, view: follow?.view ?? 'chase' },
                      )
                    }
                  >
                    <i className={`livery livery--${v.livery}`} aria-hidden="true" />
                    <span className="mono">{v.plate}</span>
                    <span className="mono fleet-item__occ">
                      {v.occupancy}/{v.capacity}
                    </span>
                  </button>
                );
              })}
            </div>
            <p className="fine">Pick one here or on the map to ride along with it.</p>
          </section>
          <FleetEarnings />
          <section className="section">
            <Fold title="Passenger journeys">
              <PassengerPanel />
            </Fold>
          </section>
          <section className="section">
            <Fold title={`Phones on the road (${Object.keys(sessions).length})`}>
              {Object.keys(sessions).length === 0 && (
                <p className="fine">
                  No phone connected. Open{' '}
                  <a href="/track.html" target="_blank" rel="noreferrer">
                    the phone tracker
                  </a>{' '}
                  on a phone and start a session.
                </p>
              )}
              {Object.entries(sessions).map(([id, s]) => {
                const v = twin.live.get(id);
                if (!v) return null;
                const status = v.status(now);
                const ageS = v.lastFix ? Math.round((now - v.lastFix.timestamp) / 1000) : null;
                return (
                  <article key={id} className={`session session--${status}`}>
                    <header className="session__head">
                      <b className="mono">{s.meta.vehicleId}</b>
                      <span
                        className={`chip chip--${status === 'live' ? 'good' : status === 'stale' ? 'warn' : 'neutral'}`}
                      >
                        {status === 'live'
                          ? 'Live'
                          : `${status === 'stale' ? 'Stale' : 'Lost'} · ${ageS}s ago`}
                      </span>
                    </header>
                    <div className="kv">
                      <span>Trip</span>
                      <span>{s.trip.replace('_', ' ').toLowerCase()}</span>
                      <span>Speed</span>
                      <span className="mono">{(v.speedMps * 3.6).toFixed(0)} km/h</span>
                      <span>GPS accuracy</span>
                      <span className="mono">±{v.lastFix?.accuracyM.toFixed(0) ?? '–'} m</span>
                      <span>On route</span>
                      <span className="mono">
                        {route.projection
                          ? v.matched
                            ? `yes, ${v.offsetM.toFixed(0)} m off centre`
                            : 'no'
                          : 'no geographic route'}
                      </span>
                      <span>Fixes</span>
                      <span className="mono">{v.trace.length}</span>
                    </div>
                    <p className="fine">
                      {s.meta.source === 'passenger-consented'
                        ? 'Phone-observed: shows where this phone is. Which vehicle it is in is the rider’s confirmation, not a measurement.'
                        : 'Driver device registered to this vehicle.'}
                    </p>
                    <div className="row">
                      <button
                        type="button"
                        className="btn btn--primary"
                        onClick={() =>
                          setFollow(
                            sameTarget(follow, { kind: 'live', id }) ? null : { kind: 'live', id },
                          )
                        }
                      >
                        {sameTarget(follow, { kind: 'live', id }) ? 'Stop following' : 'Follow'}
                      </button>
                      <button
                        type="button"
                        className="btn"
                        disabled={v.trace.length < 10}
                        onClick={() => adoptTraceAsRoute(id, v)}
                      >
                        Use trace as route
                      </button>
                    </div>
                  </article>
                );
              })}
            </Fold>
          </section>
        </>
      )}

      {tab === 'stops' && (
        <>
          <IncomingStopsPanel />
          <section className="section">
            <Fold title={`All ${route.stops.length} stops`}>
              {route.stopsSource !== 'placeholder' && (
                <ol className="stop-list">
                  {route.stops.map((stop) => (
                    <li key={stop.s} className={stop.terminal ? 'stop-list__terminal' : undefined}>
                      <span>
                        {stop.name}
                        {stop.terminal
                          ? ' (terminal)'
                          : route.loop && stop.towards
                            ? ` → ${stop.towards}`
                            : ''}
                      </span>
                      <span className="mono">{(stop.s / 1000).toFixed(1)} km</span>
                    </li>
                  ))}
                </ol>
              )}
              <p className="fine">
                {route.stopsSource === 'osm'
                  ? 'Stops from OpenStreetMap.'
                  : route.stopsSource === 'gtfs'
                    ? 'Stops from the DOTC GTFS, 2015.'
                    : 'Evenly spaced placeholder stops.'}
              </p>
            </Fold>
          </section>
          <section className="section">
            <Fold title="Route file">
              <div className="kv">
                <span>Source</span>
                <span>{ROUTE_SOURCE_LABEL[route.source]}</span>
              </div>
              {route.note && <p className="fine">{route.note}</p>}
              <div className="row">
                <label className="btn">
                  Load route file…
                  <input
                    type="file"
                    accept=".json,.geojson,application/geo+json"
                    hidden
                    onChange={loadGeoJson}
                  />
                </label>
                {route.source !== 'synthetic' && (
                  <button
                    type="button"
                    className="btn"
                    onClick={() => download(`${route.id}.geojson`, routeToGeoJson(route))}
                  >
                    Download
                  </button>
                )}
                {route.id !== DEFAULT_ROUTE_ID ? (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => setRoute(defaultRoute())}
                  >
                    Tungko – Fairview
                  </button>
                ) : (
                  <button
                    type="button"
                    className="btn btn--ghost"
                    onClick={() => setRoute(syntheticDemoRoute())}
                  >
                    Offline demo road
                  </button>
                )}
              </div>
              {route.source === 'synthetic' && (
                <p className="fine">
                  Offline demo: no map and no real road, so live GPS cannot be matched. Switch back
                  to Tungko – Fairview, load a route file, or ride once and use the trace as the
                  route.
                </p>
              )}
            </Fold>
          </section>
        </>
      )}

      {/* A newly focused route brings its own scenario: start the form from it. */}
      {tab === 'simulate' && <SimulationPanel key={route.id} />}

      {tab === 'ask' && (
        <AssistPanel
          about={follow?.kind === 'sim' ? (twin.fleet.vehicles[follow.index]?.plate ?? null) : null}
          keywords={voiceKeywords(twin.route)}
          agent={{
            role: 'operator',
            run: operatorTools(twin),
            screen: () => {
              const state = twinState(twin);
              return operatorScreen(state, dispatch(state));
            },
          }}
          request={(): PlannerRequest => {
            const state = twinState(twin);
            const plan = dispatch(state);
            const v = follow?.kind === 'sim' ? state.vehicles[follow.index] : undefined;
            // The selected vehicle: what its driver's app would send.
            if (v) {
              const at = { s: v.s, direction: v.direction, x: v.x, z: v.z };
              return {
                ...plannerRequest(state, { role: 'driver', vehicle: v.index }),
                screen: driverScreen(
                  driverView(state, v.index, plan),
                  fuelAhead(twin.route, stationsFor(twin.route), at),
                ),
              };
            }
            return {
              ...plannerRequest(state, { role: 'operator' }),
              screen: operatorScreen(state, plan),
            };
          }}
        />
      )}
    </div>
  );
}

function download(filename: string, data: object): void {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/geo+json' }),
  );
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}
