/**
 * Asking by voice without paying for every word said in the cab. Two ways:
 *
 *   push to talk   tap the mic and ask (record below). Works in every
 *                  browser; only that recording is sent and transcribed.
 *   hands-free     the microphone stays open, the browser turns speech into
 *                  text, and only a sentence starting with the wake phrase
 *                  ("Hey Sakay, ...") becomes a question (listen below).
 *                  Talk with passengers, the radio, "para po": none of it
 *                  is sent, so none of it costs Meta credit. It depends on
 *                  the browser's speech service: Chrome's runs on Google's
 *                  servers; Edge and Brave block it ("network" error).
 *
 * Answers are read out by the browser's own speech synthesis, free.
 */

/**
 * Said first, in any of these forms, to address the assistant. Not "hoy sakay":
 * barkers shout that at every stop, and each false start spends Meta credit.
 */
export const WAKE_PHRASES = [
  'hey sakay',
  'hi sakay',
  'ok sakay',
  // Speech recognition hears the name either way.
  'hey sakai',
  'hi sakai',
  'ok sakai',
  'sakay sight',
  'sakay site',
  'sakaysight',
];

/** What follows a wake phrase ('' when nothing does), or null without one. */
function afterWake(transcript: string, wake: readonly string[]): string | null {
  for (const phrase of wake) {
    // "hey sakay" also matches "Hey, Sakay!" and "hey   sakay".
    const words = phrase.split(' ').join('[\\s,.!]+');
    const match = new RegExp(`^\\s*${words}\\b[\\s,.!?:;-]*`, 'i').exec(transcript);
    if (match) return transcript.slice(match[0].length).trim();
  }
  return null;
}

/**
 * The question in `transcript` if it is addressed to the assistant, else
 * null. "Hey Sakay, how many are waiting at Lagro?" gives "how many are
 * waiting at Lagro?"; anything that does not start with a wake phrase gives
 * null, and so does the wake phrase with nothing after it.
 */
export function addressed(transcript: string, wake = WAKE_PHRASES): string | null {
  return afterWake(transcript, wake) || null;
}

/** After the wake phrase alone, the next sentence within this long is the question (ms). */
export const FOLLOW_UP_MS = 8000;

/** What a sentence was: a question, the wake phrase alone, or none of our business. */
export type Heard = 'asked' | 'woken' | 'ignored';

/**
 * Sorting what is heard, sentence by sentence: "Hey Sakay, ..." at once, or
 * "Hey Sakay" and then a pause before the question, as people say it to
 * someone across a room. Anything else costs nothing.
 */
export function wakeListener(wake = WAKE_PHRASES) {
  let waitingUntil = -Infinity;
  return (sentence: string, now: number): { heard: Heard; question: string | null } => {
    const rest = afterWake(sentence, wake);
    if (rest === '') {
      waitingUntil = now + FOLLOW_UP_MS;
      return { heard: 'woken', question: null };
    }
    const question = rest ?? (now <= waitingUntil ? sentence.trim() : null);
    if (question === null) return { heard: 'ignored', question: null };
    waitingUntil = -Infinity;
    return { heard: 'asked', question };
  };
}

// The Web Speech API is not in TypeScript's DOM types yet; just what we use.
interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((e: { resultIndex: number; results: ArrayLike<RecognitionResult> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
}
interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const voiceSupported = () => typeof window !== 'undefined' && recognitionCtor() !== null;

/**
 * Listen until stopped. `onQuestion` gets only addressed questions;
 * `onHeard` (optional) every sentence, for showing what was ignored.
 * Returns a stop function.
 */
export function listen(
  onQuestion: (question: string) => void,
  onHeard?: (sentence: string, heard: Heard) => void,
  onError?: (message: string) => void,
): () => void {
  const Ctor = recognitionCtor();
  if (!Ctor) {
    onError?.('This browser has no speech recognition.');
    return () => {};
  }
  const rec = new Ctor();
  rec.continuous = true;
  rec.interimResults = false;
  rec.lang = 'en-PH';

  let running = true;
  const sort = wakeListener();
  rec.onresult = (e) => {
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i]!;
      if (!r.isFinal) continue;
      const sentence = r[0].transcript;
      const { heard, question } = sort(sentence, performance.now());
      onHeard?.(sentence, heard);
      if (question) onQuestion(question);
    }
  };
  // Browsers end a session after a silence; keep listening until stopped.
  rec.onend = () => {
    if (running) rec.start();
  };
  rec.onerror = (e) => {
    if (e.error === 'no-speech' || e.error === 'aborted') return;
    running = false;
    onError?.(
      e.error === 'not-allowed'
        ? 'Microphone permission denied.'
        : e.error === 'network'
          ? 'Hands-free needs the browser’s own speech service, which is not reachable here (Edge and Brave block it). Use the mic button instead.'
          : `Hands-free stopped (${e.error}). Use the mic button instead.`,
    );
  };
  rec.start();

  return () => {
    running = false;
    rec.stop();
  };
}

