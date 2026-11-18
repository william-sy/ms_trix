// Moving camera backgrounds, drawn here frame by frame so there are no video files to ship:
// leaves in the wind, clouds drifting by, fireflies at dusk, misty mountains. Each one prepares its pieces once
// for the picture size and then only moves them, so a frame is a handful of drawImage calls.

/** Draws one frame at `t` seconds. */
export type Painter = (ctx: CanvasRenderingContext2D, t: number) => void;

export const MOVING: { id: string; make: (w: number, h: number) => Painter }[] = [
  { id: "leaves", make: leaves },
  { id: "clouds", make: clouds },
  { id: "fireflies", make: fireflies },
  { id: "valley", make: valley },
];

const filterSupported = (() => {
  try { return typeof document.createElement("canvas").getContext("2d")?.filter === "string"; } catch { return false; }
})();

function layer(w: number, h: number): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return [c, c.getContext("2d")!];
}

/** The same "random" layout every time, so the thumbnail matches what the call shows. */
function seeded(seed: number): () => number {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function vertical(c: CanvasRenderingContext2D, w: number, h: number, stops: [number, string][]) {
  const g = c.createLinearGradient(0, 0, 0, h);
  for (const [at, color] of stops) g.addColorStop(at, color);
  c.fillStyle = g;
  c.fillRect(0, 0, w, h);
}

/** Between colours `a` and `b` ("#rrggbb"), `u` of the way. */
function mix(a: string, b: string, u: number): string {
  const ch = (c: string, i: number) => parseInt(c.slice(1 + i * 2, 3 + i * 2), 16);
  return `rgb(${[0, 1, 2].map((i) => Math.round(ch(a, i) + (ch(b, i) - ch(a, i)) * u)).join(",")})`;
}

/** A soft round light: `rgb` ("r,g,b") fading out from the middle. */
function glow(c: CanvasRenderingContext2D, x: number, y: number, r: number, rgb: string, alpha: number) {
  const g = c.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, `rgba(${rgb},${alpha})`);
  g.addColorStop(1, `rgba(${rgb},0)`);
  c.fillStyle = g;
  c.beginPath();
  c.arc(x, y, r, 0, Math.PI * 2);
  c.fill();
}

