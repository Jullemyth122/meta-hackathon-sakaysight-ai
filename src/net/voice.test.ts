import { describe, expect, it } from 'vitest';
import { MAX_KEYWORD_CHARS, voiceKeywords } from '@/core/advisory/screen';
import { FOLLOW_UP_MS, wakeListener } from './voice';
import { defaultRoute } from '@/core/geo/routes';
import {
  addressed,
  encodeWav,
  hasFilipinoVoice,
  looksTagalog,
  pickVoice,
  sentences,
  spokenText,
  VOICE_START,
  voiceStep,
  type VoiceState,
} from './voice';

/** Run the voice detector over loudness samples, 100 ms apart; when (s) it ended, or null. */
function endsAt(levels: number[]): number | null {
  let s: VoiceState = VOICE_START;
  for (let i = 0; i < levels.length; i++) {
    const step = voiceStep(s, levels[i]!, (i + 1) / 10);
    if (step.done) return (i + 1) / 10;
    s = step;
  }
  return null;
}
const noise = (seconds: number) => Array<number>(Math.round(seconds * 10)).fill(0.004);
const talk = (seconds: number) => Array<number>(Math.round(seconds * 10)).fill(0.08);

describe('when a spoken question is over', () => {
  it('lets the speaker pause mid-sentence to think', () => {
    // "Kuya, yung jeep… (2 s pause) …papuntang Lagro?" must stay one question.
    expect(endsAt([...noise(0.5), ...talk(1.5), ...noise(2), ...talk(1.5), ...noise(4)])).toBe(
      0.5 + 1.5 + 2 + 1.5 + 2.5,
    );
  });

  it('ends after a long enough quiet', () => {
    expect(endsAt([...noise(0.5), ...talk(2), ...noise(5)])).toBe(5);
  });

  it('still ends when the speaker talked from the very first instant', () => {
    expect(endsAt([...talk(2), ...noise(5)])).not.toBeNull();
  });

  it('never ends on background noise alone, until the time limit', () => {
    expect(endsAt(noise(10))).toBeNull();
    expect(endsAt(noise(31))).toBe(30);
  });
});

describe('hands-free', () => {
  it('takes the question in one breath', () => {
    const sort = wakeListener();
    expect(sort('Hey Sakay, next stop?', 0)).toEqual({ heard: 'asked', question: 'next stop?' });
  });

  it('takes it after a pause, once', () => {
    const sort = wakeListener();
    expect(sort('Hey Sakay', 0)).toEqual({ heard: 'woken', question: null });
    expect(sort(' magkano ang pamasahe ', 2000)).toEqual({
      heard: 'asked',
      question: 'magkano ang pamasahe',
    });
    expect(sort('kuya bayad po', 2500).heard).toBe('ignored');
  });

  it('stops waiting after a while', () => {
    const sort = wakeListener();
    sort('Hey Sakay', 0);
    expect(sort('magkano', FOLLOW_UP_MS + 1).heard).toBe('ignored');
  });

  it('ignores what is not said to it', () => {
    const sort = wakeListener();
    expect(sort('hoy sakay na, sakay na', 0).heard).toBe('ignored');
    expect(sort('bayad po', 100).question).toBeNull();
  });

  it('hears the name however the browser spells it', () => {
    expect(wakeListener()('Hey Sakai, next stop', 0).question).toBe('next stop');
  });
});

describe('words to listen for', () => {
  it('keeps the commute words when a long route has more stops than the limit', () => {
    const route = {
      ...defaultRoute(),
      stops: Array.from({ length: 120 }, (_, i) => ({ name: `Stop ${i}`, s: i })),
    };
    expect(voiceKeywords(route).slice(0, 50)).toContain('pamasahe');
  });

  it('fits Meta’s 30-character keyword limit and keeps how stops are said', () => {
    const words = voiceKeywords(defaultRoute());
    expect(words.every((w) => w.length > 0 && w.length <= MAX_KEYWORD_CHARS)).toBe(true);
    // Long terminal names are sent the way people say them.
    expect(words).toContain('Tungko');
    expect(words).toContain('SM City Fairview');
    expect(words).toContain('pamasahe');
  });
});

