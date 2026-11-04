import { useRuntimes } from '@/app/runtimeContext';
import { twinState } from '@/app/twinState';
import { approachTime, incomingMapData } from '@/scene/world/incomingMap';
import { Fold } from './Tabs';
import { useTicker } from './useTicker';
import '@/styles/incoming.scss';

export function IncomingStopsPanel() {
  useTicker(2);
  const { twin } = useRuntimes();
  const state = twinState(twin);
  const stops = incomingMapData(state, { view: 'twin' });
  const incoming = stops.reduce((sum, s) => sum + s.incoming.length, 0);
  const waiting = state.passengers.filter((p) => p.phase === 'waiting').length;
  return (
    <section className="section">
      <div className="stats">
        <div className="stat">
          <span className="stat__value">{waiting}</span>
          <span className="stat__label">Waiting at stops</span>
        </div>
        <div className="stat">
          <span className="stat__value">{incoming}</span>
          <span className="stat__label">Within 500 m</span>
        </div>
      </div>
      <h3 className="section__title">Busiest stops</h3>
      <ul className="incoming-stops">
        {stops
          .filter((s) => s.incoming.length > 0)
          .slice(0, 6)
          .map((entry) => {
            const first = entry.incoming[0]!;
            const tricycles = entry.incoming.filter((p) => p.mode === 'tricycle').length;
            return (
              <li key={`${entry.stop}-${entry.direction}`}>
                <strong>
                  {state.route.stops[entry.stop]!.name}
                  {!state.route.loop && ` · ${entry.direction === 1 ? 'outbound' : 'inbound'}`}
                </strong>
                <span>
                  {entry.waiting} waiting · {entry.incoming.length} approaching
                </span>
                <span className="muted">
                  Nearest arrival in {approachTime(first.etaS)} · {Math.round(first.distanceM)} m
                </span>
                <span className="fine">
                  {entry.incoming.length - tricycles} walking · {tricycles} by tricycle
                </span>
              </li>
            );
          })}
      </ul>
      {incoming === 0 && <p className="fine">Nobody is heading to a stop right now.</p>}
      <Fold title="Reading the map labels">
        <p className="fine">
          Simulated journeys. Teal labels show stop counts, amber follow people on their way to a
          stop, and purple follow people walking home in the evening. People on their way join the
          queue when they reach the stop.
        </p>
      </Fold>
    </section>
  );
}