/** Sunlit greenery, out of focus, with two leafy branches swaying in front. */
function leaves(w: number, h: number): Painter {
  const s = w / 1280;
  const rand = seeded(3);
  const [base, bc] = layer(w, h);
  vertical(bc, w, h, [[0, "#d7ebbd"], [0.45, "#8fbf76"], [1, "#4a7c47"]]);
  for (let i = 0; i < 26; i++) glow(bc, rand() * w, rand() * h, (70 + rand() * 150) * s, rand() < 0.5 ? "58,108,52" : "118,168,88", 0.4);
  for (let i = 0; i < 10; i++) glow(bc, rand() * w, rand() * h * 0.6, (40 + rand() * 90) * s, "255,250,215", 0.4);

  // Sunlight through the leaves: soft spots that wander and brighten a little.
  const [spot, sc] = layer(128, 128);
  glow(sc, 64, 64, 64, "255,252,225", 0.55);
  const spots = Array.from({ length: 7 }, () => ({ x: rand() * w, y: rand() * h * 0.7, r: (60 + rand() * 90) * s, p: rand() * 10, f: 0.12 + rand() * 0.18 }));

  // A branch drawn once, slightly out of focus; it sways about where it enters the picture.
  const branch = (len: number) => {
    // Room around the stem for the leaves.
    const bh = len * 0.75;
    const [c, x] = layer(len * 1.12, bh);
    if (filterSupported) x.filter = `blur(${Math.max(0.4, 1.6 * s)}px)`;
    const p0 = [0, bh * 0.25], p1 = [len * 0.45, bh * 0.16], p2 = [len * 0.95, bh * 0.58];
    const at = (u: number, i: 0 | 1) => (1 - u) * (1 - u) * p0[i]! + 2 * (1 - u) * u * p1[i]! + u * u * p2[i]!;
    x.strokeStyle = "#3b3a24";
    x.lineCap = "round";
    x.lineWidth = Math.max(1, len * 0.012);
    x.beginPath();
    x.moveTo(p0[0]!, p0[1]!);
    x.quadraticCurveTo(p1[0]!, p1[1]!, p2[0]!, p2[1]!);
    x.stroke();
    for (let i = 2; i <= 20; i++) {
      const u = i / 20;
      for (const side of [-1, 1]) {
        const size = len * (0.055 + rand() * 0.035) * (1 - u * 0.35);
        x.save();
        x.translate(at(u, 0), at(u, 1));
        x.rotate(side * (0.7 + rand() * 0.5) + u * 0.5);
        x.fillStyle = ["#2c6429", "#3a8133", "#4b9640"][Math.floor(rand() * 3)]!;
        x.beginPath();
        x.ellipse(size, 0, size, size * 0.4, 0, 0, Math.PI * 2);
        x.fill();
        x.restore();
      }
    }
    return c;
  };
  const left = branch(w * 0.55), right = branch(w * 0.42);
  const sway = (ctx: CanvasRenderingContext2D, img: HTMLCanvasElement, x: number, y: number, flip: number, t: number, phase: number) => {
    ctx.save();
    ctx.translate(x, y);
    ctx.scale(flip, 1);
    ctx.rotate(0.1 + Math.sin(t * 0.7 + phase) * 0.025 + Math.sin(t * 1.7 + phase) * 0.008);
    ctx.drawImage(img, 0, -img.height * 0.25);
    ctx.restore();
  };

  return (ctx, t) => {
    ctx.drawImage(base, 0, 0);
    ctx.globalCompositeOperation = "screen";
    for (const p of spots) {
      ctx.globalAlpha = 0.35 + 0.25 * Math.sin(t * p.f * 2 + p.p);
      const x = p.x + Math.sin(t * p.f + p.p) * 30 * s, y = p.y + Math.cos(t * p.f * 0.8 + p.p) * 20 * s;
      ctx.drawImage(spot, x - p.r, y - p.r, p.r * 2, p.r * 2);
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    sway(ctx, left, -w * 0.02, h * 0.02, 1, t, 0);
    sway(ctx, right, w * 1.02, h * 0.06, -1, t, 2);
  };
}

/** A blue sky with soft clouds drifting slowly across, the far ones slower. */
function clouds(w: number, h: number): Painter {
  const s = w / 1280;
  const rand = seeded(7);
  const [sky, sc] = layer(w, h);
  vertical(sc, w, h, [[0, "#4a7fc9"], [0.6, "#8fbbe8"], [1, "#dcebf8"]]);
  glow(sc, w * 0.85, h * 0.08, h * 0.55, "255,244,214", 0.45); // the sun, just out of the picture

  const cloud = (cw: number, ch: number) => {
    const [c, x] = layer(cw, ch);
    const n = 9;
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      const px = cw * (0.2 + 0.6 * u) + (rand() - 0.5) * cw * 0.08;
      const py = ch * (0.66 - Math.sin(u * Math.PI) * 0.24) + (rand() - 0.5) * ch * 0.06;
      glow(x, px, py, ch * (0.26 + rand() * 0.14), "255,255,255", 0.8);
    }
    // A flatter, fuller underside.
    for (let i = 0; i < 6; i++) glow(x, cw * (0.25 + 0.5 * (i / 5)), ch * 0.7, ch * 0.24, "255,255,255", 0.7);
    return c;
  };
  const drift = (count: number, size: number, speed: number, alpha: number, top: number, band: number) =>
    Array.from({ length: count }, (_, i) => {
      const cw = size * s * (0.8 + rand() * 0.5);
      return { img: cloud(cw, cw * 0.45), x: (i + rand() * 0.6) * ((w + cw) / count), y: h * (top + rand() * band), speed: speed * s * (0.8 + rand() * 0.4), alpha };
    });
  const far = drift(4, 300, 5, 0.55, 0.04, 0.3);
  const near = drift(3, 540, 11, 0.9, 0.12, 0.42);

  return (ctx, t) => {
    ctx.drawImage(sky, 0, 0);
    for (const group of [far, near]) {
      for (const c of group) {
        const span = w + c.img.width;
        ctx.globalAlpha = c.alpha;
        ctx.drawImage(c.img, (((c.x + c.speed * t) % span) + span) % span - c.img.width, c.y);
      }
    }
    ctx.globalAlpha = 1;
  };
}

