import DOMPurify from "dompurify";
import { useMemo, type MouseEvent, type ReactNode } from "react";
import { backend, isLive, mediaUrl } from "./backend";
import { useOpenProfile } from "./Profile";

// Tags and attributes the Matrix spec allows in formatted messages.
const ALLOWED_TAGS = [
  "font", "del", "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "p", "a", "ul", "ol", "sup", "sub", "li", "b", "i", "u",
  "strong", "em", "s", "strike", "code", "hr", "br", "div", "table", "thead", "tbody", "tr", "th", "td", "caption", "pre",
  "span", "img", "details", "summary",
];
const ALLOWED_ATTR = ["href", "src", "alt", "title", "width", "height", "start", "colspan", "rowspan", "class", "data-mx-color", "data-mx-bg-color", "data-mx-spoiler", "color"];

const MENTION = /^https:\/\/matrix\.to\/#\/[@!#]/;

function sanitize(html: string, account: string): string {
  const clean = DOMPurify.sanitize(html, { ALLOWED_TAGS, ALLOWED_ATTR, ALLOW_DATA_ATTR: false });
  const doc = new DOMParser().parseFromString(`<div>${clean}</div>`, "text/html");
  const root = doc.body.firstElementChild!;
  for (const a of root.querySelectorAll("a")) {
    const href = a.getAttribute("href") ?? "";
    if (MENTION.test(href)) a.classList.add("mention");
    a.removeAttribute("target");
  }
  // Inline images are only allowed from the homeserver (mxc://), never the open web.
  for (const img of root.querySelectorAll("img")) {
    const src = img.getAttribute("src") ?? "";
    const url = src.startsWith("mxc://") ? mediaUrl(account, src) : undefined;
    if (url) img.setAttribute("src", url);
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

const URL_RE = /\b(https?:\/\/[^\s<]+[^\s<.,:;"')\]!?])/g;

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
  const parts = text.split(URL_RE);
  return (
    <>
      {parts.map((part, i) =>
        i % 2 === 1 ? <a key={i} href={part}>{highlight(part, query, `l${i}`)}</a> : <span key={i}>{highlight(part, query, `t${i}`)}</span>,
      )}
    </>
  );
}


export function RichText({ body, html, account, query }: { body: string; html?: string; account: string; query?: string }) {
  const safe = useMemo(() => (html ? sanitize(html, account) : null), [html, account]);
  const openProfile = useOpenProfile();
  const onLinkClick = (e: MouseEvent) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    const href = a.getAttribute("href") ?? "";
    // User mentions open the profile card; room links will open rooms later.
    const user = /^https:\/\/matrix\.to\/#\/(@[^/?]+)/.exec(href)?.[1];
    if (user) return openProfile(account, decodeURIComponent(user), { x: e.clientX, y: e.clientY + 12 });
    if (MENTION.test(href) || !isLive) return;
    backend.openUrl(href).catch(() => {});
  };
  // Search highlights only work on plain text; formatted messages still match, they just aren't marked.
  if (safe && !query) return <div className="rich" onClick={onLinkClick} dangerouslySetInnerHTML={{ __html: safe }} />;
  return <span className="plain" onClick={onLinkClick}><PlainText text={body} query={query} /></span>;
}
