/**
 * POST /api/plan
 *
 * 100% Zero-Credit ($0.00) Deterministic Commute & Dispatch Endpoint.
 *
 * Computes and returns the full mathematical intelligence without calling the
 * external Meta LLM API, so the frontend (or driver/commuter HUD) can query it
 * as often as needed without spending any of the $150 free Meta API credit:
 *
 * - Commuter ETAs, distance in km, seat forecast after intermediate drop-offs,
 *   best jeepney to board, and LTFRB regular/discounted fares.
 * - Driver stop-by-stop action plan (`STOP_PICKUP_AND_DROPOFF`, `STOP_PICKUP_ONLY`,
 *   `STOP_DROPOFF_ONLY`, `SKIP_CLAIMED_BY_CLOSER_JEEPNEY`, `SKIP_FULL_CAPACITY`,
 *   `SKIP_EMPTY_STOP`).
 * - Multi-jeepney First-Come, First-Served (FCFS) conflict resolution so two
 *   jeepneys never race for the same waiting passengers.
 * - Diesel fuel consumption & savings in kilometers, liters/mL, and PHP.
 */

import { refused } from './_lib/guard.js';
import { buildCommutePlan, type PlanOptions } from './_lib/planner.js';
import type { TripBudgetInputs } from '../src/core/advisory/tripBudget';

/** As /api/assist: room for the largest fleet. */
const MAX_SNAPSHOT_BYTES = 96_000;
/** Free of credit, but not of the server's time. */
const PER_MINUTE = 60;

interface PlanRequestBody {
  tripBudgetInputs?: unknown;
  dieselPriceBasis?: unknown;
  question?: unknown;
  snapshot?: unknown;
  role?: unknown;
  driverPlate?: unknown;
  commuterStop?: unknown;
  destinationStop?: unknown;
  commuterKm?: unknown;
  dieselPricePhpPerLiter?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  const no = refused(request, 'plan', PER_MINUTE);
  if (no) return no;
  let body: PlanRequestBody;
  try {
    body = (await request.json()) as PlanRequestBody;
  } catch {
    return Response.json({ error: 'Body must be JSON' }, { status: 400 });
  }

  const snapshotStr = JSON.stringify(body.snapshot ?? {});
  if (snapshotStr.length > MAX_SNAPSHOT_BYTES) {
    return Response.json({ error: 'snapshot too large' }, { status: 413 });
  }

  const opts: PlanOptions = {
    tripBudgetInputs:
      body.tripBudgetInputs && typeof body.tripBudgetInputs === 'object'
        ? (body.tripBudgetInputs as Partial<TripBudgetInputs>)
        : undefined,
    dieselPriceBasis:
      typeof body.dieselPriceBasis === 'string' ? body.dieselPriceBasis.slice(0, 180) : undefined,
    question: typeof body.question === 'string' ? body.question : undefined,
    role:
      body.role === 'commuter' || body.role === 'driver' || body.role === 'operator'
        ? body.role
        : 'auto',
    driverPlate: typeof body.driverPlate === 'string' ? body.driverPlate : undefined,
    commuterStop: typeof body.commuterStop === 'string' ? body.commuterStop : undefined,
    destinationStop: typeof body.destinationStop === 'string' ? body.destinationStop : undefined,
    commuterKm: typeof body.commuterKm === 'number' ? body.commuterKm : undefined,
    dieselPricePhpPerLiter:
      typeof body.dieselPricePhpPerLiter === 'number' ? body.dieselPricePhpPerLiter : undefined,
  };

  const plan = buildCommutePlan(body.snapshot, opts);
  return Response.json({
    text: plan.directAnswer,
    // Who asked and their plan; every stop for every vehicle runs to megabytes.
    plan: {
      detectedRole: plan.detectedRole,
      route: plan.route,
      stops: plan.stops,
      focusedDriverPlan: plan.focusedDriverPlan,
      focusedCommuterAdvice: plan.focusedCommuterAdvice,
      sceneActions: plan.sceneActions,
      tripBudget: plan.tripBudget,
    },
    creditUsed: false,
    source: 'deterministic-planner',
  });
}
