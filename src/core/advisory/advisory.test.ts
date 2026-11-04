import { describe, expect, it } from 'vitest';
import { Polyline } from '../geo/polyline';
import { commuterView } from './commuter';
import { dispatch } from './dispatch';
import { driverView } from './driver';
import { ADVISORY, type PassengerState, type TwinState, type VehicleState } from './model';
import { plannerRequest, stopLabels } from './plannerSnapshot';
import { operatorScreen } from './screen';
import { TwinRuntime } from '@/app/twinRuntime';
import { twinState } from '@/app/twinState';
import { DEFAULT_SCENARIO } from '../fleet/scenario';
import { aheadOf, defaultRoute, type Route } from '../geo/routes';

/** A 400 m square loop: Home (terminal), Out, Far (terminal), Back. */
const square: Route = {
  id: 'advisory-test',
  name: 'Square loop',
  source: 'synthetic',
  projection: null,
  stopsSource: 'placeholder',
  loop: true,
  polyline: new Polyline([
    { x: 0, z: 0 },
    { x: 100, z: 0 },
    { x: 100, z: 100 },
    { x: 0, z: 100 },
    { x: 0, z: 0 },
  ]),
  stops: [
    { name: 'Home', s: 0, terminal: true },
    { name: 'Out', s: 100 },
    { name: 'Far', s: 200, terminal: true },
    { name: 'Back', s: 300 },
  ],
};

const OUT = 1;
const FAR = 2;

function jeep(index: number, plate: string, s: number, occupancy: number): VehicleState {
  return {
    index,
    plate,
    s,
    direction: 1,
    speedMps: 5,
    occupancy,
    capacity: 4,
    atStop: null,
    x: s,
    z: 0,
    heading: 0,
  };
}

function person(
  id: number,
  phase: PassengerState['phase'],
  originStop: number,
  destinationStop: number,
  extra: Partial<PassengerState> = {},
): PassengerState {
  return {
    id,
    phase,
    originStop,
    destinationStop,
    direction: 1,
    vehicle: null,
    x: 100,
    z: 0,
    queuedAt: id,
    ...extra,
  };
}

/**
 * A (50 m) carries three: one gets off at Out, two at Far. B (10 m) is
 * empty, right behind it. Three wait at Out; one is running for B.
 */
function scene(waitingAtOut = [10, 11, 12]): TwinState {
  return {
    route: square,
    vehicles: [jeep(0, 'AAA 111', 50, 3), jeep(1, 'BBB 222', 10, 0)],
    passengers: [
      person(1, 'seated', 0, OUT, { vehicle: 0 }),
      person(2, 'seated', 0, FAR, { vehicle: 0 }),
      person(3, 'seated', 0, FAR, { vehicle: 0 }),
      ...waitingAtOut.map((id) => person(id, 'waiting', OUT, FAR)),
      person(20, 'approaching', OUT, FAR, { x: -20, z: 3 }),
      person(21, 'approaching', OUT, FAR, { x: -200, z: 0 }),
    ],
  };
}

describe('first come, first served', () => {
  it('gives the queue to the nearest jeepney, up to its free seats on arrival', () => {
    const plan = dispatch(scene());
    // A: 4 seats - 3 riders + 1 getting off at Out = 2 seats.
    expect(plan.claimedAt(0, OUT)).toBe(2);
    expect(plan.vehicleFor(10)).toBe(0);
    expect(plan.vehicleFor(11)).toBe(0);
    // B takes whoever is left.
    expect(plan.vehicleFor(12)).toBe(1);
    expect(plan.unclaimed[OUT]).toBe(0);
  });

  it('times arrivals with a dwell at every stop made on the way', () => {
    const plan = dispatch(scene());
    expect(plan.etaS(0, OUT)).toBeCloseTo(50 / 5);
    expect(plan.etaS(0, FAR)).toBeCloseTo(50 / 5 + 100 / ADVISORY.cruiseMps + ADVISORY.dwellS);
  });
});

