/**
 * POST /api/speak
 *
 * Body: { text: string, lang: 'fil' | 'en' }  (text already said-as-words,
 *       see spokenText in src/net/voice.ts)
 * Returns: audio/mpeg, or 503 when no voice service is set up (the app then
 *          reads with the browser's own voices, as before).
 *
 * Why a server voice at all: Brave and desktop Chrome on Windows only have
 * Windows' English voices, and an American voice reading Tagalog is barely
 * understandable. Meta's API has no text to speech. So, whichever key is in
 * .env, checked in this order:
 *
 *   ELEVENLABS_API_KEY  ElevenLabs Multilingual v2 (speaks Filipino).
 *                       ELEVENLABS_VOICE_ID picks the voice (one voice
 *                       speaks both languages).
 *   AZURE_SPEECH_KEY    Azure neural voices, the same ones Edge has:
 *   + AZURE_SPEECH_REGION  fil-PH Blessica for Tagalog, en-PH Rosa for
 *                       English (AZURE_VOICE_FIL / AZURE_VOICE_EN override).
 *
 * Both bill per character, so the text is capped and the app caches what
 * it already heard: "Read aloud" twice costs once.
 */

import { refused } from './_lib/guard.js';

/** An answer read out every 3 seconds, per visitor: each one bills by the character. */
const PER_MINUTE = 20;
/**
 * The longest answer assist.ts asks for (about 120 words, ~800 characters)
 * with room to spare; anything longer is not an answer, so not paid for.
 */
const MAX_TEXT_CHARS = 1500;

type Lang = 'fil' | 'en';

/** The configured voice service, if any. */
function provider(): 'elevenlabs' | 'azure' | null {
  if (process.env.ELEVENLABS_API_KEY) return 'elevenlabs';
  if (process.env.AZURE_SPEECH_KEY && process.env.AZURE_SPEECH_REGION) return 'azure';
  return null;
}

function elevenLabs(text: string): Promise<Response> {
  const voice = process.env.ELEVENLABS_VOICE_ID ?? 'JBFqnCBsd6RMkjVDRZzb';
  return fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_64`,
    {
      method: 'POST',
      headers: {
        'xi-api-key': process.env.ELEVENLABS_API_KEY!,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg',
      },
      body: JSON.stringify({
        text,
        model_id: process.env.ELEVENLABS_MODEL ?? 'eleven_multilingual_v2',
      }),
      signal: AbortSignal.timeout(20_000),
    },
  );
}

const xml = (s: string) => s.replace(/[<>&'"]/g, (c) => `&#${c.charCodeAt(0)};`);

function azure(text: string, lang: Lang): Promise<Response> {
  const [locale, voice] =
    lang === 'fil'
      ? ['fil-PH', process.env.AZURE_VOICE_FIL ?? 'fil-PH-BlessicaNeural']
      : ['en-PH', process.env.AZURE_VOICE_EN ?? 'en-PH-RosaNeural'];
  return fetch(
    `https://${process.env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': process.env.AZURE_SPEECH_KEY!,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
        'User-Agent': 'SakaySightAI',
      },
      body: `<speak version="1.0" xml:lang="${locale}"><voice name="${xml(voice)}">${xml(text)}</voice></speak>`,
      signal: AbortSignal.timeout(20_000),
    },
  );
}

export async function POST(request: Request): Promise<Response> {
  const no = refused(request, 'speak', PER_MINUTE);
  if (no) return no;
  const which = provider();
  if (!which) {
    return Response.json(
      { error: 'No voice service: set ELEVENLABS_API_KEY or AZURE_SPEECH_KEY' },
      { status: 503 },
    );
  }
  const body = (await request.json().catch(() => null)) as {
    text?: unknown;
    lang?: unknown;
  } | null;
  const text = typeof body?.text === 'string' ? body.text.trim() : '';
  if (!text || text.length > MAX_TEXT_CHARS) {
    return Response.json({ error: `Text must be 1–${MAX_TEXT_CHARS} characters` }, { status: 413 });
  }
  const lang: Lang = body?.lang === 'fil' ? 'fil' : 'en';

  try {
    const res = which === 'elevenlabs' ? await elevenLabs(text) : await azure(text, lang);
    if (!res.ok) {
      // The provider's reason (quota, bad voice id) holds no secrets.
      const reason = (await res.text().catch(() => '')).slice(0, 300);
      console.error(`${which} speech error`, res.status, reason);
      return Response.json(
        { error: `Voice failed (${which} ${res.status})${reason ? `: ${reason}` : ''}` },
        { status: 502 },
      );
    }
    return new Response(await res.arrayBuffer(), {
      headers: { 'Content-Type': 'audio/mpeg', 'X-Voice-Provider': which },
    });
  } catch {
    return Response.json({ error: 'Voice timed out' }, { status: 504 });
  }
}
