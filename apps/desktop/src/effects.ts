// Chat effects, compatible with Element: sent with Element's message types,
// shown when a new message carries one of the effect's emoji.

export type EffectName = "confetti" | "fireworks" | "rainfall" | "snowfall" | "spaceinvaders" | "hearts";

export const effects: Record<EffectName, { msgtype: string; body: string; emoji: string[] }> = {
  confetti: { msgtype: "nic.custom.confetti", body: "sends confetti 🎉", emoji: ["🎉", "🎊"] },
  fireworks: { msgtype: "nic.custom.fireworks", body: "sends fireworks 🎆", emoji: ["🎆"] },
  rainfall: { msgtype: "io.element.effect.rainfall", body: "sends rainfall 🌧️", emoji: ["🌧"] },
  snowfall: { msgtype: "io.element.effect.snowfall", body: "sends snowfall ❄", emoji: ["❄", "☃", "⛄", "🌨"] },
  spaceinvaders: { msgtype: "io.element.effects.space_invaders", body: "sends space invaders 👾", emoji: ["👾"] },
  hearts: { msgtype: "io.element.effect.hearts", body: "sends love 💝", emoji: ["💝", "💖", "💞", "💘"] },
};

export function effectFor(body: string): EffectName | null {
  for (const [name, e] of Object.entries(effects) as [EffectName, (typeof effects)[EffectName]][]) {
    if (e.emoji.some((x) => body.includes(x))) return name;
  }
  return null;
}
