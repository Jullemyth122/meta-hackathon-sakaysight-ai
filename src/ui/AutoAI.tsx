/**
 * The Automatic AI switch, for the one vehicle or person selected: nothing
 * selected, no switch. It shows On or Off, and is on for one at a time, so
 * Muse never speaks for someone who is not the one on screen.
 */

import { driverTools } from '@/app/agentTools';
import { useRuntimes } from '@/app/runtimeContext';
import { autoKey, useApp } from '@/app/store';
import type { TwinRuntime } from '@/app/twinRuntime';
import { twinState } from '@/app/twinState';
import { commuterView } from '@/core/advisory/commuter';
import { dispatch } from '@/core/advisory/dispatch';
import { driverView } from '@/core/advisory/driver';
import { noticesFor, riderNotices, type Notice } from '@/core/agent/autopilot';
import {
  handOver,
  lateRiders,
  seatsForNextStops,
  trafficAhead,
  vehiclesAhead,
} from '@/core/agent/road';
import { useAutopilot } from './phone/useAutopilot';

export type AutoSubject = { kind: 'vehicle'; index: number } | { kind: 'person'; id: number };

const keyOf = (s: AutoSubject) =>
  s.kind === 'vehicle' ? autoKey('vehicle', s.index) : autoKey('person', s.id);

function vehicleNotices(twin: TwinRuntime, index: number): Notice[] {
  const v = twin.fleet.vehicles[index];
  // Off the route on a way of its own (a U-turn, a shortcut): nothing about its stops to say.
  if (!v || v.detour?.on) return [];
  const now = twinState(twin);
  const plan = dispatch(now);
  const view = driverView(now, index, plan);
  const notices = noticesFor({
    view,
    traffic: trafficAhead(now, index),
    ahead: vehiclesAhead(now, plan, view, index),
    seats: seatsForNextStops(plan, view, index),
    late: lateRiders(now, view, index),
    tank: v.tankL / v.tankCapacityL,
    handOver: handOver(now, index),
  });
  // Passing riders on is done, as when the driver asks Muse: the riders get off
  // at the next stop for the jeepney behind, and this one U-turns for the crowd.
  return notices.map((n) => (n.key === 'hand-over' ? { ...n, act: () => passOn(twin, index) } : n));
}

async function passOn(twin: TwinRuntime, index: number): Promise<string | null> {
  const done = (await driverTools(twin, index)('hand_over', {})) as {
    done?: boolean;
    passedOn?: number;
    getOffAt?: string;
    uTurnNow?: string | null;
    nextVehicle?: { plate: string };
    crowd?: { stop: string; waiting: number };
    payNextDriverPhp?: number;
    gainPhp?: number;
  };
  if (!done.done) return null;
  return (
    `Passed your ${done.passedOn} riders to ${done.nextVehicle!.plate}: they switch at ${done.getOffAt}. ` +
    (done.uTurnNow
      ? `Then U-turn for the ${done.crowd!.waiting} waiting at ${done.crowd!.stop}, no jeepney is coming for them. `
      : '') +
    `Pay that driver ₱${done.payNextDriverPhp}, you gain ₱${done.gainPhp}, if the riders agree.`
  );
}

function personNotices(twin: TwinRuntime, id: number): Notice[] {
  const now = twinState(twin);
  try {
    // Woken for their stop: the clock back to real time, if it was running
    // fast, so they do not sleep through it.
    return riderNotices(commuterView(now, dispatch(now), { passenger: id })).map((n) =>
      n.key.startsWith('off:') ? { ...n, act: () => Promise.resolve(wakeUp(n.text)) } : n,
    );
  } catch {
    return []; // their trip just ended
  }
}

function wakeUp(text: string): string {
  const app = useApp.getState();
  if (app.simulationSpeed > 1) app.setSimulationSpeed(1);
  return text;
}

function Switch({ subject, name }: { subject: AutoSubject; name: string }) {
  const { twin } = useRuntimes();
  const key = keyOf(subject);
  const on = useApp((s) => s.autoAI === key);
  const setAutoAI = useApp((s) => s.setAutoAI);
  const said = useAutopilot(
    on,
    () =>
      subject.kind === 'vehicle'
        ? vehicleNotices(twin, subject.index)
        : personNotices(twin, subject.id),
    subject.kind === 'vehicle' ? 'driver' : 'commuter',
  );
  return (
    <section className="section">
      <label className="toggle">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => setAutoAI(e.target.checked ? key : null)}
        />
        <span>
          <strong>Automatic AI: {on ? 'On' : 'Off'}</strong> for {name}. Muse speaks up by itself
          when something matters. Uses Meta credit.
        </span>
      </label>
      {said && <p className="assist__answer">{said}</p>}
    </section>
  );
}

/** A new selection starts with nothing said. */
export function AutoAI({ subject, name }: { subject: AutoSubject; name: string }) {
  return <Switch key={keyOf(subject)} subject={subject} name={name} />;
}
