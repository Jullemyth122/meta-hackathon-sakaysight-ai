/**
 * Ask the assistant as this driver or commuter, by typing or by voice.
 *
 * Nothing is sent until the person asks: typing does not count, a tap on a
 * suggestion, Ask or the mic does. The mic records one question, in either
 * of two ways:
 *
 *   tap    talk, pause as you like; 2.5 s of quiet sends it (the countdown
 *          shows), or tap again to send now
 *   hold   talk while holding the mic, let go to send; pauses never end it
 *
 * Only that recording is sent (see net/voice.ts). The answer is read out,
 * with pause, resume and stop, in the voice the person picks. Hands-free
 * listens for "Hey Sakay, ..." where the browser supports it. Muse answers
 * everything; if it cannot be reached the app's own numbers stand in, and the
 * line under each answer says which it was and what it cost.
 */

import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useApp } from '@/app/store';
import type { PlannerRequest } from '@/core/advisory/plannerSnapshot';
import { askAgent, photoForMuse, phrase, type AgentContext, type AgentMessage } from '@/net/agent';
import { askAs, budgetAnswer, type AssistAnswer } from '@/net/assist';
import {
  hasFilipinoVoice,
  listen,
  looksTagalog,
  micSupported,
  record,
  speech,
  transcribe,
  voices,
  voiceSupported,
  type Heard,
  type Recording,
  type SpeechState,
} from '@/net/voice';

function costLine(a: AssistAnswer): string {
  if (a.tools?.length) return `Muse AI looked up: ${[...new Set(a.tools)].join(', ')}`;
  if (a.source === 'meta-ai')
    return a.creditUsed ? 'Muse AI (Meta) · used credit' : 'Muse AI · cached, no credit';
  return 'Muse AI could not be reached: these are the app’s own numbers';
}

/** A trip's cost is worked out on this device, and told by Muse. */
async function inMuseWords(
  worked: AssistAnswer,
  question: string,
  role: AgentContext['role'] = 'driver',
): Promise<AssistAnswer> {
  const tongue = !useApp.getState().english && looksTagalog(question) ? 'Taglish' : 'English';
  const text = await phrase(worked.text, { role, long: true, tongue }).catch(() => worked.text);
  return text === worked.text
    ? { ...worked, source: 'deterministic-fallback' }
    : { text, creditUsed: true, source: 'meta-ai' };
}

type Mic = 'idle' | 'recording' | 'holding' | 'transcribing';
/** Pressed longer than this, the mic is being held (push to talk). */
const HOLD_MS = 350;
/** Must match SILENCE_S in net/voice.ts: for the "sending in…" countdown. */
const SEND_AFTER_QUIET_S = 2.5;
const VOICE_KEY = 'sakaysightai.voice';
/** The last line from a demo scene taken up, by whichever Ask box was showing. */
let tookDemoAsk = 0;

function MicIcon() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor" />
      <path
        d="M6 11a6 6 0 0 0 12 0M12 17v4M9 21h6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
      />
    </svg>
  );
}

/** The voice the person picked, remembered on this device ('' = automatic). */
function useVoiceChoice(): [string, (uri: string) => void, SpeechSynthesisVoice[]] {
  const [choice, setChoice] = useState(() => {
    try {
      return localStorage.getItem(VOICE_KEY) ?? '';
    } catch {
      return '';
    }
  });
  const [list, setList] = useState(voices);
  useEffect(() => {
    if (typeof speechSynthesis === 'undefined') return;
    // Browsers load their voice list a moment after the page.
    const update = () => setList(voices());
    speechSynthesis.addEventListener('voiceschanged', update);
    return () => speechSynthesis.removeEventListener('voiceschanged', update);
  }, []);
  const pick = (uri: string) => {
    setChoice(uri);
    try {
      localStorage.setItem(VOICE_KEY, uri);
    } catch {
      // Private mode: the choice lasts until the page closes.
    }
  };
  return [choice, pick, list];
}

