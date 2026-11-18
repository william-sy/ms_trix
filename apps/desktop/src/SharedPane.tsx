import { useEffect, useState } from "react";
import { backend, formatTime, isLive, mediaUrl, type SharedItem } from "./backend";
import type { MediaActions } from "./Media";
import { t } from "./i18n";

type Kind = "media" | "files" | "links";
const kinds: Kind[] = ["media", "files", "links"];

interface Props {
  account: string;
  conversation: string;
  media: MediaActions;
  /** Show this message in the chat. */
  onJump: (message: string) => void;
}

/** The chat's Shared tab: pictures and videos, files and links, from the local index. */
export function SharedPane({ account, conversation, media, onJump }: Props) {
  const [kind, setKind] = useState<Kind>("media");
  // Kept with the kind they were loaded for: right after switching, the old list
  // must not be drawn as the new kind (links have no media).
  const [loaded, setLoaded] = useState<{ conversation: string; kind: Kind; items: SharedItem[] } | null>(null);
  const items = loaded?.kind === kind && loaded.conversation === conversation ? loaded.items : null;
  const [more, setMore] = useState(false);
  // Pictures that couldn't be fetched (deleted, expired, no key) are left out;
  // the others appear once they've loaded, so there's never a broken-image icon.
  const [failed, setFailed] = useState<Set<string>>(new Set());
  const [ready, setReady] = useState<Set<string>>(new Set());
  const mark = (set: typeof setReady, id: string) => set((s) => new Set(s).add(id));
  const [error, setError] = useState<string | null>(null);

  const load = (before?: number) => {
    if (!isLive) return setError(t("desktopOnly.shared"));
    const forKind = kind;
    backend.shared(conversation, forKind, before ?? null).then((page) => {
      setLoaded((prev) => ({ conversation, kind: forKind, items: before && prev?.kind === forKind && prev.conversation === conversation ? [...prev.items, ...page] : page }));
      setMore(page.length >= 60);
      setError(null);
    }).catch((e) => setError(String(e)));
  };
  useEffect(() => {
    setLoaded(null);
    load();
  }, [conversation, kind]); // eslint-disable-line react-hooks/exhaustive-deps

  const asMedia = (i: SharedItem) => ({ id: i.media!.id, kind: i.media!.kind as "image", name: i.media!.name, mime: i.media!.mime, caption: null });
  const who = (i: SharedItem) => (i.fromMe ? t("search.you") : i.senderName);
  const open = (i: SharedItem) => backend.openMedia(account, i.media!.id, i.media!.name).catch((e) => setError(String(e)));

  return (
    <div className="shared-pane">
      <div className="filters">
        {kinds.map((k) => <button key={k} className={`pill ${kind === k ? "on" : ""}`} onClick={() => setKind(k)}>{t(`shared.${k}`)}</button>)}
      </div>
      <div className="shared-scroll">
        {error && <p className="error">{error}</p>}
        {!items && !error && <p className="empty">{t("common.loading")}</p>}
        {items && (items.length === 0 || (kind === "media" && items.every((i) => !i.media || failed.has(i.message)))) && <p className="empty">{t(`shared.none.${kind}`)}</p>}
        {kind === "media" && items && (
          <div className="shared-grid">
            {items.filter((i) => i.media && !failed.has(i.message)).map((i) => (
              <button key={i.message} className={`shared-thumb ${i.media!.kind === "video" || ready.has(i.message) ? "" : "pending"}`} title={`${i.media!.name}\n${who(i)} · ${formatTime(i.at)}`}
                onClick={() => (i.media!.kind === "video" ? open(i) : media.view(asMedia(i)))} onContextMenu={(e) => { e.preventDefault(); media.menu(asMedia(i), e.clientX, e.clientY); }}>
                {/* Servers can't thumbnail (encrypted) videos, so they get a tile. */}
                {i.media!.kind === "video" ? <span className="video-tile">▶<small>{i.media!.name}</small></span>
                  : <img src={mediaUrl(account, i.media!.id, 256, i.media!.mime)} alt={i.media!.name} loading="lazy"
                      onLoad={() => mark(setReady, i.message)} onError={() => mark(setFailed, i.message)} />}
              </button>
            ))}
          </div>
        )}
        {kind === "files" && items?.filter((i) => i.media).map((i) => (
          <div key={i.message} className="shared-row" onContextMenu={(e) => { e.preventDefault(); media.menu(asMedia(i), e.clientX, e.clientY); }}>
            <span className="file-icon">{i.media!.kind === "audio" ? "🎵" : "📄"}</span>
            <span className="shared-text">
              <button className="link" title={t("media.openDefault")} onClick={() => open(i)}>{i.media!.name}</button>
              <small>{who(i)} · {formatTime(i.at)}</small>
            </span>
            <button className="btn small" onClick={() => onJump(i.message)}>{t("shared.show")}</button>
          </div>
        ))}
        {kind === "links" && items?.flatMap((i) => i.links.map((url) => (
          <div key={`${i.message}-${url}`} className="shared-row">
            <span className="file-icon">🔗</span>
            <span className="shared-text">
              <button className="link" onClick={() => backend.openUrl(url).catch(() => {})}>{url}</button>
              <small>{who(i)} · {formatTime(i.at)}</small>
            </span>
            <button className="btn small" onClick={() => onJump(i.message)}>{t("shared.show")}</button>
          </div>
        )))}
        {more && items && <button className="btn small load-more" onClick={() => load(items[items.length - 1]!.at)}>{t("shared.more")}</button>}
        <p className="hint">{t("shared.hint")}</p>
      </div>
    </div>
  );
}
