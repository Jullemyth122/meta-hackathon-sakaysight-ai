/** A small menu over the map, for what is not needed all the time. */

import { useEffect, useRef, type ReactNode } from 'react';

export function Menu({ label, children }: { label: string; children: ReactNode }) {
  const menu = useRef<HTMLDetailsElement>(null);
  // Closed by clicking anywhere else, as a menu is.
  useEffect(() => {
    const close = (e: PointerEvent) => {
      const m = menu.current;
      if (m?.open && !m.contains(e.target as Node)) m.open = false;
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  return (
    <details className="menu" ref={menu}>
      <summary className="btn">{label}</summary>
      <div className="menu__list">{children}</div>
    </details>
  );
}

/** One choice in a Menu, with what it is set to on the right. */
export function MenuItem({
  label,
  state,
  title,
  disabled,
  onClick,
}: {
  label: string;
  state?: string;
  title?: string;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="menu__item"
      title={title}
      disabled={disabled}
      onClick={onClick}
    >
      <span>{label}</span>
      {state && <span className="menu__state">{state}</span>}
    </button>
  );
}
