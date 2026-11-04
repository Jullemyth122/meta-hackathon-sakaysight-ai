/**
 * Frame and caption for the rear-view mirror drawn by the WebGPU HUD pass
 * (scene/doorway/PipRenderer.tsx): sized with the same rule, so they line up.
 * Shown only while riding in the front seat.
 */

import { useEffect, useState, type RefObject } from 'react';
import { useApp } from '@/app/store';
import { MIRROR_LAYOUT, mirrorSize } from '@/scene/doorway/PipRenderer';

export function MirrorFrame({ container }: { container: RefObject<HTMLElement | null> }) {
  const frontSeat = useApp((s) => s.follow?.kind === 'sim' && s.follow.view === 'pov');
  const [size, setSize] = useState(() => mirrorSize(800));

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setSize(mirrorSize(entry!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [container]);

  if (!frontSeat) return null;
  return (
    <div
      className="mirror-frame"
      style={{
        width: size.w,
        height: size.h,
        top: MIRROR_LAYOUT.top,
        right: MIRROR_LAYOUT.margin,
      }}
      aria-label="Rear-view mirror: the road behind the vehicle"
    >
      <span className="mirror-frame__label">Rear view</span>
    </div>
  );
}
