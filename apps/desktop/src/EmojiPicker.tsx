import { useEffect, useRef, useState, type CSSProperties } from "react";
import { t, type Key } from "./i18n";

// Curated per category; a searchable picker with names comes with a proper emoji dataset.
const categories: { icon: string; name: Key; emojis: string }[] = [
  { icon: "😀", name: "emoji.smileys", emojis: "😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶 😏 😒 🙄 😬 🤥 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🤧 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧 😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 💩 🤡 👻 👽 🤖" },
  { icon: "👍", name: "emoji.people", emojis: "👋 🤚 🖐️ ✋ 🖖 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ 👍 👎 ✊ 👊 🤛 🤜 👏 🙌 👐 🤲 🤝 🙏 ✍️ 💅 💪 🦾 🧠 👀 👁️ 👅 👄 👶 🧒 👦 👧 🧑 👨 👩 🧓 👴 👵 🙍 🙎 🙅 🙆 💁 🙋 🙇 🤦 🤷 🧑‍💻 👨‍💻 👩‍💻 🧑‍🏫 🧑‍🔬 🧑‍🚀 🦸 🦹 🧙 🧚 🧛 🧜 🧝 🚶 🏃 💃 🕺 👯 🧘 🛀 👫 👪" },
  { icon: "❤️", name: "emoji.symbols", emojis: "❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💯 💢 💥 💫 💦 💨 💬 💭 💤 ✅ ☑️ ✔️ ❌ ❎ ➕ ➖ ➗ ❓ ❔ ❕ ❗ ‼️ ⁉️ ⚠️ 🚫 ⛔ 🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟥 🟩 🟦 ⭐ 🌟 ✨ ⚡ 🔥 🎯 ♻️ 🔒 🔓 🔑 🔔 🔕 📌 📍 🏁 🚩 🆗 🆕 🆒 🆘 ℹ️ ▶️ ⏸️ ⏹️ ⏺️ ⏭️ ⏮️ 🔁 🔀" },
  { icon: "🎉", name: "emoji.activities", emojis: "🎉 🎊 🎈 🎁 🎀 🎂 🍰 🧁 🏆 🥇 🥈 🥉 🏅 🎖️ ⚽ 🏀 🏈 ⚾ 🎾 🏐 🏉 🎱 🏓 🏸 🥅 ⛳ 🏹 🎣 🥊 🥋 ⛸️ 🎿 🏂 🏋️ 🚴 🏊 🧗 🎮 🕹️ 🎲 ♟️ 🧩 🎯 🎳 🎭 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🎻 📸 🎟️" },
  { icon: "🍕", name: "emoji.food", emojis: "🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🫐 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🥑 🍆 🥔 🥕 🌽 🌶️ 🥒 🥦 🧄 🧅 🍄 🥜 🍞 🥐 🥖 🥨 🧀 🥚 🍳 🥞 🧇 🥓 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🌮 🌯 🥗 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🍦 🍩 🍪 🍫 🍬 🍭 ☕ 🍵 🧃 🥤 🍺 🍻 🥂 🍷 🍸 🍹 🧉 🍾" },
  { icon: "🌍", name: "emoji.nature", emojis: "🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🐔 🐧 🐦 🦆 🦉 🐺 🐴 🦄 🐝 🦋 🐌 🐞 🐢 🐍 🐙 🐬 🐳 🦈 🌵 🌲 🌳 🌴 🌱 🌿 🍀 🍁 🍂 🌷 🌹 🌻 🌼 🌸 🌍 🌙 ☀️ ⛅ 🌧️ ⛈️ ❄️ ☃️ 🌈 🌊 🚗 🚕 🚌 🚲 🛴 🚂 ✈️ 🚀 🛸 🚢 ⛵ 🏠 🏢 🏰 🗼 🗽 ⛺ 🏖️ 🏔️" },
  { icon: "💡", name: "emoji.objects", emojis: "⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💾 💿 📷 📹 🎥 📞 ☎️ 📺 📻 ⏰ ⏳ 🔋 🔌 💡 🔦 🕯️ 💸 💵 💰 💳 💎 🔧 🔨 🛠️ ⚙️ 🧰 🧲 🔬 🔭 📡 💉 💊 🧪 🧬 🧹 🧺 🧻 🚪 🪑 🛏️ 🛒 🎒 👓 🕶️ 👔 👕 👖 👗 👟 👑 🎩 📦 📫 ✉️ 📧 📝 📄 📃 📑 📊 📈 📉 📅 📆 🗂️ 📁 📂 📚 📖 🔖 🔗 📎 ✂️ 🖊️ ✏️ 🔍" },
];

const RECENT_KEY = "ms_trix.emoji.recent";
const loadRecent = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
};

export function EmojiPicker({ onPick, onClose, style }: { onPick: (emoji: string) => void; onClose: () => void; style?: CSSProperties }) {
  const ref = useRef<HTMLDivElement>(null);
  const [recent, setRecent] = useState(loadRecent);
  const [tab, setTab] = useState(recent.length ? -1 : 0);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.parentElement?.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  const pick = (e: string) => {
    const next = [e, ...recent.filter((r) => r !== e)].slice(0, 32);
    setRecent(next);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* private mode */
    }
    onPick(e);
  };

  const list = tab === -1 ? recent : categories[tab]!.emojis.split(" ");
  return (
    <div className="menu emoji-picker" ref={ref} role="dialog" aria-label={t("composer.emoji")} style={style}>
      <div className="emoji-tabs">
        {recent.length > 0 && <button className={`emoji-tab ${tab === -1 ? "on" : ""}`} title={t("emoji.recent")} onClick={() => setTab(-1)}>🕘</button>}
        {categories.map((c, i) => (
          <button key={c.name} className={`emoji-tab ${tab === i ? "on" : ""}`} title={t(c.name)} onClick={() => setTab(i)}>{c.icon}</button>
        ))}
      </div>
      <div className="emoji-grid">
        {list.map((e) => <button key={e} className="emoji" onClick={() => pick(e)}>{e}</button>)}
      </div>
    </div>
  );
}
