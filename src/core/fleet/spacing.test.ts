import { describe, expect, it } from 'vitest';
import { aheadOf, defaultRoute, syntheticDemoRoute, type Route } from '../geo/routes';
import { DEFAULT_FLEET, FleetSim, JEEPNEY_LENGTH_M, type FleetVehicle } from './fleetSim';
import { VEHICLES } from '../vehicles/specs';

const lengthOf = ({ kind }: FleetVehicle): number =>
  kind === 'jeepney' ? JEEPNEY_LENGTH_M : VEHICLES[kind].lengthM;

describe('indexed fleet spacing', () => {
  it.each(['loop', 'line', 'overlap'] as const)(
    'matches the exhaustive reference on a %s route',
    (kind) => {
      const route: Route = kind === 'loop' ? defaultRoute() : syntheticDemoRoute();
      // The reference below does not overtake, so neither may this.
      const config = { ...DEFAULT_FLEET, count: 36, overtaking: false };
      const indexed = new FleetSim(route, config);
      const reference = new FleetSim(route, config);
      const longer = (x: FleetVehicle, y: FleetVehicle) =>
        (lengthOf(x) + lengthOf(y)) / 2 - JEEPNEY_LENGTH_M;
      const { ignores } = reference as unknown as {
        ignores(x: FleetVehicle, y: FleetVehicle): boolean;
      };
      // Independent exhaustive nearest-neighbour oracle for the optimization.
      Object.defineProperty(reference, 'gapAhead', {
        value: (v: FleetVehicle) => {
          let gap = Infinity;
          let leader: FleetVehicle | null = null;
          for (const other of reference.vehicles) {
            if (other === v || other.direction !== v.direction) continue;
            // In another lane: not in its way.
            if (ignores.call(reference, v, other)) continue;
            const distance = route.loop
              ? aheadOf(route, v.s, other.s)
              : (other.s - v.s) * v.direction;
            if (distance > 0 && distance < gap) [gap, leader] = [distance, other];
          }
          // Less the extra length of a longer one, as the fleet keeps it.
          return leader ? gap - longer(v, leader) : gap;
        },
      });
      if (kind === 'overlap') {
        indexed.vehicles[2]!.s = indexed.vehicles[0]!.s;
        reference.vehicles[2]!.s = reference.vehicles[0]!.s;
      }
      for (let tick = 0; tick < 4000; tick++) {
        indexed.step(0.1);
        reference.step(0.1);
        if (tick % 100 === 0) expect(indexed.vehicles).toEqual(reference.vehicles);
      }
      expect(indexed.vehicles).toEqual(reference.vehicles);
      expect(indexed.waiting).toEqual(reference.waiting);
    },
  );
});
