/**
 * One driver's money and service: this jeepney only, never the fleet.
 *
 *   - Today, live from the twin, and every closed day of the month so far
 *     (FleetSim.history): what the driver would see in their own ledger.
 *   - What SakaySightAI changes, from the profit model (core/economics) run in
 *     a background worker for this route: the route's average jeepney over
 *     30 simulated days with and without it. One jeepney's own days swing
 *     far more with luck than SakaySightAI's effect, so they cannot show it.
 */

import { useEffect, useState } from 'react';
import { boundaryFor, boundaryRangeText, dayMoney } from '@/app/earnings';
import { KIND_WORD } from '@/core/vehicles/specs';
import { jeepneyStatus } from '@/app/status';
import { MAX_DAYS, type TwinRuntime } from '@/app/twinRuntime';
import {
  DEFAULT_EXPERIMENT,
  RIDERS_PER_JEEPNEY_DAY,
  type Mode,
  type RunResult,
} from '@/core/economics/model';
import { corridorFromRoute } from '@/core/economics/routes';
import type { DayTotals } from '@/core/fleet/fleetSim';
import type { Route } from '@/core/geo/routes';
import { peso } from './format';

/** The profit model's month: 30 days, the jeepney out every day (as in the lab). */
const MONTH_DAYS = 30;

/** Pesos with a proper minus sign for a loss: "−₱113.27". */
const signed = (php: number) => (php < 0 ? '−' : '') + peso(Math.abs(php));

/** One simulated month per route and fleet size, kept while the app runs. */
const cache = new Map<string, RunResult | Promise<RunResult>>();

function simulateMonth(route: Route, vehicles: number): Promise<RunResult> {
  const key = `${route.id}:${vehicles}`;
  const known = cache.get(key);
  if (known) return Promise.resolve(known);
  const n = Math.max(1, Math.min(300, vehicles));
  const config = {
    ...DEFAULT_EXPERIMENT,
    vehicles: n,
    dailyTrips: Math.min(200_000, n * RIDERS_PER_JEEPNEY_DAY),
    days: MONTH_DAYS,
    repetitions: 1,
  };
  const job = new Promise<RunResult>((resolve, reject) => {
    const w = new Worker(new URL('../../core/economics/worker.ts', import.meta.url), {
      type: 'module',
    });
    w.onmessage = (e: MessageEvent<{ type: string; result?: RunResult; message?: string }>) => {
      if (e.data.type === 'progress') return;
      w.terminate();
      if (e.data.type === 'complete' && e.data.result) resolve(e.data.result);
      else reject(new Error(e.data.message ?? 'Simulation failed'));
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message || 'Simulation failed'));
    };
    w.postMessage({ config, route: corridorFromRoute(route) });
  });
  cache.set(key, job);
  job.then((r) => cache.set(key, r)).catch(() => cache.delete(key));
  return job;
}

/** The route's average jeepney under one policy, per day: the fair test of SakaySightAI. */
function fleetAverage(run: RunResult, mode: Mode) {
  const rows = run.days.map((d) => d.results.find((r) => r.mode === mode)!);
  const n = run.config.vehicles;
  const completed = rows.reduce((s, r) => s + r.completed, 0);
  return {
    net: rows.reduce((s, r) => s + r.profitPhp, 0) / rows.length / n,
    litres: rows.reduce((s, r) => s + r.fuelLitres, 0) / rows.length / n,
    waitMin: completed ? rows.reduce((s, r) => s + r.waitSeconds, 0) / completed / 60 : 0,
  };
}

