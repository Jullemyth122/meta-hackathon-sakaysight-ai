/**
 * Minimal client for Meta's OpenAI-compatible chat completions endpoint.
 * Server-only: it reads META_API_KEY, which must never reach the browser.
 * (Files under api/_lib are not exposed as routes by Vercel.)
 *
 * Includes an in-memory TTL cache and a `META_SAVE_CREDITS=true` switch so
 * development/testing or repeated identical queries consume $0.00 of the
 * $150 free hackathon credit.
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class MetaConfigError extends Error {}

/** The model spent its whole budget thinking and wrote nothing (the call was still billed). */
export class MetaEmptyReplyError extends Error {}

/**
 * Muse reasons before it answers, and the reasoning is billed as
 * output. 'minimal' keeps that to ~100 tokens for these questions (the
 * numbers are already worked out by the planner); 'low' and up think for
 * hundreds of tokens and add seconds for no better answer.
 */
const REASONING_EFFORT = process.env.META_REASONING_EFFORT ?? 'minimal';
/**
 * Room for the thinking plus a full answer: a one-line reply normally, a
 * short paragraph (~150 words) when the question asks for more. Answers are
 * kept short by the prompt, not by this cap; the cap only bounds the cost.
 */
const MAX_COMPLETION_TOKENS = Number(process.env.META_MAX_TOKENS) || 1000;

/** The key only works here; META_API_BASE is for a different endpoint, if one is given. */
export const META_BASE = process.env.META_API_BASE ?? 'https://api.meta.ai/v1';

const CACHE_TTL_MS = 60_000;
const MAX_CACHE_ENTRIES = 100;
const responseCache = new Map<string, { text: string; expiresAt: number }>();

export function metaConfigured(): boolean {
  return Boolean(process.env.META_API_KEY && process.env.META_MODEL);
}

/**
 * When `META_SAVE_CREDITS=true` is set in `.env`, `/api/assist` answers using
 * the deterministic SakaySightAI math/dispatch planner (`api/_lib/planner.ts`)
 * without making external LLM network calls.
 */
export function creditSaverEnabled(): boolean {
  const flag = (process.env.META_SAVE_CREDITS ?? '').toLowerCase().trim();
  return flag === 'true' || flag === '1' || flag === 'yes';
}

export async function chatWithCache(
  messages: ChatMessage[],
  cacheKey?: string,
  signal?: AbortSignal,
): Promise<{ text: string; cached: boolean }> {
  const now = Date.now();
  if (cacheKey) {
    const hit = responseCache.get(cacheKey);
    if (hit && hit.expiresAt > now) {
      return { text: hit.text, cached: true };
    }
  }

  const text = await chat(messages, signal);

  if (cacheKey && text) {
    if (responseCache.size >= MAX_CACHE_ENTRIES) {
      const oldestKey = responseCache.keys().next().value;
      if (oldestKey !== undefined) responseCache.delete(oldestKey);
    }
    responseCache.set(cacheKey, { text, expiresAt: now + CACHE_TTL_MS });
  }

  return { text, cached: false };
}

/** A message of the agent's conversation: the words, a photo, or tools asked for and answered. */
export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: unknown;
  tool_calls?: unknown;
  tool_call_id?: string;
}

/**
 * One turn of the agent: Muse answers, or asks for tools. Room for the
 * reasoning a photo takes as well as the answer.
 */
export async function chatWithTools(
  messages: AgentMessage[],
  tools: readonly object[],
  effort: string,
  signal?: AbortSignal,
): Promise<{ content: string | null; tool_calls?: unknown[] }> {
  const key = process.env.META_API_KEY;
  const model = process.env.META_MODEL;
  if (!key || !model) throw new MetaConfigError('META_API_KEY and META_MODEL must be set');
  const res = await fetch(`${META_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      ...(tools.length > 0 && { tools }),
      temperature: 0.2,
      reasoning_effort: effort,
      max_completion_tokens: MAX_COMPLETION_TOKENS * 2,
    }),
    signal,
  });
  if (!res.ok) {
    console.error('Meta API error', res.status, await res.text().catch(() => ''));
    throw new Error(`Meta API responded ${res.status}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null; tool_calls?: unknown[] } }>;
  };
  const message = data.choices?.[0]?.message;
  if (!message?.content && !message?.tool_calls?.length)
    throw new MetaEmptyReplyError('Empty reply');
  return { content: message.content ?? null, tool_calls: message.tool_calls };
}

export async function chat(messages: ChatMessage[], signal?: AbortSignal): Promise<string> {
  const key = process.env.META_API_KEY;
  const model = process.env.META_MODEL;
  if (!key || !model) throw new MetaConfigError('META_API_KEY and META_MODEL must be set');

  const res = await fetch(`${META_BASE}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      temperature: 0.2,
      reasoning_effort: REASONING_EFFORT,
      max_completion_tokens: MAX_COMPLETION_TOKENS,
    }),
    signal,
  });
  if (!res.ok) {
    // Log the upstream body server-side; return only the status to the client.
    console.error('Meta API error', res.status, await res.text().catch(() => ''));
    throw new Error(`Meta API responded ${res.status}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ finish_reason?: string; message?: { content?: string | null } }>;
  };
  const choice = data.choices?.[0];
  const text = choice?.message?.content?.trim() ?? '';
  if (!text) throw new MetaEmptyReplyError(`Empty reply (finish_reason ${choice?.finish_reason})`);
  // Cut off mid-sentence by the cap: keep the complete sentences.
  if (choice?.finish_reason === 'length') {
    const end = Math.max(text.lastIndexOf('. '), text.lastIndexOf('.\n'), text.lastIndexOf('.'));
    return end > 0 ? text.slice(0, end + 1) : text;
  }
  return text;
}