/** A picture of the app's own, as a photo for Muse. */
async function demoPhoto(url: string): Promise<string | undefined> {
  const res = await fetch(url);
  if (!res.ok) return undefined;
  return photoForMuse(new File([await res.blob()], 'photo.jpg', { type: 'image/jpeg' }));
}

export function AskBox({
  suggestions,
  request,
  keywords = [],
  handsFree = false,
  agent,
}: {
  suggestions: string[];
  /** Built when asked, so it carries the numbers of that moment. */
  request: () => PlannerRequest;
  /** Words to listen for when transcribing (stop names, fare words). */
  keywords?: string[];
  /** Offer listening for the wake phrase (the driver: eyes on the road). */
  handsFree?: boolean;
  /** Let Muse look things up and act (the Sakay Agent); else it explains the app's numbers. */
  agent?: AgentContext;
}) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState<AssistAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState<{ sentence: string; heard: Heard } | null>(null);
  const [mic, setMic] = useState<Mic>('idle');
  const [level, setLevel] = useState(0);
  const [quiet, setQuiet] = useState(0);
  const [spoken, setSpoken] = useState<SpeechState>(speech.state());
  const [voice, setVoice, voiceList] = useVoiceChoice();
  const recording = useRef<Recording | null>(null);
  const pressedAt = useRef(0);
  const holding = useRef(false);
  const questionHistory = useRef<string[]>([]);
  const memory = useRef<AgentMessage[]>([]);
  const [photo, setPhoto] = useState<string | null>(null);
  // The photo seen full size, tapped on; closed by a tap anywhere or Escape.
  const [photoOpen, setPhotoOpen] = useState(false);
  useEffect(() => {
    if (!photoOpen) return;
    const close = (e: KeyboardEvent) => e.key === 'Escape' && setPhotoOpen(false);
    window.addEventListener('keydown', close);
    return () => window.removeEventListener('keydown', close);
  }, [photoOpen]);
  const box = useRef<HTMLFormElement>(null);

  const [serverVoice, setServerVoice] = useState(speech.serverVoice());
  useEffect(() => speech.subscribe(setSpoken), []);
  useEffect(() => speech.subscribeServerVoice(setServerVoice), []);

  // The latest closure, so long-lived voice callbacks never ask with stale numbers.
  const ask = useRef<(q: string, aloud?: boolean, picture?: string) => Promise<void>>(
    async () => {},
  );
  ask.current = async (q: string, aloud = false, picture = photo ?? undefined) => {
    if (!q.trim() || busy) return;
    speech.stop();
    setQuestion(q);
    setBusy(true);
    setError(null);
    try {
      const req = request();
      const budget = budgetAnswer(q, req, questionHistory.current);
      let a = budget && (await inMuseWords(budget, q, agent?.role));
      if (!a && agent) {
        try {
          const reply = await askAgent(
            q,
            agent,
            memory.current,
            picture,
            useApp.getState().english,
          );
          a = { text: reply.text, creditUsed: true, source: 'meta-ai', tools: reply.tools };
          setPhoto(null);
        } catch (err) {
          // Without Muse a photo cannot be read; a question can still be answered.
          if (picture) throw err;
        }
      }
      a ??= await askAs(q, req, questionHistory.current);
      setAnswer(a);
      questionHistory.current = [...questionHistory.current, q].slice(-4);
      // Asked by voice, answered by voice: eyes stay on the road.
      if (aloud || listening) speech.speak(a.text, voice);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  // A demo scene's line: in the box, ready for the mic, or asked aloud at once.
  const demoAsk = useApp((s) => s.demoAsk);
  useEffect(() => {
    if (!demoAsk || demoAsk.seq === tookDemoAsk) return;
    tookDemoAsk = demoAsk.seq;
    const { text, photo: picture, send } = demoAsk;
    setQuestion(text);
    setAnswer(null);
    setError(null);
    setPhoto(null);
    memory.current = [];
    questionHistory.current = [];
    // The line, the mic and the answer on screen together, under the scene.
    requestAnimationFrame(() => box.current?.scrollIntoView({ block: 'start' }));
    void (async () => {
      const shot = picture ? await demoPhoto(picture) : undefined;
      if (shot) setPhoto(shot);
      if (send) await ask.current(text, true, shot);
    })();
  }, [demoAsk]);

  /** End the recording, turn it into text, and ask it. */
  const send = useRef(async () => {});
  send.current = async () => {
    const rec = recording.current;
    if (!rec) return;
    recording.current = null;
    holding.current = false;
    setMic('transcribing');
    try {
      const text = await transcribe(await rec.stop(), keywords);
      if (text) void ask.current(text, true);
      else setError('Didn’t catch that. Tap the mic and try again.');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setMic('idle');
      setLevel(0);
      setQuiet(0);
    }
  };

  async function pressMic() {
    pressedAt.current = performance.now();
    holding.current = true;
    if (mic === 'recording') return void send.current(); // second tap: send now
    if (mic !== 'idle') return;
    setError(null);
    speech.stop();
    try {
      recording.current = await record(
        () => void send.current(),
        () => !holding.current,
      );
      setMic(holding.current ? 'holding' : 'recording');
    } catch (err) {
      holding.current = false;
      const denied = err instanceof DOMException && err.name === 'NotAllowedError';
      setError(denied ? 'Microphone permission denied.' : 'No microphone available.');
    }
  }

  function releaseMic() {
    const held = performance.now() - pressedAt.current >= HOLD_MS;
    holding.current = false;
    if (!recording.current) return;
    // Held down: letting go sends. A quick tap leaves it listening.
    if (held) void send.current();
    else setMic('recording');
  }

  // Level meter and quiet countdown while recording; drop any recording if the panel closes.
  useEffect(() => {
    if (mic !== 'recording' && mic !== 'holding') return;
    const id = window.setInterval(() => {
      setLevel(recording.current?.level() ?? 0);
      setQuiet(recording.current?.quiet() ?? 0);
    }, 100);
    return () => window.clearInterval(id);
  }, [mic]);
  useEffect(
    () => () => {
      recording.current?.cancel();
      speech.stop();
    },
    [],
  );

  useEffect(() => {
    if (!listening) return;
    return listen(
      (q) => void ask.current(q),
      (sentence, heard) => setHeard({ sentence, heard }),
      (message) => {
        setError(message);
        setListening(false);
      },
    );
  }, [listening]);

  function submit(e: FormEvent) {
    e.preventDefault();
    void ask.current(question || (photo ? 'Ano ang nakasulat dito?' : ''));
  }

  async function takePhoto(file: File | undefined) {
    if (!file) return;
    try {
      setPhoto(await photoForMuse(file));
    } catch {
      setError('That photo could not be read.');
    }
  }

  const status =
    mic === 'holding'
      ? 'Listening… let go to send.'
      : mic === 'recording'
        ? quiet >= 0.8
          ? `Sending in ${Math.max(0, SEND_AFTER_QUIET_S - quiet).toFixed(1)} s… keep talking to continue, or tap to send now.`
          : 'Listening… pause as you like. Tap the mic to send, or hold it next time to talk.'
        : mic === 'transcribing'
          ? 'Turning your voice into text…'
          : null;

  return (
    <div className="ask">
      <div className="row">
        {suggestions.map((s) => (
          <button
            key={s}
            type="button"
            className="chip ask__suggestion"
            onClick={() => void ask.current(s)}
          >
            {s}
          </button>
        ))}
      </div>
      <form className="assist" ref={box} onSubmit={submit}>
        <textarea
          value={question}
          placeholder="Ask about your trip, or tap the mic…"
          onChange={(e) => setQuestion(e.target.value)}
          rows={2}
          maxLength={500}
        />
        <div className="ask__actions">
          {micSupported() && (
            <button
              type="button"
              className={`btn ask__mic ask__mic--${mic}`}
              onPointerDown={(e) => {
                e.currentTarget.setPointerCapture(e.pointerId);
                void pressMic();
              }}
              onPointerUp={releaseMic}
              onPointerCancel={releaseMic}
              onContextMenu={(e) => e.preventDefault()}
              disabled={busy || mic === 'transcribing'}
              aria-pressed={mic === 'recording' || mic === 'holding'}
              aria-label={mic === 'idle' ? 'Ask by voice (tap or hold)' : 'Send'}
              title={mic === 'idle' ? 'Tap to talk, or hold while talking' : 'Send'}
              style={{ ['--level' as string]: level }}
            >
              <MicIcon />
            </button>
          )}
          {(agent?.role === 'commuter' || agent?.role === 'driver') && (
            <label
              className="btn ask__photo"
              title={
                agent.role === 'driver'
                  ? 'Photo of a fare matrix'
                  : "Photo of a jeepney's signboard or fare matrix"
              }
            >
              Photo
              <input
                type="file"
                accept="image/*"
                capture="environment"
                hidden
                onChange={(e) => {
                  void takePhoto(e.target.files?.[0]);
                  e.target.value = '';
                }}
              />
            </label>
          )}
          <button
            type="submit"
            className="btn btn--primary"
            disabled={busy || (!question.trim() && !photo)}
          >
            {busy ? 'Thinking…' : 'Ask'}
          </button>
        </div>
      </form>
      {photo && (
        <div className="assist__photo-preview">
          <button
            type="button"
            className="assist__photo-thumb"
            title="See it full size"
            onClick={() => setPhotoOpen(true)}
          >
            <img src={photo} alt="Your photo, to ask about" />
          </button>
          <button type="button" className="chip" onClick={() => setPhoto(null)}>
            Remove
          </button>
        </div>
      )}
      {photo && photoOpen && (
        <div
          className="photo-view"
          role="dialog"
          aria-label="Your photo, full size"
          onClick={() => setPhotoOpen(false)}
        >
          <img src={photo} alt="Your photo, full size" />
          <span className="photo-view__close">Tap anywhere to close</span>
        </div>
      )}
      {status && (
        <p className="fine" role="status">
          {status}
        </p>
      )}
      {handsFree && voiceSupported() && (
        <label className="toggle">
          <input
            type="checkbox"
            checked={listening}
            onChange={(e) => setListening(e.target.checked)}
          />
          <span>
            Hands-free: say “Hey Sakay, …”. Anything else said is ignored and costs nothing.
          </span>
        </label>
      )}
      {listening && heard && (
        <p className="fine">
          Heard “{heard.sentence}” ·{' '}
          {heard.heard === 'asked'
            ? 'asked'
            : heard.heard === 'woken'
              ? 'listening, ask now'
              : 'ignored, not sent'}
        </p>
      )}
      {answer && (
        <>
          <p className="assist__answer">{answer.text}</p>
          <div className="ask__speech">
            {spoken === 'idle' && (
              <button
                type="button"
                className="chip"
                onClick={() => speech.speak(answer.text, voice)}
              >
                ▶ Read aloud
              </button>
            )}
            {spoken === 'speaking' && (
              <button type="button" className="chip" onClick={() => speech.pause()}>
                ❚❚ Pause
              </button>
            )}
            {spoken === 'paused' && (
              <button type="button" className="chip" onClick={() => speech.resume()}>
                ▶ Resume
              </button>
            )}
            {spoken !== 'idle' && (
              <button type="button" className="chip" onClick={() => speech.stop()}>
                ■ Stop
              </button>
            )}
            {voiceList.length > 0 && (
              <select
                className="ask__voice"
                aria-label="Reading voice"
                value={voice}
                onChange={(e) => setVoice(e.target.value)}
              >
                <option value="">Voice: automatic</option>
                {voiceList.map((v) => (
                  <option key={v.voiceURI} value={v.voiceURI}>
                    {v.name} ({v.lang})
                  </option>
                ))}
              </select>
            )}
          </div>
          {looksTagalog(answer.text) &&
            serverVoice === 'off' &&
            voiceList.length > 0 &&
            !hasFilipinoVoice(voiceList) && (
              <p className="fine">
                No Filipino voice here, so Tagalog is read in English. Set ELEVENLABS_API_KEY or
                AZURE_SPEECH_KEY on the server (api/speak.ts) for a Filipino voice.
              </p>
            )}
          <p className="fine">{costLine(answer)}</p>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
