/**
 * The driver's phone: the next stop and whether to stop there, the stops
 * just ahead, the jeepney in front, people close enough to flag you down,
 * and the diesel the plan saves. Nothing behind the jeepney.
 */

import { useEffect, useMemo, useState } from 'react';
import { driverTools } from '@/app/agentTools';
import { useRuntimes } from '@/app/runtimeContext';
import { useApp } from '@/app/store';
import { twinState } from '@/app/twinState';
import { dispatch } from '@/core/advisory/dispatch';
import { arrivalHeadsUp, driverView, type StopAhead } from '@/core/advisory/driver';
import { ADVISORY } from '@/core/advisory/model';
import { plannerRequest } from '@/core/advisory/plannerSnapshot';
import { driverScreen, voiceKeywords } from '@/core/advisory/screen';
import {
  DIESEL_WEEK,
  DRIVER_MAP_RADIUS_M,
  FUEL_LOOKAHEAD_M,
  fuelAdvice,
  fuelAhead,
  stationsFor,
  TOP_UP_LITRES,
} from '@/core/fuel/stations';
import { brandColour } from '@/scene/world/FuelStations';
import { fleetPose } from '@/scene/world/lanes';
import { dieselDoing } from '@/app/status';
import { KIND_NAME, KIND_WORD } from '@/core/vehicles/specs';
import type { FleetVehicle } from '@/core/fleet/fleetSim';
import { useTicker } from '../useTicker';
import { AutoAI } from '../AutoAI';
import { AskBox } from './AskBox';
import { ShareVehicle } from './ShareVehicle';
import { metres, minutes, peso } from './format';
import { Fold, PanelTabs, useTab } from '../Tabs';
import { PhoneFrame } from './PhoneFrame';
import { RouteSearch } from '../network/RouteSearch';
import { EarningsSection } from './EarningsSection';
import { defaultBudgetInputs } from '@/core/advisory/tripBudget';
import { TripBudgetSettings } from './TripBudgetSettings';

/** "Simulate traffic ahead": this far on, this long, for this long, at a crawl. */
const JAM = { aheadM: 150, lengthM: 900, forS: 900, mps: 1.2 };

const DRIVER_TABS = [
  ['now', 'Now'],
  ['diesel', 'Diesel'],
  ['earnings', 'Earnings'],
  ['ask', 'Ask'],
] as const;

const SUGGESTIONS = [
  'Are commuters approaching the next stop?',
  'Should I stop at the next stop?',
  'May traffic ba sa unahan? May shortcut ba at gas station doon?',
  'Dapat ko bang lampasan ang mga sasakyan sa unahan?',
  'Kasya ba ang upuan ko sa mga susunod na stop?',
  'May pasahero bang mahuhuli ng 1 hanggang 3 minuto?',
  'Saan ang pinakamurang diesel sa unahan?',
  'Magkano ang diesel sa 10 ikot, SM Tungko to SM Fairview at pabalik?',
];

function StopRow({ s }: { s: StopAhead }) {
  return (
    <li className={`ahead ahead--${s.action}`}>
      <div className="ahead__head">
        <strong>{s.name}</strong>
        <span className="mono">
          {metres(s.distanceM)} · {minutes(s.etaS)}
        </span>
      </div>
      <div className="ahead__body">
        <span className={`chip ${s.action === 'stop' ? 'chip--good' : ''}`}>
          {s.action === 'stop' ? 'Stop' : 'Pass'}
        </span>
        <span className="muted">{s.reason}</span>
      </div>
      {(s.waiting > 0 || s.dropOffs > 0) && (
        <div className="ahead__counts mono">
          {s.waiting} waiting · {s.forYou} for you · {s.dropOffs} off
        </div>
      )}
      {s.incoming.length > 0 && (
        <div className="ahead__counts">
          <span className="chip chip--warn">{s.incoming.length} approaching</span>{' '}
          {s.arrivingBeforeYou} expected before you
          <ul>
            {s.incoming.slice(0, 3).map((p) => (
              <li key={p.passenger}>
                {p.mode === 'tricycle' ? 'By tricycle' : 'Walking'} · {metres(p.distanceM)} to stop
                · {minutes(p.etaS)}
              </li>
            ))}
          </ul>
          {s.incoming.length > 3 && (
            <span className="muted">+{s.incoming.length - 3} more on the way</span>
          )}
        </div>
      )}
    </li>
  );
}

/** The jeepney's diesel: what is in the tank, and what its driver is doing about it. */
function dieselNow(twin: ReturnType<typeof useRuntimes>['twin'], jeep: FleetVehicle) {
  const doing = dieselDoing(twin.route, jeep);
  return {
    litres: jeep.tankL,
    capacity: jeep.tankCapacityL,
    share: jeep.tankL / jeep.tankCapacityL,
    doing,
  };
}