/** Dusk in a pine forest; fireflies wander and blink among the trees. */
function fireflies(w: number, h: number): Painter {
  const s = w / 1280;
  const rand = seeded(11);
  const [base, bc] = layer(w, h);
  vertical(bc, w, h, [[0, "#0d1d31"], [0.55, "#12343a"], [1, "#0b2219"]]);
  glow(bc, w * 0.2, h * 0.08, h * 0.5, "170,195,255", 0.2); // moonlight
  // Three rows of trees, darker the nearer they are.
  for (const [row, color, tall] of [[0, "#123033", 0.55], [1, "#0d2424", 0.68], [2, "#081814", 0.8]] as const) {
    bc.fillStyle = color;
    for (let x = -60 * s; x < w + 60 * s;) {
      const tw = (50 + rand() * 70) * s * (1 + row * 0.4);
      const th = h * tall * (0.7 + rand() * 0.3);
      bc.beginPath();
      bc.moveTo(x, h);
      bc.quadraticCurveTo(x + tw * 0.3, h - th * 0.45, x + tw / 2, h - th);
      bc.quadraticCurveTo(x + tw * 0.7, h - th * 0.45, x + tw, h);
      bc.fill();
      x += tw * (0.55 + rand() * 0.3);
    }
  }

  const r = Math.max(3, 16 * s);
  const [fly, fc] = layer(r * 2, r * 2);
  glow(fc, r, r, r, "214,255,120", 0.85);
  glow(fc, r, r, r * 0.25, "255,255,220", 1);
  const flies = Array.from({ length: 36 }, () => ({
    x: rand() * w, y: h * (0.3 + rand() * 0.65),
    ax: (20 + rand() * 45) * s, ay: (10 + rand() * 25) * s,
    fx: 0.04 + rand() * 0.1, fy: 0.05 + rand() * 0.12, p: rand() * 100,
    blink: 0.4 + rand() * 0.6, size: 0.5 + rand() * 0.7,
  }));

  return (ctx, t) => {
    ctx.drawImage(base, 0, 0);
    ctx.globalCompositeOperation = "lighter";
    for (const f of flies) {
      const on = Math.max(0, Math.sin(t * f.blink + f.p));
      ctx.globalAlpha = 0.12 + 0.88 * on * on;
      const x = f.x + Math.sin(t * f.fx * 6.28 + f.p) * f.ax + Math.sin(t * f.fx * 2.3 + f.p * 2) * f.ax * 0.4;
      const y = f.y + Math.cos(t * f.fy * 6.28 + f.p) * f.ay;
      const d = r * 2 * f.size;
      ctx.drawImage(fly, x - d / 2, y - d / 2, d, d);
    }
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
  };
}

/**
 * Mountain ridges fading into the distance with mist in the valleys between them. The view pans
 * slowly, the near ridges further than the far ones, which gives the depth; now and then a few
 * birds glide past.
 */