describe('reading answers aloud', () => {
  it('tells Tagalog and Taglish from English', () => {
    expect(looksTagalog('Huwag sumakay sa VUH 8442, maghintay ka sa KYP 6298.')).toBe(true);
    expect(looksTagalog('₱14.50 ang student fare mo papuntang Lagro.')).toBe(true);
    expect(looksTagalog('Stop at Sampaguita to pick up your 5 waiting riders.')).toBe(false);
  });

  it('splits into sentences no browser cuts off', () => {
    const parts = sentences(`One. Two? ${'word, '.repeat(80)}end.`, 100);
    expect(parts.slice(0, 2)).toEqual(['One.', 'Two?']);
    expect(parts.every((p) => p.length <= 100)).toBe(true);
    expect(parts.join(' ')).toContain('end.');
  });

  it('picks a natural Filipino voice for Tagalog and the user pick over all', () => {
    const list = [
      { voiceURI: 'a', name: 'Microsoft David', lang: 'en-US' },
      { voiceURI: 'b', name: 'Microsoft Blessica Online (Natural) - Filipino', lang: 'fil-PH' },
      { voiceURI: 'c', name: 'Microsoft Rosa Online (Natural)', lang: 'en-PH' },
      { voiceURI: 'd', name: 'Google 日本語', lang: 'ja-JP' },
    ];
    expect(pickVoice(list, true)?.voiceURI).toBe('b');
    expect(pickVoice(list, false)?.voiceURI).toBe('c');
    expect(pickVoice(list, false, 'a')?.voiceURI).toBe('a');
    expect(pickVoice([list[3]!], false)).toBeNull();
  });

  it('never reads Tagalog in an English voice when a Filipino one exists', () => {
    const david = { voiceURI: 'a', name: 'Microsoft David', lang: 'en-US' };
    const angelo = { voiceURI: 'b', name: 'Microsoft Angelo Online (Natural)', lang: 'fil-PH' };
    expect(pickVoice([david, angelo], true, 'a')?.voiceURI).toBe('b');
    // Desktop Chrome: English voices only, so the user's pick it is.
    expect(pickVoice([david], true, 'a')?.voiceURI).toBe('a');
    expect(hasFilipinoVoice([david])).toBe(false);
    expect(hasFilipinoVoice([david, angelo])).toBe(true);
  });

  it('says units and symbols as words, in the answer’s language', () => {
    expect(spokenText('Hinto ka sa Mountain View sa 1.7 min, ~600 m pa.', true)).toBe(
      'Hinto ka sa Mountain View sa 1.7 minuto, mga 600 metro pa.',
    );
    expect(spokenText('Diesel ₱94.55/L · fill 30 L in 2.5 km', false)).toBe(
      'Diesel 94.55 pesos per litre, fill 30 litres in 2.5 kilometres',
    );
    expect(spokenText('Malaria → SM City Fairview', true)).toBe(
      'Malaria papuntang SM City Fairview',
    );
    // Plates and words that only look like units stay as they are.
    expect(spokenText('JDY 9962 is at Lagro, 5 seats', false)).toBe(
      'JDY 9962 is at Lagro, 5 seats',
    );
  });
});

describe('WAV for transcription', () => {
  it('writes a 16-bit mono PCM file at the given rate', () => {
    const wav = new DataView(encodeWav(new Float32Array([0, 1, -1, 0.5, 2]), 16_000));
    const text = (at: number, n: number) =>
      String.fromCharCode(...Array.from({ length: n }, (_, i) => wav.getUint8(at + i)));
    expect(text(0, 4)).toBe('RIFF');
    expect(text(8, 4)).toBe('WAVE');
    expect(wav.getUint16(20, true)).toBe(1); // PCM
    expect(wav.getUint16(22, true)).toBe(1); // mono
    expect(wav.getUint32(24, true)).toBe(16_000);
    expect(wav.getUint16(34, true)).toBe(16);
    expect(wav.getUint32(40, true)).toBe(10); // 5 samples × 2 bytes
    expect(wav.byteLength).toBe(54);
    // Full scale both ways, and out-of-range input clipped rather than wrapped.
    expect(wav.getInt16(46, true)).toBe(0x7fff);
    expect(wav.getInt16(48, true)).toBe(-0x8000);
    expect(wav.getInt16(52, true)).toBe(0x7fff);
  });
});

describe('wake phrase', () => {
  it('passes on only what is asked of the assistant', () => {
    expect(addressed('Hey Sakay, how many are waiting at Lagro?')).toBe(
      'how many are waiting at Lagro?',
    );
    expect(addressed('hey, sakay! next stop')).toBe('next stop');
    expect(addressed('  Sakay Sight should I stop at Regalado')).toBe('should I stop at Regalado');
  });

  it('ignores everything else said in the cab', () => {
    expect(addressed('para po')).toBeNull();
    expect(addressed('bayad po, dalawa')).toBeNull();
    expect(addressed('I told him hey sakay is useful')).toBeNull();
    expect(addressed('hoy sakay na, sakay na')).toBeNull();
    expect(addressed('hey sakayan')).toBeNull();
  });

  it('ignores the wake phrase alone', () => {
    expect(addressed('Hey Sakay.')).toBeNull();
  });
});
