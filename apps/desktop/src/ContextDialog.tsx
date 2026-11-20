import { useEffect, useState } from "react";
import { Avatar } from "./Avatar";
import { backend } from "./backend";
import { t } from "./i18n";
import { RichText } from "./RichText";
import type { Message } from "./types";
import { useEscape } from "./hooks";

interface Props {
  conversation: string;
  message: string;
  title: string;
  onShowInChat: () => void;
  onClose: () => void;
}

/** A quick look at an old message and what was said around it (one server request). */
export function ContextDialog({ conversation, message, title, onShowInChat, onClose }: Props) {
  const [messages, setMessages] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const account = conversation.split("|")[0]!;

  useEffect(() => {
    backend.messageContext(conversation, message).then(setMessages).catch((e) => setError(String(e)));
  }, [conversation, message]);
  useEscape(onClose);
  useEffect(() => {
    if (messages) requestAnimationFrame(() => document.querySelector(".context-msg.target")?.scrollIntoView({ block: "center" }));
  }, [messages]);

  return (
    <div className="login-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="login-card context-dialog">
        <button className="icon-btn close" onClick={onClose} title={t("common.closeEsc")}>✕</button>
        <h1>{title}</h1>
        <div className="context-list">
          {!messages && !error && <p className="muted">{t("common.loading")}</p>}
          {error && <p className="error">{error}</p>}
          {messages?.filter((m) => !m.system).map((m) => (
            <div key={m.id} className={`context-msg ${m.id === message ? "target" : ""}`}>
              <Avatar account={account} media={m.avatar} name={m.sender} className="small" />
              <div className="context-body">
                <span className="context-meta"><b>{m.fromMe ? t("search.you") : m.sender}</b> <span className="muted">{m.time}</span></span>
                {m.media ? <span className="muted">📎 {m.media.name}</span> : <RichText body={m.body} html={m.html} account={account} />}
              </div>
            </div>
          ))}
        </div>
        <div className="edit-actions">
          <span className="hint">{t("context.hint")}</span>
          <button className="btn small" onClick={onClose}>{t("common.close")}</button>
          <button className="btn primary small" onClick={onShowInChat}>{t("context.showInChat")}</button>
        </div>
      </div>
    </div>
  );
}