// ---- Push to talk ---------------------------------------------------------
//
// Tap the mic, ask, and it stops by itself when you go quiet (or tap again).
// Only that recording is sent, to /api/transcribe (Muse Voice Transcribe,
// ~$0.00025 for a 5-second question), so an open cab costs nothing.
//
// Background noise is cut twice before anything is sent: the browser's own
// noise suppression and echo cancellation on the microphone, then a speech
// band filter that removes engine rumble below it and hiss above it.

/** Muse Voice Transcribe's native rate (it also takes 16 kHz, less accurately). */
const WAV_RATE = 24_000;
/** The speech band: below is engine and road rumble, above is hiss. */
const HIGH_PASS_HZ = 120;
const LOW_PASS_HZ = 7_000;
/** Room for a question asked slowly, with pauses. */
const MAX_RECORD_S = 30;
/**
 * Once someone has spoken, this much quiet ends the recording. People
 * pause mid-sentence to think ("Kuya, yung jeep… papuntang Lagro…"), so it
 * is generous; tapping the mic sends straight away.
 */
const SILENCE_S = 2.5;
/** Never stop on quiet this early: the first words may not have started yet. */
const MIN_RECORD_S = 1;
/** Speech is this many times louder than the background noise. */
const SPEECH_OVER_NOISE = 3;
/** Quieter than this is never speech, however quiet the room. */
const MIN_SPEECH_RMS = 0.012;
/**
 * The noise floor follows the quietest moments and drifts up 10% a second,
 * so it adapts when the jeepney starts or stops moving, and talking from the
 * first instant is not mistaken for background.
 */
const FLOOR_RISE_PER_TICK = 1.01;
const TICK_MS = 100;

/** 16-bit PCM WAV file from mono samples in [-1, 1]. */
export function encodeWav(samples: Float32Array, rate: number): ArrayBuffer {
  const buf = new ArrayBuffer(44 + samples.length * 2);
  const v = new DataView(buf);
  const text = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  text(0, 'RIFF');
  v.setUint32(4, 36 + samples.length * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  v.setUint32(16, 16, true); // fmt chunk size
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * 2, true); // bytes per second
  v.setUint16(32, 2, true); // bytes per frame
  v.setUint16(34, 16, true); // bits per sample
  text(36, 'data');
  v.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return buf;
}

export interface Recording {
  /** Stop and get the WAV to send. */
  stop(): Promise<ArrayBuffer>;
  /** Stop and throw the recording away. */
  cancel(): void;
  /** Loudness right now, 0–1, for a level meter. */
  level(): number;
  /** Seconds of quiet since the speaker last spoke (0 while speaking or before). */
  quiet(): number;
}

/**
 * One 100 ms step of the voice detector. Pure, so it can be tested: given
 * the loudness and the state so far, is this speech, and is the turn over?
 */
export function voiceStep(
  s: VoiceState,
  rms: number,
  elapsedS: number,
): VoiceState & { done: boolean } {
  const floor = Math.min(rms, s.floor * FLOOR_RISE_PER_TICK);
  const peak = Math.max(s.peak, rms);
  const threshold = Math.max(MIN_SPEECH_RMS, floor * SPEECH_OVER_NOISE);
  const speaking = rms > threshold;
  // Judged against the floor as it is now: someone who talked from the very
  // first instant only shows as speech once a pause reveals the background.
  const spoke = peak > threshold;
  const quietS = spoke && !speaking ? s.quietS + TICK_MS / 1000 : 0;
  const done =
    (spoke && quietS >= SILENCE_S && elapsedS >= MIN_RECORD_S) || elapsedS >= MAX_RECORD_S;
  return { floor, peak, quietS, done };
}

export interface VoiceState {
  floor: number;
  peak: number;
  quietS: number;
}

export const VOICE_START: VoiceState = { floor: Infinity, peak: 0, quietS: 0 };

/** Recording works where the browser has a microphone API (any modern one). */
export const micSupported = () =>
  typeof navigator !== 'undefined' &&
  !!navigator.mediaDevices?.getUserMedia &&
  typeof MediaRecorder !== 'undefined';