export function EarningsSection({ twin, index }: { twin: TwinRuntime; index: number }) {
  const vehicles = twin.fleet.vehicles.length;
  const [month, setMonth] = useState<RunResult | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let live = true;
    setMonth(null);
    setError('');
    simulateMonth(twin.route, vehicles)
      .then((r) => live && setMonth(r))
      .catch((e: unknown) => live && setError(String(e)));
    return () => {
      live = false;
    };
  }, [twin.route, vehicles]);

  const v = twin.fleet.vehicles[index];
  if (!v) return null;
  const today = dayMoney(v);
  // The days this jeepney has finished, each from the ledger closed at 3 AM.
  const days: Array<{ day: number; totals: DayTotals }> = twin.fleet.history.map((h) => ({
    day: h.day,
    totals: h.totals[index]!,
  }));
  const closed = days.map((d) => ({
    ...d,
    money: dayMoney({ kind: v.kind, id: v.id, day: d.totals }),
  }));
  const sum = (f: (d: (typeof closed)[number]) => number) => closed.reduce((s, d) => s + f(d), 0);
  const fleet = month
    ? {
        baseline: fleetAverage(month, 'baseline'),
        planner: fleetAverage(month, 'planner'),
        muse: fleetAverage(month, 'muse'),
      }
    : null;
  const gain = fleet ? fleet.planner.net - fleet.baseline.net : 0;
  const status = jeepneyStatus(twin, v);
  const fixedLabel = v.owner ? '− Upkeep + other' : '− Boundary + other';

  return (
    <section className="section">
      <h3 className="section__title">My earnings · {v.plate}</h3>
      {v.owner ? (
        <p className="fine">
          This jeepney only. Its driver <strong>owns it</strong>: no boundary to pay, but their own
          upkeep (repairs, tyres, registration, insurance), taken as ₱
          {DEFAULT_EXPERIMENT.ownerUpkeepPhp} a day, an assumption. They buy the diesel and keep the
          rest of the fares.
        </p>
      ) : (
        <p className="fine">
          This {KIND_WORD[v.kind ?? 'jeepney']} only. Its driver pays <strong>boundary</strong>: the
          fixed fee to its owner (the operator) for each day they drive it, ₱
          {boundaryFor(v.kind, v.id).toLocaleString()} here
          {boundaryRangeText(v.kind) ? ` (${boundaryRangeText(v.kind)} for this kind)` : ''}. The
          driver buys the diesel and keeps whatever fares are left.
        </p>
      )}
      <h4 className="section__subtitle">
        Today · day {Math.min(twin.fleet.dayNumber, MAX_DAYS)} · {status}
      </h4>
      <div className="kv">
        <span>Riders, km</span>
        <span className="mono">
          {v.day.riders} riders · {today.km.toFixed(1)} km
        </span>
        <span>+ Fares collected</span>
        <span className="mono">{peso(today.fares)}</span>
        <span>− Diesel</span>
        <span className="mono">
          {today.litres.toFixed(1)} L · {peso(today.diesel)}
        </span>
        <span>{fixedLabel}</span>
        <span className="mono">{peso(today.fixed)}</span>
        <span>= Net so far</span>
        <span className="mono">
          <strong>{signed(today.net)}</strong>
        </span>
      </div>
      <p className="fine">
        The ₱{today.fixed} is owed for the whole day from the first trip, so the net starts at −₱
        {today.fixed} in the morning and climbs as riders pay; it turns positive once the fares have
        covered the diesel and the {v.owner ? 'upkeep' : 'boundary'}.
      </p>

      <h4 className="section__subtitle">
        My month so far ({closed.length} {closed.length === 1 ? 'day' : 'days'} done)
      </h4>
      {closed.length === 0 ? (
        <p className="fine">
          Each day is added here when it closes at 3 AM. Speed the clock up (up to 300×) to watch
          the month build.
        </p>
      ) : (
        <>
          <div className="kv">
            <span>Riders</span>
            <span className="mono">{sum((d) => d.totals.riders).toLocaleString()}</span>
            <span>+ Fares</span>
            <span className="mono">{peso(sum((d) => d.money.fares))}</span>
            <span>− Diesel</span>
            <span className="mono">
              {sum((d) => d.money.litres).toFixed(0)} L · {peso(sum((d) => d.money.diesel))}
            </span>
            <span>{fixedLabel}</span>
            <span className="mono">{peso(sum((d) => d.money.fixed))}</span>
            <span>= Net</span>
            <span className="mono">
              <strong>{signed(sum((d) => d.money.net))}</strong> (
              {signed(sum((d) => d.money.net) / closed.length)} a day)
            </span>
          </div>
          <details open={closed.length <= 7}>
            <summary>Day by day</summary>
            <table className="earnings">
              <thead>
                <tr>
                  <th>Day</th>
                  <th>Riders</th>
                  <th>Km</th>
                  <th>Fares</th>
                  <th>Diesel</th>
                  <th>Net</th>
                </tr>
              </thead>
              <tbody>
                {closed.map((d) => (
                  <tr key={d.day}>
                    <td className="mono">{d.day}</td>
                    <td className="mono">{d.totals.riders}</td>
                    <td className="mono">{d.money.km.toFixed(0)}</td>
                    <td className="mono">{peso(d.money.fares)}</td>
                    <td className="mono">{peso(d.money.diesel)}</td>
                    <td className="mono">{signed(d.money.net)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="fine">
              Every day has its own random riders (when and where they turn up, how far they go, who
              pays the discounted fare), so no two days are alike, as on the real road.
            </p>
          </details>
        </>
      )}

      <h4 className="section__subtitle">What SakaySightAI changes for a driver here</h4>
      {!fleet && !error && <p className="fine">Working out a month with and without it…</p>}
      {error && <p className="error">{error}</p>}
      {fleet && month && (
        <>
          <table className="earnings">
            <thead>
              <tr>
                <th>Average jeepney, a month</th>
                <th>Without</th>
                <th>With SakaySightAI</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th>Net</th>
                <td className="mono">{signed(fleet.baseline.net * MONTH_DAYS)}</td>
                <td className="mono">
                  <strong>{signed(fleet.planner.net * MONTH_DAYS)}</strong>
                </td>
              </tr>
              <tr>
                <th>Diesel</th>
                <td className="mono">{(fleet.baseline.litres * MONTH_DAYS).toFixed(0)} L</td>
                <td className="mono">{(fleet.planner.litres * MONTH_DAYS).toFixed(0)} L</td>
              </tr>
              <tr>
                <th>Riders’ wait</th>
                <td className="mono">{fleet.baseline.waitMin.toFixed(1)} min</td>
                <td className="mono">{fleet.planner.waitMin.toFixed(1)} min</td>
              </tr>
            </tbody>
          </table>
          <p className="fine">
            SakaySightAI:{' '}
            <strong className={gain >= 0 ? 'good' : 'bad'}>
              {gain >= 0 ? '+' : '−'}
              {peso(Math.abs(gain) * MONTH_DAYS)} a month
            </strong>{' '}
            for a driver, almost all of it diesel not burnt on near-empty trips. With the Muse voice
            assistant: {signed((fleet.muse.net - fleet.baseline.net) * MONTH_DAYS)} a month, its AI
            bill included. From the profit model: {MONTH_DAYS} days of this route with{' '}
            {month.config.vehicles} jeepneys, the same riders with and without, averaged over all of
            them, because one jeepney’s own days swing by hundreds of pesos with luck, far more than
            SakaySightAI’s effect.
          </p>
        </>
      )}
    </section>
  );
}
