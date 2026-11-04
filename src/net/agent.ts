/**
 * The Sakay Agent's conversation: Muse is told the question, asks for the
 * tools it wants, the app runs them here, and Muse answers from the results
 * (api/agent.ts). Short memory: the last few questions and answers, so
 * "eh yung susunod?" means something.
 */

import { onlyItsNumbers } from '@/core/agent/autopilot';
import type { AgentRole } from '@/core/agent/tools';

/** A question gets at most this many turns of looking things up. */
const MAX_ROUNDS = 5;
/** Questions and answers kept for follow-ups, in messages. */
const MEMORY_MESSAGES = 6;

interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

type Part =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail: 'high' } };

export type AgentMessage =
  | { role: 'user'; content: string | Part[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

/** Runs a tool by name; what it returns goes to Muse as JSON. */
export type ToolRunner = (name: string, args: Record<string, unknown>) => Promise<unknown>;

export interface AgentContext {
  role: AgentRole;
  /** What the person's app shows now. */
  screen: () => object | undefined;
  run: ToolRunner;
}

export interface PhraseOptions {
  role?: AgentRole;
  long?: boolean;
  tongue?: 'Taglish' | 'English';
}

export interface AgentReply {
  text: string;
  /** The tools Muse used, in order: shown under the answer. */
  tools: string[];
}

async function turn(body: object): Promise<{ content: string | null; tool_calls?: ToolCall[] }> {
  const res = await fetch('/api/agent', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as {
    message?: { content: string | null; tool_calls?: ToolCall[] };
    error?: string;
  };
  if (!res.ok || !data.message) throw new Error(data.error ?? `Agent failed (${res.status})`);
  return data.message;
}

export async function askAgent(
  question: string,
  context: AgentContext,
  memory: AgentMessage[],
  /** A photo, as a data URL. */
  photo?: string,
  /** In English, whatever they asked in. */
  english = false,
): Promise<AgentReply> {
  const asked: AgentMessage = photo
    ? {
        role: 'user',
        content: [
          { type: 'text', text: question },
          { type: 'image_url', image_url: { url: photo, detail: 'high' } },
        ],
      }
    : { role: 'user', content: question };
  const messages: AgentMessage[] = [...memory, asked];
  const tools: string[] = [];
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const reply = await turn({ role: context.role, screen: context.screen(), messages, english });
    if (!reply.tool_calls?.length) {
      const text = reply.content?.trim() ?? '';
      if (!text) throw new Error('No answer');
      // The photo is not kept: it would be sent, and paid for, on every turn after.
      memory.push({ role: 'user', content: photo ? `${question} (with a photo)` : question });
      memory.push({ role: 'assistant', content: text });
      memory.splice(0, Math.max(0, memory.length - MEMORY_MESSAGES));
      return { text, tools };
    }
    messages.push({ role: 'assistant', content: reply.content, tool_calls: reply.tool_calls });
    for (const call of reply.tool_calls) {
      tools.push(call.function.name);
      let result: unknown;
      try {
        const args = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
        result = await context.run(call.function.name, args);
      } catch (err) {
        result = { error: err instanceof Error ? err.message : String(err) };
      }
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result ?? null),
      });
    }
  }
  throw new Error('Too many steps');
}

/**
 * `facts` in Muse's words, for `role`: a sentence, or a few when `long`. The
 * facts themselves, if it brought in a number it was not given.
 */
export async function phrase(
  facts: string,
  { role = 'driver', long = false, tongue = 'Taglish' }: PhraseOptions = {},
): Promise<string> {
  const length = long ? 'a few plain sentences' : 'one short natural sentence';
  const reply = await turn({
    role,
    tools: false,
    messages: [
      {
        role: 'user',
        content: `Say this to the ${role} in ${length} of ${tongue}, keeping every number and name: ${facts}`,
      },
    ],
  });
  const said = reply.content?.trim();
  return said && onlyItsNumbers(facts, said) ? said : facts;
}

/** Which of the trips found Muse would take and why, in a sentence; null if it strayed. */
export async function recommend(trips: string): Promise<string | null> {
  const reply = await turn({
    role: 'commuter',
    tools: false,
    messages: [
      {
        role: 'user',
        content: `These are the trips the app found for a commuter:\n${trips}\nIn one short natural sentence of Taglish, say which one you would take and why. Use only these numbers and names.`,
      },
    ],
  });
  const said = reply.content?.trim();
  return said && onlyItsNumbers(trips, said) ? said : null;
}

/** A photo as a data URL small enough to send: 1024 px on its long side. */
export async function photoForMuse(file: Blob): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d')!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return canvas.toDataURL('image/jpeg', 0.8);
}
