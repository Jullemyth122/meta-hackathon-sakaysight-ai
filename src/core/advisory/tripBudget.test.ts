/// <reference types="node" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultBudgetInputs, tripBudget, tripRouteFor, type TripRoute } from './tripBudget';
import { defaultRoute } from '../geo/routes';
import { plannerRequest } from './plannerSnapshot';
import { TwinRuntime } from '@/app/twinRuntime';
import { twinState } from '@/app/twinState';
import { buildCommutePlan } from '../../../api/_lib/planner';
import { askAs } from '@/net/assist';
import { POST } from '../../../api/assist';

vi.mock('../../../api/_lib/meta', () => ({
  metaConfigured: () => true,
  creditSaverEnabled: () => false,
  chatWithCache: vi.fn(() => {
    throw new Error('Trip budgeting must not call Meta');
  }),
  MetaEmptyReplyError: class extends Error {},
}));

const route: TripRoute = {
  name: 'Test round-trip road',
  loop: true,
  lengthKm: 20,
  stops: [
    { name: 'Tungko terminal', km: 0, terminal: true, aliases: ['Tungko'] },
    {
      name: 'SM City San Jose del Monte',
      km: 1,
      terminal: false,
      aliases: ['SM Tungko', 'SM Tung'],
    },
    { name: 'SM City Fairview terminal', km: 9, terminal: true, aliases: ['SM Fairview'] },
    { name: 'Return stop', km: 15, terminal: false, aliases: [] },
  ],
};
const inputs = {
  ...defaultBudgetInputs(70),
  movingKmPerL: 5,
  stopsPerLeg: 10,
  startLitresPerStop: 0.02,
  dwellSecondsPerStop: 30,
  trafficIdleMinutesPerLeg: 10,
  terminalIdleMinutesPerLeg: 5,
  idleLPerHour: 1,
};

afterEach(() => vi.unstubAllGlobals());

