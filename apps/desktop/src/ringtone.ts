import { backend, isLive } from "./backend";
import { currentSettings } from "./settings";

// ms_trix's own ringtones, played with Web Audio (no sound files): short melodies on a soft
// marimba or bell, repeated while a call rings. Or your own sound file (Settings → Notifications).

export const RINGTONES = ["chime", "tide", "lantern", "sparkle", "phone", "retro", "classic"] as const;
export type Ringtone = (typeof RINGTONES)[number] | "custom";

type Voice = "marimba" | "bell" | "beep" | "phone" | "square";
interface Tune {
  voice: Voice;
  /** [start in seconds, note (semitones from A4), length in seconds] */
  notes: [number, number, number][];
  /** Seconds from one start of the melody to the next. */
  every: number;
}

// Notes as semitones from A4 (440 Hz): C5 = 3, D5 = 5, E5 = 7, G5 = 10, A5 = 12, C6 = 15 …

/** An old telephone's bell: the clapper hits two gongs in turn, 25 times a second. */
const trill = (from: number, length: number): [number, number, number][] =>
  Array.from({ length: Math.round(length / 0.04) }, (_, i) => [from + i * 0.04, i % 2 ? 19 : 20, 0.14]);
const TUNES: Record<(typeof RINGTONES)[number], Tune> = {
  // A short, friendly heads-up (the meeting reminder's own sound).
  chime: {
    voice: "bell",
    notes: [[0, 10, 1.2], [0.16, 15, 1.2], [0.32, 22, 1.8]],
    every: 2.4,
  },
  // A rising wave and a gentle landing (major pentatonic, lilting).
  tide: {
    voice: "marimba",
    notes: [[0, 7, 0.4], [0.18, 10, 0.4], [0.36, 15, 0.6], [0.72, 12, 0.4], [0.9, 10, 0.4], [1.08, 7, 0.7], [1.5, 5, 0.4], [1.68, 7, 0.4], [1.86, 10, 0.5], [2.22, 3, 1.1]],
    every: 3.6,
  },
  // A warm minor arpeggio that opens up at the end.
  lantern: {
    voice: "bell",
    notes: [[0, 0, 1], [0.24, 3, 1], [0.48, 7, 1], [0.72, 14, 1.2], [1.2, 12, 1], [1.44, 7, 1.4], [2.1, 2, 1], [2.34, 5, 1], [2.58, 10, 1.6]],
    every: 4,
  },
  // Quick bright sparkles, like a glockenspiel.
  sparkle: {
    voice: "bell",
    notes: [[0, 17, 0.5], [0.12, 21, 0.5], [0.24, 24, 0.5], [0.36, 29, 0.8], [0.72, 26, 0.5], [0.84, 24, 0.9], [1.4, 17, 0.5], [1.52, 21, 0.5], [1.64, 24, 0.5], [1.76, 31, 1.2]],
    every: 3.2,
  },
  // An old telephone: ring-ring … ring-ring.
  phone: {
    voice: "phone",
    notes: [...trill(0, 0.4), ...trill(0.6, 0.4)],
    every: 3,
  },
  // A 90s mobile phone: square-wave beeps, quick and cheerful (an original tune).
  retro: {
    voice: "square",
    notes: [[0, 12, 0.11], [0.12, 16, 0.11], [0.24, 19, 0.11], [0.36, 16, 0.11], [0.48, 14, 0.11], [0.6, 12, 0.11], [0.72, 14, 0.3],
      [1.08, 9, 0.11], [1.2, 12, 0.11], [1.32, 17, 0.11], [1.44, 12, 0.11], [1.56, 11, 0.11], [1.68, 7, 0.11], [1.8, 12, 0.4]],
    every: 2.8,
  },
  // The plain beeps ms_trix had before.
  classic: {
    voice: "beep",
    notes: [[0, 10, 0.22], [0.25, 14, 0.22], [0.5, 10, 0.22], [0.75, 14, 0.22]],
    every: 2,
  },
};

const freq = (semitones: number) => 440 * 2 ** (semitones / 12);

