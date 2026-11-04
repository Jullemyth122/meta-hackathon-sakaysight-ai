/**
 * Automatic AI: while it is on, the app looks at the road every few seconds
 * and speaks when something is worth saying (core/agent/autopilot.ts), in
 * words from Muse, or the plain ones if Muse cannot be reached. Off by
 * default: it spends Meta credit.
 */

import { useEffect, useRef, useState } from 'react';
import type { Notice } from '@/core/agent/autopilot';
import type { AgentRole } from '@/core/agent/tools';
import { phrase } from '@/net/agent';
import { speech } from '@/net/voice';
import { useApp } from '@/app/store';

/** How often it looks at the road (milliseconds of real time). */
const LOOK_MS = 3000;
/** At least this long between two things said. */
const QUIET_MS = 15_000;
/** The same thing is not said again for this long. */
const NOTICE_AGAIN_MS = 180_000;

export function useAutopilot(
  on: boolean,
  notices: () => readonly Notice[],
  role: AgentRole,
): string | null {
  const latest = useRef(notices);
  latest.current = notices;
  const [said, setSaid] = useState<string | null>(null);

  useEffect(() => {
    if (!on) return;
    const heard = new Map<string, number>();
    let lastSpoke = 0;
    let saying = false;
    const id = window.setInterval(() => {
      const now = performance.now();
      if (saying || now - lastSpoke < QUIET_MS) return;
      const notice = latest
        .current()
        .find((n) => now - (heard.get(n.key) ?? -Infinity) > NOTICE_AGAIN_MS);
      if (!notice) return;
      heard.set(notice.key, now);
      lastSpoke = now;
      saying = true;
      const tongue = useApp.getState().english ? 'English' : 'Taglish';
      // Something to do, not only to say: done first, then what was done is said.
      void (notice.act ? notice.act().catch(() => null) : Promise.resolve(notice.text))
        .then((words) =>
          words === null ? null : phrase(words, { role, tongue }).catch(() => words),
        )
        .then((text) => {
          saying = false;
          if (text === null) return;
          setSaid(text);
          speech.speak(text);
        });
    }, LOOK_MS);
    return () => window.clearInterval(id);
  }, [on, role]);

  return on ? said : null;
}
