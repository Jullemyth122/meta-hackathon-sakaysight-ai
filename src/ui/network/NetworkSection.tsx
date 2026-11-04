/**
 * The operator's view of the whole Metro Manila network: how many routes
 * and jeepneys, how full they run now (estimated from the flows), the
 * focused route, and a search to focus another.
 */

import { useEffect, useState } from 'react';
import { flowOf, getNetwork, routeIndex } from '@/app/network';
import { useRuntimes } from '@/app/runtimeContext';
import { useApp } from '@/app/store';
import { Fold } from '../Tabs';

/** How often the network-wide totals are worked out again (real time). */
const TOTALS_EVERY_MS = 5_000;

/** Tens of thousands of vehicles: every this-many-th stands for the rest in the totals. */
const SAMPLE_EVERY = 4;

/** Network-wide totals at clock t: cheap enough every few seconds (flows are formulas). */
function totals(t: number) {
  const network = getNetwork();
  if (!network) return null;
  let jeepneys = 0;
  let out = 0;
  let riders = 0;
  let seats = 0;
  network.routes.forEach((_, i) => {
    const flow = flowOf(i);
    jeepneys += flow.count;
    for (let k = i % SAMPLE_EVERY; k < flow.count; k += SAMPLE_EVERY) {
      const v = flow.vehicle(k, t);
      if (!v.inService) continue;
      out += SAMPLE_EVERY;
      riders += v.occupancy * SAMPLE_EVERY;
      seats += v.capacity * SAMPLE_EVERY;
    }
  });
  return {
    /** The simulated time these totals are for. */
    at: t,
    routes: network.routes.length,
    inFeed: network.routesInFeed,
    jeepneys,
    out,
    riders,
    seatsPct: seats ? Math.round((100 * riders) / seats) : 0,
  };
}

export function NetworkSection() {
  const { twin } = useRuntimes();
  const status = useApp((s) => s.network);
  const ready = status.state === 'ready';
  // Totals over every route's jeepneys: worked out every TOTALS_EVERY_MS of
  // real time, whatever the simulation speed and however often the panel
  // around this re-renders.
  const [latest, setLatest] = useState<ReturnType<typeof totals>>(null);
  useEffect(() => {
    if (!ready) return;
    const update = () => setLatest(totals(twin.clockS));
    update();
    const id = window.setInterval(update, TOTALS_EVERY_MS);
    return () => window.clearInterval(id);
  }, [ready, twin]);
  const sum = ready ? latest : null;
  const focused = routeIndex(twin.route.id);
  const meta = focused >= 0 ? getNetwork()?.routes[focused]?.meta : undefined;
  const hour = Math.floor((sum?.at ?? twin.clockS) / 3600) % 24;
  const minute = Math.floor(((sum?.at ?? twin.clockS) % 3600) / 60);
  // How often one passes a stop: the loop shared out among the jeepneys on
  // the road, at the speed they are making now, standing ones included.
  const out = twin.fleet.vehicles.filter((v) => v.duty !== 'parked');
  const mps = Math.max(0.5, out.reduce((n, v) => n + v.speedMps, 0) / Math.max(1, out.length));
  const passEveryMin = twin.route.polyline.length / Math.max(1, out.length) / mps / 60;

  return (
    <section className="section">
      <h3 className="section__title">All of Metro Manila</h3>
      {status.state === 'loading' && <p className="fine">Loading the network…</p>}
      {status.state === 'error' && <p className="error">Network not loaded: {status.message}</p>}
      {sum && (
        <>
          <div className="stats">
            <div className="stat">
              <span className="stat__value">{sum.routes.toLocaleString()}</span>
              <span className="stat__label">Routes</span>
            </div>
            <div className="stat">
              <span className="stat__value">{sum.out.toLocaleString()}</span>
              <span className="stat__label">Vehicles out now</span>
            </div>
            <div className="stat">
              <span className="stat__value">~{sum.riders.toLocaleString()}</span>
              <span className="stat__label">Riders on board</span>
            </div>
            <div className="stat">
              <span className="stat__value">{sum.seatsPct}%</span>
              <span className="stat__label">Full</span>
            </div>
          </div>
          <Fold title="About these numbers">
            <div className="kv">
              {meta && (
                <>
                  <span>This route</span>
                  <span className="mono">
                    {out.length === 0
                      ? 'none out at this hour'
                      : `one about every ${passEveryMin.toFixed(1)} min`}
                  </span>
                </>
              )}
              <span>Routes in the GTFS feed</span>
              <span className="mono">{sum.inFeed.toLocaleString()}</span>
              <span>Vehicles, all routes</span>
              <span className="mono">
                ~{sum.jeepneys.toLocaleString()} (about{' '}
                {Math.round(sum.jeepneys / Math.max(1, sum.routes))} a route)
              </span>
              <span>As of</span>
              <span className="mono">
                {String(hour).padStart(2, '0')}:{String(minute).padStart(2, '0')}
              </span>
            </div>
            <p className="fine">
              The route you picked is simulated vehicle by vehicle; the rest are estimates. Metro
              Manila’s fleet (LTFRB: about 42,000 jeepneys, 6,000 UV Express, 4,100 buses) is shared
              among these routes by each city’s population density (2024 census) and each road’s
              size, with less in car-heavy areas like Makati. Those weights are assumptions: no
              route-by-route count is published. Click any vehicle to simulate its route in full.
            </p>
            <p className="fine">
              Routes and stops: DOTC Philippine Transit GTFS (2015), via Sakay.ph; road paths by
              OSRM on OpenStreetMap. Only routes whose road path fits their 2015 stops are shown;
              routes may have changed since. Not affiliated with or endorsed by DOTC.
            </p>
          </Fold>
        </>
      )}
    </section>
  );
}
