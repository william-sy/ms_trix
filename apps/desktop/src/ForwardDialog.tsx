import { useEffect, useMemo, useState } from "react";
import { Avatar } from "./Avatar";
import { backend } from "./backend";
import { t } from "./i18n";
import { OrgAvatar } from "./OrgSwitcher";
import { useOrgs } from "./store";
import type { Conversation, Message } from "./types";

/** Forward a message to another chat, on any account (Teams' Forward, with "Add a message"). */
export function ForwardDialog({ message, from, convs, onClose, onDone }: { message: Message; from: string; convs: Conversation[]; onClose: () => void; onDone: (name: string) => void }) {
  const orgs = useOrgs();
  const [term, setTerm] = useState("");
  const [target, setTarget] = useState<Conversation | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const list = useMemo(() => {
    const q = term.trim().toLowerCase();
    return convs
      .filter((c) => !c.invitedBy && c.kind !== "team" && (!q || c.name.toLowerCase().includes(q)))
      .sort((a, b) => b.sortKey - a.sortKey)
      .slice(0, 60);
  }, [convs, term]);

  const send = async () => {
    if (!target) return;
    setBusy(true);
    setError(null);
    try {
      await backend.forwardMessage(from, message.id, target.id, note.trim() || null);
      onDone(target.name);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  };

  return (
    <div className="login-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="login-card forward-dialog">
        <button className="icon-btn close" onClick={onClose} title={t("common.closeEsc")}>✕</button>
        <h1>{t("forward.title")}</h1>
        <div className="forward-preview">
          <b>{message.sender}</b>
          <span>{message.media ? `📎 ${message.media.name}` : message.body}</span>
        </div>
        {target ? (
          <div className="forward-target">
            <Avatar account={target.orgId} media={target.avatar} name={target.name} className={`small kind-${target.kind}`} channel={target.kind === "channel"} />
            <span>{target.name}</span>
            <button className="link" onClick={() => setTarget(null)}>{t("forward.change")}</button>
          </div>
        ) : (
          <>
            <input autoFocus placeholder={t("forward.search")} value={term} onChange={(e) => setTerm(e.target.value)} />
            <div className="forward-list">
              {list.map((c) => {
                const org = orgs.find((o) => o.id === c.orgId);
                return (
                  <button key={c.id} className="forward-row" onClick={() => setTarget(c)}>
                    <Avatar account={c.orgId} media={c.avatar} name={c.name} className={`small kind-${c.kind}`} channel={c.kind === "channel"} />
                    <span className="forward-name">{c.kind === "channel" && c.team ? `${c.team} › ${c.name}` : c.name}</span>
                    {orgs.length > 1 && org && <OrgAvatar org={org} size={18} />}
                  </button>
                );
              })}
              {!list.length && <p className="muted">{t("forward.none")}</p>}
            </div>
          </>
        )}
        <textarea rows={2} placeholder={t("forward.note")} value={note} onChange={(e) => setNote(e.target.value)} />
        {error && <p className="error">{error}</p>}
        <div className="dialog-buttons">
          <button className="btn" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn primary" disabled={!target || busy} onClick={() => void send()}>{busy ? t("forward.sending") : t("forward.send")}</button>
        </div>
      </div>
    </div>
  );
}