describe('driver view', () => {
  it('shows only the stops ahead up to the next terminal', () => {
    const state = scene();
    const a = driverView(state, 0, dispatch(state));
    expect(a.ahead.map((x) => x.name)).toEqual(['Out', 'Far']);
    expect(a.ahead[0]).toMatchObject({ action: 'stop', dropOffs: 1, forYou: 2, para: true });
    expect(a.ahead[1]).toMatchObject({ action: 'stop', reason: 'Terminal: everyone gets off' });
    // Nothing in front of A, and B behind it is not shown.
    expect(a.leader).toBeNull();
  });

  it('sees the jeepney ahead, and that it covers part of the queue', () => {
    const state = scene();
    const b = driverView(state, 1, dispatch(state));
    expect(b.leader).toMatchObject({ plate: 'AAA 111', distanceM: 40, freeSeats: 1 });
    expect(b.ahead[0]).toMatchObject({ forYou: 1, action: 'stop' });
    expect(b.ahead[0]!.coveredBy).toEqual([{ plate: 'AAA 111', count: 2 }]);
  });

  it('passes a stop the jeepney ahead covers, and saves the stop-and-go', () => {
    const state = scene([10, 11]);
    const b = driverView(state, 1, dispatch(state));
    expect(b.ahead[0]).toMatchObject({ action: 'pass', reason: 'Covered by AAA 111 ahead' });
    expect(b.fuel.stopsPlanned).toBe(1);
    expect(b.fuel.savedLitres).toBeCloseTo(ADVISORY.fuel.stopGoL);
    expect(b.fuel.savedPhp).toBeCloseTo(ADVISORY.fuel.stopGoL * ADVISORY.fuel.dieselPhpPerL);
  });

  it('sees someone running for it just behind, but not far behind', () => {
    const state = scene();
    const b = driverView(state, 1, dispatch(state));
    expect(b.eyesight.map((x) => x.passenger)).toEqual([20]);
    expect(b.eyesight[0]!.behind).toBe(true);
  });
});

describe('commuter view', () => {
  it('sends a planned trip to the first jeepney with a seat left over', () => {
    const state = scene();
    const c = commuterView(state, dispatch(state), { stop: OUT, destination: FAR });
    expect(c.arrivals.map((x) => [x.plate, x.seatsForYou])).toEqual([
      ['AAA 111', 0],
      ['BBB 222', 3],
    ]);
    expect(c.pickup?.plate).toBe('BBB 222');
    expect(c.queueAhead).toBe(3);
    expect(c.trip).toMatchObject({ distanceM: 100, fare: 14 });
    expect(c.trip.arriveInS).toBeGreaterThan(c.pickup!.etaS);
  });

  it('follows someone in the queue to the jeepney FCFS gave them', () => {
    const state = scene();
    const c = commuterView(state, dispatch(state), { passenger: 11 });
    expect(c.phase).toBe('waiting');
    expect(c.queueAhead).toBe(1);
    expect(c.pickup?.plate).toBe('AAA 111');
  });

  it('counts down the ride once on board', () => {
    const state = scene();
    const plan = dispatch(state);
    const c = commuterView(state, plan, { passenger: 2 });
    expect(c.riding).toMatchObject({ plate: 'AAA 111', remainingM: 150 });
    expect(c.trip.arriveInS).toBeCloseTo(plan.etaS(0, FAR));
  });
});

