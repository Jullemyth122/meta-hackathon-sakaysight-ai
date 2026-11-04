import { describe, expect, it } from 'vitest';
import { dispatch } from '../advisory/dispatch';
import { driverView } from '../advisory/driver';
import type { Arrival, CommuterView } from '../advisory/commuter';
import type { PassengerState, TwinState, VehicleState } from '../advisory/model';
import { Polyline } from '../geo/polyline';
import type { Route } from '../geo/routes';
import type { Network } from '../network/network';
import { noticesFor, onlyItsNumbers, riderNotices, type Moment } from './autopilot';
import { boardGoesTo, routesOnBoard } from './board';
import {
  clockTime,
  lateRiders,
  nextRides,
  seatsForNextStops,
  trafficAhead,
  vehiclesAhead,
} from './road';
import { AGENT_TOOLS } from './tools';

/** A 4 km line: Start (terminal), Middle, Far, End (terminal). */
const line: Route = {
  id: 'agent-test',
  name: 'Tungko - Cubao',
  source: 'synthetic',
  projection: null,
  stopsSource: 'placeholder',
  loop: false,
  polyline: new Polyline([
    { x: 0, z: 0 },
    { x: 4000, z: 0 },
  ]),
  stops: [
    { name: 'Start', s: 0, terminal: true },
    { name: 'Middle', s: 800 },
    { name: 'Far', s: 1200 },
    { name: 'End', s: 4000, terminal: true },
  ],
};

function car(index: number, s: number, occupancy: number, over: Partial<VehicleState> = {}) {
  return {
    index,
    plate: `CAR ${index}`,
    s,
    direction: 1,
    speedMps: 6,
    occupancy,
    capacity: 20,
    atStop: null,
    x: s,
    z: 0,
    heading: 0,
    ...over,
  } as VehicleState;
}

function rider(id: number, stop: number, over: Partial<PassengerState> = {}): PassengerState {
  return {
    id,
    phase: 'waiting',
    originStop: stop,
    destinationStop: 3,
    direction: 1,
    vehicle: null,
    x: 0,
    z: 0,
    queuedAt: id,
    ...over,
  };
}

const world = (
  vehicles: VehicleState[],
  passengers: PassengerState[] = [],
  stopToStopS?: number[],
): TwinState => ({ route: line, vehicles, passengers, stopToStopS });

describe('traffic ahead', () => {
  it('sees a clear road', () => {
    expect(trafficAhead(world([car(0, 100, 5)]), 0).level).toBe('clear');
  });

  it('sees vehicles stuck ahead, not behind or at a stop', () => {
    const stuck = { speedMps: 0.3 };
    const road = world([
      car(0, 100, 5),
      car(1, 400, 5, stuck),
      car(2, 500, 5, stuck),
      car(3, 600, 5, stuck),
      car(4, 50, 5, stuck),
      car(5, 700, 5, { ...stuck, atStop: 1 }),
    ]);
    const t = trafficAhead(road, 0);
    expect(t.level).toBe('heavy');
    expect(t.stuckAhead).toBe(3);
  });

  it('knows a stretch is crawling before anyone ahead is in it', () => {
    const road = world([car(0, 100, 5)]);
    road.slowRoad = [{ s: 700, halfM: 300, mps: 1.2 }];
    const t = trafficAhead(road, 0);
    expect(t.level).toBe('heavy');
    expect(t.extraMin).toBeGreaterThan(5);
    road.slowRoad = [{ s: 3500, halfM: 300, mps: 1.2 }];
    expect(trafficAhead(road, 0).level).toBe('clear');
  });

  it('sees the road taking longer than it should', () => {
    const t = trafficAhead(world([car(0, 100, 5)], [], [0, 400, 400, 900]), 0);
    expect(t.timesLonger).toBeGreaterThan(2);
    expect(t.level).toBe('heavy');
    expect(t.extraMin).toBeGreaterThan(0);
  });
});

describe('vehicles ahead', () => {
  const ask = (vehicles: VehicleState[], passengers: PassengerState[]) => {
    const state = world(vehicles, passengers);
    const plan = dispatch(state);
    return vehiclesAhead(state, plan, driverView(state, 0, plan), 0);
  };

  it('holds back behind a line that takes everyone, with seats to spare', () => {
    const v = ask([car(0, 100, 5), car(1, 400, 2), car(2, 500, 2)], [rider(0, 1), rider(1, 1)]);
    expect(v.advice).toBe('hold_back');
    expect(v.leftForYou).toBe(0);
    expect(v.yourFreeSeats).toBe(15);
  });

  it('says to pass when those ahead are full and riders are left', () => {
    const riders = [rider(0, 1), rider(1, 1), rider(2, 1)];
    const v = ask([car(0, 100, 5), car(1, 400, 20)], riders);
    expect(v.advice).not.toBe('hold_back');
    expect(v.freeSeatsAhead).toBe(0);
  });

  it('has nothing to say with an empty road ahead', () => {
    expect(ask([car(0, 100, 5)], []).advice).toBe('carry_on');
  });
});

