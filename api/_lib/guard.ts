/**
 * Who may reach the paid routes. Keys stay on the server, but a public link
 * would still let anyone spend them through /api, so each route only answers
 * this site's own pages, and only so often per visitor.
 *
 * The counts live in the function's memory, so they hold per running
 * instance, not across a whole deployment: enough to stop a script hammering
 * one link, not a determined attacker. META_SAVE_CREDITS is the hard stop.
 */

const WINDOW_MS = 60_000;
/** All visitors together may do this many times one visitor's limit. */
const ALL_VISITORS = 10;
/** Visitors remembered; past this the quiet ones are forgotten. */
const MAX_TRACKED = 5_000;

const hits = new Map<string, number[]>();

/** The times in `key`'s window, this one included: how many it has now used. */
function count(key: string, now: number): number {
  const kept = (hits.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  kept.push(now);
  hits.delete(key);
  hits.set(key, kept);
  if (hits.size > MAX_TRACKED) hits.delete(hits.keys().next().value!);
  return kept.length;
}

/** Whether the request comes from a page of this site. */
function sameSite(request: Request): boolean {
  const origin = request.headers.get('origin');
  if (!origin) return false;
  let host: string;
  try {
    host = new URL(origin).host;
  } catch {
    return false;
  }
  const extra = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim());
  return (
    host === new URL(request.url).host ||
    host === request.headers.get('host') ||
    host === request.headers.get('x-forwarded-host') ||
    extra.includes(origin)
  );
}

/** The response refusing this request, or null when it may go ahead. */
export function refused(request: Request, route: string, perMinute: number): Response | null {
  if (!sameSite(request)) return Response.json({ error: 'Not from this site' }, { status: 403 });
  const visitor = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'local';
  const now = Date.now();
  const mine = count(`${route}:${visitor}`, now);
  const everyone = count(route, now);
  if (mine <= perMinute && everyone <= perMinute * ALL_VISITORS) return null;
  return Response.json(
    { error: 'Too many requests. Wait a moment and try again.' },
    { status: 429, headers: { 'Retry-After': String(WINDOW_MS / 1000) } },
  );
}

/** Forget every count (tests). */
export function resetGuard(): void {
  hits.clear();
}
