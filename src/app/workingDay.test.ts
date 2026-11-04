import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FIELD_SCENARIO, normalizeScenario } from '@/core/fleet/scenario';
import { setStationData } from '@/core/fuel/stations';
import { defaultRoute } from '@/core/geo/routes';
import { TwinRuntime } from './twinRuntime';

/**
 * Most any vehicle stands at an ordinary stop (seconds). Five minutes behind a
 * queue happens; one that cannot go stands for hours, the route backed up behind it.
 */
const LONGEST_AT_A_STOP_S = 600;
/**
 * The fleet (60) is never held up for long. The lines at the two terminals can
 * have this many standing between them, but they move: for minutes, not hours.
 */
const MANY_STANDING = 30;
const LONGEST_HELD_UP_S = 1200;
/** How long the checks run: through the morning rush, where one stuck vehicle shows at once. */
const HOURS = Number(process.env.DAY_HOURS ?? 8);
const LOG = process.env.DAY_LOG;

function run(seed: number) {
  const route = defaultRoute();
  const twin = new TwinRuntime(route, undefined, normalizeScenario({ ...FIELD_SCENARIO, seed }));
  const f = twin.fleet;
  const since = new Map<number, number>();
  let longest = 0;
  let longestWho = '';
  let heldUpS = 0;
  let longestHeldUp = 0;
  const dt = 0.5;
  for (let i = 0; i < (HOURS * 3600) / dt; i++) {
    twin.step(dt, i * 500);
    let standing = 0;
    for (const v of f.vehicles) {
      const out = v.duty !== 'parked' && !v.yard && v.speedMps < 0.1;
      if (out && v.currentStop === null) standing++;
      const here = v.currentStop;
      if (!out || here === null || route.stops[here]!.terminal) {
        since.delete(v.id);
        continue;
      }
      const from = since.get(v.id) ?? f.elapsedS;
      since.set(v.id, from);
      if (f.elapsedS - from > longest) {
        longest = f.elapsedS - from;
        longestWho = `${v.plate} ${v.kind} at ${route.stops[here]!.name}: ${twin.crew.status(v.id)}`;
      }
    }
    heldUpS = standing > MANY_STANDING ? heldUpS + dt : 0;
    longestHeldUp = Math.max(longestHeldUp, heldUpS);
    if (LOG && i % 7200 === 0)
      appendFileSync(
        LOG,
        `seed ${seed} day ${f.dayNumber} ${(f.timeOfDay / 3600).toFixed(1)}h standing ${standing} waiting ${f.waiting.reduce((a, b) => a + b, 0)} at terminal ${f.waiting[0]} longest ${Math.round(longest)}s ${longestWho}\n`,
      );
  }
  return { longest, longestWho, longestHeldUp };
}

describe('a working day', () => {
  setStationData(JSON.parse(readFileSync('public/data/metro-manila-fuel.json', 'utf8')).stations);
  if (LOG) writeFileSync(LOG, '');

  it('never freezes: no vehicle is left standing at a stop, holding up the route', () => {
    for (const seed of (process.env.DAY_SEEDS ?? '11').split(',').map(Number)) {
      const { longest, longestWho, longestHeldUp } = run(seed);
      expect(longest, longestWho).toBeLessThan(LONGEST_AT_A_STOP_S);
      expect(longestHeldUp).toBeLessThan(LONGEST_HELD_UP_S);
    }
  });
});
