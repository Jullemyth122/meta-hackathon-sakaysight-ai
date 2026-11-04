import { beforeEach, describe, expect, it } from 'vitest';
import { fitScreen } from './fitScreen';
import { refused, resetGuard } from './guard';
import { POST as assist } from '../assist';

const SITE = 'https://sakay.example';
const ask = (headers: Record<string, string> = { origin: SITE }, body: object = {}) =>
  new Request(`${SITE}/api/assist`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });

beforeEach(resetGuard);

describe('refused', () => {
  it('lets the site itself through', () => {
    expect(refused(ask(), 'assist', 5)).toBeNull();
  });

  it('turns away other sites and scripts with no origin', () => {
    expect(refused(ask({ origin: 'https://other.example' }), 'assist', 5)?.status).toBe(403);
    expect(refused(ask({}), 'assist', 5)?.status).toBe(403);
    expect(refused(ask({ origin: 'not a url' }), 'assist', 5)?.status).toBe(403);
  });

  it('accepts the host a proxy says it served', () => {
    const r = ask({ origin: 'http://localhost:3000', host: 'localhost:3000' });
    expect(refused(r, 'assist', 5)).toBeNull();
  });

  it('limits one visitor without touching another', () => {
    const me = () => ask({ origin: SITE, 'x-forwarded-for': '1.1.1.1' });
    for (let i = 0; i < 3; i++) expect(refused(me(), 'assist', 3)).toBeNull();
    const over = refused(me(), 'assist', 3);
    expect(over?.status).toBe(429);
    expect(over?.headers.get('Retry-After')).toBe('60');
    const other = ask({ origin: SITE, 'x-forwarded-for': '2.2.2.2' });
    expect(refused(other, 'assist', 3)).toBeNull();
  });

  it('limits everyone together too', () => {
    let last: Response | null = null;
    for (let i = 0; i < 11; i++)
      last = refused(ask({ origin: SITE, 'x-forwarded-for': `9.9.9.${i}` }), 'speak', 1);
    expect(last?.status).toBe(429);
  });
});

describe('fitScreen', () => {
  it('leaves a small screen as it is', () => {
    expect(fitScreen({ a: 1 }, 100)).toBe('{"a":1}');
  });

  it('shortens the longest list rather than dropping the screen', () => {
    const screen = { plate: 'X', dieselAhead: Array.from({ length: 50 }, (_, i) => `s${i}`) };
    const text = fitScreen(screen, 200);
    expect(text.length).toBeLessThanOrEqual(200);
    const fitted = JSON.parse(text) as typeof screen & { trimmed?: string };
    expect(fitted.plate).toBe('X');
    expect(fitted.dieselAhead[0]).toBe('s0');
    expect(fitted.trimmed).toBeTruthy();
  });

  it('gives nothing when no list can make it fit', () => {
    expect(fitScreen({ text: 'x'.repeat(500) }, 100)).toBe('');
    expect(fitScreen(null, 100)).toBe('');
  });
});

describe('POST /api/assist', () => {
  const question = { question: 'status', role: 'operator' };

  it('answers without sending the whole plan back', async () => {
    const res = await assist(ask({ origin: SITE }, question));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.source).toBe('deterministic-planner');
    expect(body.plan).toBeUndefined();
  });

  it('stays small with the largest fleet', async () => {
    const stops = Array.from({ length: 60 }, (_, i) => ({
      name: `Stop ${i} → Terminal`,
      sKm: i / 3,
      waiting: i % 5,
    }));
    const simulatedFleet = Array.from({ length: 600 }, (_, i) => ({
      plate: `ABC ${1000 + i}`,
      kind: 'jeepney',
      occupancy: 12,
      capacity: 24,
      kmh: 18,
      nextStop: `Stop ${i % 60} → Terminal`,
      sKm: (i / 600) * 20,
    }));
    const res = await assist(
      ask(
        { origin: SITE },
        {
          ...question,
          snapshot: { route: { name: 'R', source: 't', lengthKm: 20, stops }, simulatedFleet },
        },
      ),
    );
    expect(res.status).toBe(200);
    expect((await res.text()).length).toBeLessThan(10_000);
  });

  it('refuses other sites before doing any work', async () => {
    const res = await assist(ask({ origin: 'https://other.example' }, question));
    expect(res.status).toBe(403);
  });
});
