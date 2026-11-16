// Auto-replacement while typing: classic emoticons (":P") and shortcodes (":thumbsup:").

const emoticons: Record<string, string> = {
  ":)": "🙂", ":-)": "🙂", ":(": "🙁", ":-(": "🙁", ":D": "😃", ":-D": "😃", "xD": "😆", "XD": "😆",
  ";)": "😉", ";-)": "😉", ":P": "😛", ":-P": "😛", ":p": "😛", ";P": "😜", ":O": "😮", ":o": "😮",
  ":'(": "😢", ":|": "😐", ":/": "😕", ":*": "😘", "B)": "😎", "<3": "❤️", "</3": "💔", ":S": "😖",
  "O:)": "😇", ">:(": "😠", "^^": "😊", "o/": "👋",
};

const shortcodes: Record<string, string> = {
  smile: "😄", grin: "😁", joy: "😂", rofl: "🤣", wink: "😉", blush: "😊", heart_eyes: "😍", kiss: "😘",
  thinking: "🤔", neutral: "😐", unamused: "😒", roll_eyes: "🙄", grimacing: "😬", relieved: "😌", sleeping: "😴",
  sweat_smile: "😅", cry: "😢", sob: "😭", scream: "😱", angry: "😠", rage: "😡", party: "🥳", sunglasses: "😎",
  nerd: "🤓", mind_blown: "🤯", skull: "💀", poop: "💩", clown: "🤡", ghost: "👻", robot: "🤖", wave: "👋",
  ok_hand: "👌", v: "✌️", crossed_fingers: "🤞", point_up: "☝️", thumbsup: "👍", "+1": "👍", thumbsdown: "👎",
  "-1": "👎", clap: "👏", raised_hands: "🙌", pray: "🙏", muscle: "💪", eyes: "👀", heart: "❤️", broken_heart: "💔",
  fire: "🔥", sparkles: "✨", star: "⭐", zap: "⚡", tada: "🎉", confetti: "🎊", gift: "🎁", trophy: "🏆", "100": "💯",
  check: "✅", white_check_mark: "✅", x: "❌", warning: "⚠️", question: "❓", exclamation: "❗", rocket: "🚀",
  bulb: "💡", coffee: "☕", beer: "🍺", beers: "🍻", pizza: "🍕", cake: "🍰", sun: "☀️", rainbow: "🌈", snowflake: "❄️",
  computer: "💻", phone: "📱", calendar: "📅", pushpin: "📌", lock: "🔒", key: "🔑", bell: "🔔", memo: "📝", bug: "🐛",
  shrug: "🤷", facepalm: "🤦", see_no_evil: "🙈", hug: "🤗", sweat: "😓", upside_down: "🙃", money: "🤑",
};

/**
 * Called after each change. If the user just typed a space/newline after an
 * emoticon, or closed a :shortcode:, returns the replaced text and new cursor.
 */
export function autoReplace(text: string, cursor: number): { text: string; cursor: number } | null {
  const before = text.slice(0, cursor);

  const code = before.match(/(^|\s):([a-z0-9_+-]+):$/i);
  if (code) {
    const emoji = shortcodes[code[2]!.toLowerCase()];
    if (emoji) {
      const start = cursor - code[2]!.length - 2;
      return { text: text.slice(0, start) + emoji + text.slice(cursor), cursor: start + emoji.length };
    }
  }

  const typed = before.match(/(^|\s)(\S+)(\s)$/);
  if (typed) {
    const emoji = emoticons[typed[2]!];
    // Leave code alone: inside backticks an emoticon is probably syntax.
    if (emoji && (before.match(/`/g)?.length ?? 0) % 2 === 0) {
      const start = cursor - typed[2]!.length - 1;
      return { text: text.slice(0, start) + emoji + typed[3] + text.slice(cursor), cursor: start + emoji.length + 1 };
    }
  }
  return null;
}
