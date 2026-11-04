/**
 * A number that flashes when it changes (Notes.md pipeline step 6: "trigger an
 * audio/visual badge flash on state change"). Animated with GSAP.
 */

import { useGSAP } from '@gsap/react';
import gsap from 'gsap';
import { useRef } from 'react';

gsap.registerPlugin(useGSAP);

interface Props {
  label: string;
  value: number | string;
  /** Secondary value shown small, e.g. the simulated truth. */
  note?: string;
  tone?: 'neutral' | 'good' | 'warn' | 'bad';
}

export function CounterBadge({ label, value, note, tone = 'neutral' }: Props) {
  const root = useRef<HTMLDivElement>(null);
  const first = useRef(true);

  useGSAP(
    () => {
      if (first.current) {
        first.current = false;
        return;
      }
      gsap.fromTo(
        '.counter__value',
        { scale: 1.25, color: 'var(--accent-ink)' },
        { scale: 1, color: 'var(--fg)', duration: 0.6, ease: 'power3.out' },
      );
      gsap.fromTo(
        root.current,
        { boxShadow: '0 0 0 4px var(--flash)' },
        { boxShadow: '0 0 0 0px var(--flash)', duration: 0.8 },
      );
    },
    { scope: root, dependencies: [value] },
  );

  return (
    <div ref={root} className={`counter counter--${tone}`}>
      <span className="counter__label">{label}</span>
      <span className="counter__value mono">{value}</span>
      {note && <span className="counter__note">{note}</span>}
    </div>
  );
}
