import { useEffect, useRef, useState, type CSSProperties } from "react";
import { searchEmoji } from "./emojiSearch";
import { mediaUrl, type ImagePack, type PackImage } from "./backend";
import { t, type Key } from "./i18n";

// Curated per category for browsing; the search box covers every emoji by name (emojiSearch.ts).
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

export function EmojiPicker({ onPick, onClose, style, packs, account, onPickCustom }: {
  onPick: (emoji: string) => void; onClose: () => void; style?: CSSProperties;
  /** Custom emoji (MSC2545 packs), shown under ★. */
  packs?: ImagePack[]; account?: string; onPickCustom?: (image: PackImage) => void;
}) {
  const custom = (packs ?? []).flatMap((p) => p.images.filter((i) => i.emoticon));
  const ref = useRef<HTMLDivElement>(null);
  const [recent, setRecent] = useState(loadRecent);
  const [tab, setTab] = useState(recent.length ? -1 : 0);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<string[] | null>(null);
  useEffect(() => {
    if (!query.trim()) return setHits(null);
    let live = true;
    searchEmoji(query).then((h) => live && setHits(h)).catch(() => live && setHits([]));
    return () => { live = false; };
  }, [query]);

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

  const list = hits ?? (tab === -1 ? recent : tab === -2 ? [] : categories[tab]!.emojis.split(" "));
  const customHits = hits !== null ? custom.filter((i) => i.shortcode.toLowerCase().includes(query.trim().toLowerCase())) : tab === -2 ? custom : [];
  return (
    <div className="menu emoji-picker" ref={ref} role="dialog" aria-label={t("composer.emoji")} style={style}>
      <input className="emoji-search" autoFocus value={query} placeholder={t("emoji.search")} onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter" && hits?.[0]) { e.preventDefault(); pick(hits[0]); } }} />
      {hits === null && <div className="emoji-tabs">
        {recent.length > 0 && <button className={`emoji-tab ${tab === -1 ? "on" : ""}`} title={t("emoji.recent")} onClick={() => setTab(-1)}>🕘</button>}
        {custom.length > 0 && onPickCustom && <button className={`emoji-tab ${tab === -2 ? "on" : ""}`} title={t("emoji.custom")} onClick={() => setTab(-2)}>★</button>}
        {categories.map((c, i) => (
          <button key={c.name} className={`emoji-tab ${tab === i ? "on" : ""}`} title={t(c.name)} onClick={() => setTab(i)}>{c.icon}</button>
        ))}
      </div>}
      <div className="emoji-grid">
        {list.map((e) => <button key={e} className="emoji" onClick={() => pick(e)}>{e}</button>)}
        {onPickCustom && account && customHits.map((img) => (
          <button key={img.shortcode + img.url} className="emoji custom" title={`:${img.shortcode}:`} onClick={() => onPickCustom(img)}>
            <img src={mediaUrl(account, img.url, 64)} alt={`:${img.shortcode}:`} />
          </button>
        ))}
        {hits?.length === 0 && customHits.length === 0 && <p className="empty">{t("emoji.noMatch")}</p>}
      </div>
    </div>
  );
}