describe('seats and late riders', () => {
  it('says when the seats fall short', () => {
    const state = world([car(0, 100, 19)], [rider(0, 1), rider(1, 1), rider(2, 1), rider(3, 1)]);
    const plan = dispatch(state);
    const [first] = seatsForNextStops(plan, driverView(state, 0, plan), 0);
    expect(first).toMatchObject({ stop: 'Middle', freeOnArrival: 1, waiting: 4, enough: false });
    expect(first!.short).toBe(3);
  });

  it('finds who misses the vehicle by a minute or two, and no one else', () => {
    const coming = (id: number, arrivalInS: number) =>
      rider(id, 1, {
        phase: 'approaching',
        arrivalInS,
        distanceToStopM: 100,
        approachMode: 'tricycle',
      });
    const state = world([car(0, 100, 5)], [coming(0, 20), coming(1, 180), coming(2, 2000)]);
    const plan = dispatch(state);
    const view = driverView(state, 0, plan);
    const [middle] = lateRiders(state, view, 0);
    expect(middle!.count).toBe(1);
    expect(middle!.byTricycle).toBe(1);
    expect(middle!.note).toMatch(/nobody has been told to wait/);
  });
});

describe('next rides', () => {
  it('says the clock time, like a person', () => {
    expect(clockTime(7 * 3600, 600)).toBe('7:10 AM');
    expect(clockTime(12.5 * 3600, 0)).toBe('12:30 PM');
    expect(clockTime(23.9 * 3600, 3600)).toBe('12:54 AM');
  });

  it('gives each ride with the seats left after the queue', () => {
    const state = world([car(0, 100, 19), car(1, 50, 5)], [rider(0, 1), rider(1, 1)]);
    const r = nextRides(state, dispatch(state), 1, 3, 7 * 3600);
    expect(r.queueAhead).toBe(2);
    expect(r.rides[0]!.atClock).toMatch(/^7:0\d AM$/);
    expect(r.yours).toBe('CAR 1');
  });
});

describe('a signboard', () => {
  const network = { routes: [{ route: line }] } as unknown as Network;
  const near = { name: 'Far', at: { x: 1300, z: 0 } };
  const away = { name: 'Baguio', at: { x: 90_000, z: 0 } };

  it('matches the words on the board to a route', () => {
    expect(routesOnBoard(network, 'CUBAO via Commonwealth')).toEqual([0]);
    expect(routesOnBoard(network, '')).toEqual([]);
  });

  it('says yes, with the stop to get off', () => {
    expect(boardGoesTo(network, 'TUNGKO - CUBAO', near)).toMatchObject({
      answer: 'yes',
      stop: 'Far',
      metresFromPlace: 100,
    });
  });

  it('says no, and how close it comes', () => {
    const b = boardGoesTo(network, 'TUNGKO', away);
    expect(b.answer).toBe('no');
    expect(b.stop).toBe('End');
    expect(b.metresFromPlace).toBe(86_000);
  });

  it('says it does not know a board it cannot find', () => {
    expect(boardGoesTo(network, 'Zamboanga Express', near).answer).toBe('unknown');
  });
});

describe('autopilot', () => {
  const moment = (over: Partial<Moment> = {}): Moment => {
    const state = world([car(0, 500, 5)]);
    const plan = dispatch(state);
    const view = driverView(state, 0, plan);
    return {
      view,
      traffic: { level: 'clear', stuckAhead: 0, timesLonger: 1, extraMin: 0, source: '' },
      ahead: vehiclesAhead(state, plan, view, 0),
      seats: seatsForNextStops(plan, view, 0),
      late: lateRiders(state, view, 0),
      tank: 0.8,
      ...over,
    };
  };

  it('keeps quiet on a quiet road, beyond the next stop', () => {
    const keys = noticesFor(moment()).map((n) => n.key);
    expect(keys.filter((k) => !k.startsWith('stop:'))).toEqual([]);
  });

  it('puts heavy traffic first, and says the low tank', () => {
    const notices = noticesFor(
      moment({
        tank: 0.2,
        traffic: { level: 'heavy', stuckAhead: 4, timesLonger: 2.5, extraMin: 6, source: '' },
      }),
    );
    expect(notices[0]!.key).toBe('traffic');
    expect(notices[0]!.text).toContain('6 minutes');
    expect(notices.map((n) => n.key)).toContain('fuel');
  });
});

