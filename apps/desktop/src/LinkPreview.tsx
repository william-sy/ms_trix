import { createContext, useContext, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { backend, isLive, type LinkPreviewData } from "./backend";
import { showInFiles } from "./filesNav";
import { t } from "./i18n";
import { checkLink, ownDomains, siteOf, type LinkWarning } from "./linkCheck";
import { currentSettings, onSettingsChanged } from "./settings";
import { useOrgs } from "./store";

/** Your accounts' domains, for the phishing check. */
export function useOwnDomains(): string[] {
  const orgs = useOrgs();
  const ids = orgs.map((o) => o.userId).join("|");
  return useMemo(() => ownDomains(ids.split("|")), [ids]);
}

const ORDER: LinkWarning["kind"][] = ["userinfo", "mismatch", "letters", "lookalike", "ip"];

/** The warning that matters most, if any. */
export const mainWarning = (warnings: LinkWarning[]) => [...warnings].sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind))[0];

export function warningText(w: LinkWarning): string {
  switch (w.kind) {
    case "mismatch": return t("link.warn.mismatch", { shown: w.shown, real: w.real });
    case "lookalike": return t("link.warn.lookalike", { real: w.real, like: w.like });
    case "letters": return w.like ? t("link.warn.lettersLike", { real: w.real, like: w.like }) : t("link.warn.letters", { real: w.real });
    case "userinfo": return t("link.warn.userinfo", { real: w.real });
    case "ip": return t("link.warn.ip", { real: w.real });
  }
}

/** Asks before opening a link that looks like phishing; true to go ahead. */
export const confirmLink = (warning: LinkWarning | undefined) => !warning || confirm(t("link.warn.confirm", { warning: warningText(warning) }));

/** Opens a conversation of ours here (the key a Talk link points to). */
export const InAppLinkContext = createContext<((key: string) => void) | null>(null);

/**
 * Opens a link: a Talk link to one of your own servers here in the app, a link to one of your
 * own Nextcloud files in Files, anything else in the browser (asking first when it looks like
 * phishing).
 */
export function useOpenLink() {
  const openInApp = useContext(InAppLinkContext);
  return (href: string, warning?: LinkWarning) => void (async () => {
    const key = openInApp && isLive ? await backend.linkTarget(href).catch(() => null) : null;
    if (key) return openInApp!(key);
    const place = isLive ? await backend.locateCloudLink(href).catch(() => null) : null;
    if (place) return showInFiles(place.account, place.path);
    if (confirmLink(warning)) void backend.openUrl(href).catch(() => {});
  })();
}

/** The first web link in a message that gets a preview (mentions and room links don't). */
export function previewLink(body: string, html?: string): string | undefined {
  const fromHtml = html ? [...html.matchAll(/href="(https?:\/\/[^"]+)"/g)].map((m) => m[1]!.replace(/&amp;/g, "&")) : [];
  const fromText = body.match(/https?:\/\/[^\s<>"]+[^\s<>".,:;')\]!?]/g) ?? [];
  return [...fromHtml, ...fromText].find((u) => !u.startsWith("https://matrix.to/"));
}

const hostOf = (url: string) => { try { return new URL(url).hostname; } catch { return ""; } };

const previews = new Map<string, Promise<LinkPreviewData | null>>();

/** A link's preview card under its message, fetched once it scrolls into view (if previews are on). */
export function LinkPreview({ url }: { url: string }) {
  const [on, setOn] = useState(currentSettings().linkPreviews);
  useEffect(() => onSettingsChanged((s) => setOn(s.linkPreviews)), []);
  const own = useOwnDomains();
  const ref = useRef<HTMLDivElement>(null);
  const [data, setData] = useState<LinkPreviewData | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!on || !el || !isLive) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((e) => e.isIntersecting)) return;
      observer.disconnect();
      let pending = previews.get(url);
      if (!pending) {
        pending = backend.linkPreview(url).catch(() => null);
        previews.set(url, pending);
      }
      void pending.then((preview) => {
        if (!preview) return;
        // At the newest message, stay there as the card appears below it.
        const list = el.closest(".messages");
        const atBottom = !!list && list.scrollHeight - list.scrollTop - list.clientHeight < 120;
        setData(preview);
        if (atBottom) requestAnimationFrame(() => (list!.scrollTop = list!.scrollHeight));
      });
    }, { rootMargin: "300px" });
    observer.observe(el);
    return () => observer.disconnect();
  }, [url, on]);
  if (!on) return null;
  return <div ref={ref} className="link-preview-slot">{data && <PreviewCard url={url} data={data} own={own} />}</div>;
}

function PreviewCard({ url, data, own }: { url: string; data: LinkPreviewData; own: string[] }) {
  const finalHost = hostOf(data.finalUrl);
  const elsewhere = !!finalHost && siteOf(finalHost) !== siteOf(hostOf(url));
  // Where it really leads is checked too (a short link can hide a phishing site).
  const warning = mainWarning([...checkLink(url, undefined, own), ...(elsewhere ? checkLink(data.finalUrl, undefined, own) : [])]);
  const openLink = useOpenLink();
  const open = (e: MouseEvent) => {
    e.preventDefault();
    openLink(url, warning);
  };
  return (
    <a className={`link-preview ${warning ? "warn" : ""}`} href={url} title={url} onClick={open}>
      {data.image && <img src={data.image} alt="" />}
      <span className="lp-text">
        {data.siteName && <span className="lp-site">{data.siteName}</span>}
        {data.title && <b className="lp-title">{data.title}</b>}
        {data.description && <span className="lp-desc">{data.description}</span>}
        {elsewhere && <span className="lp-leads">{t("link.leadsTo", { host: finalHost.replace(/^www\./, "") })}</span>}
        {warning && <span className="lp-warn">⚠ {warningText(warning)}</span>}
      </span>
    </a>
  );
}
