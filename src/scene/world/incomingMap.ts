import type { CommuterQuery } from '@/core/advisory/commuter';
import { incomingAtStop } from '@/core/advisory/approach';
import { ADVISORY, distanceTo, type TwinState } from '@/core/advisory/model';
import { isTerminal } from '@/core/geo/routes';

export type IncomingMapAudience =
  | { view: 'twin' }
  | { view: 'driver'; vehicle: number }
  | { view: 'commuter'; query: CommuterQuery };

/** Only demand relevant to this viewer. Counts always distinguish arrival from intent. */
export function incomingMapData(state: TwinState, audience: IncomingMapAudience) {
  const { route, passengers } = state;
  let stops = route.stops.map((_, i) => i);
  let directions: readonly (1 | -1)[] = route.loop ? [1] : [1, -1];
  let own: number | undefined;
  if (audience.view === 'driver') {
    const vehicle = state.vehicles[audience.vehicle];
    if (!vehicle || vehicle.inService === false) return [];
    directions = [vehicle.direction];
    const front = stops
      .map((stop) => ({ stop, d: distanceTo(route, vehicle, route.stops[stop]!.s) }))
      .filter(({ stop, d }) => d >= 0 || stop === vehicle.atStop)
      .sort((a, b) => a.d - b.d);
    stops = [];
    for (const [i, { stop, d }] of front.entries()) {
      if (i > 0 && (i >= ADVISORY.horizonStops || d > ADVISORY.horizonM)) break;
      stops.push(stop);
      if (isTerminal(route, stop) && stop !== vehicle.atStop) break;
    }
  } else if (audience.view === 'commuter') {
    const query = audience.query;
    const person = 'passenger' in query ? passengers.find((p) => p.id === query.passenger) : null;
    if ('passenger' in query && !person) return [];
    const stop = person?.originStop ?? ('stop' in query ? query.stop : -1);
    const destination =
      person?.destinationStop ?? ('destination' in query ? query.destination : -1);
    if (!route.stops[stop] || !route.stops[destination]) return [];
    own = person?.id;
    directions = [
      person?.direction ??
        (route.loop || route.stops[destination]!.s >= route.stops[stop]!.s ? 1 : -1),
    ];
    stops = [stop];
  }
  return stops
    .flatMap((stop) =>
      directions.map((direction) => {
        const waiting = passengers.filter(
          (p) => p.originStop === stop && p.direction === direction && p.phase === 'waiting',
        ).length;
        const incoming = incomingAtStop(state, stop, direction);
        return {
          stop,
          direction,
          waiting,
          incoming,
          // Drivers and operators see anonymous arrivals. A commuter sees only their own marker.
          markers:
            audience.view === 'commuter' ? incoming.filter((p) => p.passenger === own) : incoming,
        };
      }),
    )
    .filter((entry) => audience.view === 'commuter' || entry.waiting + entry.incoming.length > 0)
    .sort((a, b) => b.waiting + b.incoming.length - a.waiting - a.incoming.length);
}

/** Arrival at a stop is never 'now' while someone is still approaching. */
export function approachTime(seconds: number): string {
  // Seconds while they count; whole minutes, the nearest, after that (65 s is not "2 min").
  return seconds < 100 ? `${Math.max(1, Math.ceil(seconds))} s` : `${Math.round(seconds / 60)} min`;
}