/**
 * Start recording a question. `onDone` fires when the speaker has finished
 * (a long enough pause) or the time limit is reached; the caller then calls
 * stop(). While `autoStop()` returns false (the mic is held down), pauses
 * never end it.
 */
export async function record(
  onDone: () => void,
  autoStop: () => boolean = () => true,
): Promise<Recording> {
  const mic = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      noiseSuppression: true,
      echoCancellation: true,
      autoGainControl: true,
    },
  });
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(mic);
  const highPass = new BiquadFilterNode(ctx, { type: 'highpass', frequency: HIGH_PASS_HZ });
  const lowPass = new BiquadFilterNode(ctx, { type: 'lowpass', frequency: LOW_PASS_HZ });
  const analyser = new AnalyserNode(ctx, { fftSize: 1024 });
  const out = ctx.createMediaStreamDestination();
  source.connect(highPass).connect(lowPass);
  lowPass.connect(analyser);
  lowPass.connect(out);

  const recorder = new MediaRecorder(out.stream);
  const chunks: Blob[] = [];
  recorder.ondataavailable = (e) => chunks.push(e.data);
  const stopped = new Promise<void>((resolve) => (recorder.onstop = () => resolve()));
  recorder.start();

  // Voice activity (voiceStep): speech, then a long enough pause, ends the
  // turn. In a loud jeepney it may never go quiet enough: the time limit
  // (or a tap) ends it then.
  const frame = new Float32Array(analyser.fftSize);
  let rms = 0;
  let vad = VOICE_START;
  const startedAt = performance.now();
  const tick = window.setInterval(() => {
    analyser.getFloatTimeDomainData(frame);
    let sum = 0;
    for (const x of frame) sum += x * x;
    rms = Math.sqrt(sum / frame.length);
    const elapsedS = (performance.now() - startedAt) / 1000;
    const step = voiceStep(vad, rms, elapsedS);
    vad = step;
    if (step.done && (autoStop() || elapsedS >= MAX_RECORD_S)) onDone();
  }, TICK_MS);

  const close = () => {
    window.clearInterval(tick);
    mic.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };

  return {
    level: () => Math.min(1, rms * 8),
    quiet: () => vad.quietS,
    cancel() {
      if (recorder.state !== 'inactive') recorder.stop();
      close();
    },
    async stop() {
      if (recorder.state !== 'inactive') recorder.stop();
      await stopped;
      close();
      const encoded = await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer();
      // Decoding into a 24 kHz context resamples on the way.
      const decoded = await new OfflineAudioContext(1, 1, WAV_RATE).decodeAudioData(encoded);
      return encodeWav(decoded.getChannelData(0), WAV_RATE);
    },
  };
}

/**
 * The recording as text, via /api/transcribe. `keywords` (stop names, "pamasahe", ...) help it hear words
 * a general model would miss.
 */
