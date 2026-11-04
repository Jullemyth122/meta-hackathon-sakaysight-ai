/**
 * The demo's scenes, in the side panel of the Driver and Commuter views: pick
 * one and it happens (app/demoScenes.ts), with the line to say on the mic.
 */

import { useEffect, useState } from 'react';
import {
  DEMO_SCENES,
  nextScene,
  sceneLine,
  stageScene,
  startScene,
  type DemoScene,
  type SceneSide,
} from '@/app/demoScenes';
import { useRuntimes } from '@/app/runtimeContext';
import { useApp } from '@/app/store';
import { speech } from '@/net/voice';
import { openTab } from '../Tabs';

/** Each scene set up once, whichever panel is showing. */
let stagedSeq = 0;

const twelveHour = (at: string) => {
  const [hour, minute] = at.split(':').map(Number) as [number, number];
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`;
};

function Playing({ scene }: { scene: DemoScene }) {
  const english = useApp((s) => s.english);
  const play = (s: DemoScene) => {
    speech.stop();
    startScene(s);
  };
  const end = () => {
    speech.stop();
    useApp.getState().leaveDemo();
  };
  const ask = () => {
    openTab(scene.side, 'ask');
    useApp.getState().setDemoAsk({ text: sceneLine(scene), photo: scene.photo, send: true });
  };
  return (
    <div className="scene-card">
      <span className="scene-card__clock mono">{twelveHour(scene.at)}</span>
      <strong className="scene-card__title">{scene.title}</strong>
      <p className="scene-card__shows">{scene.shows}</p>
      {scene.who && (
        <p className="scene-card__who">
          <strong>For:</strong> {scene.who}
        </p>
      )}
      {scene.why && (
        <p className="scene-card__why">
          <strong>Why it helps:</strong> {scene.why}
        </p>
      )}
      <span className="scene-card__label">Say on the mic</span>
      <p className="scene-card__say">“{english ? scene.sayEn : scene.say}”</p>
      <div className="scene-card__actions">
        <button type="button" className="btn btn--primary" onClick={ask}>
          Ask Muse
        </button>
        <button type="button" className="btn" onClick={() => play(scene)}>
          Replay
        </button>
        <button type="button" className="btn" onClick={() => play(nextScene(scene))}>
          Next
        </button>
        <button type="button" className="btn" onClick={end}>
          End
        </button>
      </div>
    </div>
  );
}

export function DemoScenes({ side }: { side: SceneSide }) {
  const { twin } = useRuntimes();
  const demo = useApp((s) => s.demoScene);
  const [open, setOpen] = useState(false);
  const scene = DEMO_SCENES.find((s) => s.id === demo?.id);

  // Once the twin has been rebuilt for it.
  useEffect(() => {
    if (!demo || !scene || stagedSeq === demo.seq) return;
    if (twin.scenario !== useApp.getState().scenario) return;
    stagedSeq = demo.seq;
    stageScene(scene, twin);
  }, [demo, scene, twin]);

  const list = DEMO_SCENES.filter((s) => s.side === side);
  const english = useApp((s) => s.english);
  const setEnglish = useApp((s) => s.setEnglish);
  const toggleEnglish = (on: boolean) => {
    setEnglish(on);
    // The line waiting in the Ask box, in the new language.
    if (scene)
      useApp.getState().setDemoAsk({ text: sceneLine(scene), photo: scene.photo, send: false });
  };
  return (
    <section className="scenes" aria-label="Demo scenes">
      <button
        type="button"
        className="scenes__toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span>Demo scenes</span>
        <span className="muted">
          {list.length} ready {open ? '▴' : '▾'}
        </span>
      </button>
      {open && (
        <ol className="scenes__list">
          {list.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className={s === scene ? 'is-on' : ''}
                onClick={() => {
                  setOpen(false);
                  speech.stop();
                  startScene(s);
                }}
              >
                <span className="mono">{twelveHour(s.at)}</span>
                <span>{s.title}</span>
              </button>
            </li>
          ))}
        </ol>
      )}
      <div className="scenes__language" role="group" aria-label="Muse answers in">
        <span className="muted">Muse answers in</span>
        <button type="button" aria-pressed={!english} onClick={() => toggleEnglish(false)}>
          Taglish
        </button>
        <button type="button" aria-pressed={english} onClick={() => toggleEnglish(true)}>
          English
        </button>
      </div>
      {scene?.side === side && <Playing scene={scene} />}
    </section>
  );
}
