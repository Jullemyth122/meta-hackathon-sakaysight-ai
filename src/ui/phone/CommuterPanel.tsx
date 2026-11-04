/**
 * The commuter's phone: which jeepney comes next and whether it has a seat,
 * which one takes you (first come, first served), when you get there, and
 * the fare. Plan a trip (where you are, where you are going: TripPlanner),
 * or be someone already in the twin; then the phone follows that rider.
 */

import { commuterTools } from '@/app/agentTools';
import { useRuntimes } from '@/app/runtimeContext';
import { useApp } from '@/app/store';
import { chainWay, knownWay } from '@/app/streetWays';
import { twinState } from '@/app/twinState';
import { commuterView, riderOf, type CommuterView } from '@/core/advisory/commuter';
import { dispatch } from '@/core/advisory/dispatch';
import { plannerRequest } from '@/core/advisory/plannerSnapshot';
import { commuterScreen, voiceKeywords } from '@/core/advisory/screen';
import { stopsAhead, type Route } from '@/core/geo/routes';
import { WALK_TO_STOP_M } from '@/core/network/plan';
import { YOUR_SPOT } from '@/core/network/roadside';
import { besideRoad } from '@/core/people/onward';
import type { LocalPoint } from '@/core/geo/projection';
import { AutoAI } from '../AutoAI';
import { LocateMe } from './LocateMe';
import { PASSENGER_PHASE, passengerName } from '../PassengerPanel';
import { useTicker } from '../useTicker';
import { AskBox } from './AskBox';
import { clockIn, metres, minutes, peso } from './format';
import { PhoneFrame } from './PhoneFrame';
import { TripPlanner } from '../network/TripPlanner';
import { focusRoute, getNetwork, routeIndex, tripSummary } from '@/app/network';
import { useEffect, useState } from 'react';
import { discountedKind, RIDER_KIND_LABEL, type RiderKind } from '@/core/fare';
import { KIND_NAME, KIND_WORD } from '@/core/vehicles/specs';
import { PanelTabs, useTab } from '../Tabs';
import { kindOf } from '@/core/people/passengerSystem';

const COMMUTER_TABS = [
  ['trip', 'My trip'],
  ['ask', 'Ask'],
] as const;

const SUGGESTIONS = [
  'When does my ride come?',
  'Will it have a seat for me?',
  'Anong oras ang susunod na sakay?',
  'Na-miss ko ang sakay ko. Ano ang gagawin ko?',
];
const PLANNING_QUESTIONS = [
  'Paano pumunta sa Cubao?',
  'Paano pumunta sa Philcoa mula SM Fairview?',
];
/** Riders offered in the "follow" list: those whose trip is still ahead. */
const arrivalTime = (s: number) => (s < 60 ? `${Math.max(1, Math.ceil(s))} sec` : minutes(s));

/** Who pays what: a discount group's fare, or the regular one. */
function fareLine(kind: RiderKind, fare: number, discounted: number): string {
  if (discountedKind(kind))
    return `${peso(discounted)} · ${RIDER_KIND_LABEL[kind].toLowerCase()}, 20% off (regular ${peso(fare)})`;
  if (kind === 'pregnant') return `${peso(fare)} · regular fare; ask for a priority seat`;
  return `${peso(fare)} · regular fare`;
}

/** Where you can ride to from `stop`: every stop up to the next terminal. */
function destinations(route: Route, stop: number): number[] {
  if (route.loop) return stopsAhead(route, stop, 1);
  return route.stops.map((_, i) => i).filter((i) => i !== stop);
}

/** Riders offered to be at once. */
const BE_LIST = 8;
/** Who to offer first: people at a stop, then on their way to one, then riding. */
const BE_ORDER = ['waiting', 'approaching', 'boarding', 'seated', 'alighting'];

/**
 * Someone already in the twin to be: every rider has an ID; pick one (or
 * find them by it) and this phone shows their trip, the camera on them.
 */
