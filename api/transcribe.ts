/**
 * POST /api/transcribe
 *
 * Body: a WAV recording (Content-Type: audio/wav), sent only when the user
 * pressed the mic button: nothing is ever streamed while nobody is asking.
 * Query: ?keywords=a,b,c  words to listen for (stop names, fare words).
 * Returns: { text: string, creditUsed: boolean }
 *
 * Speech to text with Meta's Muse Voice Transcribe ($0.18 per hour of audio,
 * so a 5-second question costs ~$0.00025). The key stays on the server.
 */

import { refused } from './_lib/guard.js';
import { META_BASE, metaConfigured } from './_lib/meta.js';

const TRANSCRIBE_MODEL = process.env.META_TRANSCRIBE_MODEL ?? 'muse-voice-transcribe-1.0';
/** 24 kHz mono 16-bit WAV is 48 KB/s: this is about 60 seconds. */
const MAX_AUDIO_BYTES = 3_000_000;
/**
 * Riders and drivers speak Tagalog, English and both in one sentence; the
 * model handles code-switching, this only tells it what to expect.
 */
const LANGUAGES = (process.env.META_TRANSCRIBE_LANGUAGES ?? 'Tagalog,English')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const MAX_KEYWORDS = 50;
/**
 * Meta rejects the whole request (HTTP 400) if any keyword is longer than
 * this, so longer ones are dropped here (the app also sends short forms).
 */
const MAX_KEYWORD_CHARS = 30;
/** A question every 5 seconds, per visitor. */
const PER_MINUTE = 12;

/** "?keywords=Malaria,Lagro,pamasahe": words to listen for, from the app. */
function keywordsOf(url: string): string[] {
  const raw = new URL(url).searchParams.get('keywords') ?? '';
  const words = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && s.length <= MAX_KEYWORD_CHARS);
  return [...new Set(words)].slice(0, MAX_KEYWORDS);
}

export async function POST(request: Request): Promise<Response> {
  const no = refused(request, 'transcribe', PER_MINUTE);
  if (no) return no;
  if (!metaConfigured()) {
    return Response.json({ error: 'Voice needs META_API_KEY on the server' }, { status: 503 });
  }
  if (Number(request.headers.get('content-length')) > MAX_AUDIO_BYTES) {
    return Response.json({ error: 'Recording must be a WAV under 60 seconds' }, { status: 413 });
  }
  const audio = await request.arrayBuffer();
  if (audio.byteLength < 44 || audio.byteLength > MAX_AUDIO_BYTES) {
    return Response.json({ error: 'Recording must be a WAV under 60 seconds' }, { status: 413 });
  }

  const keywords = keywordsOf(request.url);
  const form = new FormData();
  form.append(
    'request',
    new Blob(
      [
        JSON.stringify({
          model: TRANSCRIBE_MODEL,
          audioEncoding: 'WAV',
          mode: 'PUSH_TO_TALK',
          languageBias: LANGUAGES,
          ...(keywords.length && { keywords }),
        }),
      ],
      { type: 'application/json' },
    ),
  );
  form.append('audio', new Blob([audio], { type: 'audio/wav' }), 'question.wav');

  try {
    const res = await fetch(`${META_BASE}/asr/transcribe`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.META_API_KEY}`, Accept: 'text/plain' },
      body: form,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      // Meta's reason ("keyword exceeds…", "must be a mono WAV…") says what to
      // fix; it holds no secrets, so the app shows it too.
      const body = await res.text().catch(() => '');
      console.error('Meta transcribe error', res.status, body);
      let reason = '';
      try {
        reason = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? '';
      } catch {
        // Not JSON: the status alone will have to do.
      }
      return Response.json(
        { error: `Transcription failed (${res.status})${reason ? `: ${reason}` : ''}` },
        { status: 502 },
      );
    }
    // One turn per line; drop any speaker label ("unknown:", "A:").
    const text = (await res.text())
      .split('\n')
      .map((line) => line.replace(/^(unknown|[A-Z]):/, '').trim())
      .filter(Boolean)
      .join(' ');
    return Response.json({ text, creditUsed: true });
  } catch {
    return Response.json({ error: 'Transcription timed out' }, { status: 504 });
  }
}
