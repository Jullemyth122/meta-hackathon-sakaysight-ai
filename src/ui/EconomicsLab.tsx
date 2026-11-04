import { useEffect, useMemo, useRef, useState } from 'react';
import { useRuntimes } from '@/app/runtimeContext';
import { useApp } from '@/app/store';
import {
  DEFAULT_EXPERIMENT,
  GROUPS,
  MAX_REPETITIONS,
  MODEL_VERSION,
  RIDERS_PER_JEEPNEY_DAY,
  aiCost,
  fareCentavos,
  groupTotal,
  ledgerCsv,
  problems,
  summarize,
  type DayLedger,
  type Experiment,
  type Group,
  type Mode,
  type Problem,
  type RunResult,
} from '@/core/economics/model';
import { corridorFromRoute, economicCorridor } from '@/core/economics/routes';
import { download } from './download';

const names: Record<Mode, string> = {
  baseline: 'No SakaySightAI',
  planner: 'SakaySightAI, rules only',
  muse: 'SakaySightAI + Muse AI',
};
const php = (n: number) =>
  n.toLocaleString('en-PH', { style: 'currency', currency: 'PHP', maximumFractionDigits: 2 });
const num = (n: number) => n.toLocaleString('en-PH', { maximumFractionDigits: 1 });
// Keep the last experiment when changing application tabs. No private data or API keys.
type Destination = 'fairview' | 'lagro' | 'live';
let saved: {
  config: Experiment;
  destination: Destination;
  result: RunResult | null;
  area: number;
} = {
  config: structuredClone(DEFAULT_EXPERIMENT),
  destination: 'fairview',
  result: null,
  area: 0,
};
/** A month: the jeepney runs every day (a driver resting one day a week earns 26/30 of it). */
const MONTH_DAYS = 30;
type NumericKey = {
  [K in keyof Experiment]: Experiment[K] extends number ? K : never;
}[keyof Experiment];
const fieldLabels: Partial<Record<NumericKey, string>> = {
  days: 'Operating days per run',
  repetitions: 'Independent seeded runs',
  seed: 'Starting seed',
  dailyTrips: 'One-way passenger trips / day',
  vehicles: 'Jeepneys',
  hours: 'Operating hours / day',
  startHour: 'Start hour (24-hour clock)',
  capacity: 'Seats / jeepney',
  speedKmh: 'Off-peak speed (km/h)',
  peakSpeedFactor: 'Peak speed multiplier (0–1)',
  movingKmPerL: 'Moving fuel efficiency (km/L)',
  idleLPerHour: 'Idling consumption (L/hour)',
  startLitres: 'Extra fuel per departure from stop (L)',
  dieselPhp: 'Diesel (PHP/L)',
  terminalSeconds: 'Required terminal dwell (seconds)',
  serviceSeconds: 'Base service dwell (seconds)',
  passengerSeconds: 'Dwell per boarding/alighting (seconds)',
  emptyStopProbability: 'Chance of unnecessary stop (0–1)',
  emptyStopSeconds: 'Unnecessary stop dwell (seconds)',
  extraTerminalSeconds: 'Habitual terminal wait without advice (seconds/visit)',
  fillShare: 'Advice: leave once this share of seats is taken (0–1)',
  maxHoldSeconds: 'Advice: longest wait for riders at a quiet terminal (seconds)',
  holdStepSeconds: 'Advice: re-check the terminal queue every (seconds)',
  plannerAdoption: 'Rules-only advice adoption (0–1)',
  museAdoption: 'Muse advice adoption (0–1)',
  boundaryPhp: 'Boundary / vehicle-day (PHP)',
  ownerShare: 'Share of owner-drivers, no boundary (0–1)',
  ownerUpkeepPhp: 'Owner-driver upkeep / day (PHP)',
  otherDailyPhp: 'Other costs / vehicle-day (PHP)',
  maintenancePhpPerKm: 'Additional maintenance / km (PHP)',
  dataPhpPerVehicleDay: 'Incremental data / vehicle-day (PHP)',
  hardwarePhpPerVehicleDay: 'Hardware allocation / vehicle-day (PHP)',
  serverPhpPerDay: 'Server / entire fleet-day (PHP)',
  driverQuestionsPerDay: 'Questions / driver-day',
  commuterQuestionShare: 'Questions per attempted passenger trip',
  inputTokens: 'Input tokens / uncached answer',
  outputTokens: 'Total output tokens incl. reasoning / answer',
  cacheHitShare: 'Exact response-cache hit fraction',
  voiceShare: 'Fraction of questions spoken',
  audioSeconds: 'Audio seconds / spoken question',
  inputUsdPerMillion: 'USD / million input tokens',
  outputUsdPerMillion: 'USD / million output tokens',
  transcriptionUsdPerHour: 'USD / audio hour',
  phpPerUsd: 'PHP / USD',
};
/** Input bounds the browser can enforce while typing; problems() has the full rules. */
const fieldLimits: Partial<Record<NumericKey, { min?: number; max?: number }>> = {
  days: { min: 1, max: 31 },
  repetitions: { min: 1, max: MAX_REPETITIONS },
  vehicles: { min: 1, max: 300 },
  dailyTrips: { min: 0, max: 200_000 },
  hours: { min: 1, max: 18 },
  startHour: { min: 0, max: 23 },
  capacity: { min: 1, max: 40 },
};

