import { useEffect, useState } from "react";
import { backend } from "./backend";
import { useEscape } from "./hooks";
import { t } from "./i18n";
import { RichText } from "./RichText";
import type { Conversation, Message } from "./types";

// Pinned messages: for everyone in the conversation (Matrix room state, so Element and Element X
// show them too; Talk 23 and later).

/** One line for the banner and the list: the text, or what was shared. */
export const pinPreview = (m: Message) => (m.media ? `📎 ${m.media.caption || m.media.name}` : m.body.split("\n").find((l) => l.trim()) ?? "");

/** The chat's pinned messages, loaded again whenever they change; `reload` after pinning. */
export function usePinned(conv: Conversation): { pinned: Message[]; reload: () => void } {
  const [pinned, setPinned] = useState<Message[]>([]);
  const [round, setRound] = useState(0);
  useEffect(() => {
    if (!conv.pins) return setPinned([]);
    let live = true;
    backend.pinnedMessages(conv.id).then((list) => live && setPinned(list), () => live && setPinned([]));
    return () => { live = false; };
  }, [conv.id, conv.pins, round]);
  return { pinned, reload: () => setRound((r) => r + 1) };
}

/** Under the chat header: one pinned message; a click goes to it and shows the next one. */
export function PinnedBar({ pinned, onGoTo, onAll }: { pinned: Message[]; onGoTo: (m: Message) => void; onAll: () => void }) {
  const [index, setIndex] = useState(0);
  if (!pinned.length) return null;
  const at = index % pinned.length;
  const m = pinned[at]!;
  return (
    <div className="pinned-bar">
      <button className="pinned-current" title={t("pins.goTo")} onClick={() => { onGoTo(m); setIndex(at + 1); }}>
        <span className="pinned-icon">📌</span>
        <span className="pinned-text">
          <b>{pinned.length > 1 ? t("pins.numbered", { n: at + 1, count: pinned.length }) : t("pins.pinned")}</b>
          {" "}{m.sender}: {pinPreview(m)}
        </span>
      </button>
      <button className="link" onClick={onAll}>{t("pins.all")}</button>
    </div>
  );
}

/** Every pinned message: go to one, or unpin it. */
export function PinnedDialog({ pinned, account, canPin, onGoTo, onUnpin, onClose }: {
  pinned: Message[]; account: string; canPin: boolean;
  onGoTo: (m: Message) => void; onUnpin: (m: Message) => void; onClose: () => void;
}) {
  useEscape(onClose);
  return (
    <div className="login-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="login-card context-dialog pinned-dialog">
        <button className="icon-btn close" onClick={onClose} title={t("common.closeEsc")}>✕</button>
        <h1>{t("pins.title", { count: pinned.length })}</h1>
        <div className="context-list">
          {pinned.length === 0 && <p className="muted">{t("pins.none")}</p>}
          {pinned.map((m) => (
            <div key={m.id} className="pinned-item">
              <div className="hit-top"><b>{m.sender}</b><span className="row-time">{m.time}</span></div>
              <div className="pinned-body">{m.media ? pinPreview(m) : <RichText body={m.body} html={m.html} account={account} sent={m.ts} />}</div>
              <div className="pinned-actions">
                <button className="link" onClick={() => { onClose(); onGoTo(m); }}>{t("pins.goTo")}</button>
                {canPin && <button className="link" onClick={() => onUnpin(m)}>{t("pins.unpin")}</button>}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
