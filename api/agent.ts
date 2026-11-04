/**
 * POST /api/agent
 *
 * One turn of the Sakay Agent. The browser holds the twin, so it runs the
 * tools; this only holds the key:
 *
 *   { role, screen?, messages, tools?: false }
 *     -> { message: { content, tool_calls? } }
 *
 * The browser sends the conversation, gets either an answer or the tools Muse
 * wants, runs those, and sends the results back (src/net/agent.ts). `tools:
 * false` asks for words alone: a sentence for the driver's autopilot to say.
 * A photo is a message part { type: 'image_url', image_url: { url } }.
 *
 * Muse decides what to look up and how to say it; the numbers come from the
 * tools. 503 when no Meta key is set or credit saving is on: the app then
 * answers from the planner (/api/assist).
 */

import { AGENT_PROMPT, AGENT_TOOLS, type AgentRole } from '../src/core/agent/tools.js';
import { fitScreen } from './_lib/fitScreen.js';
import { refused } from './_lib/guard.js';
import {
  chatWithTools,
  creditSaverEnabled,
  metaConfigured,
  type AgentMessage,
} from './_lib/meta.js';

/** A question can take a few turns, so more than /api/assist's. */
const PER_MINUTE = 40;
const MAX_MESSAGES = 24;
/** Tool results and history, without the photo. */
const MAX_TEXT_BYTES = 40_000;
/** A 1024 px JPEG, as base64. */
const MAX_IMAGE_BYTES = 1_500_000;
const MAX_SCREEN_BYTES = 6_000;

/** The person asked for English (a global audience): it wins over the language they type in. */
const IN_ENGLISH = 'Always answer in clear, simple English, whatever language they ask in.';

interface AgentBody {
  english?: unknown;
  role?: unknown;
  screen?: unknown;
  messages?: unknown;
  tools?: unknown;
}

const roleOf = (role: unknown): AgentRole | null =>
  role === 'driver' || role === 'commuter' || role === 'operator' ? role : null;

/** The bytes of a photo in the messages, and of everything else. */
function sizes(messages: readonly AgentMessage[]): { text: number; image: number } {
  let image = 0;
  const text = JSON.stringify(messages, (key, value: unknown) => {
    if (key === 'url' && typeof value === 'string') {
      image += value.length;
      return '';
    }
    return value;
  }).length;
  return { text, image };
}

export async function POST(request: Request): Promise<Response> {
  const no = refused(request, 'agent', PER_MINUTE);
  if (no) return no;
  if (!metaConfigured() || creditSaverEnabled())
    return Response.json({ error: 'The agent needs Meta' }, { status: 503 });

  const body = (await request.json().catch(() => null)) as AgentBody | null;
  const role = roleOf(body?.role);
  const messages = body?.messages as AgentMessage[] | undefined;
  if (!role || !Array.isArray(messages) || messages.length === 0)
    return Response.json({ error: 'role and messages are required' }, { status: 400 });
  if (messages.length > MAX_MESSAGES)
    return Response.json({ error: 'Conversation too long' }, { status: 413 });
  const { text, image } = sizes(messages);
  if (text > MAX_TEXT_BYTES || image > MAX_IMAGE_BYTES)
    return Response.json({ error: 'Too much to send' }, { status: 413 });

  const screen = fitScreen(body?.screen, MAX_SCREEN_BYTES);
  try {
    const message = await chatWithTools(
      [
        {
          role: 'system',
          content:
            AGENT_PROMPT +
            (body?.english === true ? `\n${IN_ENGLISH}` : '') +
            (screen ? `\nSCREEN (what their app shows now):\n${screen}` : ''),
        },
        ...messages,
      ],
      body?.tools === false ? [] : AGENT_TOOLS[role],
      // Reading a photo takes more thought than phrasing numbers.
      image > 0 ? 'low' : 'minimal',
      AbortSignal.timeout(25_000),
    );
    return Response.json({ message });
  } catch (err) {
    console.error('Agent', err);
    return Response.json({ error: 'Muse did not answer' }, { status: 502 });
  }
}
