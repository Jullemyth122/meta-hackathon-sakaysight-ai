/**
 * The operator's money and service for the whole fleet: every jeepney of the
 * twin today so far (the same rule as each driver's "My earnings",
 * app/earnings.ts), and the way into the Profit & service lab, which
 * belongs to this view. The table of every jeepney is opened under the map.
 */

import { dayMoney } from '@/app/earnings';
import { useRuntimes } from '@/app/runtimeContext';
import { MAX_DAYS } from '@/app/twinRuntime';
import { peso } from './phone/format';
import { Fold } from './Tabs';

const signed = (php: number) => (php < 0 ? '−' : '') + peso(Math.abs(php));

export function FleetEarnings() {
  const { twin } = useRuntimes();
  const vs = twin.fleet.vehicles;
  if (vs.length === 0) return null;
  const money = vs.map(dayMoney);
  const sum = (f: (m: (typeof money)[number]) => number) => money.reduce((s, m) => s + f(m), 0);
  const riders = vs.reduce((n, v) => n + v.day.riders, 0);
  const net = sum((m) => m.net);
  const out = vs.filter((v) => v.duty !== 'parked').length;
  // The month so far: every closed day of the ledger.
  const month = twin.fleet.history.reduce(
    (n, h) =>
      n + h.totals.reduce((m, d, i) => m + dayMoney({ ...twin.fleet.vehicles[i], day: d }).net, 0),
    0,
  );
  const days = twin.fleet.history.length;

  return (
    <section className="section">
      <h3 className="section__title">Today’s money, whole fleet</h3>
      <div className="kv">
        <span>Today, day {Math.min(twin.fleet.dayNumber, MAX_DAYS)}</span>
        <span className="mono">
          {out} of {vs.length} out · {riders} riders
        </span>
        <span>Fares</span>
        <span className="mono">{peso(sum((m) => m.fares))}</span>
        <span>Diesel</span>
        <span className="mono">
          {sum((m) => m.litres).toFixed(0)} L · {peso(sum((m) => m.diesel))}
        </span>
        <span>Boundary + other</span>
        <span className="mono">{peso(sum((m) => m.fixed))}</span>
        <span>Drivers’ net, all</span>
        <span className="mono">
          <strong>{signed(net)}</strong> ({signed(net / vs.length)} each)
        </span>
        <span>Month so far</span>
        <span className="mono">
          {days === 0
            ? 'no day closed yet (at 3 AM)'
            : `${signed(month)} in ${days} days · ${signed(month / days / vs.length)} a vehicle a day`}
        </span>
      </div>
      <Fold title="What these mean">
        <p className="fine">
          Live from the simulation. Boundary: the fixed fee each driver pays the owner for the day,
          owed from the first trip, so nets start negative each morning. Every vehicle, stop and
          day: More → All vehicles data, on the map.
        </p>
      </Fold>
    </section>
  );
}