describe('the tools Muse is told', () => {
  it('has the same tool once, and a description for each', () => {
    for (const tools of Object.values(AGENT_TOOLS)) {
      const names = tools.map((t) => t.function.name);
      expect(new Set(names).size).toBe(names.length);
      for (const t of tools) expect(t.function.description.length).toBeGreaterThan(10);
    }
  });
});

describe('Automatic AI for a commuter', () => {
  const coming = (over: Partial<Arrival>): Arrival => ({
    vehicle: 1,
    plate: 'ABC 123',
    kind: 'jeepney',
    distanceM: 500,
    etaS: 120,
    freeSeats: 4,
    seatsForYou: 3,
    catchable: true,
    ...over,
  });
  const view = (over: Partial<CommuterView>): CommuterView => ({
    phase: 'waiting',
    approach: null,
    stop: { index: 2, name: 'Amparo' },
    roadside: false,
    destination: { index: 5, name: 'Fairview' },
    queueAhead: 0,
    arrivals: [],
    pickup: null,
    trip: { distanceM: 3000, by: 'jeepney', fare: 13, fareDiscounted: 10, arriveInS: null },
    riding: null,
    ...over,
  });

  it('says when the ride that takes you is close', () => {
    const ride = coming({});
    const [first] = riderNotices(view({ arrivals: [ride], pickup: ride }));
    expect(first?.text).toBe('ABC 123 reaches Amparo in about 2 minutes, with a seat for you.');
  });

  it('keeps quiet while the ride is still far off', () => {
    const ride = coming({ etaS: 900 });
    expect(riderNotices(view({ arrivals: [ride], pickup: ride }))).toEqual([]);
  });

  it('warns of a full one before naming the one with a seat', () => {
    const full = coming({ plate: 'FUL 111', seatsForYou: 0, etaS: 60 });
    const next = coming({ plate: 'NEX 222', etaS: 150 });
    const keys = riderNotices(view({ arrivals: [full, next], pickup: next })).map((n) => n.key);
    expect(keys).toEqual(['full:FUL 111', 'pickup:NEX 222']);
  });

  it('says so when nothing in sight has a seat', () => {
    expect(riderNotices(view({})).map((n) => n.key)).toEqual(['no-seat']);
  });

  it('tells someone still on their way which ride they will miss', () => {
    const gone = coming({ catchable: false, etaS: 60 });
    const keys = riderNotices(view({ phase: 'approaching', arrivals: [gone] })).map((n) => n.key);
    expect(keys).toEqual(['missed:ABC 123']);
  });

  it('says your own spot, not a stop, when waiting by the road', () => {
    const ride = coming({});
    const [first] = riderNotices(view({ roadside: true, arrivals: [ride], pickup: ride }));
    expect(first?.text).toContain('your spot');
  });

  it('tells a rider to get ready as their stop nears, and not before', () => {
    const riding = { vehicle: 1, plate: 'ABC 123', kind: 'jeepney' as const, etaS: 90 };
    const near = view({ phase: 'seated', riding: { ...riding, remainingM: 300 } });
    expect(riderNotices(near).map((n) => n.key)).toEqual(['off:5']);
    const far = view({ phase: 'seated', riding: { ...riding, remainingM: 2000, etaS: 600 } });
    expect(riderNotices(far)).toEqual([]);
    // Far in metres, but a clear road brings it in a couple of minutes: time to wake up.
    const soon = view({ phase: 'seated', riding: { ...riding, remainingM: 1200, etaS: 150 } });
    expect(riderNotices(soon).map((n) => n.key)).toEqual(['off:5']);
  });
});

describe('Muse keeping to the numbers', () => {
  const facts = 'Diesel for the trip: 12.5 L, about ₱1,250.';

  it('takes its own words for them', () => {
    expect(onlyItsNumbers(facts, 'Mga ₱1250 ang diesel, 12.5 litro.')).toBe(true);
  });

  it('does not take a number it was never given', () => {
    expect(onlyItsNumbers(facts, 'Mga ₱1,300 ang diesel.')).toBe(false);
  });

  it('may leave one out', () => {
    expect(onlyItsNumbers(facts, 'Mga ₱1,250 ang diesel.')).toBe(true);
  });
});
