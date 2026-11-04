/** Client for /api/assist. `npm run dev`, `vercel dev` and a deployment all serve it. */

import type { PlannerRequest } from '@/core/advisory/plannerSnapshot';
import { budgetHistory, tripBudget } from '@/core/advisory/tripBudget';

export interface AssistAnswer {
  text: string;
  /** True only when Meta AI was actually called (not cached). */
  creditUsed: boolean;
  /** 'meta-ai', or the app's own numbers when Muse is off or out of reach. */
  source: string;
  cached?: boolean;
  /** The tools Muse used for it, when the agent answered. */
  tools?: string[];
}

async function post(body: object): Promise<AssistAnswer> {
  const res = await fetch('/api/assist', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 404) throw new Error('No /api here. Use `npm run dev` or the deployment.');
  const data = (await res.json().catch(() => ({}))) as Partial<AssistAnswer> & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Assistant failed (${res.status})`);
  return {
    text: data.text ?? '',
    creditUsed: data.creditUsed === true,
    source: data.source ?? 'unknown',
    cached: data.cached,
  };
}

/** Ask as a driver, commuter or operator. */
export function askAs(
  question: string,
  request: PlannerRequest,
  localQuestionHistory: readonly string[] = [],
): Promise<AssistAnswer> {
  const budget = budgetAnswer(question, request, localQuestionHistory);
  return budget ? Promise.resolve(budget) : post({ question, ...request });
}

/**
 * A whole-trip budget question's numbers, worked out here to the peso for Muse
 * to tell, or null when it is not one.
 */
export function budgetAnswer(
  question: string,
  request: PlannerRequest,
  localQuestionHistory: readonly string[] = [],
): AssistAnswer | null {
  // Whole-trip arithmetic and follow-up context stay on this device. Never
  // forward prior questions to the external model or to the API request.
  const budget = tripBudget(
    question,
    request.snapshot.tripRoute,
    { dieselPhpPerL: request.dieselPricePhpPerLiter, ...request.tripBudgetInputs },
    budgetHistory(localQuestionHistory),
    request.dieselPriceBasis,
  );
  return budget
    ? { text: budget.answer, creditUsed: false, source: 'deterministic-planner' }
    : null;
}
