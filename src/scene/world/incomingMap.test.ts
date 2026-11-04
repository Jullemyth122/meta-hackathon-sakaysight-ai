import { describe, expect, it } from 'vitest';
import type { PassengerState, TwinState } from '@/core/advisory/model';
import { Polyline } from '@/core/geo/polyline';
import { approachTime, incomingMapData } from './incomingMap';

function scene(): TwinState {
  const person = (
    id: number,
    originStop: number,
    extra: Partial<PassengerState> = {},
  ): PassengerState => ({
    id,
    originStop,
    destinationStop: 3,
    direction: 1,
    phase: 'approaching',
    vehicle: null,
    x: 100,
    z: 10,
    queuedAt: Infinity,
    approachMode: 'walk',
    distanceToStopM: 300,
    arrivalInS: 200,
    ...extra,
  });
  return {
    route: {
      id: 'map',
      name: 'Map test',
      source: 'synthetic',
      projection: null,
      stopsSource: 'placeholder',
      loop: false,
      polyline: new Polyline([
        { x: 0, z: 0 },
        { x: 3000, z: 0 },
      ]),
      stops: [
        { name: 'Behind', s: 0, terminal: true },
        { name: 'Next', s: 400 },
        { name: 'End', s: 800, terminal: true },
        { name: 'Beyond terminal', s: 1500 },
      ],
    },
    vehicles: [
      {
        index: 0,
        plate: 'TEST',
        s: 200,
        direction: 1,
        speedMps: 5,
        occupancy: 0,
        capacity: 20,
        atStop: null,
        x: 200,
        z: 0,
        heading: 0,
      },
    ],
    passengers: [
      person(1, 0),
      person(2, 1),
      person(3, 1, { phase: 'waiting', distanceToStopM: 0, arrivalInS: 0 }),
      person(4, 1, { direction: -1 }),
      person(5, 1, { distanceToStopM: 501 }),
      person(6, 2, { approachMode: 'tricycle', arrivalInS: 60 }),
      person(7, 3),
    ],
  };
}

describe('incoming commuters on the map', () => {
  it('shows driver only stops ahead through the next terminal and their direction', () => {
    const stops = incomingMapData(scene(), { view: 'driver', vehicle: 0 });
    expect(stops.map((s) => s.stop)).toEqual([1, 2]);
    expect(stops[0]!.waiting).toBe(1);
    expect(stops[0]!.incoming.map((p) => p.passenger)).toEqual([2]);
  });

  it('shows only the individual commuter marker while retaining stop totals', () => {
    const stops = incomingMapData(scene(), { view: 'commuter', query: { passenger: 2 } });
    expect(stops).toHaveLength(1);
    expect(stops[0]!.markers.map((p) => p.passenger)).toEqual([2]);
    expect(stops[0]!.waiting).toBe(1);
    expect(incomingMapData(scene(), { view: 'commuter', query: { passenger: 99 } })).toEqual([]);
  });

  it('keeps both directions in the operational twin and excludes distant approaches', () => {
    const stops = incomingMapData(scene(), { view: 'twin' });
    expect(stops.find((s) => s.stop === 1 && s.direction === -1)!.incoming[0]!.passenger).toBe(4);
    expect(stops.flatMap((s) => s.incoming).some((p) => p.passenger === 5)).toBe(false);
  });

  it('does not call a person still on their way arrived', () => {
    expect(approachTime(20)).toBe('20 s');
    expect(approachTime(65)).toBe('65 s');
    expect(approachTime(130)).toBe('2 min');
    expect(approachTime(170)).toBe('3 min');
  });
});
