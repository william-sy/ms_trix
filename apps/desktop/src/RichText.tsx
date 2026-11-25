import DOMPurify from "dompurify";
import { useMemo, type MouseEvent, type ReactNode } from "react";
import { backend, isLive, mediaUrl } from "./backend";
import { useOpenHashtag } from "./Hashtags";
import { findDates, fromToday, isoDay, longDate, type FoundDate } from "./dates";
import { useOpenDate } from "./DateRef";
import { FENCE, highlightCode, highlightIn, useHighlightVersion } from "./highlight";
import { checkLink } from "./linkCheck";
import { mainWarning, useOpenLink, useOwnDomains, warningText } from "./LinkPreview";
import { useOpenProfile } from "./Profile";
import { HASHTAG, markTerm } from "./searchQuery";
import { parseRoomLink, useOpenRoomLink } from "./roomLinks";
import { dateLocale, locale, t } from "./i18n";

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

function sanitize(html: string, account: string, own: string[], sent: Date): string {
  // DOMPurify drops URL schemes it doesn't know; Matrix images use mxc:// (turned into
  // our own media URLs below), so allow that next to the usual web/mail links.
  const clean = DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false, ALLOWED_URI_REGEXP: SAFE_URI });
  const doc = new DOMParser().parseFromString(`<div>${clean}</div>`, "text/html");
  const root = doc.body.firstElementChild!;
  // Web links, room addresses and #hashtags in the text become links, as in plain messages (not
  // inside links or code). Before the pass over links below, so new ones get checked too.
  const texts: Text[] = [];
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!n.parentElement?.closest("a, code, pre")) texts.push(n as Text);
  for (const node of texts) {
    const value = node.nodeValue ?? "";
    const found = [...value.matchAll(URL_RE)];
    if (!found.length) continue;
    const parts = doc.createDocumentFragment();
    let at = 0;
    for (const m of found) {
      parts.append(value.slice(at, m.index));
      const [whole, url, room, tag] = m;
      const a = doc.createElement("a");
      a.textContent = whole;
      if (url) a.setAttribute("href", url);
      else if (room) a.setAttribute("href", `https://matrix.to/#/${encodeURIComponent(room)}`);
      else {
        a.className = "hashtag";
        a.setAttribute("href", "#");
        a.dataset.tag = tag!.toLowerCase();
      }
      parts.append(a);
      at = m.index! + whole.length;
    }
    parts.append(value.slice(at));
    node.replaceWith(parts);
  }
  for (const a of root.querySelectorAll("a")) {
    const href = a.getAttribute("href") ?? "";
    if (MENTION.test(href)) a.classList.add("mention");
    a.removeAttribute("target");
    // Links that look like phishing are marked (and asked about before they open).
    const warning = /^https?:/i.test(href) ? mainWarning(checkLink(href, a.textContent ?? "", own)) : undefined;
    if (warning) {
      a.classList.add("link-warn");
      a.setAttribute("title", warningText(warning));
    }
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
  markDates(doc, root, sent);
  // Code blocks with a language get its colours.
  highlightIn(root);
  for (const el of root.querySelectorAll("[data-mx-color], [data-mx-bg-color], font[color]")) {
    const color = el.getAttribute("data-mx-color") ?? el.getAttribute("color");
    const bg = el.getAttribute("data-mx-bg-color");
    if (color && /^#[0-9a-f]{3,8}$/i.test(color)) (el as HTMLElement).style.color = color;
    if (bg && /^#[0-9a-f]{3,8}$/i.test(bg)) (el as HTMLElement).style.backgroundColor = bg;
  }
  return root.innerHTML;
}


/** On hover: "Thursday 9 December 2026 · 14:00 · in 19 days", and a weekday that doesn't fit. */
function dateTitle(f: FoundDate): string {
  const when = `${longDate(f.date, locale())}${f.time ? ` · ${f.time}` : ""} · ${fromToday(f.date, locale())}`;
  return f.wrongWeekday ? `${when}\n${t("dates.wrongWeekday", { weekday: f.date.toLocaleDateString(dateLocale(), { weekday: "long" }) })}` : when;
}
const dateClass = (f: FoundDate) => `date-ref${f.wrongWeekday ? " wrong-weekday" : ""}`;

/** Dates get a dotted underline: their weekday on hover, a small calendar on click. */
function markDates(doc: Document, root: Element, sent: Date) {
  const texts: Text[] = [];
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (!n.parentElement?.closest("a, code, pre")) texts.push(n as Text);
  for (const node of texts) {
    const value = node.nodeValue ?? "";
    const found = findDates(value, sent);
    if (!found.length) continue;
    const parts = doc.createDocumentFragment();
    let at = 0;
    for (const f of found) {
      parts.append(value.slice(at, f.index));
      const span = doc.createElement("span");
      span.className = dateClass(f);
      span.dataset.date = isoDay(f.date);
      if (f.time) span.dataset.time = f.time;
      span.title = dateTitle(f);
      span.textContent = value.slice(f.index, f.index + f.length);
      parts.append(span);
      at = f.index + f.length;
    }
    parts.append(value.slice(at));
    node.replaceWith(parts);
  }
}

/** Plain text with its dates marked (see markDates), and search highlighting. */
function dated(text: string, sent: Date, query: string | undefined, key: string): ReactNode[] {
  const found = findDates(text, sent);
  if (!found.length) return highlight(text, query, key);
  const out: ReactNode[] = [];
  let at = 0;
  for (const f of found) {
    if (f.index > at) out.push(...highlight(text.slice(at, f.index), query, `${key}-${at}`));
    out.push(
      <span key={`${key}-d${f.index}`} className={dateClass(f)} data-date={isoDay(f.date)} data-time={f.time} title={dateTitle(f)}>
        {highlight(text.slice(f.index, f.index + f.length), query, `${key}-d${f.index}`)}
      </span>,
    );
    at = f.index + f.length;
  }
  if (at < text.length) out.push(...highlight(text.slice(at), query, `${key}-${at}`));
  return out;
}

// Web links, bare room addresses like #room:server.org (turned into matrix.to links), hashtags.
const URL_RE = new RegExp(String.raw`\b(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])|(?<![\w#])(#[\w.=-]+:[\w-]+(?:\.[\w-]+)+)|` + HASHTAG, "gu");

function highlight(text: string, query: string | undefined, key: string): ReactNode[] {
  query = query && markTerm(query);
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

/** A code block from a plain-text message (```lang …```), coloured when the language is known. */
function CodeBlock({ code, language }: { code: string; language: string }) {
  const languages = useHighlightVersion();
  const html = useMemo(() => highlightCode(code, language), [code, language, languages]); // eslint-disable-line react-hooks/exhaustive-deps
  return <pre className="code-block">{html ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}</pre>;
}

/** Plain text with ```fenced``` code blocks, clickable links and optional search highlighting. */
function PlainText({ text, query, own, sent }: { text: string; query?: string; own: string[]; sent: Date }) {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(FENCE)) {
    if (m.index! > at) out.push(<Linked key={`t${at}`} text={text.slice(at, m.index)} query={query} own={own} sent={sent} />);
    out.push(<CodeBlock key={`c${m.index}`} code={m[2]!} language={m[1]!} />);
    at = m.index! + m[0].length;
  }
  if (!out.length) return <Linked text={text} query={query} own={own} sent={sent} />;
  if (at < text.length) out.push(<Linked key={`t${at}`} text={text.slice(at)} query={query} own={own} sent={sent} />);
  return <>{out}</>;
}

/** Text with clickable links, room addresses, hashtags and dates. */
function Linked({ text, query, own, sent }: { text: string; query?: string; own: string[]; sent: Date }) {
  // split() puts the capture groups after each text part: [text, url, room, tag, text, …].
  const parts = text.split(URL_RE);
  const out: ReactNode[] = [];
  for (let i = 0; i < parts.length; i += 4) {
    if (parts[i]) out.push(<span key={i}>{dated(parts[i]!, sent, query, `t${i}`)}</span>);
    const url = parts[i + 1];
    const room = parts[i + 2];
    const tag = parts[i + 3];
    const warning = url ? mainWarning(checkLink(url, url, own)) : undefined;
    if (url) out.push(<a key={`l${i}`} href={url} className={warning ? "link-warn" : undefined} title={warning && warningText(warning)}>{highlight(url, query, `l${i}`)}</a>);
    if (room) out.push(<a key={`r${i}`} className="mention" href={`https://matrix.to/#/${encodeURIComponent(room)}`}>{highlight(room, query, `r${i}`)}</a>);
    if (tag) out.push(<a key={`h${i}`} className="hashtag" href="#" data-tag={tag.toLowerCase()}>{highlight(`#${tag}`, query, `h${i}`)}</a>);
  }
  return <>{out}</>;
}


export function RichText({ body, html, account, query, sent }: {
  body: string; html?: string; account: string; query?: string;
  /** When the message was sent (ms): a date without a year is the first one from then. */
  sent?: number;
}) {
  const own = useOwnDomains();
  // Again when a language loads that a code block here was waiting for.
  const languages = useHighlightVersion();
  const sentAt = useMemo(() => new Date(sent ?? Date.now()), [sent]);
  const safe = useMemo(() => (html ? sanitize(html, account, own, sentAt) : null), [html, account, own, languages, sentAt]); // eslint-disable-line react-hooks/exhaustive-deps
  const openProfile = useOpenProfile();
  const openRoomLink = useOpenRoomLink();
  const openHashtag = useOpenHashtag();
  const openLink = useOpenLink();
  const openDate = useOpenDate();
  const onLinkClick = (e: MouseEvent) => {
    const day = (e.target as HTMLElement).closest<HTMLElement>(".date-ref");
    if (day?.dataset.date) {
      e.preventDefault();
      return openDate({ date: day.dataset.date, time: day.dataset.time, text: body.trim(), x: e.clientX, y: e.clientY });
    }
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
    if (a.classList.contains("hashtag")) return openHashtag(a.dataset.tag ?? "");
    const href = a.getAttribute("href") ?? "";
    // User mentions open the profile card; room links open (or offer to join) the room.
    const user = /^https:\/\/matrix\.to\/#\/(@[^/?]+)/.exec(href)?.[1];
    if (user) return openProfile(account, decodeURIComponent(user), { x: e.clientX, y: e.clientY + 12 });
    const room = parseRoomLink(href);
    if (room) return openRoomLink(account, room);
    if (MENTION.test(href) || !isLive) return;
    openLink(href, /^https?:/i.test(href) ? mainWarning(checkLink(href, a.textContent ?? "", own)) : undefined);
  };
  // Search highlights only work on plain text; formatted messages still match, they just aren't marked.
  if (safe && !query) return <div className="rich" onClick={onLinkClick} dangerouslySetInnerHTML={{ __html: safe }} />;
  return <span className="plain" onClick={onLinkClick}><PlainText text={body} query={query} own={own} sent={sentAt} /></span>;
}