describe('whole-trip budgeting', () => {
  it('prices ten complete asymmetric round trips, including starts and all engine-on waiting', () => {
    const b = tripBudget(
      'Total diesel for SM Tungko to SM Fairview with 10 times lap',
      route,
      inputs,
    )!;
    expect(b.status).toBe('estimate');
    expect(b.count).toBe(10);
    expect(b.legs?.map((l) => l.km)).toEqual([8, 12]);
    expect(b.legs?.[0]?.from).toBe('SM City San Jose del Monte');
    expect(b.totals).toMatchObject({
      km: 200,
      stops: 200,
      drivingLitres: 40,
      startLitres: 4,
      idleMinutes: 400,
    });
    expect(b.totals?.idleLitres).toBeCloseTo(400 / 60);
    expect(b.totals?.fuelPhp).toBeCloseTo((40 + 4 + 400 / 60) * 70);
    expect(b.answer).toContain('20 one-way legs');
    expect(b.answer).toContain('not measured consumption');
  });
  it('distinguishes one-way trips from ikot and does not double a loop twice', () => {
    const b = tripBudget('10 one-way trips SM Tungko to SM Fairview, total diesel', route, inputs)!;
    expect(b.totals?.km).toBe(80);
    expect(b.legs).toHaveLength(1);
    expect(tripBudget('Diesel for 10 trips', route, inputs)?.status).toBe('clarification');
    expect(tripBudget('Diesel for sampung ikot', route, inputs)?.count).toBe(10);
  });
  it('retains endpoints and repeat count for a local follow-up and accepts new explicit rates', () => {
    const b = tripBudget(
      'Bakit parang Malaria yung calculation? What about ₱80/L at 4 km/L?',
      route,
      inputs,
      ['Total diesel for 10 laps from SM Tungko to SM Fairview'],
    )!;
    expect(b.count).toBe(10);
    expect(b.legs?.[0]?.from).toBe('SM City San Jose del Monte');
    expect(b.totals?.km).toBe(200);
    expect(b.totals?.drivingLitres).toBe(50);
    expect(b.inputs?.dieselPhpPerL).toBe(80);
  });
  it('does not replace ordinary stop, savings, fare or refuelling advice', () => {
    for (const q of [
      'Should I stop at the next stop?',
      'How much diesel do I save?',
      'Saan ang pinakamurang diesel sa unahan?',
      'What is the one-way fare?',
    ])
      expect(tripBudget(q, route, inputs, ['Diesel for 10 laps'])).toBeNull();
  });
  it('asks for missing geometry and rejects invalid rates/counts rather than guessing Malaria distances', () => {
    expect(tripBudget('10 laps total cost', undefined, inputs)?.status).toBe('clarification');
    for (const q of ['-10 laps', '0 laps', '2.5 laps', '1001 laps'])
      expect(tripBudget(q, route, inputs)?.status).toBe('clarification');
    expect(tripBudget('10 laps', route, { ...inputs, movingKmPerL: 0 })?.status).toBe(
      'clarification',
    );
    expect(tripBudget('10 laps', route, { ...inputs, dieselPhpPerL: Infinity })?.status).toBe(
      'clarification',
    );
  });
  it('adds other expenses once and supports measured all-in fuel efficiency without double counting idle', () => {
    const b = tripBudget('10 ikot', route, {
      ...inputs,
      idleLPerHour: 0,
      startLitresPerStop: 0,
      otherCostsPhp: 500,
    })!;
    expect(b.totals?.litres).toBe(40);
    expect(b.totals?.fuelPhp).toBe(2800);
    expect(b.totals?.listedCostsPhp).toBe(3300);
  });
  it('does not silently replace unknown endpoints with the default route', () => {
    expect(tripBudget('Total fuel for 10 laps from Manila to Baguio', route, inputs)?.status).toBe(
      'clarification',
    );
  });
  it('keeps whole-route distance independent of the driver position and three-stop horizon', () => {
    const actualRoute = defaultRoute();
    const twin = new TwinRuntime(actualRoute);
    twin.fleet.vehicles[0]!.s = actualRoute.polyline.length * 0.78;
    const req = plannerRequest(twinState(twin), { role: 'driver', vehicle: 0 });
    expect(req.snapshot.route.stops.length).toBeLessThanOrEqual(3);
    const p = buildCommutePlan(req.snapshot, {
      ...req,
      question: '10 ikot SM Tungko to SM Fairview total diesel',
      tripBudgetInputs: inputs,
    });
    expect(p.tripBudget?.totals?.km).toBeCloseTo((actualRoute.polyline.length / 1000) * 10);
    expect(p.sceneActions.focusStopName).toBeNull();
    expect(p.directAnswer).not.toContain('Skip (');
    expect(tripRouteFor(actualRoute).stops).toHaveLength(actualRoute.stops.length);
  });
  it('answers AI-mode API budgets using deterministic math without calling Meta', async () => {
    const response = await POST(
      new Request('http://localhost/api/assist', {
        method: 'POST',
        headers: { origin: 'http://localhost' },
        body: JSON.stringify({
          question: '10 ikot SM Tungko to SM Fairview total diesel',
          mode: 'ai',
          role: 'driver',
          snapshot: { tripRoute: route },
          tripBudgetInputs: inputs,
        }),
      }),
    );
    const result = await response.json();
    expect(response.status).toBe(200);
    expect(result.creditUsed).toBe(false);
    expect(result.source).toBe('deterministic-planner');
    expect(result.text).toContain('200');
  });
  it('keeps previous questions on-device and sends no history for ordinary questions', async () => {
    const request = plannerRequest(twinState(new TwinRuntime(defaultRoute())), {
      role: 'driver',
      vehicle: 0,
    });
    const fetcher = vi
      .fn()
      .mockResolvedValue(Response.json({ text: 'Stop advice', source: 'test' }));
    vi.stubGlobal('fetch', fetcher);
    const history = ['Diesel for 10 laps SM Tungko to SM Fairview'];
    const answer = await askAs('What about ₱80/L at 4 km/L?', request, history);
    expect(answer.text).toContain('10 round trips');
    expect(fetcher).not.toHaveBeenCalled();
    await askAs('Should I stop at the next stop?', request, history);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]![1].body).not.toContain(history[0]);
    expect(fetcher.mock.calls[0]![1].body).not.toContain('questionHistory');
  });
});