function valley(w: number, h: number): Painter {
  const s = w / 1280;
  const rand = seeded(5);
  const pan = 36 * s; // how far the nearest ridge moves either way
  const [sky, sc] = layer(w, h);
  vertical(sc, w, h, [[0, "#9db4cd"], [0.45, "#e2e0db"], [0.6, "#f3e1cb"], [1, "#f3e1cb"]]);
  glow(sc, w * 0.68, h * 0.48, h * 0.45, "255,236,200", 0.6); // the sun, low behind the mountains

  const [mist, mc] = layer(128, 128);
  glow(mc, 64, 64, 64, "250,248,244", 0.75);
  const count = 5;
  const ridges = Array.from({ length: count }, (_, i) => {
    const depth = (i + 1) / count; // 0.2 far … 1 near
    const lw = w + pan * 2 * depth + 4;
    const [c, x] = layer(lw, h);
    const base = h * (0.44 + i * 0.1);
    const waves = [0, 1, 2, 3].map((k) => ({ amp: (h * 0.075 * (1 - i * 0.1)) / 2 ** k, freq: ((1.2 + rand()) * 2 ** k * 6.28) / w, phase: rand() * 6.28 }));
    const crest = (px: number) => waves.reduce((y, o) => y - o.amp * Math.sin(px * o.freq + o.phase), base);
    x.fillStyle = mix("#b3bfcb", "#22333a", depth ** 1.3);
    x.beginPath();
    x.moveTo(0, h);
    for (let px = 0; px <= lw; px += Math.max(2, 6 * s)) x.lineTo(px, crest(px));
    x.lineTo(lw, h);
    x.fill();
    // Trees on the nearer ridges: they show how big (and far) the mountains are.
    if (i >= count - 2) {
      for (let px = 0; px < lw; px += (6 + rand() * 10) * s * depth) {
        const th = (8 + rand() * 10) * s * depth ** 2, tw = th * 0.45;
        const y = crest(px) + 2 * s;
        x.beginPath();
        x.moveTo(px - tw / 2, y);
        x.lineTo(px, y - th);
        x.lineTo(px + tw / 2, y);
        x.fill();
      }
    }
    // Mist lying in the valley in front of this ridge, drifting; nearer mist drifts faster.
    const bands = Array.from({ length: 3 }, () => ({
      x: rand() * w, y: base + h * (0.02 + rand() * 0.05), bw: (380 + rand() * 360) * s, bh: (40 + rand() * 40) * s,
      speed: (2 + depth * 7) * s * (0.7 + rand() * 0.6), alpha: 0.25 + rand() * 0.25,
    }));
    return { img: c, depth, bands };
  });
  const birds = Array.from({ length: 4 }, (_, i) => ({ dx: i * 26 * s + rand() * 14 * s, dy: (rand() - 0.5) * 24 * s, p: rand() * 6 }));

  return (ctx, t) => {
    ctx.drawImage(sky, 0, 0);
    const view = Math.sin((t * 6.28) / 70);
    ridges.forEach((r, i) => {
      const shift = (view - 1) * pan * r.depth - 2;
      ctx.drawImage(r.img, shift, 0);
      for (const b of r.bands) {
        const span = w + b.bw;
        ctx.globalAlpha = b.alpha;
        ctx.drawImage(mist, ((((b.x + b.speed * t) % span) + span) % span) - b.bw + shift, b.y - b.bh / 2, b.bw, b.bh);
      }
      ctx.globalAlpha = 1;
      // Birds, far off: in front of the farthest ridges only.
      if (i === 1) {
        const cycle = (t % 50) / 36; // across in 36 s, then a while without
        if (cycle > 1) return;
        ctx.strokeStyle = "rgba(60,64,70,0.55)";
        ctx.lineWidth = Math.max(1, 1.4 * s);
        for (const b of birds) {
          const x = -0.1 * w + cycle * 1.2 * w - b.dx, y = h * 0.24 + b.dy + Math.sin(t * 0.8 + b.p) * 4 * s;
          const span = 6 * s, lift = (0.3 + 0.35 * Math.sin(t * 5 + b.p)) * span;
          ctx.beginPath();
          ctx.moveTo(x - span, y - lift);
          ctx.lineTo(x, y);
          ctx.lineTo(x + span, y - lift);
          ctx.stroke();
        }
      }
    });
  };
}
