import { describe, expect, it } from 'vitest';
import { ADVISORY } from '../../src/core/advisory/model';
import { FARE_BY_VEHICLE, fareFor } from '../../src/core/fare';
import { buildCommutePlan, COSTS, STOP_DWELL_SECONDS } from './planner';

const ride = (kind: string, capacity = 24) => ({
  route: {
    name: 'Line',
    source: 'test',
    lengthKm: 12,
    stops: [
      { name: 'A', sKm: 0, waiting: 0 },
      { name: 'B', sKm: 12, waiting: 0 },
    ],
  },
  simulatedFleet: [{ plate: 'X 1', kind, occupancy: 2, capacity, kmh: 20, nextStop: 'A', sKm: 0 }],
});

describe('the planner agrees with the screens', () => {
  it('counts only riders who get off at a stop shown, not everyone beyond it', () => {
    const plan = buildCommutePlan(
      {
        route: {
          name: 'Line',
          source: 'test',
          lengthKm: 1.5,
          stops: [
            { name: 'A', sKm: 0.4, waiting: 0 },
            { name: 'B', sKm: 0.9, waiting: 6 },
            { name: 'C', sKm: 1.4, waiting: 0 },
          ],
        },
        simulatedFleet: [
          // 18 of the 20 get off further on, past what the driver sees.
          {
            plate: 'X 1',
            occupancy: 20,
            capacity: 24,
            kmh: 20,
            nextStop: 'A',
            sKm: 0,
            dropOffs: { A: 2, 'Far away': 18 },
          },
        ],
      },
      { role: 'driver', driverPlate: 'X 1' },
    );
    const byStop = Object.fromEntries(
      plan.focusedDriverPlan!.stopDecisions.map((d) => [d.stopName, d.dropOffsHere]),
    );
    expect(byStop).toEqual({ A: 2, B: 0, C: 0 });
  });

  it('still empties the vehicle at a terminal', () => {
    const plan = buildCommutePlan(
      {
        route: {
          name: 'Line',
          source: 'test',
          lengthKm: 1,
          stops: [
            { name: 'A', sKm: 0.4, waiting: 0 },
            { name: 'End', sKm: 1, waiting: 0, terminal: true },
          ],
        },
        simulatedFleet: [
          {
            plate: 'X 1',
            occupancy: 5,
            capacity: 24,
            kmh: 20,
            nextStop: 'A',
            sKm: 0,
            dropOffs: {},
          },
        ],
      },
      { role: 'driver', driverPlate: 'X 1' },
    );
    expect(plan.focusedDriverPlan!.stopDecisions.at(-1)!.dropOffsHere).toBe(5);
  });

  it.each(['jeepney', 'modern', 'bus', 'uv'] as const)('charges a %s its own fare', (kind) => {
    const plan = buildCommutePlan(ride(kind), { role: 'commuter', commuterStop: 'A' });
    const advice = plan.focusedCommuterAdvice!;
    expect(advice.regularFarePhp).toBe(fareFor(12, false, FARE_BY_VEHICLE[kind]));
    expect(advice.discountedFarePhp).toBe(fareFor(12, true, FARE_BY_VEHICLE[kind]));
  });

  it('calls the vehicle what it is', () => {
    const plan = buildCommutePlan(ride('bus', 80), { role: 'commuter', commuterStop: 'A' });
    expect(plan.directAnswer).toContain('bus X 1');
    expect(plan.directAnswer).toContain('₱38.75');
  });

  it('never tells a UV Express to load between its terminals', () => {
    const plan = buildCommutePlan(
      {
        route: {
          name: 'Line',
          source: 'test',
          lengthKm: 2,
          stops: [
            { name: 'Mid', sKm: 0.5, waiting: 4 },
            { name: 'End', sKm: 2, waiting: 3, terminal: true },
          ],
        },
        simulatedFleet: [
          {
            plate: 'UV 1',
            kind: 'uv',
            occupancy: 0,
            capacity: 14,
            kmh: 20,
            nextStop: 'Mid',
            sKm: 0,
          },
        ],
      },
      { role: 'driver', driverPlate: 'UV 1' },
    );
    const [mid, end] = plan.focusedDriverPlan!.stopDecisions;
    expect(mid!.expectedBoardingsHere).toBe(0);
    expect(mid!.action.startsWith('SKIP_')).toBe(true);
    expect(mid!.reason).toContain('terminals');
    expect(end!.expectedBoardingsHere).toBe(3);
    expect(plan.stops[0]!.unclaimedWaiting).toBe(4);
  });

  it('uses the ETA the screen shows when the app sends it', () => {
    const snapshot = ride('jeepney');
    Object.assign(snapshot.simulatedFleet[0]!, { sKm: 0, etaS: { A: 90, B: 1234 } });
    const plan = buildCommutePlan(snapshot, { role: 'commuter', commuterStop: 'B' });
    expect(plan.focusedCommuterAdvice!.nearestJeepney!.etaSeconds).toBe(1234);
  });

  it('assumes nothing of a route it is not told about', () => {
    const plan = buildCommutePlan({}, { role: 'operator', question: 'status' });
    expect(plan.directAnswer).not.toContain('Malaria');
    expect(plan.route.name).toBe('this route');
  });

  it('keeps the numbers of the advisory screens', () => {
    expect(STOP_DWELL_SECONDS).toBe(ADVISORY.dwellS);
    expect(COSTS.baseLPerKm).toBe(ADVISORY.fuel.baseLPerKm);
    expect(COSTS.perRiderLPerKm).toBe(ADVISORY.fuel.perRiderLPerKm);
    expect(COSTS.stopGoL).toBe(ADVISORY.fuel.stopGoL);
  });
});