/** Shares scaled to add up to exactly 1, rounded to 0.001; the rounding goes to the largest. */
function rescaled(groups: Record<Group, number>): Record<Group, number> {
  const total = GROUPS.reduce((s, g) => s + Math.max(0, groups[g]), 0);
  if (total <= 0) return { ...DEFAULT_EXPERIMENT.groups };
  const out = {} as Record<Group, number>;
  for (const g of GROUPS) out[g] = Math.round((Math.max(0, groups[g]) / total) * 1000) / 1000;
  const largest = GROUPS.reduce((a, b) => (out[b] > out[a] ? b : a));
  out[largest] = 1 - GROUPS.filter((g) => g !== largest).reduce((s, g) => s + out[g], 0);
  return out;
}

function ProblemList({ issues }: { issues: readonly Problem[] }) {
  if (issues.length === 0) return null;
  return (
    <ul className="economics-problems">
      {issues.map((p) => (
        <li key={p.message}>{p.message}</li>
      ))}
    </ul>
  );
}

/**
 * The per-jeepney results for every jeepney of an area. A district's jeepneys
 * run on many routes, never 1,000+ on one road, so the lab simulates one
 * corridor's fleet and multiplies its average jeepney.
 */
function AreaTotals({
  area,
  setArea,
  vehicles,
  daily,
}: {
  area: number;
  setArea: (n: number) => void;
  vehicles: number;
  daily: Array<{ mode: Mode; perJeepney: number }>;
}) {
  const baseline = daily.find((d) => d.mode === 'baseline')!.perJeepney;
  return (
    <div className="economics-area">
      <label>
        Scale to an area: jeepneys in the whole district or city (this corridor has {vehicles})
        <input
          type="number"
          min={0}
          step={1}
          placeholder="e.g. 1270"
          value={area || ''}
          onChange={(e) => setArea(Math.max(0, Math.round(Number(e.target.value) || 0)))}
        />
      </label>
      {area > 0 && (
        <div className="economics-table">
          <table>
            <caption>{num(area)} jeepneys together, each like the average jeepney here</caption>
            <thead>
              <tr>
                <th>Area</th>
                {daily.map((d) => (
                  <th key={d.mode}>{names[d.mode]}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr>
                <th>Drivers’ cash, per day</th>
                {daily.map((d) => (
                  <td key={d.mode}>{php(d.perJeepney * area)}</td>
                ))}
              </tr>
              <tr>
                <th>Drivers’ cash, per month ({MONTH_DAYS} days)</th>
                {daily.map((d) => (
                  <td key={d.mode}>
                    <strong>{php(d.perJeepney * area * MONTH_DAYS)}</strong>
                  </td>
                ))}
              </tr>
              <tr>
                <th>Change vs no app, per month</th>
                {daily.map((d) => (
                  <td key={d.mode}>{php((d.perJeepney - baseline) * area * MONTH_DAYS)}</td>
                ))}
              </tr>
            </tbody>
          </table>
          <p className="fine">
            Assumes every jeepney of the area carries as many riders, works the same hours and pays
            the same costs as the average one here. Busier or quieter routes change it. The count is
            yours to enter; the lab does not verify it.
          </p>
        </div>
      )}
    </div>
  );
}

type Stats = ReturnType<typeof summarize>;

/**
 * The month in one table, for a presentation: where each peso comes from
 * and goes, with and without SakaySightAI, for one jeepney (the fleet's
 * average) or the whole fleet, then the time and the service it buys.
 */
function MonthReport({ result, stats }: { result: RunResult; stats: Stats }) {
  const [scope, setScope] = useState<'jeepney' | 'fleet'>('jeepney');
  const n = result.config.vehicles;
  // Per month: the average simulated day × MONTH_DAYS, for one jeepney or all of them.
  const month = (s: Stats[number], total: number) =>
    (total / s.days / (scope === 'jeepney' ? n : 1)) * MONTH_DAYS;
  // Time: per jeepney per day, in hours.
  const hours = (s: Stats[number], seconds: number) => seconds / s.days / n / 3600;
  const base = stats[0]!;
  const lines: Array<{ label: string; value: (s: Stats[number]) => string; strong?: boolean }> = [
    {
      label: 'Riders carried',
      value: (s) => num(month(s, s.completed)),
    },
    { label: '+ Fares collected', value: (s) => php(month(s, s.revenuePhp)) },
    {
      label: '− Diesel',
      value: (s) => `${num(month(s, s.fuelLitres))} L · ${php(month(s, s.fuelPhp))}`,
    },
    { label: '− Boundary paid to owners', value: (s) => php(month(s, s.boundaryPhp)) },
    { label: '− Owner-drivers’ own upkeep', value: (s) => php(month(s, s.upkeepPhp)) },
    { label: '− Other daily costs', value: (s) => php(month(s, s.otherPhp)) },
    { label: '− SakaySightAI phone data, hardware, server', value: (s) => php(month(s, s.appPhp)) },
    { label: '− Muse AI questions (text + voice)', value: (s) => php(month(s, s.aiPhp)) },
    { label: '= Net profit', value: (s) => php(month(s, s.profitPhp)), strong: true },
    {
      label: 'Change vs no SakaySightAI',
      value: (s) => php(month(s, s.profitPhp) - month(base, base.profitPhp)),
      strong: true,
    },
  ];
  const time: Array<{ label: string; value: (s: Stats[number]) => string }> = [
    { label: 'Hours driving, per jeepney a day', value: (s) => num(hours(s, s.driveSeconds)) },
    {
      label: 'Hours standing (stops, terminals), per jeepney a day',
      value: (s) => num(hours(s, s.idleSeconds)),
    },
    {
      label: '… of which waiting for riders on advice',
      value: (s) => num(hours(s, s.holdSeconds)),
    },
    { label: 'Km driven, per jeepney a day', value: (s) => num(s.km / s.days / n) },
    { label: 'Riders’ average wait at the stop', value: (s) => `${num(s.meanWaitMin)} min` },
    {
      label: 'Trips served',
      value: (s) => `${num((s.completed / s.requested) * 100 || 0)}%`,
    },
  ];
  return (
    <div className="economics-table economics-month">
      <div className="economics-actions">
        <strong>
          Month report ({MONTH_DAYS} days) ·{' '}
          {scope === 'jeepney' ? 'one jeepney, the fleet’s average' : `all ${n} jeepneys`}
        </strong>
        <div className="row">
          <button
            type="button"
            className="btn"
            aria-pressed={scope === 'jeepney'}
            onClick={() => setScope('jeepney')}
          >
            One jeepney
          </button>
          <button
            type="button"
            className="btn"
            aria-pressed={scope === 'fleet'}
            onClick={() => setScope('fleet')}
          >
            Whole fleet
          </button>
        </div>
      </div>
      <table>
        <thead>
          <tr>
            <th>Money, per month</th>
            {stats.map((s) => (
              <th key={s.mode}>{names[s.mode]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.label}>
              <th>{l.strong ? <strong>{l.label}</strong> : l.label}</th>
              {stats.map((s) => (
                <td key={s.mode}>{l.strong ? <strong>{l.value(s)}</strong> : l.value(s)}</td>
              ))}
            </tr>
          ))}
          <tr>
            <th colSpan={stats.length + 1}>Time and service</th>
          </tr>
          {time.map((l) => (
            <tr key={l.label}>
              <th>{l.label}</th>
              {stats.map((s) => (
                <td key={s.mode}>{l.value(s)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="fine">
        <strong>How the money works.</strong> Every rider pays when they get off, by how far they
        rode: ₱{result.config.fare.base} for the first {result.config.fare.baseKm} km, ₱
        {result.config.fare.perKm} for each km after; students, seniors and PWD pay{' '}
        {result.config.fare.discountPct}% less. Diesel = km ÷ {result.config.movingKmPerL} km/L +
        hours standing with the engine on × {result.config.idleLPerHour} L/h, at ₱
        {result.config.dieselPhp}/L. A driver who does not own the jeepney pays its owner ₱
        {result.config.boundaryPhp} boundary a day; an owner-driver (
        {Math.round(result.config.ownerShare * 100)}% of the fleet here) pays none but ₱
        {result.config.ownerUpkeepPhp} of their own upkeep. Everyone pays ₱
        {result.config.otherDailyPhp} other costs a day. Net = fares − diesel − boundary or upkeep −
        other − SakaySightAI − Muse. SakaySightAI does not create riders: it saves diesel, by
        leaving a busy terminal at once, waiting for riders at a quiet one instead of driving
        near-empty, and skipping stops nobody needs. Every simulated day has its own random riders
        (when and where they turn up), so no two days are alike; the month is {result.config.days}{' '}
        such days
        {result.config.repetitions > 1 ? `, averaged over ${result.config.repetitions} runs` : ''}.
      </p>
    </div>
  );
}

export function EconomicsLab() {
  const [config, setConfig] = useState(() => saved.config);
  const [destination, setDestination] = useState(saved.destination);
  const [result, setResult] = useState<RunResult | null>(saved.result);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [latest, setLatest] = useState<DayLedger | null>(null);
  const [error, setError] = useState('');
  const worker = useRef<Worker | null>(null);
  const { twin } = useRuntimes();
  const setView = useApp((s) => s.setView);
  const route = useMemo(
    () => (destination === 'live' ? corridorFromRoute(twin.route) : economicCorridor(destination)),
    [destination, twin.route],
  );
  // Jeepneys in the whole area (a district, a city) to scale the per-jeepney results to.
  const [area, setArea] = useState(saved.area);
  useEffect(() => {
    saved = { config, destination, result, area };
  }, [config, destination, result, area]);
  useEffect(() => () => worker.current?.terminate(), []);
  // Checked as they type, so every problem shows at once and Run waits until there are none.
  const issues = problems(config, route);
  const invalid = (key: Problem['key']) => issues.some((p) => p.key === key);
  const change = (key: NumericKey, value: number) => setConfig((c) => ({ ...c, [key]: value }));
  const field = (key: NumericKey) => (
    <label key={key}>
      {fieldLabels[key]}
      <input
        aria-label={fieldLabels[key]}
        aria-invalid={invalid(key)}
        type="number"
        step="any"
        {...fieldLimits[key]}
        value={config[key]}
        onChange={(e) => change(key, Number(e.target.value))}
      />
    </label>
  );
  const fields = (keys: NumericKey[]) => <div className="economics-fields">{keys.map(field)}</div>;
  const start = () => {
    setError('');
    if (issues.length > 0) return;
    worker.current?.terminate();
    const w = new Worker(new URL('../core/economics/worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.current = w;
    setRunning(true);
    setLatest(null);
    setProgress({ done: 0, total: config.days * config.repetitions });
    w.onmessage = (
      e: MessageEvent<
        | { type: 'progress'; done: number; total: number; row: DayLedger }
        | { type: 'complete'; result: RunResult }
        | { type: 'error'; message: string }
      >,
    ) => {
      const data = e.data;
      if (data.type === 'progress') {
        setProgress({ done: data.done, total: data.total });
        setLatest(data.row);
      } else {
        setRunning(false);
        w.terminate();
        worker.current = null;
        if (data.type === 'complete') setResult(data.result);
        else setError(data.message);
      }
    };
    w.onerror = (e) => {
      setError(e.message || 'Experiment worker failed');
      setRunning(false);
      w.terminate();
      worker.current = null;
    };
    w.postMessage({ config: structuredClone(config), route });
  };
  const stats = result ? summarize(result) : null;
  const baseline = stats?.[0],
    planner = stats?.[1],
    muse = stats?.[2];
  const lastKm = route.stops.at(-1)!.km;
  return (
    <main className="stage economics-stage">
      <section className="economics-results" aria-label="Economic experiment results">
        <div className="section">
          <div className="economics-heading">
            <div>
              <button type="button" className="btn" onClick={() => setView('twin')}>
                ← Live twin
              </button>{' '}
              <span className="chip">Operator view · synthetic experiment · no paid API calls</span>
              <h2>Profit & service lab</h2>
            </div>
            <span className="mono">{MODEL_VERSION}</span>
          </div>
          <p>
            The whole fleet of one corridor: the same riders, fares, traffic and jeepneys under
            three policies. These are simulated pesos under explicit assumptions, not measured
            earnings. Demand counts one-way trips, not unique people. Each driver sees their own
            jeepney in the driver app.
          </p>
          <p className="fine">
            A 30-day run at 50× wall-clock speed would still take 14.4 hours. This lab jumps between
            vehicle events in a background worker, without animating millions of people. “30 runs”
            means 30 independently seeded months, not 30× earnings.
          </p>
          {running && (
            <div role="status">
              <progress max={progress.total} value={progress.done} />
              <p>
                {progress.done} / {progress.total} simulated operating days completed
              </p>
              {latest && (
                <p>
                  Latest: run {latest.repetition + 1}, day {latest.day + 1} · {latest.demandHash} ·{' '}
                  {num(latest.results[0]!.completed)} baseline trips completed
                </p>
              )}
            </div>
          )}
          {error && (
            <p role="alert" className="economics-error">
              {error}
            </p>
          )}
          {issues.length > 0 && !running && (
            <>
              <p className="economics-error">Fix these settings before running:</p>
              <ProblemList issues={issues} />
            </>
          )}
          {!result && !running && (
            <p>
              Choose a corridor (or the live twin’s route), then run 30 or 31 days. The defaults are
              calibrated to what boundary drivers report: about {RIDERS_PER_JEEPNEY_DAY} riders per
              jeepney a day. The 100k/200k presets are unverified stress tests: far more riders per
              jeepney than real routes carry, so their pesos are far above real earnings. Overloaded
              demand remains unserved; it never becomes fictional fare revenue.
            </p>
          )}
        </div>
        {result && stats && baseline && planner && muse && (
          <>
            <div className="section">
              <h3>
                {result.route.name} · {result.config.days} operating days ×{' '}
                {result.config.repetitions} seeded runs
              </h3>
              <p>
                {num(result.config.dailyTrips)} attempted trips/day · {result.config.vehicles}{' '}
                vehicles · {result.config.hours} hours/day ·{' '}
                {result.route.stops.at(-1)!.km.toFixed(2)} km each way. Results below use the saved
                run inputs; edit controls and rerun to apply changes.
              </p>
              <div className="economics-actions">
                <button
                  className="btn"
                  onClick={() =>
                    download('sakaysightai-roi-ledger.csv', ledgerCsv(result), 'text/csv')
                  }
                >
                  Export daily ledger CSV
                </button>
                <button
                  className="btn"
                  onClick={() =>
                    download(
                      'sakaysightai-roi-audit.json',
                      JSON.stringify(result, null, 2),
                      'application/json',
                    )
                  }
                >
                  Export inputs + audit JSON
                </button>
              </div>
              <MonthReport result={result} stats={stats} />
              <div className="economics-table">
                <table>
                  <caption>
                    One driver (the average jeepney of this fleet) · cash after diesel, boundary and
                    listed costs, before unlisted expenses or taxes
                  </caption>
                  <thead>
                    <tr>
                      <th>Per jeepney</th>
                      {stats.map((s) => (
                        <th key={s.mode}>{names[s.mode]}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th>Per day</th>
                      {stats.map((s) => (
                        <td key={s.mode}>{php(s.dailyPerVehicle)}</td>
                      ))}
                    </tr>
                    <tr>
                      <th>Per month ({MONTH_DAYS} days)</th>
                      {stats.map((s) => (
                        <td key={s.mode}>
                          <strong>{php(s.dailyPerVehicle * MONTH_DAYS)}</strong>
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <th>Change vs no app, per month</th>
                      {stats.map((s) => (
                        <td key={s.mode}>
                          {php((s.dailyPerVehicle - baseline.dailyPerVehicle) * MONTH_DAYS)}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <th>Whole run ({result.config.days} days, no day off)</th>
                      {stats.map((s) => (
                        <td key={s.mode}>{php(s.monthlyPerVehicle)}</td>
                      ))}
                    </tr>
                    {result.config.repetitions > 1 && (
                      <tr>
                        <th>Whole run, spread between seeded runs (P10–P90)</th>
                        {stats.map((s) => (
                          <td key={s.mode}>
                            {php(s.p10)} – {php(s.p90)}
                          </td>
                        ))}
                      </tr>
                    )}
                    <tr>
                      <th>Riders carried per day</th>
                      {stats.map((s) => (
                        <td key={s.mode}>{num(s.completed / s.days / result.config.vehicles)}</td>
                      ))}
                    </tr>
                    <tr>
                      <th>Km driven per day</th>
                      {stats.map((s) => (
                        <td key={s.mode}>{num(s.km / s.days / result.config.vehicles)}</td>
                      ))}
                    </tr>
                    <tr>
                      <th>Diesel per day</th>
                      {stats.map((s) => (
                        <td key={s.mode}>
                          {num(s.fuelLitres / s.days / result.config.vehicles)} L ·{' '}
                          {php(s.fuelPhp / s.days / result.config.vehicles)}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="economics-table">
                <table>
                  <caption>
                    Whole fleet of this corridor · {result.config.vehicles} jeepneys together
                  </caption>
                  <thead>
                    <tr>
                      <th>All jeepneys</th>
                      {stats.map((s) => (
                        <th key={s.mode}>{names[s.mode]}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <th>Drivers’ cash, per day</th>
                      {stats.map((s) => (
                        <td key={s.mode}>{php(s.profitPhp / s.days)}</td>
                      ))}
                    </tr>
                    <tr>
                      <th>Drivers’ cash, per month ({MONTH_DAYS} days)</th>
                      {stats.map((s) => (
                        <td key={s.mode}>
                          <strong>{php((s.profitPhp / s.days) * MONTH_DAYS)}</strong>
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <th>Riders per day</th>
                      {stats.map((s) => (
                        <td key={s.mode}>{num(s.completed / s.days)}</td>
                      ))}
                    </tr>
                    <tr>
                      <th>Trips served</th>
                      {stats.map((s) => (
                        <td key={s.mode}>{num((s.completed / s.requested) * 100 || 0)}%</td>
                      ))}
                    </tr>
                    <tr>
                      <th>Trips not served, per day</th>
                      {stats.map((s) => (
                        <td key={s.mode}>{num(s.unserved / s.days)}</td>
                      ))}
                    </tr>
                    <tr>
                      <th>Average wait of riders who boarded</th>
                      {stats.map((s) => (
                        <td key={s.mode}>{num(s.meanWaitMin)} min</td>
                      ))}
                    </tr>
                    <tr>
                      <th>Waiting by riders never served, per day</th>
                      {stats.map((s) => (
                        <td key={s.mode}>{num(s.unservedWaitHours / s.days)} passenger-hours</td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
              <p className="fine">
                <strong>How to read these.</strong> “Per day” is one operating day of{' '}
                {result.config.hours} hours. “Per month” is the average day × {MONTH_DAYS}: the
                jeepney runs every day. “Whole run” adds up the {result.config.days} simulated days,
                each with its own random riders. Seeded runs repeat the month with other random
                riders; they are averaged, not added together.
              </p>
              <AreaTotals
                area={area}
                setArea={setArea}
                vehicles={result.config.vehicles}
                daily={stats.map((s) => ({ mode: s.mode, perJeepney: s.dailyPerVehicle }))}
              />
              <p>
                <strong>Muse versus rules only:</strong>{' '}
                {php((muse.dailyPerVehicle - planner.dailyPerVehicle) * MONTH_DAYS)} per jeepney per
                month.{' '}
                {result.config.museAdoption === result.config.plannerAdoption
                  ? 'Equal adoption produces equal service; Muse adds cost only.'
                  : 'Different adoption is a user-entered hypothesis, not evidence of an AI effect.'}
              </p>
              <p>
                <strong>AI break-even:</strong>{' '}
                {php(muse.aiPhp / muse.days / result.config.vehicles)} extra operational benefit
                needed per vehicle-day to cover this run’s AI bill, before any further costs.
              </p>
            </div>
            <div className="section economics-table">
              <table>
                <caption>
                  Average daily ledger for the entire {result.config.vehicles}-vehicle fleet
                </caption>
                <thead>
                  <tr>
                    <th>PHP per fleet-day</th>
                    {stats.map((s) => (
                      <th key={s.mode}>{names[s.mode]}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(
                    [
                      ['Fare receipts', 'revenuePhp'],
                      ['Fuel', 'fuelPhp'],
                      ['Boundary', 'boundaryPhp'],
                      ['Owner-drivers’ upkeep', 'upkeepPhp'],
                      ['Other listed costs', 'otherPhp'],
                      ['Data + hardware + server', 'appPhp'],
                      ['Muse text + transcription', 'aiPhp'],
                      ['Cash after listed costs', 'profitPhp'],
                    ] as const
                  ).map(([label, key]) => (
                    <tr key={key}>
                      <th>{label}</th>
                      {stats.map((s) => (
                        <td key={s.mode}>{php(s[key] / s.days)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <p>
                Cash = completed-trip fares − fuel − boundary − other costs − app infrastructure −
                AI. Fare revenue uses integer centavos. Boundary is deducted from driver cash; it is
                not an extra deduction when calculating combined driver-and-owner income.
              </p>
            </div>
            <div className="section economics-table">
              <table>
                <caption>
                  Completed rides and fares by eligibility · totals across all saved days and
                  repetitions
                </caption>
                <thead>
                  <tr>
                    <th>Category</th>
                    {stats.map((s) => (
                      <th key={s.mode}>{names[s.mode]}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {GROUPS.map((g) => (
                    <tr key={g}>
                      <th>{g}</th>
                      {stats.map((s) => {
                        const rows = result.days.map((d) =>
                          d.results.find((r) => r.mode === s.mode)!,
                        );
                        return (
                          <td key={s.mode}>
                            {num(rows.reduce((n, r) => n + r.groups[g], 0))} rides ·{' '}
                            {php(rows.reduce((n, r) => n + r.groupRevenueCentavos[g], 0) / 100)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <details className="section">
              <summary>Daily calculation logs</summary>
              <div className="economics-table">
                <table>
                  <thead>
                    <tr>
                      <th>Run / day / seed</th>
                      <th>Policy</th>
                      <th>Served / unserved</th>
                      <th>Litres</th>
                      <th>Extra stops</th>
                      <th>Terminal waits for riders</th>
                      <th>Cash / vehicle-day</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.days.slice(0, 31).flatMap((d) =>
                      d.results.map((r) => (
                        <tr key={`${d.repetition}-${d.day}-${r.mode}`}>
                          <td>
                            {d.repetition + 1} / {d.day + 1} / {d.seed}
                          </td>
                          <td>{names[r.mode]}</td>
                          <td>
                            {num(r.completed)} / {num(r.unserved)}
                          </td>
                          <td>{num(r.fuelLitres)}</td>
                          <td>{r.extraStops}</td>
                          <td>{num((r.holdSeconds ?? 0) / 60)} min</td>
                          <td>{php(r.profitPhp / result.config.vehicles)}</td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
              <p>
                First 31 simulated days displayed. Export includes every day, configuration, demand
                fingerprint and per-vehicle cash ledger.
              </p>
            </details>
            <details className="section">
              <summary>Passenger fare and time audit samples</summary>
              <div className="economics-table">
                <table>
                  <thead>
                    <tr>
                      <th>Policy / rider</th>
                      <th>Eligibility</th>
                      <th>From → to</th>
                      <th>Distance / fare</th>
                      <th>Wait / total journey</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.days[0]?.results.flatMap((r) =>
                      r.logs.map((l) => (
                        <tr key={`${r.mode}-${l.id}`}>
                          <td>
                            {names[r.mode]} / {l.id}
                          </td>
                          <td>{l.group}</td>
                          <td>
                            {l.from} → {l.to}
                          </td>
                          <td>
                            {l.km.toFixed(3)} km / {php(l.farePhp)}
                          </td>
                          <td>
                            {((l.boardedS - l.arrivedS) / 60).toFixed(1)} /{' '}
                            {((l.completedS - l.arrivedS) / 60).toFixed(1)} min
                          </td>
                        </tr>
                      )),
                    )}
                  </tbody>
                </table>
              </div>
              <p>
                First 40 completed trips per policy on the first day; samples are not representative
                averages. Full category totals and daily accounts are exported.
              </p>
            </details>
          </>
        )}
        <details className="section" open>
          <summary>Model boundaries and evidence</summary>
          <p>{route.note}</p>
          <p>
            FIFO stop queues; finite seats; arrivals during a dwell wait for the next vehicle.
            Demand varies by hour and direction. Service stops always happen when needed. Advice
            does two things only: it removes assumed unnecessary stops, and it makes terminal
            departures demand-aware (leave once enough seats are taken; at a quiet terminal, wait
            for riders up to a cap instead of driving a near-empty trip). It does not teleport
            riders, change fares or create seats. Leaving sooner can add kilometres, fuel and
            completed trips; waiting can save fuel and lengthen waits. All of these are counted.
          </p>
          <p>
            Each day starts empty with departures staggered from both endpoints. New boarding ends
            at the operating cutoff; aboard riders finish their trip and overtime fuel is charged.
            Unserved queues reset next day and remain reported as unserved. No traffic interactions,
            abandonment, holidays, transfers, disruptions, congestion caused by this fleet or
            passenger-specific boarding times are modelled.
          </p>
          <p>
            Fuel = distance / moving km-per-litre + idle hours × idle L/hour + stopped departures ×
            start litres. Moving efficiency must exclude idling. Never add the prototype’s combined
            0.028 L/stop to this split model.
          </p>
          <p>
            Fare scenario follows the app’s traditional-jeepney rule: first 4 km ₱14, then ₱2 per
            started km; eligible fares rounded to ₱0.25. Base fare is supported by the government
            announcement; verify the posted corridor matrix and distance rounding before deployment.
            Pregnant riders with another eligibility belong in that eligible bucket; discounts do
            not stack. No universal 10% discount is applied.
          </p>
          <ul>
            <li>
              <a
                href="https://dev.meta.ai/docs/pricing-rate-limits"
                target="_blank"
                rel="noreferrer"
              >
                Meta pricing
              </a>
              : Muse Spark standard $1.25/M input and $4.25/M output; transcription $0.18/audio
              hour. Rates are editable assumptions, checked 28 Oct 2026. Future price cuts are not
              assumed.
            </li>
            <li>
              <a
                href="https://pco.gov.ph/news_releases/palace-govt-balances-transport-support-commuter-welfare-amid-fare-hike-and-rising-fuel-prices/"
                target="_blank"
                rel="noreferrer"
              >
                September 2026 fare announcement
              </a>{' '}
              ·{' '}
              <a
                href="https://lawphil.net/statutes/repacts/ra2019/ra_11314_2019.html"
                target="_blank"
                rel="noreferrer"
              >
                Student discount
              </a>{' '}
              ·{' '}
              <a
                href="https://lawphil.net/statutes/repacts/ra2010/ra_9994_2010.html"
                target="_blank"
                rel="noreferrer"
              >
                Senior discount
              </a>{' '}
              ·{' '}
              <a
                href="https://ncda.gov.ph/disability-laws/implementing-rules-and-regulations-irr/irr-of-ra-10754-an-act-expanding-the-benefits-and-privileges-of-persons-with-disability-pwd/"
                target="_blank"
                rel="noreferrer"
              >
                PWD discount
              </a>
              .
            </li>
          </ul>
        </details>
      </section>
      <aside className="panel economics-controls">
        <div className="section">
          <h3>Experiment settings</h3>
          <p className="fine">
            All behavior, costs and passenger shares below are editable assumptions. No future AI
            price reduction or AI adoption gain is built in.
          </p>
          <fieldset disabled={running}>
            <label>
              Corridor
              <select
                value={destination}
                onChange={(e) => {
                  const next = e.target.value as Destination;
                  setDestination(next);
                  // The live twin's route comes with its fleet, at realistic riders per jeepney.
                  if (next === 'live') {
                    const n = Math.max(1, Math.min(300, twin.fleet.vehicles.length));
                    setConfig((c) => ({
                      ...c,
                      vehicles: n,
                      dailyTrips: n * RIDERS_PER_JEEPNEY_DAY,
                    }));
                  }
                }}
              >
                <option value="fairview">SM Tungko ↔ SM Fairview</option>
                <option value="lagro">SM Tungko ↔ Lagro</option>
                <option value="live">
                  Live twin route: {twin.route.name} ({twin.fleet.vehicles.length} jeepneys)
                </option>
              </select>
            </label>
            <p>
              {lastKm.toFixed(3)} km each way · {route.stops.length} mapped stops
            </p>
            <div className="economics-actions">
              <button
                type="button"
                className="btn"
                onClick={() => setConfig((c) => ({ ...c, dailyTrips: 100000, vehicles: 200 }))}
              >
                100k trips / 200 jeeps
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setConfig((c) => ({ ...c, dailyTrips: 200000, vehicles: 300 }))}
              >
                200k trips / 300 jeeps
              </button>
            </div>
            {fields(['dailyTrips', 'vehicles', 'days', 'repetitions', 'seed', 'hours'])}
            <p className="fine">
              {config.days} days × {config.repetitions} runs ={' '}
              {num(config.days * config.repetitions)} simulated days. Every run compares all three
              policies on identical demand. Maximum 31 days, {MAX_REPETITIONS} runs, 200k trips/day
              and 300 vehicles.
            </p>
            <details open>
              <summary>Passenger mix and fares</summary>
              <div className="economics-fields">
                {GROUPS.map((g) => (
                  <label key={g}>
                    {g} share (0–1)
                    <input
                      type="number"
                      step=".01"
                      min={0}
                      max={1}
                      aria-invalid={invalid('groups')}
                      value={config.groups[g]}
                      onChange={(e) =>
                        setConfig((c) => ({
                          ...c,
                          groups: { ...c.groups, [g]: Number(e.target.value) },
                        }))
                      }
                    />
                  </label>
                ))}
              </div>
              <p className={invalid('groups') ? 'economics-error' : undefined}>
                Total: {num(groupTotal(config) * 100)}% (must be 100%).{' '}
                {invalid('groups') && (
                  <button
                    type="button"
                    className="linkish"
                    onClick={() => setConfig((c) => ({ ...c, groups: rescaled(c.groups) }))}
                  >
                    Rescale to 100%
                  </button>
                )}
              </p>
              <p>
                Eligible: student, PWD, senior = {config.fare.discountPct}% off. Regular and
                pregnancy-only = no discount. Each rider is in one group, so the shares add up to 1.
              </p>
              <p className="fine">
                These are a weekday&apos;s riders as a whole. Within it the mix moves: students in
                the morning and afternoon rush and leaving school stops after class, seniors
                mid-morning, few students on Saturdays and Sundays (day 1 is a Monday), and each day
                up to 20% either way. So one jeepney can fill with students while the next carries
                mostly regular fares. Assumptions, not survey data.
              </p>
              <p>
                End-to-end scenario: {php(fareCentavos(lastKm, 'regular', config.fare) / 100)}{' '}
                regular; {php(fareCentavos(lastKm, 'student', config.fare) / 100)} eligible.
              </p>
            </details>
            <details>
              <summary>Service and behavior</summary>
              {fields([
                'startHour',
                'capacity',
                'speedKmh',
                'peakSpeedFactor',
                'serviceSeconds',
                'passengerSeconds',
                'terminalSeconds',
                'emptyStopProbability',
                'emptyStopSeconds',
                'extraTerminalSeconds',
                'fillShare',
                'maxHoldSeconds',
                'holdStepSeconds',
                'plannerAdoption',
                'museAdoption',
              ])}
              <p className="fine">
                Adoption is the share of stops and terminal visits where the driver follows the
                advice: no unnecessary stops, and leave a terminal by demand (at once when it is
                busy, waiting for riders when it is quiet) instead of the fixed habit. Raising Muse
                adoption is a hypothesis to test, not a measured effect.
              </p>
            </details>
            <details>
              <summary>Fuel and operating expenses</summary>
              {fields([
                'movingKmPerL',
                'idleLPerHour',
                'startLitres',
                'dieselPhp',
                'boundaryPhp',
                'ownerShare',
                'ownerUpkeepPhp',
                'otherDailyPhp',
                'maintenancePhpPerKm',
                'dataPhpPerVehicleDay',
                'hardwarePhpPerVehicleDay',
                'serverPhpPerDay',
              ])}
            </details>
            <details>
              <summary>Muse usage and prices</summary>
              {fields([
                'driverQuestionsPerDay',
                'commuterQuestionShare',
                'inputTokens',
                'outputTokens',
                'cacheHitShare',
                'voiceShare',
                'audioSeconds',
                'inputUsdPerMillion',
                'outputUsdPerMillion',
                'transcriptionUsdPerHour',
                'phpPerUsd',
              ])}
              <p>
                Budgeted cost per question: {php(aiCost(config, 1).php)}. Cache fraction refers to
                complete reused answers; spoken requests still incur transcription. No calls are
                made by this experiment.
              </p>
            </details>
          </fieldset>
          <ProblemList issues={issues} />
          <button
            type="button"
            className="btn economics-run"
            disabled={running || issues.length > 0}
            onClick={start}
          >
            {running ? 'Running…' : 'Run fast comparison'}
          </button>
          {running && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                worker.current?.terminate();
                worker.current = null;
                setRunning(false);
                setError('Cancelled. Partial run discarded; previous completed results remain.');
              }}
            >
              Cancel experiment
            </button>
          )}
        </div>
      </aside>
    </main>
  );
}
