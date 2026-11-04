/**
 * Ask Muse from the Live twin, by typing or by voice. With a jeepney
 * selected, the question is about that jeepney and sent exactly as its
 * driver's app would send it; with none, about the whole fleet
 * (operatorScreen: totals and the busiest stops). Either way the size, and so
 * the cost, does not grow with the fleet.
 */

import type { PlannerRequest } from '@/core/advisory/plannerSnapshot';
import type { AgentContext } from '@/net/agent';
import { AskBox } from './phone/AskBox';

const FLEET_QUESTIONS = [
  'Which vehicle should pick up the most waiting riders next?',
  'Where are the most people waiting?',
];
const VEHICLE_QUESTIONS = ['Should it stop at the next stop?', 'How full will it be?'];

export function AssistPanel({
  about,
  keywords,
  request,
  agent,
}: {
  /** The selected jeepney's plate, or null for the whole fleet. */
  about: string | null;
  /** Words to listen for when asked by voice. */
  keywords: string[];
  request: () => PlannerRequest;
  agent: AgentContext;
}) {
  return (
    <section className="section">
      <h3 className="section__title">Ask the assistant</h3>
      <p className="fine">
        {about
          ? `Asking about ${about}, the vehicle you selected.`
          : 'Asking about the whole fleet. Select a vehicle to ask about it.'}
      </p>
      <AskBox
        suggestions={about ? VEHICLE_QUESTIONS : FLEET_QUESTIONS}
        keywords={keywords}
        request={request}
        agent={agent}
      />
      <p className="fine">Muse AI answers, using only the numbers the app has worked out.</p>
    </section>
  );
}
