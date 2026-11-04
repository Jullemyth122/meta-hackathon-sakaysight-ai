/**
 * The commuter's "from anywhere to anywhere" in Metro Manila: pick where you
 * are and where you are going (stop names are the landmarks people know),
 * get the best jeepney trips, direct or with one change, and choose one.
 * Either end can be clicked on the map instead. The best trip is drawn on
 * the map end to end (scene/world/TripPlanLayer.tsx), any other on "Show on
 * map". Choosing one focuses the first jeepney's route, so the phone and the
 * map show that stop, that jeepney and its seats, and "you" set out from
 * where the trip starts; the second leg (if any) is estimated from its
 * route's flow.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { arrivalsAt, getNetwork, loadPlaces } from '@/app/network';
import { useRuntimes } from '@/app/runtimeContext';
import { useApp, type TripEnd, type TripPoint } from '@/app/store';
import { askRisk, chainMetres, knownRisk, useStreetWaysVersion } from '@/app/streetWays';
import { legsOf, takeTrip, tripPoints } from '@/app/trips';
import type { LocalPoint } from '@/core/geo/projection';
import type { RoadRisk } from '@/core/map/streets';
import type { Network } from '@/core/network/network';
import { planTrips, WAITING_AREA_M, type TripOption } from '@/core/network/plan';
import { searchPlaces, type Place } from '@/core/network/search';
import { recommend } from '@/net/agent';
import { RIDER_KIND_LABEL, RIDER_KINDS, type RiderKind } from '@/core/fare';
import { metres, minutes, peso } from '../phone/format';

/** Places this close to the route on the map come first in the search (metres). */
const NEAR_ROUTE_M = 3000;

const RISK_WORDS: Record<RoadRisk, string> = {
  expressway: 'an expressway',
  ramp: 'an expressway ramp',
  flyover: 'a flyover or a bridge',
  tunnel: 'a tunnel or underpass',
};

/** Trips Muse is told about, of those found. */
const TRIPS_FOR_MUSE = 3;
/** The trips must stay the same this long before Muse is asked: it costs credit (ms). */
const ASK_MUSE_AFTER_MS = 900;
/** What Muse said about these trips: they are asked about once. */
const museTakes = new Map<string, string | null>();

const tripFacts = (options: readonly TripOption[]) =>
  options
    .slice(0, TRIPS_FOR_MUSE)
    .map((o, i) => {
      const legs = o.legs.map((l) => `${l.routeName}, ${l.boardName} to ${l.alightName}`);
      return `${i + 1}. ${legs.join(', then ')}: about ${Math.round(o.totalS / 60)} minutes, ${o.fare} pesos.`;
    })
    .join('\n');

/** Which of the trips found Muse would take, when there is a choice to make. */
function MuseTake({ options }: { options: readonly TripOption[] }) {
  const facts = tripFacts(options);
  const [take, setTake] = useState<{ facts: string; text: string | null } | null>(null);
  useEffect(() => {
    if (options.length < 2) return;
    let live = true;
    const id = window.setTimeout(() => {
      const known = museTakes.get(facts);
      void (known === undefined ? recommend(facts).catch(() => null) : Promise.resolve(known)).then(
        (text) => {
          museTakes.set(facts, text);
          if (live) setTake({ facts, text });
        },
      );
    }, ASK_MUSE_AFTER_MS);
    return () => {
      live = false;
      window.clearTimeout(id);
    };
  }, [facts]);
  if (options.length < 2) return null;
  if (take?.facts !== facts) return <p className="fine">Muse AI is comparing these trips…</p>;
  return take.text && <p className="assist__answer">{take.text}</p>;
}

/** Where stop `i` of route `r` is on the map. */
function stopPoint(network: Network, r: number, i: number): LocalPoint {
  const route = network.routes[r]!.route;
  return route.polyline.pointAt(route.stops[i]!.s);
}

/** By road when that is known; else the planner's straight line, said as such. */
const distance = (road: number | undefined, straight: number) =>
  road === undefined ? `~${metres(straight)}` : metres(road);