export function DriverPanel() {
  useTicker(2);
  const [tab, setTab] = useTab<(typeof DRIVER_TABS)[number][0]>('driver', 'now');
  const [budgetInputs, setBudgetInputs] = useState(() =>
    defaultBudgetInputs(ADVISORY.fuel.dieselPhpPerL),
  );
  const { twin } = useRuntimes();
  const index = useApp((s) => s.driverVehicle);
  // The trip costs start from this vehicle's own diesel, whatever kind it is.
  const kind = twin.fleet.vehicles[index]?.kind ?? 'jeepney';
  useEffect(() => {
    const own = defaultBudgetInputs(ADVISORY.fuel.dieselPhpPerL, kind);
    setBudgetInputs((b) => ({
      ...b,
      movingKmPerL: own.movingKmPerL,
      idleLPerHour: own.idleLPerHour,
    }));
  }, [kind]);
  const setDriverVehicle = useApp((s) => s.setDriverVehicle);
  const fuelLoaded = useApp((s) => s.network.fuel === true);
  const stations = useMemo(() => stationsFor(twin.route), [twin.route, fuelLoaded]);
  const jeep = twin.fleet.vehicles[index];
  if (!jeep) return null;

  const state = twinState(twin);
  const view = driverView(state, index, dispatch(state));
  const next = view.ahead[0];
  // Before the next stop, and the next thing to do, while there is a seat for them.
  const flagging = view.roadside.find((r) => r.canTake);
  const where = () => {
    const p = fleetPose(twin.fleet, index, { x: 0, z: 0, heading: 0 });
    return { s: jeep.s, direction: jeep.direction, x: p.x, z: p.z };
  };
  const diesel = fuelAhead(twin.route, stations, where());
  const refuel = fuelAdvice(diesel);
  const tank = dieselNow(twin, jeep);
  const screenNow = () => {
    const now = twinState(twin);
    return {
      ...driverScreen(
        driverView(now, index, dispatch(now)),
        fuelAhead(twin.route, stations, where()),
      ),
      // The twin's own tank (a real jeepney: the driver's word, or a fuel sensor).
      tank: {
        litres: Math.round(tank.litres * 10) / 10,
        capacityL: Math.round(tank.capacity),
        percent: Math.round(tank.share * 100),
        now: tank.doing ?? 'enough for now',
        boughtTodayL: Math.round(jeep.day.fuelBoughtL),
      },
    };
  };
  const simulateJam = () =>
    twin.fleet.addSlowZone(
      jeep.s + (jeep.direction === 1 ? JAM.aheadM : -JAM.aheadM - JAM.lengthM),
      JAM.lengthM,
      JAM.forS,
      JAM.mps,
    );

  return (
    <div className="panel__body">
      <PhoneFrame
        app="Driver"
        who={
          <select
            className="phone__select"
            aria-label="Whose phone"
            value={index}
            onChange={(e) => setDriverVehicle(Number(e.target.value))}
          >
            {twin.fleet.vehicles.map((v, i) => (
              <option key={v.id} value={i}>
                {v.plate}
                {v.kind !== 'jeepney' && ` · ${KIND_NAME[v.kind]}`}
              </option>
            ))}
          </select>
        }
      >
        <PanelTabs label="Driver" tabs={DRIVER_TABS} active={tab} onChange={setTab} />
        <ShareVehicle />
        <AutoAI subject={{ kind: 'vehicle', index }} name={jeep.plate} />
        {tab === 'now' && (
          <>
            {flagging ? (
              <section className="hero hero--stop">
                <span className="hero__label">By the road · {metres(flagging.distanceM)}</span>
                <strong className="hero__title">Someone waiting, not at a stop</strong>
                <span className="hero__action">PULL OVER</span>
                <span>1 rider going your way</span>
              </section>
            ) : next ? (
              <section className={`hero hero--${next.action}`}>
                <span className="hero__label">Next stop · {metres(next.distanceM)}</span>
                <strong className="hero__title">{next.name}</strong>
                <span className="hero__action">{next.action === 'stop' ? 'STOP' : 'PASS'}</span>
                <span>{next.reason}</span>
                {next.para && (
                  <span className="chip chip--warn">“Para!” {next.dropOffs} getting off</span>
                )}
              </section>
            ) : (
              <section className="hero">
                <strong className="hero__title">No stops ahead</strong>
              </section>
            )}

            <div className="counters">
              <div className="counter">
                <span className="counter__label">On board</span>
                <span className="counter__value mono">{view.seats.onBoard}</span>
                <span className="counter__note">
                  {jeep.kind === 'jeepney' ? 'cabin camera' : 'door cameras'}
                </span>
              </div>
              <div
                className={`counter ${view.seats.free === 0 ? 'counter--bad' : 'counter--good'}`}
              >
                <span className="counter__label">Room left</span>
                <span className="counter__value mono">{view.seats.free}</span>
                <span className="counter__note">of {view.seats.capacity}</span>
              </div>
              <div className="counter">
                <span className="counter__label">Near you</span>
                <span className="counter__value mono">{view.eyesight.length}</span>
                <span className="counter__note">within {ADVISORY.eyesightM} m</span>
              </div>
            </div>
            {tank.doing && <p className="chip chip--warn">⛽ {tank.doing}</p>}

            <section className="section">
              <h3 className="section__title">Heads-up</h3>
              <p>{next ? arrivalHeadsUp(next) : 'No upcoming stop to check.'}</p>
              <p className="fine">Estimates. Recheck at the stop.</p>
            </section>

            <section className="section">
              <h3 className="section__title">Ahead</h3>
              <ul className="ahead-list">
                {view.roadside.map((r) => (
                  <li key={r.passenger} className={`ahead ahead--${r.canTake ? 'stop' : 'pass'}`}>
                    <div className="ahead__head">
                      <strong>Waiting by the road</strong>
                      <span className="mono">
                        {metres(r.distanceM)} · {minutes(r.etaS)}
                      </span>
                    </div>
                    <div className="ahead__body">
                      <span className={`chip ${r.canTake ? 'chip--good' : ''}`}>
                        {r.canTake ? 'Pull over' : 'Pass'}
                      </span>
                      <span className="muted">
                        {r.canTake ? '1 rider, not at a stop' : 'No free seats'}
                      </span>
                    </div>
                  </li>
                ))}
                {view.ahead.map((s) => (
                  <StopRow key={s.stop} s={s} />
                ))}
              </ul>
              {view.eyesight.some((e) => e.behind) && (
                <p className="chip chip--warn">
                  Someone just behind you may be running for the {KIND_WORD[jeep.kind]}
                </p>
              )}
            </section>

            <section className="section">
              <h3 className="section__title">Vehicle in front</h3>
              {view.leader ? (
                <div className="kv">
                  <span>Plate</span>
                  <span className="mono">{view.leader.plate}</span>
                  <span>Distance</span>
                  <span className="mono">{metres(view.leader.distanceM)}</span>
                  <span>Room left</span>
                  <span className="mono">{view.leader.freeSeats}</span>
                </div>
              ) : (
                <p className="muted">None within sight. You pick up first.</p>
              )}
            </section>

            <section className="section">
              <Fold title="Change route">
                <p className="route__name">{twin.route.name}</p>
                <RouteSearch placeholder="Drive another route (e.g. Cubao, Alabang)" />
              </Fold>
            </section>
          </>
        )}

        {tab === 'diesel' && (
          <>
            <section className="section">
              <h3 className="section__title">My diesel</h3>
              <div
                className={`fuel-gauge ${tank.share < 0.25 ? 'fuel-gauge--low' : ''}`}
                role="meter"
                aria-label="Diesel in the tank"
                aria-valuemin={0}
                aria-valuemax={tank.capacity}
                aria-valuenow={Math.round(tank.litres)}
              >
                <span style={{ width: `${Math.round(tank.share * 100)}%` }} />
              </div>
              <div className="kv">
                <span>In the tank</span>
                <span className="mono">
                  {tank.litres.toFixed(1)} of {tank.capacity.toFixed(0)} L ·{' '}
                  {Math.round(tank.share * 100)}%
                </span>
                <span>Now</span>
                <span>
                  {tank.doing ??
                    'Enough for now. Below a quarter of the tank, or before it could not reach the station after next, it fills up at the next one on your side.'}
                </span>
                <span>Today</span>
                <span className="mono">
                  started {jeep.day.tankStartL.toFixed(0)} L · burnt {jeep.day.fuelUsedL.toFixed(1)}{' '}
                  L · bought {jeep.day.fuelBoughtL.toFixed(0)} L ({jeep.day.refuels} fill-up
                  {jeep.day.refuels === 1 ? '' : 's'})
                </span>
              </div>
            </section>

            <section className="section">
              <h3 className="section__title">Diesel to the terminal</h3>
              <div className="kv">
                <span>Distance</span>
                <span className="mono">{view.fuel.km.toFixed(1)} km</span>
                <span>Stops</span>
                <span className="mono">
                  {view.fuel.stopsPlanned} of {view.fuel.stopsAll}
                </span>
                <span>This plan</span>
                <span className="mono">{view.fuel.litres.toFixed(2)} L</span>
                <span>Saved</span>
                <span className="mono">
                  {(view.fuel.savedLitres * 1000).toFixed(0)} mL · {peso(view.fuel.savedPhp)}
                </span>
              </div>
            </section>

            <section className="section">
              <h3 className="section__title">Gas stations ahead</h3>
              {refuel.nearest && !tank.doing && tank.share >= 0.5 && (
                <p className="muted">
                  No need yet: {Math.round(tank.share * 100)}% in the tank. When you do, these are
                  on your way.
                </p>
              )}
              {refuel.nearest && (tank.doing || tank.share < 0.5) && (
                <div className="kv">
                  <span>Fill up now</span>
                  <span>
                    {refuel.nearest.station.brand}, {metres(refuel.nearest.distanceM)}
                    {refuel.nearest.expectedPhpPerL !== null &&
                      ` · ~${peso(refuel.nearest.expectedPhpPerL)}/L`}
                  </span>
                  {refuel.cheaper && (
                    <>
                      <span>Can wait?</span>
                      <span>
                        {refuel.cheaper.station.brand} in {metres(refuel.cheaper.distanceM)} · saves
                        ~{peso(refuel.savingPhp)} on {TOP_UP_LITRES} L
                        {!refuel.cheaper.onMap && ' (not on your map yet)'}
                      </span>
                    </>
                  )}
                </div>
              )}
              {diesel.length === 0 ? (
                <p className="muted">
                  No station on your side in the next {FUEL_LOOKAHEAD_M / 1000} km.
                </p>
              ) : (
                <ul className="ahead-list">
                  {diesel.map((f) => (
                    <li key={f.station.id} className="ahead">
                      <div className="ahead__head">
                        <strong>
                          <span
                            className="fuel-dot"
                            style={{ background: brandColour(f.station.brand) }}
                            aria-hidden="true"
                          />
                          {f.station.brand}
                        </strong>
                        <span className="mono">{metres(f.distanceM)}</span>
                      </div>
                      <div className="ahead__body">
                        <span className="mono">
                          {f.price
                            ? `Diesel ${peso(f.price.min)}–${peso(f.price.max)}/L`
                            : 'Diesel price not listed by the DOE'}
                        </span>
                        {f.expectedPhpPerL !== null && (
                          <span className="muted">~{peso(f.expectedPhpPerL)}</span>
                        )}
                        {f.cheapest && <span className="chip chip--good">Cheapest ahead</span>}
                        <span className={`chip ${f.onMap ? '' : 'chip--warn'}`}>
                          {f.onMap ? 'On your map' : 'Further ahead'}
                        </span>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <Fold title="About these prices">
                <p className="fine">
                  Only stations on your side you can pull straight into, all on your way. Your map
                  shows gas stations within {DRIVER_MAP_RADIUS_M / 1000} km; further ones are listed
                  here when they are worth knowing. Prices: DOE, week{' '}
                  {DIESEL_WEEK.replace('/', ' to ')}; the brand’s range in Caloocan and Quezon City
                  (~ is its middle), not this pump’s own price. Costs above use{' '}
                  {peso(ADVISORY.fuel.dieselPhpPerL)}/L.
                </p>
              </Fold>
            </section>
          </>
        )}

        {/* Stays mounted on the other tabs: hands-free goes on listening while they show. */}
        <section className="section" hidden={tab !== 'ask'}>
          <h3 className="section__title">Ask</h3>
          <TripBudgetSettings value={budgetInputs} onChange={setBudgetInputs} />
          <AskBox
            fab
            suggestions={SUGGESTIONS}
            keywords={voiceKeywords(twin.route)}
            agent={{ role: 'driver', screen: screenNow, run: driverTools(twin, index) }}
            request={() => ({
              ...plannerRequest(twinState(twin), { role: 'driver', vehicle: index }),
              tripBudgetInputs: budgetInputs,
              dieselPriceBasis: `editable input; app price dataset dated ${DIESEL_WEEK}, not a live pump quote`,
              screen: screenNow(),
            })}
            handsFree
          />
          <Fold title="Try it out">
            <button type="button" className="btn" onClick={simulateJam}>
              Simulate traffic ahead
            </button>
            <p className="fine">
              A jam starts just ahead of this vehicle for 15 simulated minutes. Then ask about the
              traffic or a shortcut.
            </p>
          </Fold>
        </section>

        {tab === 'earnings' && <EarningsSection twin={twin} index={index} />}

        <p className="fine phone__note">
          Shows only what is ahead: {ADVISORY.horizonStops} stops or{' '}
          {(ADVISORY.horizonM / 1000).toFixed(1)} km. Behind you, only people within{' '}
          {ADVISORY.eyesightM} m. Estimates; fuel figures until measured on a real vehicle.
        </p>
      </PhoneFrame>
    </div>
  );
}
