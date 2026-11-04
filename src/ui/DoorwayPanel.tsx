/**
 * Sensor lab panel: the cabin camera's count next to the simulated truth,
 * the pipeline telemetry, and controls to run the stop.
 */

import { useRuntimes } from '@/app/runtimeContext';
import { useApp } from '@/app/store';
import { CounterBadge } from './CounterBadge';
import { Fold } from './Tabs';
import { useTicker } from './useTicker';
import { VehiclePicker, VehicleSpecPanel } from './VehicleSpecPanel';

export function DoorwayPanel() {
  const vehicle = useApp((s) => s.labVehicle);
  if (vehicle !== 'jeepney')
    return (
      <div className="panel__body">
        <VehiclePicker />
        <VehicleSpecPanel kind={vehicle} />
      </div>
    );
  return <JeepneyLabPanel />;
}

function JeepneyLabPanel() {
  useTicker(8);
  const { doorway } = useRuntimes();
  const showFov = useApp((s) => s.showFov);
  const setShowFov = useApp((s) => s.setShowFov);
  const { sim, pipeline } = doorway;
  const t = pipeline.telemetry(doorway.clockMs);
  const off = t.counts.current - sim.truth.inside;

  return (
    <div className="panel__body">
      <VehiclePicker />
      <section className="section">
        <h3 className="section__title">Camera count against the truth</h3>
        <div className="counters">
          <CounterBadge
            label="Passengers on board"
            value={t.counts.current}
            note={`actual ${sim.truth.inside}${off ? ` (${off > 0 ? '+' : ''}${off})` : ''}`}
            tone={off === 0 ? 'good' : Math.abs(off) <= 1 ? 'warn' : 'bad'}
          />
          <CounterBadge
            label="Total boarded"
            value={t.counts.boarded}
            note={`actual ${sim.truth.boarded}`}
          />
          <CounterBadge
            label="Total alighted"
            value={t.counts.alighted}
            note={`actual ${sim.truth.alighted}`}
          />
        </div>
        <p className="fine">“Actual” is what the simulation knows and a real phone would not.</p>
      </section>

      <section className="section">
        <h3 className="section__title">Run the stop</h3>
        <div className="row">
          <button type="button" className="btn" onClick={() => sim.request('board', 1)}>
            +1 boards
          </button>
          <button type="button" className="btn" onClick={() => sim.request('board', 4)}>
            +4 board
          </button>
          <button type="button" className="btn" onClick={() => sim.request('alight', 1)}>
            −1 alights
          </button>
          <button type="button" className="btn" onClick={() => sim.request('alight', 4)}>
            −4 alight
          </button>
        </div>
        <label className="toggle">
          <input
            type="checkbox"
            checked={sim.autoStops}
            onChange={(e) => (sim.autoStops = e.target.checked)}
          />
          <span>Automatic stops every 14–22 s</span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={showFov} onChange={(e) => setShowFov(e.target.checked)} />
          <span>Show what the camera sees</span>
        </label>
      </section>

      <section className="section">
        <Fold title="How the camera counts">
          <div className="kv">
            <span>Heads in view</span>
            <span className="mono">
              {t.seenNow} now, {t.seenSteady} steady
            </span>
            <span>Corrections</span>
            <span className="mono">{t.counts.corrections}</span>
          </div>
          <p className="fine">
            A head that goes from the door (small, inside the green box) into the cabin is a
            boarding; the reverse is an alighting. Heads in view are a floor: when the camera sees
            more people than the door count allows, it corrects upward. In a full jeepney the back
            rows hide behind the front ones, so heads in view undercount and the door count carries
            the estimate.
          </p>
        </Fold>
      </section>

      <section className="section">
        <Fold title="Camera details">
          <div className="kv">
            <span>FPS</span>
            <span className="mono">{t.fps}</span>
            <span>Inference latency</span>
            <span className="mono">{t.latencyMs.toFixed(0)} ms</span>
            <span>Dropped frames</span>
            <span className="mono">{t.dropped}</span>
            <span>Link</span>
            <span>Local Wi-Fi SoftAP (video) / BLE (counts)</span>
            <span>Hardware</span>
            <span>ESP32-S3-CAM, QVGA 320×240, wide lens, ceiling at the front</span>
            <span>Detector</span>
            <span>
              Head detector (simulated: {Math.round(pipeline.model.missRate * 100)}% miss, misses
              heads hidden behind nearer people)
            </span>
          </div>
        </Fold>
      </section>
    </div>
  );
}