function BeSomeone() {
  const { twin } = useRuntimes();
  const setCommuter = useApp((s) => s.setCommuter);
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();
  const stops = twin.route.stops;
  const people = [...twin.crew.passengers.values()]
    .filter((r) => BE_ORDER.includes(r.phase))
    .filter((r) => !q || passengerName(r.id).toLowerCase().includes(q))
    .sort((a, b) => BE_ORDER.indexOf(a.phase) - BE_ORDER.indexOf(b.phase) || a.id - b.id)
    .slice(0, BE_LIST);
  return (
    <div className="route-search">
      <p className="muted">
        Every rider in the twin has an ID. Pick one and this phone becomes theirs; the camera
        follows them.
      </p>
      <input
        type="search"
        className="input"
        aria-label="Find a rider by ID"
        placeholder="Rider ID, e.g. P0718"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {people.length === 0 ? (
        <p className="muted">
          {q
            ? 'No rider with that ID on this route right now.'
            : 'Nobody is out on this route yet.'}
        </p>
      ) : (
        <ul className="route-search__results">
          {people.map((r) => (
            <li key={r.id}>
              <button
                type="button"
                className="route-search__item route-search__item--stack"
                onClick={() => setCommuter({ passenger: r.id, chosen: true })}
              >
                <span>
                  <b className="mono">{passengerName(r.id)}</b> · {RIDER_KIND_LABEL[kindOf(r)]} ·{' '}
                  {PASSENGER_PHASE[r.phase]}
                </span>
                <span className="mono">
                  {stops[r.originStop]?.name} → {stops[r.destinationStop]?.name}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Ask before setting out: where to go, or a photo of a vehicle's signboard. */
/** Where no street joins them, straight there. */
const straightWay = (a: LocalPoint, b: LocalPoint) => ({
  points: [a, b],
  widths: [0],
  metres: Math.hypot(b.x - a.x, b.z - a.z),
});

function PlanAsk({ stop, destination }: { stop: number; destination: number }) {
  const { twin } = useRuntimes();
  return (
    <section className="section">
      <h3 className="section__title">Ask Sakay</h3>
      <AskBox
        fab
        suggestions={PLANNING_QUESTIONS}
        keywords={voiceKeywords(twin.route)}
        agent={{ role: 'commuter', screen: () => undefined, run: commuterTools(twin) }}
        request={() =>
          plannerRequest(twinState(twin), {
            role: 'commuter',
            stop,
            destination,
            direction: 1,
            jeepneys: [],
          })
        }
      />
    </section>
  );
}

function Hero({ view, clockS }: { view: CommuterView; clockS: number }) {
  if (view.riding)
    return (
      <section className="hero hero--stop">
        <span className="hero__label">
          On {view.riding.plate}
          {view.riding.kind !== 'jeepney' && ` · ${KIND_NAME[view.riding.kind]}`}
        </span>
        <strong className="hero__title">{metres(view.riding.remainingM)} to go</strong>
        <span>
          {view.destination.name} in {minutes(view.riding.etaS)} · around{' '}
          {clockIn(view.riding.etaS, clockS)}
        </span>
      </section>
    );
  if (view.trip.arriveInS === 0)
    return (
      <section className="hero hero--stop">
        <strong className="hero__title">Arrived</strong>
        <span>{view.destination.name}</span>
      </section>
    );
  if (!view.pickup)
    return (
      <section className="hero hero--pass">
        <span className="hero__label">Boarding at {view.stop.name}</span>
        <strong className="hero__title">
          {view.approach ? 'Finding a ride you can catch' : 'No seat in sight yet'}
        </strong>
        <span>
          {view.arrivals.length > 0
            ? view.approach
              ? 'The ones coming now may arrive before you or have no seats. We’ll update as you get closer.'
              : 'The ones coming are full by the time they reach you.'
            : 'Nothing is heading here right now.'}
        </span>
      </section>
    );
  return (
    <section className="hero hero--stop">
      <span className="hero__label">
        Suggested {KIND_WORD[view.pickup.kind]} · {view.pickup.plate}
      </span>
      <strong className="hero__title">{minutes(view.pickup.etaS)}</strong>
      <span>
        {metres(view.pickup.distanceM)} away, {view.pickup.seatsForYou} seat
        {view.pickup.seatsForYou === 1 ? '' : 's'} left for you
      </span>
    </section>
  );
}

export function CommuterPanel() {
  useTicker(2);
  const { twin } = useRuntimes();
  const me = useApp((s) => s.me);
  const route = twin.route;
  const query = useApp((s) => s.commuter);
  const setCommuter = useApp((s) => s.setCommuter);
  const setFocus = useApp((s) => s.setFocus);
  const tripLegs = useApp((s) => s.tripLegs);
  const tripLeg = useApp((s) => s.tripLeg);
  const pendingJoin = useApp((s) => s.pendingJoin);
  const startLeg = useApp((s) => s.startLeg);
  const clearPendingJoin = useApp((s) => s.clearPendingJoin);
  const picked = useApp((s) => s.commuterVehicle);
  const [tab, setTab] = useTab<(typeof COMMUTER_TABS)[number][0]>('commuter', 'trip');

  // A planned trip: once its route is the focused one, "you" join the twin
  // as a rider walking to the stop, and the phone follows you.
  useEffect(() => {
    if (
      !pendingJoin ||
      useApp.getState().pendingJoin !== pendingJoin ||
      twin.route.id !== pendingJoin.routeId
    )
      return;
    const leg = useApp.getState().tripLegs?.[pendingJoin.leg];
    clearPendingJoin();
    if (!leg) return;
    // The very way the map showed, when it is in: the streets, not a straight line.
    const route = twin.route;
    const board = route.polyline.pointAt(route.stops[leg.board]!.s);
    const way = leg.from
      ? chainWay(
          leg.flag
            ? [leg.from, leg.flag.at]
            : leg.via
              ? [leg.from, leg.via, board]
              : [leg.from, board],
          leg.approachMode ?? 'walk',
        )
      : undefined;
    // Off the last jeepney: on to where they said, by the way the map showed.
    const { tripLegs: legs, tripEnds } = useApp.getState();
    const off = route.polyline.pointAt(route.stops[leg.alight]!.s);
    const to = pendingJoin.leg === (legs?.length ?? 0) - 1 ? tripEnds.to?.at : undefined;
    const known = to && knownWay(off, to);
    const onwardWay = known ?? (to && straightWay(off, to));
    setCommuter({
      // From where the trip starts (the place chosen), to the stop the planner chose.
      passenger: twin.crew.join(leg.board, leg.alight, way?.metres ?? leg.walkM, leg.approachMode, {
        kind: useApp.getState().me.kind,
        ...(leg.from && { from: leg.from, keepStop: true }),
        ...(way && { way }),
        ...(leg.flag && { flagS: leg.flag.s, flagAt: leg.flag.at }),
        ...(onwardWay && {
          onward: {
            way: onwardWay,
            to: besideRoad(route, to!),
            mode: onwardWay.metres <= WALK_TO_STOP_M ? ('walk' as const) : ('tricycle' as const),
          },
        }),
      }),
    });
  }, [pendingJoin, twin, clearPendingJoin, setCommuter]);

  const state = twinState(twin);
  const plan = dispatch(state);
  const following = 'passenger' in query;
  // A vehicle picked for this phone: be someone riding it, as soon as someone is.
  const riderToBe = picked === null ? null : riderOf(state, plan, picked);
  useEffect(() => {
    if (riderToBe !== null) setCommuter({ passenger: riderToBe, chosen: true });
  }, [riderToBe, setCommuter]);
  // The second jeepney of a planned trip, once the first ride is over.
  const planned = tripLegs?.[tripLeg + 1];
  const nextLegRoute = planned ? getNetwork()?.routes[planned.route]?.route : undefined;
  // Only with its route at hand (the network can be reloading).
  const nextLeg = nextLegRoute ? planned : undefined;
  const continueTrip = () => {
    if (!nextLeg || !nextLegRoute) return;
    if (routeIndex(twin.route.id) !== nextLeg.route)
      setFocus(focusRoute(nextLeg.route, twin), true);
    setCommuter({ stop: nextLeg.board, destination: nextLeg.alight });
    startLeg(tripLeg + 1, nextLegRoute.id);
  };
  // A rider whose trip is over has left the twin.
  if (following && !twin.crew.passengers.has(query.passenger))
    return (
      <div className="panel__body">
        <PhoneFrame app="Commuter" who="My trip">
          <section className="hero hero--stop">
            <strong className="hero__title">
              {nextLeg ? 'Change rides here' : 'Trip finished'}
            </strong>
            <span>
              {nextLeg
                ? `Walk ${metres(nextLeg.walkM)} to ${nextLegRoute!.stops[nextLeg.board]!.name} for ${nextLegRoute!.name}.`
                : query.chosen
                  ? `${passengerName(query.passenger)} has reached where they were going.`
                  : 'Your demo trip has ended.'}
            </span>
          </section>
          {nextLeg && (
            <section className="section">
              <button type="button" className="btn btn--primary" onClick={continueTrip}>
                Continue: {nextLegRoute!.name}
              </button>
            </section>
          )}
          <section className="section">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() =>
                setCommuter({ stop: 0, destination: destinations(route, 0).at(-1) ?? 0 })
              }
            >
              Plan a trip
            </button>
          </section>
        </PhoneFrame>
      </div>
    );
  // Planning: one way in. Where you are and where you are going, on the map
  // or by name; the trip drawn on the map, then taken (TripPlanner).
  if (!following)
    return (
      <div className="panel__body">
        <PhoneFrame app="Commuter" who="My trip">
          <LocateMe />
          {picked !== null && twin.fleet.vehicles[picked] && (
            <section className="hero hero--pass" aria-live="polite">
              <span className="hero__label">{KIND_NAME[twin.fleet.vehicles[picked]!.kind]}</span>
              <strong className="hero__title">{twin.fleet.vehicles[picked]!.plate}</strong>
              <span>Nobody on it yet. This phone joins the first rider who gets on.</span>
            </section>
          )}
          <section className="section">
            <h3 className="section__title">Plan my trip</h3>
            <p className="muted">
              Click the map where you are and where you are going, or type a place. The app finds
              your waiting area and ride and draws the whole trip on the map. Take it, and you go to
              the waiting area on foot or by tricycle, as you choose.
            </p>
            <span className="chip">Simulation · individual commuter</span>
          </section>
          <PlanAsk stop={query.stop} destination={query.destination} />
          <TripPlanner />
          <details className="section">
            <summary className="section__title">Or be someone already on the map</summary>
            <BeSomeone />
          </details>
        </PhoneFrame>
      </div>
    );
  const view = commuterView(state, plan, query);
  const rider = twin.crew.passengers.get(query.passenger);
  const kind = rider ? kindOf(rider) : me.kind;
  const doing =
    rider?.phase === 'approaching' && rider.approachMode === 'tricycle'
      ? `Riding a tricycle to ${view.roadside ? YOUR_SPOT : 'the waiting area'}`
      : rider?.phase === 'approaching' && view.roadside
        ? `Walking to ${YOUR_SPOT}`
        : PASSENGER_PHASE[view.phase as keyof typeof PASSENGER_PHASE];
  // Back to planning (the rider, if someone else's, stays in the twin).
  const leave = () => setCommuter({ stop: view.stop.index, destination: view.destination.index });

  return (
    <div className="panel__body">
      <PhoneFrame app="Commuter" who="My trip">
        <PanelTabs label="Commuter" tabs={COMMUTER_TABS} active={tab} onChange={setTab} />
        <LocateMe />
        <AutoAI
          subject={{ kind: 'person', id: query.passenger }}
          name={query.chosen ? passengerName(query.passenger) : 'your trip'}
        />
        {tab === 'trip' && (
          <>
            <Hero view={view} clockS={twin.clockS} />
            <section className="section">
              <h3 className="section__title">
                {query.chosen ? `Being ${passengerName(query.passenger)}` : 'My trip'}
              </h3>
              <p>
                <b className="mono">{passengerName(query.passenger)}</b> · {RIDER_KIND_LABEL[kind]}{' '}
                · {doing}
              </p>
              <p className="muted">
                {route.name}: {view.stop.name} → {view.destination.name}
              </p>
            </section>
            <section className="section" aria-live="polite">
              <h3 className="section__title">My journey</h3>
              <ol className="journey-steps">
                <li aria-current={view.phase === 'approaching' ? 'step' : undefined}>
                  {view.roadside ? 'Getting to your spot' : 'Getting to the stop'}
                </li>
                <li aria-current={view.phase === 'waiting' ? 'step' : undefined}>
                  Waiting for {view.pickup ? `the ${KIND_WORD[view.pickup.kind]}` : 'a ride'}
                </li>
                <li aria-current={view.riding ? 'step' : undefined}>On board</li>
                <li aria-current={view.trip.arriveInS === 0 ? 'step' : undefined}>Arrived</li>
              </ol>
              {view.approach && (
                <div className="hero hero--pass">
                  <span className="hero__label">
                    {view.approach.mode === 'tricycle' ? 'Riding a tricycle' : 'Walking'} to{' '}
                    {view.stop.name}
                  </span>
                  <strong className="hero__title">
                    {metres(view.approach.distanceM)} to your {view.roadside ? 'spot' : 'stop'}
                  </strong>
                  <span>Estimated arrival in {arrivalTime(view.approach.etaS)}</span>
                  <span className="fine">
                    {view.roadside
                      ? 'Stand at the side of the road: whatever comes going your way with a seat stops for you there.'
                      : view.approach.distanceM <= 500
                        ? 'Shown as incoming to drivers and the Operational Twin. You are not in the queue yet.'
                        : 'You will appear in nearby incoming counts within 500 m of the stop.'}
                  </span>
                </div>
              )}
              {view.phase === 'waiting' && (
                <p className="chip chip--good">
                  {view.roadside
                    ? 'You are by the road · wave it down, it will stop for you'
                    : `You are at the stop · ${view.queueAhead} ahead in the queue`}
                </p>
              )}
              {query.chosen ? (
                // Someone else's trip: leave them to it, they stay in the twin.
                <button type="button" className="btn" onClick={leave}>
                  Stop being {passengerName(query.passenger)}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => {
                      // Not yet on a jeepney: gone from the twin. On one: rides on
                      // as anyone else would; the phone stops following.
                      twin.crew.cancel(query.passenger);
                      useApp.getState().setTripLegs(null);
                      leave();
                    }}
                  >
                    Cancel my trip
                  </button>
                  <p className="fine">
                    Your home, waiting area and destination stay as they are: change any of them, or
                    take the trip again.
                  </p>
                </>
              )}
            </section>

            {!view.riding && view.trip.arriveInS !== 0 && (
              <section className="section">
                <h3 className="section__title">Coming to {view.stop.name}</h3>
                {view.arrivals.length === 0 && <p className="muted">Nothing on its way.</p>}
                <ul className="ahead-list">
                  {view.arrivals.map((a) => (
                    <li
                      key={a.vehicle}
                      className={`ahead ${a.vehicle === view.pickup?.vehicle ? 'ahead--stop' : ''}`}
                    >
                      <div className="ahead__head">
                        <strong className="mono">
                          {a.plate}
                          {a.kind !== 'jeepney' && (
                            <span className="muted"> · {KIND_NAME[a.kind]}</span>
                          )}
                        </strong>
                        <span className="mono">
                          {minutes(a.etaS)} · {metres(a.distanceM)}
                        </span>
                      </div>
                      <div className="ahead__body">
                        <span
                          className={`chip ${a.catchable && a.seatsForYou > 0 ? 'chip--good' : 'chip--bad'}`}
                        >
                          {!a.catchable
                            ? 'Arrives before you reach the stop'
                            : a.seatsForYou > 0
                              ? `~${a.seatsForYou} seats available`
                              : 'Full for you'}
                        </span>
                        <span className="muted">{a.freeSeats} free on arrival</span>
                      </div>
                    </li>
                  ))}
                </ul>
                <p className="fine">
                  {view.queueAhead} {view.queueAhead === 1 ? 'person' : 'people'} ahead of you in
                  the queue board first. Seats are estimates, not reservations.
                </p>
              </section>
            )}

            <section className="section">
              <h3 className="section__title">Trip</h3>
              <div className="kv">
                <span>Distance</span>
                <span className="mono">{metres(view.trip.distanceM)}</span>
                <span>Fare</span>
                <span className="mono">
                  {fareLine(kind, view.trip.fare, view.trip.fareDiscounted)}
                  {view.trip.by !== 'jeepney' && ` · by ${KIND_WORD[view.trip.by]}`}
                </span>
                <span>Arrive</span>
                <span className="mono">
                  {view.trip.arriveInS === null
                    ? 'once a ride has a seat'
                    : view.trip.arriveInS === 0
                      ? 'arrived'
                      : `around ${clockIn(view.trip.arriveInS, twin.clockS)} (${minutes(view.trip.arriveInS)})`}
                </span>
              </div>
            </section>
          </>
        )}

        {tab === 'ask' && (
          <section className="section">
            <h3 className="section__title">Ask</h3>
            <AskBox
              fab
              suggestions={SUGGESTIONS}
              keywords={voiceKeywords(twin.route)}
              agent={{
                role: 'commuter',
                run: commuterTools(twin),
                screen: () => {
                  const now = twinState(twin);
                  if (!twin.crew.passengers.has(query.passenger)) return undefined;
                  const shown = commuterView(now, dispatch(now), query);
                  return {
                    ...commuterScreen(shown),
                    // Who is asking: their fare is the discounted one, or the regular one.
                    rider: RIDER_KIND_LABEL[kind],
                    yourFare: discountedKind(kind) ? shown.trip.fareDiscounted : shown.trip.fare,
                  };
                },
              }}
              request={() => {
                const now = twinState(twin);
                let shown: ReturnType<typeof commuterView> | null = null;
                try {
                  shown = commuterView(now, dispatch(now), query);
                } catch {
                  // A followed rider who just finished their trip: no screen, no jeepney.
                }
                const req = plannerRequest(now, {
                  role: 'commuter',
                  stop: view.stop.index,
                  destination: view.destination.index,
                  direction: route.loop
                    ? 1
                    : route.stops[view.destination.index]!.s >= route.stops[view.stop.index]!.s
                      ? 1
                      : -1,
                  // Only the jeepneys on their screen: the one they ride, or
                  // the ones coming. The rest of the fleet would only cost tokens.
                  jeepneys: shown?.riding
                    ? [shown.riding.vehicle]
                    : (shown?.arrivals.map((a) => a.vehicle) ?? []),
                });
                const legs = useApp.getState().tripLegs;
                const trip = legs && legs.length > 1 ? tripSummary(legs, twin) : undefined;
                return shown
                  ? {
                      ...req,
                      screen: {
                        ...commuterScreen(shown),
                        // Who is asking: their fare is the discounted one, or the regular one.
                        rider: RIDER_KIND_LABEL[kind],
                        yourFare: discountedKind(kind)
                          ? shown.trip.fareDiscounted
                          : shown.trip.fare,
                        ...(trip && { plannedTrip: trip }),
                      },
                    }
                  : req;
              }}
            />
          </section>
        )}

        <p className="fine phone__note">
          Times are estimates from the vehicles’ positions now. Fares are by the vehicle that takes
          you, from the LTFRB matrix in force since 28 September 2026 (core/fare.ts): a UV Express
          loads only at its terminal.
        </p>
      </PhoneFrame>
    </div>
  );
}