function PlaceInput({
  label,
  end,
  places,
  value,
  onChange,
  near,
  placeholder = 'Click the map, or type a place (e.g. Philcoa)',
}: {
  label: string;
  end: TripPoint;
  placeholder?: string;
  places: readonly Place[];
  value: TripEnd | null;
  onChange: (p: TripEnd | null) => void;
  near: (p: Place) => boolean;
}) {
  const [query, setQuery] = useState('');
  const found = useMemo(() => searchPlaces(places, query, 6, near), [places, query, near]);
  const picking = useApp((s) => s.pickingPlace === end);
  const setPicking = useApp((s) => s.setPickingPlace);
  return (
    <div className="route-search">
      <span className="route-search__head">
        <span className="muted">{label}</span>
        <button
          type="button"
          className={`btn btn--small ${picking ? 'btn--primary' : ''}`}
          aria-pressed={picking}
          onClick={() => setPicking(picking ? false : end)}
        >
          {picking ? 'Click the map…' : 'Pick on the map'}
        </button>
      </span>
      <input
        type="search"
        className="input"
        aria-label={label}
        placeholder={placeholder}
        value={value ? value.name : query}
        onChange={(e) => {
          onChange(null);
          setQuery(e.target.value);
        }}
      />
      {!value && found.length > 0 && (
        <ul className="route-search__results">
          {found.map((p) => (
            // A stop and a landmark (or two landmarks) can share a name.
            <li key={`${p.kind}:${p.name}:${p.at.x.toFixed(0)},${p.at.z.toFixed(0)}`}>
              <button
                type="button"
                className="route-search__item"
                onClick={() => {
                  onChange({ name: p.name, at: p.at });
                  setQuery('');
                }}
              >
                <span>{p.name}</span>
                <span className="mono">
                  {p.kind === 'stop' ? `${p.routes} route${p.routes === 1 ? '' : 's'}` : p.kind}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function OptionCard({
  option,
  badges,
  roadTo,
  roadFrom,
  shown,
  onShow,
  onChoose,
}: {
  option: TripOption;
  /** What sets it apart from the others: "Fastest", "Cheapest". */
  badges: string[];
  /** Metres by road to the waiting area, and from the last stop, once the map has them. */
  roadTo?: number;
  roadFrom?: number;
  /** This is the trip drawn on the map. */
  shown: boolean;
  onShow: () => void;
  onChoose: () => void;
}) {
  return (
    <li className={`ahead ${shown ? 'ahead--stop' : ''}`}>
      <div className="ahead__head">
        <strong>
          {minutes(option.totalS)} door to door
          {badges.map((b) => (
            <span key={b} className="chip chip--good">
              {b}
            </span>
          ))}
        </strong>
        <span className="mono">
          {peso(option.fare)} · {peso(option.fareDiscounted)} discounted
          {option.toBy === 'tricycle' || option.fromBy === 'tricycle' ? ' + tricycle' : ''}
        </span>
      </div>
      <ol className="trip-legs">
        <li className="muted">
          {option.toBy === 'walk'
            ? `Walk ${distance(roadTo, option.walkToM)} to the waiting area: ${option.legs[0]!.boardName}`
            : `Tricycle ${distance(roadTo, option.walkToM)} to the waiting area: ${option.legs[0]!.boardName} (fare set by your city or town)`}
          {option.legs[0]!.flag && (
            <>
              . Whatever comes going your way with a seat stops for you there.
              {option.legs[0]!.flag.across &&
                ' This trip goes from the far side of the road: cross first, somewhere safe.'}
            </>
          )}
        </li>
        {option.legs.map((leg, k) => (
          <li key={k}>
            {k > 0 && (
              <span className="muted">
                Walk {metres(option.transferWalkM)} and change at {leg.boardName}.{' '}
              </span>
            )}
            <strong>{leg.routeName}</strong>: {leg.boardName} → {leg.alightName} (
            {metres(leg.rideM)}, {peso(leg.fare)}).{' '}
            {leg.jeepney ? (
              <span className={leg.jeepney.freeSeats > 0 ? 'good' : 'bad'}>
                {leg.jeepney.plate} in {minutes(leg.waitS)},{' '}
                {leg.jeepney.freeSeats > 0
                  ? `~${leg.jeepney.freeSeats} seat${leg.jeepney.freeSeats === 1 ? '' : 's'} (estimated)`
                  : 'full for you'}
              </span>
            ) : (
              <span className="muted">about every {minutes(leg.waitS)}</span>
            )}
            {leg.alsoBy.length > 0 && (
              <span className="muted">
                {' '}
                Or whichever comes first: {leg.alsoBy.slice(0, 3).join(', ')}
                {leg.alsoBy.length > 3 ? ` and ${leg.alsoBy.length - 3} more` : ''}.
              </span>
            )}
          </li>
        ))}
        <li className="muted">
          {option.fromBy === 'walk'
            ? `Walk ${distance(roadFrom, option.walkFromM)} to where you are going`
            : `Tricycle ${distance(roadFrom, option.walkFromM)} to where you are going (fare set by your city or town)`}
        </li>
      </ol>
      <div className="trip-actions">
        <button type="button" className="btn" aria-pressed={shown} onClick={onShow}>
          {shown ? 'On the map' : 'Show on map'}
        </button>
        <button type="button" className="btn btn--primary" onClick={onChoose}>
          Take this trip
        </button>
      </div>
    </li>
  );
}

export function TripPlanner() {
  const { twin } = useRuntimes();
  const ready = useApp((s) => s.network.state === 'ready');
  const setMe = useApp((s) => s.setMe);
  const me = useApp((s) => s.me);
  const { home, from, to } = useApp((s) => s.tripEnds);
  const setTripEnd = useApp((s) => s.setTripEnd);
  const preview = useApp((s) => s.tripPreview);
  const setPreview = useApp((s) => s.setTripPreview);
  const requestShot = useApp((s) => s.requestShot);
  const network = ready ? getNetwork() : null;
  const line = twin.route.polyline;
  // A place named like one across the city: the one by the route on the map first.
  const near = useCallback((p: Place) => line.project(p.at).offset < NEAR_ROUTE_M, [line]);
  const [places, setPlaces] = useState<Place[]>([]);
  useEffect(() => {
    if (!network) return;
    let live = true;
    void loadPlaces().then((p) => live && setPlaces(p));
    return () => {
      live = false;
    };
  }, [network]);
  const [options, setOptions] = useState<TripOption[] | null>(null);
  const [shownAt, setShownAt] = useState(0);
  // The map's ways by road have come in: the trip on it can say its real metres.
  useStreetWaysVersion();
  // A spot nobody can wait at (undefined until the map's roads have said).
  const risk = from ? knownRisk(from.at) : null;
  const origin = twin.route.projection?.origin;
  useEffect(() => {
    if (from && origin) askRisk(from.at, origin);
  }, [from, origin]);

  /** Draw option `i` of `list` on the map, and frame it end to end. */
  const show = useCallback(
    (list: readonly TripOption[], i: number) => {
      const o = list[i];
      const n = getNetwork();
      if (!o || !n || !home || !to) return;
      const legs = legsOf(o, home.at, from?.at);
      setShownAt(i);
      setPreview(legs);
      requestShot('area', tripPoints(n, legs, from ? [home, from, to] : [home, to]));
    },
    [home, from, to, setPreview, requestShot],
  );

  // The trips, as soon as home and destination are chosen (by name or on the
  // map), from the waiting area chosen if one is; the best one drawn on the
  // map; again on the button, for a later time.
  const plan = useCallback(() => {
    const n = getNetwork();
    if (!n || !home || !to) {
      setOptions(null);
      setPreview(null);
      return;
    }
    if (risk) {
      setOptions([]);
      setPreview(null);
      return;
    }
    const toBy = me.mode === 'auto' ? undefined : me.mode;
    const found = planTrips(n, home.at, to.at, twin.clockS, arrivalsAt(twin), toBy, from?.at);
    setOptions(found);
    if (found.length > 0) show(found, 0);
    else setPreview(null);
  }, [home, from, to, twin, show, setPreview, me.mode, risk]);
  // Only when an end (or the network) changes: not when the twin moves on
  // to another route, as taking a trip does (the rider is followed then).
  const latest = useRef(plan);
  latest.current = plan;
  useEffect(() => {
    if (network) latest.current();
  }, [network, home, from, to, me.mode, risk]);

  if (!network) return null;
  // The waiting area of the trip on the map, when it was chosen for you.
  const shownBoard = !from && options?.[shownAt] ? options[shownAt]!.legs[0]!.boardName : null;
  /** "Fastest" and "Cheapest", when there is a choice to make. */
  const badgesOf = (o: TripOption) => {
    if (!options || options.length < 2) return [];
    const fares = options.map((x) => x.fare);
    const cheapest = Math.min(...fares);
    const fastest = Math.min(...options.map((x) => x.totalS));
    return [
      ...(o.totalS === fastest ? ['Fastest'] : []),
      ...(o.fare === cheapest && Math.max(...fares) > cheapest ? ['Cheapest'] : []),
    ];
  };
  /** The trip on the map's metres by road: none for an option not on it. */
  const roads = (o: TripOption, i: number) => {
    if (preview === null || shownAt !== i || !home || !to) return {};
    const first = o.legs[0]!;
    const last = o.legs.at(-1)!;
    const board = stopPoint(network, first.route, first.board);
    const chain = first.flag
      ? [home.at, first.flag.at]
      : from
        ? [home.at, from.at, board]
        : [home.at, board];
    return {
      roadTo: chainMetres(chain, o.toBy),
      roadFrom: chainMetres([stopPoint(network, last.route, last.alight), to.at]),
    };
  };

  const choose = (o: TripOption) => {
    takeTrip(o, twin);
    setOptions(null);
  };

  return (
    <section className="section">
      <PlaceInput
        label="Home: where you appear"
        end="home"
        places={places}
        value={home}
        near={near}
        onChange={(p) => setTripEnd('home', p)}
      />
      <PlaceInput
        label="From: your waiting area"
        end="from"
        places={places}
        value={from}
        near={near}
        onChange={(p) => setTripEnd('from', p)}
        placeholder={
          shownBoard
            ? `Chosen for you: ${shownBoard} (or pick a spot by the road)`
            : 'Chosen for you, or pick a spot by the road'
        }
      />
      <PlaceInput
        label="To: where you are going"
        end="to"
        places={places}
        value={to}
        near={near}
        onChange={(p) => setTripEnd('to', p)}
      />
      <div className="trip-picker">
        <label>
          <span className="muted">I am</span>
          <select
            aria-label="I am"
            value={me.kind}
            onChange={(e) => setMe({ kind: e.target.value as RiderKind })}
          >
            {RIDER_KINDS.map((k) => (
              <option key={k} value={k}>
                {RIDER_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span className="muted">To the waiting area</span>
          <select
            aria-label="To the waiting area"
            value={me.mode}
            onChange={(e) => setMe({ mode: e.target.value as 'auto' | 'walk' | 'tricycle' })}
          >
            <option value="auto">As most do (walk if near)</option>
            <option value="walk">Walking</option>
            <option value="tricycle">Riding a tricycle</option>
          </select>
        </label>
      </div>
      <button type="button" className="btn btn--primary" disabled={!home || !to} onClick={plan}>
        {options ? 'Find again (now)' : 'Find jeepneys'}
      </button>
      {risk && (
        <p className="error">
          You cannot wait for a ride here: this is {RISK_WORDS[risk]}. Pick a spot at the side of an
          ordinary road.
        </p>
      )}
      {options && options.length === 0 && !risk && (
        <p className="muted">
          {from
            ? `No jeepney passes there going your way, and no stop within ${WAITING_AREA_M} m does. Pick a spot beside a jeepney road, or clear it to have one chosen for you.`
            : 'No jeepney trip with at most one change found. It may be close enough to walk, or need a bus, train or tricycle.'}
        </p>
      )}
      {options && <MuseTake options={options} />}
      {options && options.length > 0 && (
        <ul className="ahead-list">
          {options.map((o, i) => (
            <OptionCard
              key={i}
              option={o}
              badges={badgesOf(o)}
              {...roads(o, i)}
              shown={preview !== null && shownAt === i}
              onShow={() => show(options, i)}
              onChoose={() => choose(o)}
            />
          ))}
        </ul>
      )}
      <p className="fine">
        Seats and times on other routes are estimates from how they usually run; the jeepney you
        choose is then followed live.
      </p>
    </section>
  );
}
