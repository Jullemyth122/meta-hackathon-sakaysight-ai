/** The commuter's Locate me button, and how it is going (app/useLocateMe.ts). */

import { useApp } from '@/app/store';
import type { GeoError } from '@/tracker/useGeolocation';

export const PROBLEM: Record<Exclude<GeoError, null>, string> = {
  unsupported: 'This browser cannot read your location.',
  insecure: 'Your location only works on the https address of this site.',
  denied: 'Location is blocked. Allow it for this site in your browser settings.',
  unavailable: 'No GPS signal yet. Try near a window or outside.',
  timeout: 'Still looking for a GPS signal…',
};

export function LocateMe() {
  const on = useApp((s) => s.locating && s.sharingAs === 'commuter');
  const located = useApp((s) => s.located);
  const error = useApp((s) => s.locateError);
  const setLocating = useApp((s) => s.setLocating);
  // A demo scene is staged: your real place belongs to the live map, not to it.
  const inScene = useApp((s) => s.demoScene !== null);
  if (inScene) return null;
  return (
    <section className="section">
      <button
        type="button"
        className={on ? 'btn btn--big' : 'btn btn--primary btn--big'}
        aria-pressed={on}
        onClick={() => setLocating(!on)}
      >
        {on ? 'Stop sharing my location' : 'Locate me'}
      </button>
      <p className="fine" role="status">
        {on && error
          ? PROBLEM[error]
          : !on
            ? 'Shows you on the map and plans from where you are. While it is on, the operator’s live map shows you too.'
            : located
              ? `Found you, within about ${Math.round(located.accuracyM)} m: that is you on the map. The live map can see you.`
              : 'Finding you… allow location if your phone asks.'}
      </p>
    </section>
  );
}
