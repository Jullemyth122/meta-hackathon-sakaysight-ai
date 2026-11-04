/**
 * The operator's data for every jeepney on the route, live: where each is
 * and what it is doing, its riders, kilometres, fares, diesel and net today,
 * sortable, with the fleet's totals; the log of every stop made (who got
 * off and on, the fares paid); and every day of the month so far, closed at
 * 3 AM (FleetSim.history). All export as CSV. Drawn over the live twin,
 * which keeps running underneath. Click a jeepney to monitor it.
 */

import { useState } from 'react';
import { FUEL } from '@/core/vehicles/specs';
import { boundaryRangeText, clockText, dayMoney, type DayMoney } from '@/app/earnings';
import { useRuntimes } from '@/app/runtimeContext';
import { jeepneyStatus } from '@/app/status';
import { useApp } from '@/app/store';
import { ADVISORY } from '@/core/advisory/model';
import { DEFAULT_EXPERIMENT } from '@/core/economics/model';
import type { FleetVehicle } from '@/core/fleet/fleetSim';
import { csvRow, download } from './download';
import { peso } from './phone/format';
import { useTicker } from './useTicker';

/** Stop events shown on screen, newest first; the export has every kept one. */
const LOG_SHOWN = 200;

interface Row {
  v: FleetVehicle;
  index: number;
  status: string;
  stop: string;
  money: DayMoney;
}

type Column = {
  name: string;
  value: (r: Row) => number | string;
  text: (r: Row) => string;
};

const signed = (php: number) => (php < 0 ? '−' : '') + peso(Math.abs(php));

const COLUMNS: Column[] = [
  { name: 'Plate', value: (r) => r.v.plate, text: (r) => r.v.plate },
  {
    name: 'Driver',
    value: (r) => (r.v.owner ? 'Owner' : 'Boundary'),
    text: (r) => (r.v.owner ? 'Owner' : 'Boundary'),
  },
  { name: 'Status', value: (r) => r.status, text: (r) => r.status },
  { name: 'Stop', value: (r) => r.stop, text: (r) => r.stop },
  {
    name: 'On board',
    value: (r) => r.v.occupancy,
    text: (r) => `${r.v.occupancy}/${r.v.capacity}`,
  },
  { name: 'Riders today', value: (r) => r.v.day.riders, text: (r) => String(r.v.day.riders) },
  { name: 'Km', value: (r) => r.money.km, text: (r) => r.money.km.toFixed(1) },
  {
    name: 'Tank',
    value: (r) => r.v.tankL,
    text: (r) => `${r.v.tankL.toFixed(0)} of ${r.v.tankCapacityL.toFixed(0)} L`,
  },
  {
    name: 'Bought today',
    value: (r) => r.v.day.fuelBoughtL,
    text: (r) =>
      r.v.day.refuels === 0
        ? '–'
        : `${r.v.day.fuelBoughtL.toFixed(0)} L · ${r.v.day.refuels} fill-up${r.v.day.refuels === 1 ? '' : 's'}`,
  },
  { name: 'Idle', value: (r) => r.money.idleMin, text: (r) => `${r.money.idleMin.toFixed(0)} min` },
  { name: 'Fares', value: (r) => r.money.fares, text: (r) => peso(r.money.fares) },
  {
    name: 'Diesel',
    value: (r) => r.money.diesel,
    text: (r) => `${r.money.litres.toFixed(1)} L · ${peso(r.money.diesel)}`,
  },
  {
    name: 'Boundary or upkeep + other',
    value: (r) => r.money.fixed,
    text: (r) => peso(r.money.fixed),
  },
  { name: 'Net', value: (r) => r.money.net, text: (r) => signed(r.money.net) },
];

