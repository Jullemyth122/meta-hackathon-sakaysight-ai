import { describe, expect, it } from 'vitest';
import { DEFAULT_SCENARIO } from '@/core/fleet/scenario';
import { defaultRoute } from '@/core/geo/routes';
import { TwinRuntime } from './twinRuntime';
import { twinState } from './twinState';
import { commuterView } from '@/core/advisory/commuter';
import { dispatch } from '@/core/advisory/dispatch';
import { yourJeepney } from './yourJeepney';

const route = defaultRoute();
const MALARIA = route.stops.findIndex((s) => s.name === 'Malaria');

function running(seconds: number) {
  const twin = new TwinRuntime(route, undefined, DEFAULT_SCENARIO);
  for (let i = 0; i < seconds * 10; i++) twin.step(0.1, i * 100);
  return twin;
}

describe('the commuter’s jeepney on the map', () => {
  it('labels the jeepney the commuter app says will take them', () => {
    const twin = running(120);
    const query = { stop: MALARIA, destination: (MALARIA + 2) % route.stops.length };
    const state = twinState(twin);
    const view = commuterView(state, dispatch(state), query);
    const mine = yourJeepney(twin, query)!;
    expect(mine).not.toBeNull();
    if (view.pickup) {
      expect(mine.vehicle).toBe(view.pickup.vehicle);
      expect(mine.full).toBe(false);
      expect(mine.text).toContain(view.pickup.plate);
      expect(mine.text).toMatch(/seats? for you/);
    } else {
      // Nothing with a seat in sight: the next one is marked as full for them.
      expect(mine.full).toBe(true);
      expect(mine.text).toContain('full for you');
    }
  });

  it('follows the jeepney a rider is on, with the time to their stop', () => {
    const twin = running(300);
    const rider = [...twin.crew.passengers.values()].find((p) => p.phase === 'seated')!;
    const mine = yourJeepney(twin, { passenger: rider.id })!;
    expect(mine.vehicle).toBe(rider.vehicleId);
    expect(mine.text).toContain(route.stops[rider.destinationStop]!.name);
  });

  it(
    'lets the commuter join the twin as a rider and ride to their stop',
    { timeout: 120_000 },
    () => {
      const twin = running(60);
      const destination = (MALARIA + 3) % route.stops.length;
      const id = twin.crew.join(MALARIA, destination, 120);
      const me = () => twin.crew.passengers.get(id);
      expect(me()!.phase).toBe('approaching');
      expect(me()!.destinationStop).toBe(destination);
      // Through every phase of a ride: walk in, wait, board, ride, get off.
      const seen = new Set<string>();
      for (let i = 0; i < 40 * 60 * 10 && me(); i++) {
        twin.step(0.1, i * 100);
        seen.add(me()?.phase ?? 'gone');
        if (me()?.phase === 'seated')
          expect(yourJeepney(twin, { passenger: id })?.text).toMatch(/^Your /);
      }
      for (const phase of ['waiting', 'boarding', 'seated', 'alighting'])
        expect(seen).toContain(phase);
    },
  );

  it('shows nothing once their trip is over, rather than failing', () => {
    const twin = running(10);
    expect(yourJeepney(twin, { passenger: -1 })).toBeNull();
  });
});
