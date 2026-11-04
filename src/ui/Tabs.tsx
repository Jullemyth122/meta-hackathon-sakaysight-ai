/**
 * The side panel's small pieces: tabs along its top (one thing at a time,
 * instead of everything in one long scroll), and folds for what only some
 * people need (notes, sources, raw numbers).
 */

import { useEffect, useState, type ReactNode } from 'react';

/** Each panel's open tab, kept while its view is closed. */
const remembered = new Map<string, string>();
/** The panels on screen, to open a tab of from outside. */
const shown = new Map<string, (tab: string) => void>();

/** Open a tab of panel `key`, on screen or next time it is. */
export function openTab(key: string, tab: string): void {
  remembered.set(key, tab);
  shown.get(key)?.(tab);
}

/** The tab open in panel `key`, `first` to begin with. */
export function useTab<T extends string>(key: string, first: T): [T, (tab: T) => void] {
  const [tab, setTab] = useState<T>(() => (remembered.get(key) as T | undefined) ?? first);
  useEffect(() => {
    shown.set(key, (next) => setTab(next as T));
    return () => void shown.delete(key);
  }, [key]);
  return [
    tab,
    (next) => {
      remembered.set(key, next);
      setTab(next);
    },
  ];
}

export function PanelTabs<T extends string>({
  label,
  tabs,
  active,
  onChange,
}: {
  label: string;
  tabs: ReadonlyArray<readonly [T, string]>;
  active: T;
  onChange: (tab: T) => void;
}) {
  return (
    <div className="panel-tabs" role="tablist" aria-label={label}>
      {tabs.map(([id, name]) => (
        <button
          key={id}
          type="button"
          role="tab"
          aria-selected={active === id}
          className={active === id ? 'is-on' : ''}
          onClick={() => onChange(id)}
        >
          {name}
        </button>
      ))}
    </div>
  );
}

/** Folded away until wanted. */
export function Fold({
  title,
  open = false,
  children,
}: {
  title: string;
  open?: boolean;
  children: ReactNode;
}) {
  return (
    <details className="fold" open={open}>
      <summary>{title}</summary>
      <div className="fold__body">{children}</div>
    </details>
  );
}