export function FleetData() {
  useTicker(2);
  const { twin } = useRuntimes();
  const setFleetData = useApp((s) => s.setFleetData);
  const follow = useApp((s) => s.follow);
  const setFollow = useApp((s) => s.setFollow);
  const [tab, setTab] = useState<'jeepneys' | 'log' | 'days'>('jeepneys');
  const [sort, setSort] = useState({ column: 4, descending: true });

  const route = twin.route;
  const stopName = (i: number) => route.stops[i]?.name ?? '—';
  const rows: Row[] = twin.fleet.vehicles.map((v, index) => ({
    v,
    index,
    status: jeepneyStatus(twin, v),
    stop:
      v.duty === 'parked'
        ? `Near ${stopName(v.nextStop)}`
        : v.currentStop !== null
          ? `At ${stopName(v.currentStop)}`
          : `→ ${stopName(v.nextStop)}`,
    money: dayMoney(v),
  }));
  const column = COLUMNS[sort.column]!;
  rows.sort((a, b) => {
    const x = column.value(a);
    const y = column.value(b);
    const order = typeof x === 'number' ? x - (y as number) : String(x).localeCompare(String(y));
    return sort.descending ? -order : order;
  });
  const total = (f: (r: Row) => number) => rows.reduce((n, r) => n + f(r), 0);
  const startS = twin.clockS - twin.fleet.elapsedS;
  const now = clockText(twin.clockS);
  const plateOf = (id: number) => twin.fleet.vehicles[id]?.plate ?? `#${id}`;
  const log = twin.crew.log;

  const exportJeepneys = () =>
    download(
      `sakaysightai-fleet-${now.replace(/:/g, '')}.csv`,
      [
        csvRow([
          'time',
          'plate',
          'kind',
          'owner_driver',
          'status',
          'stop',
          'on_board',
          'seats',
          'riders_today',
          'km',
          'idle_min',
          'fares_php',
          'diesel_litres',
          'diesel_php',
          'boundary_other_php',
          'net_php',
          'tank_l',
          'tank_capacity_l',
          'diesel_bought_today_l',
          'refuels_today',
        ]),
        ...rows.map((r) =>
          csvRow([
            now,
            r.v.plate,
            r.v.kind ?? 'jeepney',
            r.v.owner ? 'yes' : 'no',
            r.status,
            r.stop,
            r.v.occupancy,
            r.v.capacity,
            r.v.day.riders,
            r.money.km.toFixed(3),
            r.money.idleMin.toFixed(1),
            r.money.fares.toFixed(2),
            r.money.litres.toFixed(3),
            r.money.diesel.toFixed(2),
            r.money.fixed.toFixed(2),
            r.money.net.toFixed(2),
            r.v.tankL.toFixed(2),
            r.v.tankCapacityL.toFixed(1),
            r.v.day.fuelBoughtL.toFixed(2),
            r.v.day.refuels,
          ]),
        ),
      ].join('\n'),
      'text/csv',
    );
  // Each closed day for the whole fleet, and the totals of every jeepney in it.
  const history = twin.fleet.history;
  const dayRows = history.map((h) => {
    const money = h.totals.map((d, i) => dayMoney({ ...twin.fleet.vehicles[i], day: d }));
    const add = (g: (m: DayMoney) => number) => money.reduce((n, m) => n + g(m), 0);
    return {
      day: h.day,
      riders: h.totals.reduce((n, d) => n + d.riders, 0),
      km: add((m) => m.km),
      fares: add((m) => m.fares),
      litres: add((m) => m.litres),
      diesel: add((m) => m.diesel),
      bought: h.totals.reduce((n, d) => n + d.fuelBoughtL, 0),
      refuels: h.totals.reduce((n, d) => n + d.refuels, 0),
      fixed: add((m) => m.fixed),
      net: add((m) => m.net),
      jeepneys: h.totals.length,
    };
  });
  const exportDays = () =>
    download(
      `sakaysightai-days-${now.replace(/:/g, '')}.csv`,
      [
        csvRow([
          'day',
          'plate',
          'kind',
          'owner_driver',
          'riders',
          'km',
          'idle_min',
          'fares_php',
          'diesel_litres',
          'diesel_php',
          'boundary_other_php',
          'net_php',
          'tank_start_l',
          'diesel_bought_l',
          'refuels',
          'tank_end_l',
        ]),
        ...history.flatMap((h) =>
          h.totals.map((d, i) => {
            const m = dayMoney({ ...twin.fleet.vehicles[i], day: d });
            return csvRow([
              h.day,
              plateOf(i),
              twin.fleet.vehicles[i]?.kind ?? 'jeepney',
              d.owner ? 'yes' : 'no',
              d.riders,
              m.km.toFixed(3),
              m.idleMin.toFixed(1),
              m.fares.toFixed(2),
              m.litres.toFixed(3),
              m.diesel.toFixed(2),
              m.fixed.toFixed(2),
              m.net.toFixed(2),
              d.tankStartL.toFixed(2),
              d.fuelBoughtL.toFixed(2),
              d.refuels,
              (d.tankEndL ?? 0).toFixed(2),
            ]);
          }),
        ),
      ].join('\n'),
      'text/csv',
    );
  const exportLog = () =>
    download(
      `sakaysightai-stop-log-${now.replace(/:/g, '')}.csv`,
      [
        csvRow(['time', 'plate', 'stop', 'off', 'on', 'fares_php']),
        ...log.map((e) =>
          csvRow([
            clockText(startS + e.atS),
            plateOf(e.vehicle),
            stopName(e.stop),
            e.off,
            e.on,
            (e.fareCentavos / 100).toFixed(2),
          ]),
        ),
      ].join('\n'),
      'text/csv',
    );

  return (
    <section className="fleet-data" aria-label="All jeepneys data">
      <header className="fleet-data__bar">
        <strong>
          {route.name} · {rows.length} jeepneys · {now}
        </strong>
        <div className="row">
          <button
            type="button"
            className="btn"
            aria-pressed={tab === 'jeepneys'}
            onClick={() => setTab('jeepneys')}
          >
            All jeepneys
          </button>
          <button
            type="button"
            className="btn"
            aria-pressed={tab === 'log'}
            onClick={() => setTab('log')}
          >
            Stop log ({log.length})
          </button>
          <button
            type="button"
            className="btn"
            aria-pressed={tab === 'days'}
            onClick={() => setTab('days')}
          >
            Days ({history.length})
          </button>
          <button
            type="button"
            className="btn"
            onClick={tab === 'jeepneys' ? exportJeepneys : tab === 'log' ? exportLog : exportDays}
          >
            Export CSV
          </button>
          <button type="button" className="btn" onClick={() => setFleetData(false)}>
            Close
          </button>
        </div>
      </header>
      <div className="fleet-data__table">
        {tab === 'jeepneys' ? (
          <table>
            <thead>
              <tr>
                {COLUMNS.map((c, k) => (
                  <th key={c.name}>
                    <button
                      type="button"
                      className="linkish"
                      onClick={() =>
                        setSort((s) => ({
                          column: k,
                          descending: s.column === k ? !s.descending : true,
                        }))
                      }
                    >
                      {c.name}
                      {sort.column === k ? (sort.descending ? ' ▼' : ' ▲') : ''}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.v.id}
                  className={
                    follow?.kind === 'sim' && follow.index === r.index ? 'is-on' : undefined
                  }
                  onClick={() =>
                    setFollow({ kind: 'sim', index: r.index, view: follow?.view ?? 'chase' })
                  }
                >
                  {COLUMNS.map((c) => (
                    <td key={c.name} className={c.name === 'Status' ? undefined : 'mono'}>
                      {c.text(r)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th colSpan={4}>All {rows.length}</th>
                <td className="mono">{total((r) => r.v.occupancy)}</td>
                <td className="mono">{total((r) => r.v.day.riders)}</td>
                <td className="mono">{total((r) => r.money.km).toFixed(0)}</td>
                <td className="mono">{total((r) => r.v.tankL).toFixed(0)} L</td>
                <td className="mono">
                  {total((r) => r.v.day.fuelBoughtL).toFixed(0)} L · {total((r) => r.v.day.refuels)}{' '}
                  fill-ups
                </td>
                <td className="mono">{total((r) => r.money.idleMin).toFixed(0)} min</td>
                <td className="mono">{peso(total((r) => r.money.fares))}</td>
                <td className="mono">
                  {total((r) => r.money.litres).toFixed(0)} L · {peso(total((r) => r.money.diesel))}
                </td>
                <td className="mono">{peso(total((r) => r.money.fixed))}</td>
                <td className="mono">
                  <strong>{signed(total((r) => r.money.net))}</strong>
                </td>
              </tr>
            </tfoot>
          </table>
        ) : tab === 'days' ? (
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th>Riders</th>
                <th>Km</th>
                <th>Fares</th>
                <th>Diesel</th>
                <th>Diesel bought</th>
                <th>Boundary or upkeep + other</th>
                <th>Drivers’ net, all</th>
                <th>Net per jeepney</th>
              </tr>
            </thead>
            <tbody>
              {dayRows.length === 0 && (
                <tr>
                  <td colSpan={9}>
                    No day closed yet: each is added at 3 AM. Speed the clock up (up to 300×) to
                    watch the month build.
                  </td>
                </tr>
              )}
              {dayRows.map((d) => (
                <tr key={d.day}>
                  <td className="mono">{d.day}</td>
                  <td className="mono">{d.riders.toLocaleString()}</td>
                  <td className="mono">{d.km.toFixed(0)}</td>
                  <td className="mono">{peso(d.fares)}</td>
                  <td className="mono">
                    {d.litres.toFixed(0)} L · {peso(d.diesel)}
                  </td>
                  <td className="mono">
                    {d.bought.toFixed(0)} L · {d.refuels} fill-ups
                  </td>
                  <td className="mono">{peso(d.fixed)}</td>
                  <td className="mono">{signed(d.net)}</td>
                  <td className="mono">{signed(d.net / d.jeepneys)}</td>
                </tr>
              ))}
            </tbody>
            {dayRows.length > 0 && (
              <tfoot>
                <tr>
                  <th>
                    {dayRows.length} {dayRows.length === 1 ? 'day' : 'days'}
                  </th>
                  <td className="mono">
                    {dayRows.reduce((n, d) => n + d.riders, 0).toLocaleString()}
                  </td>
                  <td className="mono">{dayRows.reduce((n, d) => n + d.km, 0).toFixed(0)}</td>
                  <td className="mono">{peso(dayRows.reduce((n, d) => n + d.fares, 0))}</td>
                  <td className="mono">{peso(dayRows.reduce((n, d) => n + d.diesel, 0))}</td>
                  <td className="mono">{dayRows.reduce((n, d) => n + d.bought, 0).toFixed(0)} L</td>
                  <td className="mono">{peso(dayRows.reduce((n, d) => n + d.fixed, 0))}</td>
                  <td className="mono">
                    <strong>{signed(dayRows.reduce((n, d) => n + d.net, 0))}</strong>
                  </td>
                  <td className="mono">
                    {signed(dayRows.reduce((n, d) => n + d.net / d.jeepneys, 0) / dayRows.length)} a
                    day
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Plate</th>
                <th>Stop</th>
                <th>Off</th>
                <th>On</th>
                <th>Fares paid</th>
              </tr>
            </thead>
            <tbody>
              {log
                .slice(-LOG_SHOWN)
                .reverse()
                .map((e, k) => (
                  <tr key={`${e.atS}-${e.vehicle}-${k}`}>
                    <td className="mono">{clockText(startS + e.atS)}</td>
                    <td className="mono">{plateOf(e.vehicle)}</td>
                    <td>{stopName(e.stop)}</td>
                    <td className="mono">{e.off}</td>
                    <td className="mono">{e.on}</td>
                    <td className="mono">{peso(e.fareCentavos / 100)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        )}
      </div>
      <p className="fine fleet-data__note">
        Live from the simulation: fares are paid as riders get off, by distance (₱14 for the first 4
        km, ₱2 per started km after; 20% off for students, seniors and PWD). Diesel = km ÷{' '}
        {DEFAULT_EXPERIMENT.movingKmPerL} km/L + idle hours × {DEFAULT_EXPERIMENT.idleLPerHour} L/h
        for a jeepney (each kind its own: a bus {FUEL.bus.kmPerL} km/L) at ₱
        {ADVISORY.fuel.dieselPhpPerL}/L. Boundary: the fixed fee a driver who does not own the
        jeepney pays its owner for the day (₱{DEFAULT_EXPERIMENT.boundaryPhp}; a modern jeepney{' '}
        {boundaryRangeText('modern')}, a UV Express {boundaryRangeText('uv')}, a bus{' '}
        {boundaryRangeText('bus')}); an owner-driver pays none but their own upkeep (₱
        {DEFAULT_EXPERIMENT.ownerUpkeepPhp} a day, an assumption). Either is owed from the first
        trip, so a net starts negative each morning and climbs as fares come in. With and without
        SakaySightAI, month by month: the Profit &amp; service lab.{' '}
        {tab === 'log' && `Newest ${Math.min(LOG_SHOWN, log.length)} shown; the export has all.`}
      </p>
    </section>
  );
}
