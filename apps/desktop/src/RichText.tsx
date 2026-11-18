import DOMPurify from "dompurify";
import { useMemo, type MouseEvent, type ReactNode } from "react";
import { backend, isLive, mediaUrl } from "./backend";
import { useOpenProfile } from "./Profile";
import { parseRoomLink, useOpenRoomLink } from "./roomLinks";
import { t } from "./i18n";

/** Adds someone's custom emoji to your own pack (same image, a free name). */
async function addToMyEmoji(account: string, name: string, url: string) {
  const pack = await backend.ownPack(account);
  if (pack.images.some((i) => i.url === url)) return;
  const taken = new Set(pack.images.map((i) => i.shortcode));
  let code = name.replace(/[^a-zA-Z0-9_+-]/g, "_").slice(0, 32) || "emoji";
  for (let n = 2; taken.has(code); n++) code = `${name.slice(0, 29)}_${n}`;
  await backend.saveOwnPack(account, { ...pack, images: [...pack.images, { shortcode: code, url, body: null, emoticon: true, sticker: false }] });
}

// Tags and attributes the Matrix spec allows in formatted messages.
const ALLOWED_TAGS = [
  "font", "del", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "p", "a", "ul", "ol", "sup", "sub", "li", "b", "i", "u",
  "strong", "em", "s", "strike", "code", "hr", "br", "div", "table", "thead", "tbody", "tr", "th", "td", "caption", "pre",
  "span", "img", "details", "summary",
];
const ALLOWED_ATTR = ["href", "src", "alt", "title", "width", "height", "start", "colspan", "rowspan", "class", "data-mx-color", "data-mx-bg-color", "data-mx-spoiler", "data-mx-emoticon", "color"];

const SAFE_URI = /^(?:(?:https?|mailto|mxc|matrix):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i;

const MENTION = /^https:\/\/matrix\.to\/#\/[@!#]/;

function sanitize(html: string, account: string): string {
  // DOMPurify drops URL schemes it doesn't know; Matrix images use mxc:// (turned into
  // our own media URLs below), so allow that next to the usual web/mail links.
  const clean = DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false, ALLOWED_URI_REGEXP: SAFE_URI });
  const doc = new DOMParser().parseFromString(`<div>${clean}</div>`, "text/html");
  const root = doc.body.firstElementChild!;
  for (const a of root.querySelectorAll("a")) {
    const href = a.getAttribute("href") ?? "";
    if (MENTION.test(href)) a.classList.add("mention");
    a.removeAttribute("target");
  }
  // Spoilers stay blurred until clicked; the attribute's value is the optional reason.
  for (const el of root.querySelectorAll("[data-mx-spoiler]")) {
    el.classList.add("spoiler");
    const reason = el.getAttribute("data-mx-spoiler");
    if (reason) el.setAttribute("title", reason);
  }
  // Inline images are only allowed from the homeserver (mxc://), never the open web.
  for (const img of root.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    const url = src.startsWith("mxc://") ? mediaUrl(account, src) : undefined;
    if (url) img.setAttribute("src", url);
    if (url && img.hasAttribute("data-mx-emoticon")) img.setAttribute("data-mxc", src); // for "add to my emoji"
    else img.remove();
  }
  for (const el of root.querySelectorAll("[data-mx-color], [data-mx-bg-color], font[color]")) {
    const color = el.getAttribute("data-mx-color") ?? el.getAttribute("color");
    const bg = el.getAttribute("data-mx-bg-color");
    if (color && /^#[0-9a-f]{3,8}$/i.test(color)) (el as HTMLElement).style.color = color;
    if (bg && /^#[0-9a-f]{3,8}$/i.test(bg)) (el as HTMLElement).style.backgroundColor = bg;
  }
  return root.innerHTML;
}

// Web links, plus bare room addresses like #room:server.org (turned into matrix.to links).
const URL_RE = /\b(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])|(?<![\w#])(#[\w.=-]+:[\w-]+(?:\.[\w-]+)+)/g;

function highlight(text: string, query: string | undefined, key: string): ReactNode[] {
  if (!query) return [text];
  const out: ReactNode[] = [];
  const lower = text.toLowerCase();
  const q = query.toLowerCase();
  let at = 0;
  for (let i = lower.indexOf(q); i !== -1; i = lower.indexOf(q, at)) {
    if (i > at) out.push(text.slice(at, i));
    out.push(<mark key={`${key}-${i}`}>{text.slice(i, i + q.length)}</mark>);
    at = i + q.length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}

/** Plain text with clickable links and optional search highlighting. */
function PlainText({ text, query }: { text: string; query?: string }) {
  // split() puts the two capture groups after each text part: [text, url, room, text, …].
  const parts = text.split(URL_RE);
  const out: ReactNode[] = [];
  for (let i = 0; i < parts.length; i += 3) {
    if (parts[i]) out.push(<span key={i}>{highlight(parts[i]!, query, `t${i}`)}</span>);
    const url = parts[i + 1];
    const room = parts[i + 2];
    if (url) out.push(<a key={`l${i}`} href={url}>{highlight(url, query, `l${i}`)}</a>);
    if (room) out.push(<a key={`r${i}`} className="mention" href={`https://matrix.to/#/${encodeURIComponent(room)}`}>{highlight(room, query, `r${i}`)}</a>);
  }
  return <>{out}</>;
}


export function RichText({ body, html, account, query }: { body: string; html?: string; account: string; query?: string }) {
  const safe = useMemo(() => (html ? sanitize(html, account) : null), [html, account]);
  const openProfile = useOpenProfile();
  const openRoomLink = useOpenRoomLink();
  const onLinkClick = (e: MouseEvent) => {
    // Someone's custom emoji: offer to add it to your own pack.
    const emote = (e.target as HTMLElement).closest("img[data-mx-emoticon]") as HTMLImageElement | null;
    if (emote && isLive) {
      e.preventDefault();
      const url = emote.dataset.mxc;
      const name = (emote.getAttribute("alt") ?? "").replace(/^:|:$/g, "") || "emoji";
      if (url && confirm(t("emoji.addToMine", { name }))) void addToMyEmoji(account, name, url).catch((err) => alert(String(err)));
      return;
    }
    const spoiler = (e.target as HTMLElement).closest(".spoiler:not(.revealed)");
    if (spoiler) {
      e.preventDefault();
      return spoiler.classList.add("revealed");
    }
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    // User mentions open the profile card; room links open (or offer to join) the room.
    const user = /^https:\/\/matrix\.to\/#\/(@[^/?]+)/.exec(href)?.[1];
    if (user) return openProfile(account, decodeURIComponent(user), { x: e.clientX, y: e.clientY + 12 });
    const room = parseRoomLink(href);
    if (room) return openRoomLink(account, room);
    if (MENTION.test(href) || !isLive) return;
    backend.openUrl(href).catch(() => {});
  };
  // Search highlights only work on plain text; formatted messages still match, they just aren't marked.
  if (safe && !query) return <div className="rich" onClick={onLinkClick} dangerouslySetInnerHTML={{ __html: safe }} />;
  return <span className="plain" onClick={onLinkClick}><PlainText text={body} query={query} /></span>;
}
