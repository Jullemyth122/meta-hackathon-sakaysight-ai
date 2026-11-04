import { onPhone } from '@/app/device';
import { useApp, type View } from '@/app/store';
import { ViewPerformance } from './ViewPerformance';

const VIEWS: Array<{ id: View; label: string }> = [
  { id: 'twin', label: 'Live map' },
  { id: 'driver', label: 'Driver' },
  { id: 'commuter', label: 'Commuter' },
  { id: 'doorway', label: 'Sensor lab' },
];

/** On a phone you are a commuter or a driver: the rest is the operator's. */
const SHOWN = onPhone ? VIEWS.filter((v) => v.id === 'commuter' || v.id === 'driver') : VIEWS;

/** The Profit & service lab is the operator's: opened from the live twin, and part of it. */
const tabOf = (view: View): View => (view === 'economics' ? 'twin' : view);

export function Header() {
  const view = useApp((s) => s.view);
  const setView = useApp((s) => s.setView);
  const backend = useApp((s) => s.backend);
  const transport = useApp((s) => s.transport);

  return (
    <header className="header">
      <div className="brand">
        <span className="brand__mark" aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
        <h1>SakaySightAI</h1>
      </div>

      <nav className="seg" aria-label="Views">
        {SHOWN.map((v) => (
          <button
            key={v.id}
            type="button"
            className={tabOf(view) === v.id ? 'is-on' : ''}
            aria-current={tabOf(view) === v.id ? 'page' : undefined}
            onClick={() => setView(v.id)}
          >
            {v.label}
          </button>
        ))}
      </nav>

      <div className="header__status">
        <ViewPerformance />
        {!onPhone && (
          <a
            className="chip chip--link"
            href="/track.html"
            target="_blank"
            rel="noreferrer"
            title={`Share a phone's GPS with this map. Link: ${
              transport === 'firebase'
                ? 'Firebase Realtime'
                : transport === 'loopback'
                  ? 'same browser'
                  : 'connecting'
            }. Drawing with ${backend ?? 'starting renderer'}.`}
          >
            Phone tracker ↗
          </a>
        )}
      </div>
    </header>
  );
}
