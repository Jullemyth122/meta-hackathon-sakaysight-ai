/**
 * The "driver's phone browser" view on top of the QVGA picture-in-picture:
 * head boxes and track IDs from the camera, the rear-opening region (heads
 * seen there are outside) or a door camera's crossing line, and the running
 * count. Drawn on a 2D canvas, sized with the same layout rule as the WebGPU
 * PiP quad so the two line up.
 */

import { useEffect, useRef, useState, type RefObject } from 'react';
import type { CameraFeed } from '@/app/doorwayRuntime';
import { FRAME_H, FRAME_W, sideOf, type Side } from '@/core/doorway/pipeline';
import { PIP_LAYOUT, pipSize } from '@/scene/doorway/PipRenderer';

const SIDE_STYLE: Record<Side, { color: string; label: (id: number) => string }> = {
  in: { color: '#ff3b30', label: (id) => `#${id}` },
  unsure: { color: '#efbe2c', label: (id) => `#${id} at door` },
  out: { color: '#9aa1a8', label: () => 'outside' },
};

export function PipOverlay({
  container,
  feed,
}: {
  container: RefObject<HTMLElement | null>;
  feed: CameraFeed;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [size, setSize] = useState(() => pipSize(800));

  useEffect(() => {
    const el = container.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setSize(pipSize(entry!.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [container]);

  useEffect(() => {
    let raf = 0;
    /**
     * Drawn box per track, eased toward the latest detection every screen
     * frame. Only the drawing is smoothed (like a phone UI would); the
     * counter works on the raw detections.
     */
    const shown = new Map<number, { cx: number; cy: number; w: number; h: number }>();
    const EASE = 0.25;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const c = canvas.current;
      const ctx = c?.getContext('2d');
      const pipeline = feed.pipeline;
      if (!c || !ctx) return;

      const dpr = window.devicePixelRatio || 1;
      if (c.width !== Math.round(size.w * dpr)) {
        c.width = Math.round(size.w * dpr);
        c.height = Math.round(size.h * dpr);
      }
      // Draw in camera-frame pixels (320×240) and let the transform scale.
      ctx.setTransform((size.w * dpr) / FRAME_W, 0, 0, (size.h * dpr) / FRAME_H, 0, 0);
      ctx.clearRect(0, 0, FRAME_W, FRAME_H);
      if (!pipeline) return;

      const t = pipeline.telemetry(feed.clockMs);
      ctx.font = '9px Inter, sans-serif';
      ctx.lineWidth = 1;

      ctx.strokeStyle = '#2f9e5b';
      ctx.fillStyle = '#2f9e5b';
      ctx.setLineDash([4, 3]);
      if ('door' in t.view) {
        // Rear opening: heads seen in here, at doorway size, are outside.
        const d = t.view.door;
        ctx.strokeRect(d.x0, d.y0, d.x1 - d.x0, d.y1 - d.y0);
        ctx.fillText('door', d.x0, d.y0 - 3);
      } else {
        // A door camera's line, right across the frame: crossing it is getting on or off.
        const { a, b } = t.view;
        const k = (FRAME_W + FRAME_H) / Math.hypot(b.x - a.x, b.y - a.y);
        ctx.beginPath();
        ctx.moveTo(a.x - (b.x - a.x) * k, a.y - (b.y - a.y) * k);
        ctx.lineTo(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k);
        ctx.stroke();
        ctx.fillText(t.view.name, 4, 11);
      }
      ctx.setLineDash([]);

      const live = new Set<number>();
      for (const tr of t.tracks) {
        live.add(tr.id);
        let b = shown.get(tr.id);
        if (!b) shown.set(tr.id, (b = { cx: tr.cx, cy: tr.cy, w: tr.w, h: tr.h }));
        b.cx += (tr.cx - b.cx) * EASE;
        b.cy += (tr.cy - b.cy) * EASE;
        b.w += (tr.w - b.w) * EASE;
        b.h += (tr.h - b.h) * EASE;

        const style = SIDE_STYLE[sideOf(tr, t.view)];
        ctx.strokeStyle = style.color;
        ctx.fillStyle = style.color;
        ctx.strokeRect(b.cx - b.w / 2, b.cy - b.h / 2, b.w, b.h);
        ctx.fillText(style.label(tr.id), b.cx - b.w / 2, b.cy - b.h / 2 - 2);
      }
      for (const id of shown.keys()) if (!live.has(id)) shown.delete(id);

      ctx.fillStyle = 'rgba(0,0,0,.6)';
      ctx.fillRect(0, FRAME_H - 15, FRAME_W, 15);
      ctx.fillStyle = '#fff';
      ctx.font = '10px Inter, sans-serif';
      const heads = 'door' in t.view ? ` (heads ${t.seenSteady})` : '';
      ctx.fillText(
        `ESP ${t.fps} fps · ${t.latencyMs.toFixed(0)} ms · riders ${t.counts.current}${heads} ↑${t.counts.boarded} ↓${t.counts.alighted}`,
        4,
        FRAME_H - 4,
      );
    };
    draw();
    return () => cancelAnimationFrame(raf);
  }, [feed, size]);

  return (
    <canvas
      ref={canvas}
      className="pip-overlay"
      style={{ width: size.w, height: size.h, right: PIP_LAYOUT.margin, bottom: PIP_LAYOUT.margin }}
      aria-label="Simulated ESP32-S3-CAM view with head detections"
    />
  );
}
