import { useState } from 'react';
import { useRuntimes } from '@/app/runtimeContext';
import { useApp } from '@/app/store';
import type { PassengerPhase } from '@/core/people/passengerSystem';
import { useTicker } from './useTicker';

export const PASSENGER_PHASE: Record<PassengerPhase, string> = {
  approaching: 'Walking to queue',
  waiting: 'Waiting',
  boarding: 'Boarding',
  seated: 'On board',
  alighting: 'Getting off',
  walking: 'Walking to arrivals',
  arrived: 'At destination',
};
export const passengerName = (id: number) => `P${String(id).padStart(4, '0')}`;

export function PassengerPanel() {
  useTicker(4);
  const { twin } = useRuntimes();
  const follow = useApp((s) => s.follow);
  const tracked = useApp((s) => s.trackedRiderId);
  const track = useApp((s) => s.trackRider);
  const [search, setSearch] = useState('');
  const [scope, setScope] = useState('vehicle');
  const people = [...twin.crew.passengers.values()];
  const selected = tracked === null ? null : twin.crew.passengers.get(tracked);
  const visible = people
    .filter((r) => {
      if (search) return passengerName(r.id).toLowerCase().includes(search.toLowerCase());
      if (scope === 'walking') return ['walking', 'alighting', 'arrived'].includes(r.phase);
      if (scope === 'vehicle' && follow?.kind === 'sim') return r.lastVehicleId === follow.index;
      return true;
    })
    .sort(
      (a, b) =>
        b.history[b.history.length - 1]!.at - a.history[a.history.length - 1]!.at || a.id - b.id,
    );
  const stopName = (index: number) => twin.route.stops[index]?.name ?? 'Unknown stop';

  return (
    <div className="fold__body" aria-label="Passenger journeys">
      <p className="fine">
        The same person from queue to destination. On the map, blue areas are waiting and green are
        arrivals.
      </p>
      <div className="passenger-tools">
        <select
          className="input"
          aria-label="Which passengers"
          value={scope}
          onChange={(e) => setScope(e.target.value)}
        >
          <option value="vehicle">Followed vehicle / all</option>
          <option value="walking">Getting off &amp; arrived</option>
          <option value="all">Everyone</option>
        </select>
        <input
          className="input"
          aria-label="Find passenger ID"
          placeholder="Find ID, e.g. P0001"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {selected && (
        <div className="passenger-selected">
          <strong>
            Tracking {passengerName(selected.id)} · {PASSENGER_PHASE[selected.phase]}
          </strong>
          <div>
            {stopName(selected.originStop)} → {stopName(selected.destinationStop)}
          </div>
          <div className="muted">
            {selected.history
              .map(
                (h) =>
                  `${Math.floor(h.at / 60)}:${String(Math.floor(h.at % 60)).padStart(2, '0')} ${PASSENGER_PHASE[h.phase]}`,
              )
              .join(' → ')}
          </div>
          <button className="btn" onClick={() => track(null)}>
            Stop tracking passenger
          </button>
        </div>
      )}
      <div className="passenger-list">
        {visible.slice(0, 40).map((r) => (
          <div className="passenger-row" key={r.id}>
            <div>
              <strong>{passengerName(r.id)}</strong> · {PASSENGER_PHASE[r.phase]}
              <div className="muted">
                {stopName(r.originStop)} → {stopName(r.destinationStop)}
              </div>
              {r.lastVehicleId !== null && (
                <small>{twin.fleet.vehicles[r.lastVehicleId]?.plate}</small>
              )}
            </div>
            <button
              className="btn"
              aria-label={`Track ${passengerName(r.id)}`}
              aria-pressed={tracked === r.id}
              onClick={() => track(r.id)}
            >
              Track
            </button>
          </div>
        ))}
      </div>
      <small className="muted">
        {visible.length > 40
          ? `Showing 40 of ${visible.length}. Search an ID to find any passenger.`
          : `${visible.length} passengers`}{' '}
        · {twin.crew.delivered + people.filter((r) => r.phase === 'arrived').length} arrived
      </small>
    </div>
  );
}
