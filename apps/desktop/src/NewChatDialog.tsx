import { useEffect, useState } from "react";
import { Avatar } from "./Avatar";
import { backend } from "./backend";
import { useOrgs } from "./store";
import type { Member } from "./types";
import { t } from "./i18n";

interface Props {
  /** Preselected account (the org in view), else the first one. */
  orgId?: string;
  /** Start with the chat, room or team form. */
  initialMode?: "chat" | "room" | "team";
  /** Create a channel in this team (Matrix space) instead. */
  team?: { account: string; spaceId: string; name: string };
  onClose: () => void;
  /** Called with the conversation to open once it has synced. */
  onOpen: (key: string) => void;
}

const ROOM_ADDRESS = /^[#!][^\s:]+:\S+$/;
const USER_ID = /^@[^\s:]+:\S+$/;

export function NewChatDialog({ orgId, initialMode = "chat", team, onClose, onOpen }: Props) {
  const allOrgs = useOrgs();
  const [mode, setMode] = useState<"chat" | "room" | "team">(team ? "room" : initialMode);
  // Teams (and channels in them) are Matrix spaces.
  const orgs = mode === "team" ? allOrgs.filter((o) => o.protocol === "matrix") : allOrgs;
  // Room form; people picked below are invited.
  const [roomName, setRoomName] = useState("");
  const [topic, setTopic] = useState("");
  const [isPublic, setPublic] = useState(false);
  const [encrypted, setEncrypted] = useState(mode !== "team");
  const [alias, setAlias] = useState("");
  const [account, setAccount] = useState(team?.account ?? (orgs.some((o) => o.id === orgId) ? orgId! : orgs[0]?.id ?? ""));
  const isMatrix = orgs.find((o) => o.id === account)?.protocol === "matrix";
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

  const createRoom = () => run(() => backend.createRoom(account, {
    name: roomName.trim(), topic: topic.trim() || null, public: isPublic, encrypted: encrypted && isMatrix && mode !== "team", alias: isPublic && isMatrix ? alias.trim() || null : null, invite: picked.map((p) => p.userId),
    space: mode === "team", team: team?.spaceId ?? null,
  }));
  const formTitle = team ? t("newChannel.title", { team: team.name }) : mode === "team" ? t("newTeam.title") : mode === "room" ? t("newRoom.title") : t("newChat.title");
  const start = () => run(() => backend.createChat(account, picked.map((p) => p.userId), picked.length > 1 ? name : null));
  const join = () => run(() => backend.joinRoom(account, query));

  return (
    <div className="login-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="login-card new-chat">
        <button className="icon-btn close" onClick={onClose} title={t("common.closeEsc")}>✕</button>
        <h1>{formTitle}</h1>
        {mode !== "team" && !team && (
          <div className="segmented" role="radiogroup">
            {(["chat", "room"] as const).map((m) => (
              <button key={m} role="radio" aria-checked={mode === m} className={mode === m ? "on" : ""} onClick={() => setMode(m)}>{t(`newChat.mode.${m}`)}</button>
            ))}
          </div>
        )}

        {orgs.length > 1 && !team && (
          <label>
            {t("newChat.org")}
            <select value={account} onChange={(e) => { setAccount(e.target.value); setPicked([]); }}>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name} · {o.userId}</option>)}
            </select>
          </label>
        )}

        {(mode === "room" || mode === "team") && (
          <>
            <label>
              {t(mode === "team" ? "newTeam.name" : "newRoom.name")}
              <input autoFocus value={roomName} onChange={(e) => setRoomName(e.target.value)} placeholder={t("newRoom.namePlaceholder")} />
            </label>
            <label>
              {t("newRoom.topic")}
              <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder={t("newRoom.topicPlaceholder")} />
            </label>
            <div className="field-row">
              <span>{t("room.whoCanJoin")}</span>
              <div className="segmented small" role="radiogroup">
                {([false, true] as const).map((p) => (
                  <button key={String(p)} role="radio" aria-checked={isPublic === p} className={isPublic === p ? "on" : ""}
                    onClick={() => { setPublic(p); setEncrypted(!p && mode !== "team"); }}>{t(p ? "room.join.public" : team ? "room.join.team" : "room.join.invite")}</button>
                ))}
              </div>
            </div>
            {isMatrix && isPublic && (
              <label>
                {t("room.address")}
                <span className="alias-edit">#<input value={alias} onChange={(e) => setAlias(e.target.value.replace(/[\s#:]/g, ""))} placeholder={t("newRoom.aliasPlaceholder")} /></span>
              </label>
            )}
            {isMatrix && mode !== "team" && (
              <label className="toggle-row">
                <input type="checkbox" checked={encrypted} onChange={(e) => setEncrypted(e.target.checked)} />
                <span>{t("newRoom.encrypted")}</span>
              </label>
            )}
            {isMatrix && isPublic && encrypted && mode !== "team" && <p className="hint">{t("newRoom.publicEncryptedHint")}</p>}
            {mode === "team" && <p className="hint">{t("newTeam.hint")}</p>}
          </>
        )}

        <label>
          {mode !== "chat" ? t("newRoom.invite") : t("newChat.to")}
          <div className="to-field">
            {picked.map((p) => (
              <span key={p.userId} className="chip" title={p.userId}>
                {p.name}
                <button onClick={() => setPicked(picked.filter((x) => x.userId !== p.userId))} title={t("common.remove")}>✕</button>
              </span>
            ))}
            <input autoFocus={mode === "chat"} value={term} onChange={(e) => setTerm(e.target.value)} placeholder={picked.length ? t("newChat.addMore") : t("newChat.toPlaceholder")}
              onKeyDown={(e) => {
                if (e.key === "Enter" && shown[0]) { e.preventDefault(); pick(shown[0]); }
                if (e.key === "Backspace" && !term && picked.length) setPicked(picked.slice(0, -1));
              }} />
          </div>
        </label>

        {mode === "chat" && ROOM_ADDRESS.test(query) ? (
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

        {mode === "chat" && picked.length > 1 && (
          <label>
            {t("newChat.groupName")}
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("newChat.groupPlaceholder")} />
          </label>
        )}

        {mode !== "chat" && (
          <button className="btn primary wide" disabled={busy || !roomName.trim() || !account} onClick={createRoom}>
            {busy ? t("newChat.starting") : t(team ? "newChannel.create" : mode === "team" ? "newTeam.create" : "newRoom.create")}
          </button>
        )}
        {mode === "chat" && !ROOM_ADDRESS.test(query) && (
          <button className="btn primary wide" disabled={busy || picked.length === 0} onClick={start}>
            {busy ? t("newChat.starting") : picked.length > 1 ? t("newChat.startGroup", { count: picked.length + 1 }) : t("newChat.start")}
          </button>
        )}
        {mode === "chat" && <p className="hint">{t("newChat.hint")}</p>}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
