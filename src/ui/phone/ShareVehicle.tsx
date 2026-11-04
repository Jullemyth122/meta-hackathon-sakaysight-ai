/**
 * A real driver sharing their phone's GPS, as the vehicle they drive: the
 * operator's live map draws that vehicle where they really are. It stands
 * beside the simulated fleet: nobody boards it, and the advice on this screen
 * stays that of the simulated vehicle chosen above.
 */

import { useState } from 'react';
import { useApp } from '@/app/store';
import { KIND_NAME, type FleetKind } from '@/core/vehicles/specs';
import { PROBLEM } from './LocateMe';

const KINDS: readonly FleetKind[] = ['jeepney', 'modern', 'uv', 'bus'];

export function ShareVehicle() {
  const sharing = useApp((s) => (s.locating && s.sharingAs !== 'commuter' ? s.sharingAs : null));
  const located = useApp((s) => s.located);
  const error = useApp((s) => s.locateError);
  const setLocating = useApp((s) => s.setLocating);
  const [kind, setKind] = useState<FleetKind>('jeepney');
  const on = sharing !== null;
  // A demo scene is staged: your real vehicle belongs to the live map, not to it.
  const inScene = useApp((s) => s.demoScene !== null);
  if (inScene) return null;
  return (
    <section className="section">
      <label className="row">
        <span>I drive a</span>
        <select
          className="phone__select"
          value={sharing ?? kind}
          disabled={on}
          onChange={(e) => setKind(e.target.value as FleetKind)}
        >
          {KINDS.map((k) => (
            <option key={k} value={k}>
              {KIND_NAME[k]}
            </option>
          ))}
        </select>
      </label>
      <button
        type="button"
        className={on ? 'btn btn--big' : 'btn btn--primary btn--big'}
        aria-pressed={on}
        onClick={() => setLocating(!on, kind)}
      >
        {on ? 'Stop sharing my location' : 'Share my location'}
      </button>
      <p className="fine" role="status">
        {on && error
          ? PROBLEM[error]
          : !on
            ? 'Puts your real vehicle on the live map, where you are. Your phone stays on while it runs.'
            : located
              ? `The live map shows your ${KIND_NAME[sharing!].toLowerCase()} here, within about ${Math.round(located.accuracyM)} m.`
              : 'Finding you… allow location if your phone asks.'}
      </p>
    </section>
  );
}