// One audio context for all ringtones, kept running while any of them plays: WebKit can pause
// a context on its own (e.g. when a dropdown menu closes), which cut a tune off after a note.
let shared: AudioContext | null = null;
let playing = 0;
function audio(): AudioContext {
  if (!shared || shared.state === "closed") {
    const ctx = new AudioContext();
    ctx.onstatechange = () => { if (ctx.state !== "running" && ctx.state !== "closed" && playing > 0) void ctx.resume().catch(() => {}); };
    shared = ctx;
  }
  if (shared.state !== "running") void shared.resume().catch(() => {});
  return shared;
}

function note(ctx: AudioContext, out: AudioNode, voice: Voice, semitones: number, at: number, length: number) {
  const f = freq(semitones);
  // Square: a 90s phone's beeper, held for the note and cut off (not a fading strike).
  if (voice === "square") {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.value = f;
    gain.gain.setValueAtTime(0.18, at);
    gain.gain.setValueAtTime(0.18, at + length - 0.015);
    gain.gain.linearRampToValueAtTime(0.0001, at + length);
    osc.connect(gain).connect(out);
    osc.start(at);
    osc.stop(at + length + 0.02);
    return;
  }
  // Marimba: the tone plus a quiet fourth harmonic that dies away fast. Bell: an inharmonic
  // overtone (2.76×) and a longer ring. Phone: a small metal gong, struck hard. Beep: a sine.
  const partials: [number, number, number][] =
    voice === "marimba" ? [[1, 1, length], [4, 0.12, length * 0.25]]
      : voice === "bell" ? [[1, 1, length], [2.76, 0.25, length * 0.5], [5.4, 0.08, length * 0.2]]
        : voice === "phone" ? [[1, 0.5, length], [2.4, 0.3, length * 0.6], [3.9, 0.15, length * 0.4]]
          : [[1, 1, length]];
  for (const [ratio, level, decay] of partials) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = f * ratio;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(level, at + 0.008);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + decay);
    osc.connect(gain).connect(out);
    osc.start(at);
    osc.stop(at + decay + 0.05);
  }
}

/**
 * Plays the chosen ringtone `times` times (Infinity: until stopped); returns stop. A custom
 * sound file plays whole each time.
 */
export function playRingtone(times = Infinity, which: Ringtone = currentSettings().ringtone): () => void {
  const ctx = audio();
  const out = ctx.createGain();
  out.gain.value = which === "classic" ? 0.18 : 0.22;
  out.connect(ctx.destination);
  playing++;
  let stopped = false;
  let timer = 0;
  // Notes still scheduled go nowhere once their output is disconnected.
  const stop = () => {
    if (stopped) return;
    stopped = true;
    playing--;
    window.clearTimeout(timer);
    out.disconnect();
  };

  const melody = (tune: Tune) => {
    let played = 0;
    const once = () => {
      if (stopped) return;
      // Done: let the last notes ring out, then free the audio.
      if (played++ >= times) return void (timer = window.setTimeout(stop, 2000));
      const start = ctx.currentTime + 0.05;
      for (const [at, semitones, length] of tune.notes) note(ctx, out, tune.voice, semitones, start + at, length);
      timer = window.setTimeout(once, tune.every * 1000);
    };
    once();
  };
  if (which === "custom") {
    void (isLive ? backend.ringtone() : Promise.reject(new Error("no file")))
      .then((data) => ctx.decodeAudioData(data))
      .then((buffer) => {
        let played = 0;
        const once = () => {
          if (stopped) return;
          if (played++ >= times) return stop();
          const src = ctx.createBufferSource();
          src.buffer = buffer;
          src.connect(out);
          src.onended = () => { timer = window.setTimeout(once, 600); };
          src.start();
        };
        out.gain.value = 0.8;
        once();
      })
      // No (readable) file: the default tune instead of silence.
      .catch(() => { if (!stopped) melody(TUNES.tide); });
    return stop;
  }

  melody(TUNES[which] ?? TUNES.tide);
  return stop;
}
