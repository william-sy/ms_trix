import { useEffect, useRef } from "react";
import type { EffectName } from "./effects";

const DURATION_MS = 4500;
const COLORS = ["#f44336", "#e91e63", "#9c27b0", "#3f51b5", "#03a9f4", "#4caf50", "#ffeb3b", "#ff9800"];

interface Particle { x: number; y: number; vx: number; vy: number; size: number; color: string; spin: number; angle: number; life: number; text?: string }

/** A short full-window animation drawn on a canvas that ignores the mouse. */
export function ChatEffect({ name, onDone }: { name: EffectName; onDone: () => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return onDone();
    const el = canvas.current!;
    const ctx = el.getContext("2d")!;
    const w = (el.width = window.innerWidth);
    const h = (el.height = window.innerHeight);
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    const pick = <T,>(xs: T[]) => xs[Math.floor(Math.random() * xs.length)]!;
    const particles: Particle[] = [];
    const add = (p: Partial<Particle>) => particles.push({ x: 0, y: 0, vx: 0, vy: 0, size: 8, color: pick(COLORS), spin: 0, angle: 0, life: Infinity, ...p });
    const start = performance.now();
    let last = start;
    let nextBurst = 0;

    // Seed per effect; fireworks keep adding bursts while running.
    if (name === "confetti") for (let i = 0; i < 180; i++) add({ x: rnd(0, w), y: rnd(-h, 0), vx: rnd(-40, 40), vy: rnd(120, 260), size: rnd(6, 11), spin: rnd(-6, 6) });
    if (name === "rainfall") for (let i = 0; i < 260; i++) add({ x: rnd(0, w), y: rnd(-h, 0), vy: rnd(700, 1000), size: rnd(10, 22), color: "rgba(120,160,255,0.6)" });
    if (name === "snowfall") for (let i = 0; i < 160; i++) add({ x: rnd(0, w), y: rnd(-h, 0), vx: rnd(-20, 20), vy: rnd(40, 110), size: rnd(2, 5), color: "rgba(255,255,255,0.9)", spin: rnd(0, 6) });
    if (name === "hearts") for (let i = 0; i < 40; i++) add({ x: rnd(0, w), y: h + rnd(0, h / 2), vy: rnd(-180, -90), size: rnd(20, 40), spin: rnd(0, 6), text: pick(["💝", "💖", "💕", "💗"]) });
    if (name === "spaceinvaders") for (let i = 0; i < 24; i++) add({ x: -60 - (i % 8) * 70, y: 60 + Math.floor(i / 8) * 70, vx: 220, size: 36, text: "👾" });

    let frame = 0;
    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const t = now - start;
      if (name === "fireworks" && t < DURATION_MS - 1200 && t > nextBurst) {
        nextBurst = t + rnd(250, 600);
        const cx = rnd(w * 0.15, w * 0.85), cy = rnd(h * 0.15, h * 0.5), color = pick(COLORS);
        for (let i = 0; i < 70; i++) {
          const a = (i / 70) * Math.PI * 2, speed = rnd(80, 260);
          add({ x: cx, y: cy, vx: Math.cos(a) * speed, vy: Math.sin(a) * speed, size: 2.5, color, life: rnd(0.8, 1.4) });
        }
      }
      ctx.clearRect(0, 0, w, h);
      // Fade everything out over the last second.
      ctx.globalAlpha = Math.max(0, Math.min(1, (DURATION_MS - t) / 1000));
      for (const p of particles) {
        p.x += p.vx * dt;
        p.y += p.vy * dt;
        p.angle += p.spin * dt;
        p.life -= dt;
        if (name === "fireworks") p.vy += 120 * dt;
        if (name === "snowfall" || name === "hearts") p.x += Math.sin(p.angle) * 20 * dt;
        if (p.life <= 0) continue;
        if (p.text) {
          ctx.font = `${p.size}px sans-serif`;
          ctx.fillText(p.text, p.x, p.y);
        } else if (name === "rainfall") {
          ctx.strokeStyle = p.color;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(p.x, p.y + p.size);
          ctx.stroke();
        } else if (name === "confetti") {
          ctx.save();
          ctx.translate(p.x, p.y);
          ctx.rotate(p.angle);
          ctx.fillStyle = p.color;
          ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
          ctx.restore();
        } else {
          ctx.fillStyle = p.color;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (t < DURATION_MS) frame = requestAnimationFrame(tick);
      else onDone();
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [name]); // eslint-disable-line react-hooks/exhaustive-deps

  return <canvas ref={canvas} className="chat-effect" aria-hidden />;
}
