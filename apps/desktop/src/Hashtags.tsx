import { createContext, useContext, useEffect, useState } from "react";
import { backend, formatTime, type SearchHit } from "./backend";
import { t } from "./i18n";
import { Highlight } from "./TitleBar";

/** Opens the list of messages with a #hashtag (the tag lowercased, without the #). */
export const HashtagContext = createContext<(tag: string) => void>(() => {});
export const useOpenHashtag = () => useContext(HashtagContext);

/** Every message with #tag, in the open chat or in all chats (search index plus loaded messages). */
export function HashtagPanel({ tag, conversation, conversationName, onOpen, onClose }: {
  tag: string;
  conversation?: string;
  conversationName?: string;
  onOpen: (conversation: string, message: string) => void;
  onClose: () => void;
}) {
  const [scope, setScope] = useState<"chat" | "all">(conversation ? "chat" : "all");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  useEffect(() => {
    setHits(null);
    backend.searchMessages(`#${tag}`, scope === "chat" ? conversation ?? null : null).then(setHits).catch(() => setHits([]));
  }, [tag, scope, conversation]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="login-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="login-card context-dialog hashtag-dialog">
        <button className="icon-btn close" onClick={onClose} title={t("common.closeEsc")}>✕</button>
        <h1>#{tag}</h1>
        {conversation && (
          <div className="segmented" role="radiogroup">
            <button role="radio" aria-checked={scope === "chat"} className={scope === "chat" ? "on" : ""} onClick={() => setScope("chat")}>{t("hashtag.inChat", { name: conversationName ?? "" })}</button>
            <button role="radio" aria-checked={scope === "all"} className={scope === "all" ? "on" : ""} onClick={() => setScope("all")}>{t("hashtag.allChats")}</button>
          </div>
        )}
        <div className="context-list">
          {!hits && <p className="muted">{t("common.loading")}</p>}
          {hits?.length === 0 && <p className="muted">{t("hashtag.none")}</p>}
          {hits?.map((h) => (
            <button key={`${h.conversation}/${h.message}`} className="search-hit" onClick={() => { onClose(); onOpen(h.conversation, h.message); }}>
              <span className="hit-top"><b>{h.conversationName}</b><span className="row-time">{formatTime(h.at)}</span></span>
              <span className="hit-text">{h.senderName || t("search.you")}: <Highlight text={h.snippet} query={`#${tag}`} /></span>
            </button>
          ))}
        </div>
        <p className="hint small">{t("hashtag.hint")}</p>
      </div>
    </div>
  );
}