describe('assistant snapshot', () => {
  it('cuts the loop at the driver and keeps only what is ahead', () => {
    const { snapshot, role, driverPlate } = plannerRequest(scene(), { role: 'driver', vehicle: 0 });
    expect(role).toBe('driver');
    expect(driverPlate).toBe('AAA 111');
    expect(snapshot.route.stops.map((s) => [s.name, s.sKm, s.waiting])).toEqual([
      ['Out', 0.051, 3],
      ['Far', 0.151, 0],
    ]);
    expect(snapshot.simulatedFleet.map((v) => v.plate)).toEqual(['AAA 111']);
    expect(snapshot.simulatedFleet[0]!.dropOffs).toEqual({ Out: 1, Far: 2 });
  });

  it('cuts the loop after the commuter destination so the trip runs forward', () => {
    const req = plannerRequest(scene(), {
      role: 'commuter',
      stop: OUT,
      destination: FAR,
      direction: 1,
      jeepneys: [0, 1],
    });
    // From where the furthest of their jeepneys is (B, past Home) to Far.
    expect(req.snapshot.route.stops.map((s) => s.name)).toEqual(['Out', 'Far']);
    const km = Object.fromEntries(req.snapshot.simulatedFleet.map((v) => [v.plate, v.sKm]));
    const out = req.snapshot.route.stops[0]!.sKm;
    // Both jeepneys are still before the commuter's stop.
    expect(km['AAA 111']).toBeLessThan(out);
    expect(km['BBB 222']).toBeLessThan(out);
    expect(req).toMatchObject({ commuterStop: 'Out', destinationStop: 'Far' });
  });

  it(
    'is about the person’s own jeepney and screen, however big the fleet',
    { timeout: 60_000 },
    () => {
      // Before, a driver in the 120-jeepney stress preset sent every jeepney up
      // to the terminal: "snapshot too large", and a bigger bill when it fit.
      for (const vehicles of [20, 120]) {
        const twin = new TwinRuntime(defaultRoute(), undefined, {
          ...DEFAULT_SCENARIO,
          vehicles,
          dailyTrips: vehicles * 900,
        });
        for (let i = 0; i < 600; i++) twin.step(1, i * 1000);
        const state = twinState(twin);
        const plan = dispatch(state);

        for (let vehicle = 0; vehicle < vehicles; vehicle += 7) {
          const { snapshot } = plannerRequest(state, { role: 'driver', vehicle });
          const screen = driverView(state, vehicle, plan);
          // The same stops as the driver's screen, and only the jeepneys
          // between the driver and the last of them.
          expect(snapshot.route.stops.length).toBe(screen.ahead.length);
          expect(snapshot.simulatedFleet.map((v) => v.plate)).toContain(
            state.vehicles[vehicle]!.plate,
          );
          const me = state.vehicles[vehicle]!.s - 1;
          const lastStop = state.route.stops[screen.ahead.at(-1)!.stop]!;
          const last = aheadOf(state.route, me, lastStop.s);
          const between = state.vehicles.filter((v) => aheadOf(state.route, me, v.s) <= last);
          expect(snapshot.simulatedFleet.map((v) => v.plate).sort()).toEqual(
            between.map((v) => v.plate).sort(),
          );
          // What /api/assist accepts (MAX_SNAPSHOT_BYTES), even in a jam.
          expect(JSON.stringify(snapshot).length).toBeLessThan(16_000);
        }

        const stop = state.route.stops.findIndex((s) => s.name === 'Malaria');
        const destination = (stop + 2) % state.route.stops.length;
        const waiting = commuterView(state, plan, { stop, destination });
        const asWaiting = plannerRequest(state, {
          role: 'commuter',
          stop,
          destination,
          direction: 1,
          jeepneys: waiting.arrivals.map((a) => a.vehicle),
        });
        expect(asWaiting.snapshot.simulatedFleet.map((v) => v.plate).sort()).toEqual(
          waiting.arrivals.map((a) => a.plate).sort(),
        );

        // On board: their jeepney, nobody else's.
        const rider = state.passengers.find((p) => p.phase === 'seated')!;
        const riding = commuterView(state, plan, { passenger: rider.id });
        const asRider = plannerRequest(state, {
          role: 'commuter',
          stop: rider.originStop,
          destination: rider.destinationStop,
          direction: 1,
          jeepneys: [riding.riding!.vehicle],
        });
        expect(asRider.snapshot.simulatedFleet.map((v) => v.plate)).toEqual([riding.riding!.plate]);
        expect(asRider.snapshot.route.stops.at(-1)!.name).toBe(
          stopLabels(state.route)[rider.destinationStop],
        );
      }
    },
  );

  it(
    'gives the Live twin the whole fleet at real positions, in a fixed-size summary',
    { timeout: 60_000 },
    () => {
      // Before, the Live twin sent no positions: the server guessed them
      // (a jeepney 4.2 km along was put at 0.3 km) and spread the stops evenly.
      const twin = new TwinRuntime(defaultRoute(), undefined, {
        ...DEFAULT_SCENARIO,
        vehicles: 200,
        dailyTrips: 180_000,
      });
      for (let i = 0; i < 600; i++) twin.step(1, i * 1000);
      const state = twinState(twin);
      const req = plannerRequest(state, { role: 'operator' });
      expect(req.role).toBe('operator');
      expect(req.snapshot.simulatedFleet).toHaveLength(200);
      for (const v of state.vehicles) {
        const sent = req.snapshot.simulatedFleet.find((x) => x.plate === v.plate)!;
        expect(sent.sKm).toBeCloseTo(aheadOf(state.route, 0, v.s) / 1000, 2);
      }
      const lagro = state.route.stops.findIndex((x) => x.name === 'Lagro');
      expect(req.snapshot.route.stops.find((x) => x.name.startsWith('Lagro'))!.sKm).toBeCloseTo(
        aheadOf(state.route, 0, state.route.stops[lagro]!.s) / 1000,
        2,
      );
      // /api/assist's limit for this snapshot (MAX_SNAPSHOT_BYTES); it stays on the server.
      expect(JSON.stringify(req.snapshot).length).toBeLessThan(48_000);

      // What goes to Meta: the same handful of numbers for any fleet size,
      // within /api/assist's screen limit (MAX_SCREEN_BYTES).
      const screen = operatorScreen(state, dispatch(state));
      expect(screen.jeepneys).toBe(200);
      expect(screen.busiestStops.length).toBeLessThanOrEqual(5);
      const counts = screen.busiestStops.map((x) => x.waiting);
      expect(counts).toEqual([...counts].sort((a, b) => b - a));
      expect(JSON.stringify(screen).length).toBeLessThan(3000);
    },
  );

  it('names every stop uniquely, never one inside another', () => {
    const route: Route = {
      ...square,
      stops: [
        { name: 'Lagro', s: 0, towards: 'SM' },
        { name: 'Lagro', s: 100, towards: 'SM' },
        { name: 'Lagro', s: 300, towards: 'Malaria' },
      ],
    };
    const labels = stopLabels(route);
    expect(labels).toEqual(['Lagro → SM', 'Lagro (2) → SM', 'Lagro → Malaria']);
    for (const a of labels) for (const b of labels) if (a !== b) expect(b.includes(a)).toBe(false);
  });
});
