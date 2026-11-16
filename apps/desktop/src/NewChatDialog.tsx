import { useEffect, useState } from "react";
import { Avatar } from "./Avatar";
import { backend } from "./backend";
import { useOrgs } from "./store";
import type { Member } from "./types";
import { t } from "./i18n";

interface Props {
  /** Preselected account (the org in view), else the first one. */
  orgId?: string;
  onClose: () => void;
  /** Called with the conversation to open once it has synced. */
  onOpen: (key: string) => void;
}

const ROOM_ADDRESS = /^[#!][^\s:]+:\S+$/;
const USER_ID = /^@[^\s:]+:\S+$/;

export function NewChatDialog({ orgId, onClose, onOpen }: Props) {
  const orgs = useOrgs();
  const [account, setAccount] = useState(orgId ?? orgs[0]?.id ?? "");
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<Member[]>([]);
  const [picked, setPicked] = useState<Member[]>([]);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = term.trim();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Search the server's user directory as you type (debounced).
  useEffect(() => {
    if (query.length < 2 || ROOM_ADDRESS.test(query)) return setResults([]);
    const timer = window.setTimeout(() => {
      backend.searchUsers(account, query).then(setResults).catch(() => setResults([]));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [query, account]);

  // A full user id that the directory doesn't know can still be invited.
  const typedUser: Member | null = USER_ID.test(query) && !results.some((r) => r.userId === query) ? { userId: query, name: query } : null;
  const shown = [...(typedUser ? [typedUser] : []), ...results].filter((r) => !picked.some((p) => p.userId === r.userId));

  const pick = (m: Member) => {
    setPicked([...picked, m]);
    setTerm("");
  };

  const run = async (f: () => Promise<{ open: string | null }>) => {
    setBusy(true);
    setError(null);
    try {
      const out = await f();
      if (out.open) onOpen(out.open);
      onClose();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const start = () => run(() => backend.createChat(account, picked.map((p) => p.userId), picked.length > 1 ? name : null));
  const join = () => run(() => backend.joinRoom(account, query));

  return (
    <div className="login-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="login-card new-chat">
        <button className="icon-btn close" onClick={onClose} title={t("common.closeEsc")}>✕</button>
        <h1>{t("newChat.title")}</h1>

        {orgs.length > 1 && (
          <label>
            {t("newChat.org")}
            <select value={account} onChange={(e) => { setAccount(e.target.value); setPicked([]); }}>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name} · {o.userId}</option>)}
            </select>
          </label>
        )}

        <label>
          {t("newChat.to")}
          <div className="to-field">
            {picked.map((p) => (
              <span key={p.userId} className="chip" title={p.userId}>
                {p.name}
                <button onClick={() => setPicked(picked.filter((x) => x.userId !== p.userId))} title={t("common.remove")}>✕</button>
              </span>
            ))}
            <input autoFocus value={term} onChange={(e) => setTerm(e.target.value)} placeholder={picked.length ? t("newChat.addMore") : t("newChat.toPlaceholder")}
              onKeyDown={(e) => {
                if (e.key === "Enter" && shown[0]) { e.preventDefault(); pick(shown[0]); }
                if (e.key === "Backspace" && !term && picked.length) setPicked(picked.slice(0, -1));
              }} />
          </div>
        </label>

        {ROOM_ADDRESS.test(query) ? (
          <button className="result join" onClick={join} disabled={busy}>
            <span className="avatar kind-channel">#</span>
            <span><b>{t("newChat.join", { address: query })}</b><small>{t("newChat.joinHint")}</small></span>
          </button>
        ) : (
          shown.length > 0 && (
            <div className="results">
              {shown.slice(0, 8).map((m) => (
                <button key={m.userId} className="result" onClick={() => pick(m)}>
                  <Avatar account={account} media={m.avatar ?? undefined} name={m.name} />
                  <span><b>{m.name}</b><small>{m.userId}</small></span>
                </button>
              ))}
            </div>
          )
        )}

        {picked.length > 1 && (
          <label>
            {t("newChat.groupName")}
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("newChat.groupPlaceholder")} />
          </label>
        )}

        {!ROOM_ADDRESS.test(query) && (
          <button className="btn primary wide" disabled={busy || picked.length === 0} onClick={start}>
            {busy ? t("newChat.starting") : picked.length > 1 ? t("newChat.startGroup", { count: picked.length + 1 }) : t("newChat.start")}
          </button>
        )}
        <p className="hint">{t("newChat.hint")}</p>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