export async function transcribe(wav: ArrayBuffer, keywords: string[] = []): Promise<string> {
  const query = keywords.length ? `?keywords=${encodeURIComponent(keywords.join(','))}` : '';
  const res = await fetch(`/api/transcribe${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'audio/wav' },
    body: wav,
  });
  if (res.status === 404) throw new Error('No /api here. Use `npm run dev` or the deployment.');
  const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
  if (!res.ok) throw new Error(data.error ?? `Transcription failed (${res.status})`);
  return data.text ?? '';
}

// ---- Reading answers aloud ------------------------------------------------
//
// The browser's own voices: free and offline-ish, but quality depends on
// the browser. Edge has natural Filipino voices (Blessica, Angelo) and
// Philippine English ones (Rosa, James); Chrome on Android has a Filipino
// voice; desktop Chrome on Windows has only Windows' English voices.
// Chrome also silently stops an utterance after about 15 seconds, so the
// answer is spoken one sentence at a time.

/** Tagalog function words: enough of them and the answer is Tagalog or Taglish. */
const TAGALOG_WORDS =
  /\b(ang|ng|mga|sa|po|ka|mo|ko|na|ay|hindi|yung|siya|ito|iyan|darating|sumakay|sakay|bayad|pamasahe|maghintay|upuan|ikaw|kayo|para sa)\b/gi;

export function looksTagalog(text: string): boolean {
  const words = text.split(/\s+/).filter(Boolean).length;
  const hits = text.match(TAGALOG_WORDS)?.length ?? 0;
  return hits >= 2 && hits / Math.max(1, words) >= 0.08;
}

/** Sentences short enough that no browser cuts them off. */
export function sentences(text: string, maxChars = 220): string[] {
  const out: string[] = [];
  for (const s of text.split(/(?<=[.!?…])\s+|\n+/)) {
    let rest = s.trim();
    while (rest.length > maxChars) {
      // Break after a comma (kept with the first part) when there is one.
      const cut = rest.lastIndexOf(', ', maxChars - 1);
      const at = cut > 40 ? cut + 1 : maxChars;
      out.push(rest.slice(0, at).trim());
      rest = rest.slice(at).trim();
    }
    if (rest) out.push(rest);
  }
  return out;
}

/**
 * What a voice should say for what is written: "1.7 min" read letter by
 * letter, "₱94.55/L" as "peso sign", or "→" as nothing is what makes a
 * spoken answer sound broken. Units are said in the answer's language.
 */
export function spokenText(text: string, tagalog: boolean): string {
  const say = (tl: string, en: string) => (tagalog ? tl : en);
  return text
    .replace(/₱\s?(\d[\d,]*(?:\.\d+)?)/g, `$1 ${say('piso', 'pesos')}`)
    .replace(/\s?\/\s?L\b/g, say(' kada litro', ' per litre'))
    .replace(/(\d)\s?L\b/g, `$1 ${say('litro', 'litres')}`)
    .replace(/(\d)\s?km\b/g, `$1 ${say('kilometro', 'kilometres')}`)
    .replace(/(\d)\s?m\b/g, `$1 ${say('metro', 'metres')}`)
    .replace(/(\d)\s?min\b/g, `$1 ${say('minuto', 'minutes')}`)
    .replace(/(\d)\s?s\b/g, `$1 ${say('segundo', 'seconds')}`)
    .replace(/\s*→\s*/g, say(' papuntang ', ' to '))
    .replace(/\s*·\s*/g, ', ')
    .replace(/~\s?(?=\d)/g, say('mga ', 'about '));
}

/** The parts of SpeechSynthesisVoice we choose by. */
export interface VoiceInfo {
  voiceURI: string;
  name: string;
  lang: string;
}

const isFilipino = (v: VoiceInfo) => /^(fil|tl)/i.test(v.lang);

/** Whether this browser can read Tagalog in a Filipino voice at all. */
export const hasFilipinoVoice = (list: readonly VoiceInfo[]) => list.some(isFilipino);

/**
 * The best voice for this answer: a Filipino voice for Tagalog, a
 * Philippine English one for English, and natural/neural voices over the
 * robotic defaults. `preferred` (the user's pick) wins, except that a
 * Tagalog answer is never read by an English voice when a Filipino one
 * exists: an American voice reading Tagalog is barely understandable.
 */
export function pickVoice<V extends VoiceInfo>(
  voices: readonly V[],
  tagalog: boolean,
  preferred?: string,
): V | null {
  const chosen = preferred && voices.find((v) => v.voiceURI === preferred);
  if (chosen && (!tagalog || isFilipino(chosen) || !voices.some(isFilipino))) return chosen;
  const score = (v: V) => {
    const lang = v.lang.toLowerCase();
    let s = 0;
    if (isFilipino(v)) s += tagalog ? 100 : 40;
    else if (lang === 'en-ph' || lang === 'en_ph') s += tagalog ? 30 : 60;
    else if (lang.startsWith('en')) s += tagalog ? 5 : 30;
    else return -1;
    if (/natural|neural/i.test(v.name)) s += 25;
    if (/online|google/i.test(v.name)) s += 10;
    return s;
  };
  let best: V | null = null;
  for (const v of voices) if (score(v) > (best ? score(best) : 0)) best = v;
  return best;
}

/** Filipino and English voices this browser has (may fill in a moment after load). */
export function voices(): SpeechSynthesisVoice[] {
  if (typeof speechSynthesis === 'undefined') return [];
  return speechSynthesis
    .getVoices()
    .filter((v) => /^(fil|tl|en)/i.test(v.lang))
    .sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
}

export type SpeechState = 'idle' | 'speaking' | 'paused';

const listeners = new Set<(s: SpeechState) => void>();
let speechState: SpeechState = 'idle';
const setSpeech = (s: SpeechState) => {
  speechState = s;
  listeners.forEach((fn) => fn(s));
};

// The server voice (/api/speak: ElevenLabs or Azure, see there) reads
// Tagalog properly in any browser. 'unknown' until the first answer; 'off'
// when the server has no voice service set up, and then never asked again.
export type ServerVoice = 'unknown' | 'on' | 'off';
let serverVoice: ServerVoice = 'unknown';
const serverListeners = new Set<(s: ServerVoice) => void>();
const setServerVoice = (s: ServerVoice) => {
  serverVoice = s;
  serverListeners.forEach((fn) => fn(s));
};

/** Clips already paid for, by what was said: "Read aloud" again is free. */
const clips = new Map<string, string>();
const MAX_CLIPS = 20;
let audio: HTMLAudioElement | null = null;
/** Bumped by every speak and stop, so a late clip never talks over a newer one. */
let turn = 0;

/** The clip for `text` from /api/speak, or null (then the browser reads it). */
async function serverClip(text: string, tagalog: boolean): Promise<string | null> {
  const key = `${tagalog ? 'fil' : 'en'}:${text}`;
  const cached = clips.get(key);
  if (cached) return cached;
  try {
    const res = await fetch('/api/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, lang: tagalog ? 'fil' : 'en' }),
    });
    if (res.status === 503 || res.status === 404) {
      setServerVoice('off');
      return null;
    }
    // Out of credit: no more asking this visit, the browser's own voices read
    // (Edge has a Filipino one). Anything else: this answer falls back, the next tries again.
    if (!res.ok) {
      const why = await res.text().catch(() => '');
      if (/quota|credit/i.test(why)) setServerVoice('off');
      return null;
    }
    setServerVoice('on');
    const url = URL.createObjectURL(await res.blob());
    clips.set(key, url);
    if (clips.size > MAX_CLIPS) {
      const [oldest, old] = clips.entries().next().value!;
      clips.delete(oldest);
      URL.revokeObjectURL(old);
    }
    return url;
  } catch {
    return null;
  }
}

/** The browser's own voices, one sentence at a time. */
function speakInBrowser(text: string, tagalog: boolean, preferred?: string): void {
  if (typeof speechSynthesis === 'undefined') return setSpeech('idle');
  const voice = pickVoice(voices(), tagalog, preferred);
  const parts = sentences(text);
  parts.forEach((part, i) => {
    const u = new SpeechSynthesisUtterance(part);
    if (voice) u.voice = voice;
    u.lang = voice?.lang ?? (tagalog ? 'fil-PH' : 'en-PH');
    u.rate = 0.95;
    if (i === 0) u.onstart = () => setSpeech('speaking');
    if (i === parts.length - 1) u.onend = u.onerror = () => setSpeech('idle');
    speechSynthesis.speak(u);
  });
}

/**
 * Whether the server voice reads this answer: always on "automatic"; with
 * a browser voice picked, only where pickVoice would not use it anyway (a
 * Tagalog answer and no Filipino voice picked).
 */
function wantsServerVoice(tagalog: boolean, preferred?: string): boolean {
  if (serverVoice === 'off') return false;
  const picked = preferred ? voices().find((v) => v.voiceURI === preferred) : undefined;
  return !picked || (tagalog && !isFilipino(picked));
}

/** Reading answers aloud, with pause, resume and stop. */
export const speech = {
  state: () => speechState,
  subscribe(fn: (s: SpeechState) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  serverVoice: () => serverVoice,
  subscribeServerVoice(fn: (s: ServerVoice) => void): () => void {
    serverListeners.add(fn);
    return () => serverListeners.delete(fn);
  },
  speak(text: string, preferred?: string): void {
    speech.stop();
    const mine = turn;
    const tagalog = looksTagalog(text);
    const said = spokenText(text, tagalog);
    if (!wantsServerVoice(tagalog, preferred)) return speakInBrowser(said, tagalog, preferred);
    // Fetching the clip takes a moment: show it as speaking so "Stop" works.
    setSpeech('speaking');
    void serverClip(said, tagalog).then((url) => {
      if (mine !== turn) return;
      if (!url) return speakInBrowser(said, tagalog, preferred);
      audio = new Audio(url);
      audio.onended = audio.onerror = () => mine === turn && setSpeech('idle');
      audio.play().catch(() => mine === turn && speakInBrowser(said, tagalog, preferred));
    });
  },
  pause() {
    if (speechState !== 'speaking') return;
    if (audio) audio.pause();
    else speechSynthesis.pause();
    setSpeech('paused');
  },
  resume() {
    if (speechState !== 'paused') return;
    if (audio) void audio.play();
    else speechSynthesis.resume();
    setSpeech('speaking');
  },
  stop() {
    turn++;
    audio?.pause();
    audio = null;
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    setSpeech('idle');
  },
};

/** Read an answer out loud (on-device, free). */
export const speak = (text: string, preferred?: string) => speech.speak(text, preferred);
