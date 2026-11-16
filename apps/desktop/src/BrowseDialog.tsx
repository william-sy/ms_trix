import { useEffect, useState } from "react";
import { Avatar } from "./Avatar";
import { backend, type DirectoryRoom } from "./backend";
import { useOrgs } from "./store";
import type { Member } from "./types";
import { t, t as tr } from "./i18n";

type Tab = "rooms" | "spaces" | "people";

interface Props {
  orgId?: string;
  /** Open straight on a space's rooms (e.g. "more channels" of a team). */
  initialSpace?: DirectoryRoom;
  onClose: () => void;
  onOpen: (key: string) => void;
}

export function BrowseDialog({ orgId, initialSpace, onClose, onOpen }: Props) {
  const orgs = useOrgs();
  const [account, setAccount] = useState(orgId ?? orgs[0]?.id ?? "");
  const [tab, setTab] = useState<Tab>("rooms");
  const [server, setServer] = useState("");
  const [home, setHome] = useState("");
  const [term, setTerm] = useState("");
  // Breadcrumb of spaces we've opened; the last one is shown.
  const [spaces, setSpaces] = useState<DirectoryRoom[]>(initialSpace ? [initialSpace] : []);
  const [rooms, setRooms] = useState<DirectoryRoom[]>([]);
  const [people, setPeople] = useState<Member[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const space = spaces[spaces.length - 1];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Default to the account's own server: that's where your organization's rooms live.
  useEffect(() => {
    backend.homeServer(account).then((s) => { setHome(s ?? ""); setServer(s ?? ""); }).catch(() => {});
  }, [account]);

  useEffect(() => {
    setError(null);
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        if (tab === "people") setPeople(term.trim().length > 1 ? await backend.searchUsers(account, term) : []);
        else if (space) setRooms(await backend.spaceRooms(account, space.id));
        else setRooms(await backend.directory(account, server, term, tab === "spaces"));
      } catch (e) {
        setError(String(e));
        setRooms([]);
      } finally {
        setLoading(false);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [account, tab, server, term, space]);

  const q = term.trim().toLowerCase();
  // Space contents come unfiltered from the server; filter them here.
  const shownRooms = space && q ? rooms.filter((r) => `${r.name} ${r.alias ?? ""} ${r.topic ?? ""}`.toLowerCase().includes(q)) : rooms;

  const act = async (id: string, f: () => Promise<{ open: string | null }>) => {
    setBusy(id);
    setError(null);
    try {
      const out = await f();
      if (out.open) { onOpen(out.open); onClose(); }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const join = (r: DirectoryRoom) => act(r.id, () => backend.joinRoom(account, r.alias ?? r.id, server || home || null));

  return (
    <div className="login-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="login-card browse">
        <button className="icon-btn close" onClick={onClose} title={t("common.closeEsc")}>✕</button>
        <h1>{space ? space.name : t("browse.title")}</h1>

        <div className="browse-controls">
          <input autoFocus className="browse-search" value={term} onChange={(e) => setTerm(e.target.value)}
            placeholder={space ? t("browse.searchIn", { name: space.name }) : tab === "people" ? t("browse.searchPeople") : tab === "spaces" ? t("browse.searchSpaces") : t("browse.searchRooms")} />
          {orgs.length > 1 && (
            <select value={account} onChange={(e) => { setAccount(e.target.value); setSpaces([]); }} title={t("newChat.org")}>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )}
        </div>

        {space ? (
          <div className="crumbs">
            <button className="link" onClick={() => setSpaces([])}>{t("browse.allSpaces")}</button>
            {spaces.map((s, i) => (
              <span key={s.id}> › {i === spaces.length - 1 ? <b>{s.name}</b> : <button className="link" onClick={() => setSpaces(spaces.slice(0, i + 1))}>{s.name}</button>}</span>
            ))}
            {!space.joined && <button className="btn small" disabled={busy === space.id} onClick={() => join(space)}>{t("browse.joinSpace")}</button>}
          </div>
        ) : (
          <div className="browse-tabs">
            {(["rooms", "spaces", "people"] as Tab[]).map((t) => (
              <button key={t} className={`pill ${tab === t ? "on" : ""}`} onClick={() => setTab(t)}>
                {tr(`browse.tab.${t}`)}
              </button>
            ))}
            {tab !== "people" && (
              <label className="server-pick" title={tr("browse.serverTitle")}>
                {tr("browse.on")}
                <input value={server} onChange={(e) => setServer(e.target.value)} placeholder={home} />
                {server !== home && <button className="link" onClick={() => setServer(home)}>{tr("browse.reset")}</button>}
              </label>
            )}
          </div>
        )}

        <div className="results browse-results">
          {loading && <p className="empty">{t("browse.searching")}</p>}
          {!loading && tab === "people" && !space && people.map((p) => (
            <div key={p.userId} className="result">
              <Avatar account={account} media={p.avatar ?? undefined} name={p.name} />
              <span><b>{p.name}</b><small>{p.userId}</small></span>
              <button className="btn small" disabled={busy === p.userId} onClick={() => act(p.userId, () => backend.createChat(account, [p.userId], null))}>{t("browse.chat")}</button>
            </div>
          ))}
          {!loading && (tab !== "people" || space) && shownRooms.map((r) => (
            <div key={r.id} className={`result ${r.isSpace ? "clickable" : ""}`} onClick={() => r.isSpace && setSpaces([...spaces, r])}>
              <Avatar account={account} media={r.avatar ?? undefined} name={r.name} className={r.isSpace ? "space" : "kind-channel"} channel={!r.isSpace} />
              <span className="result-text">
                <b>{r.name}{r.isSpace && <span className="tag">{t("browse.space")}</span>}</b>
                <small>{[r.alias, t("browse.members", { count: r.members })].filter(Boolean).join(" · ")}</small>
                {r.topic && <small className="topic">{r.topic}</small>}
              </span>
              {r.joined && !r.isSpace ? (
                <button className="btn small" onClick={(e) => { e.stopPropagation(); onOpen(r.joined!); onClose(); }}>{t("browse.open")}</button>
              ) : r.isSpace ? (
                <span className="chev">›</span>
              ) : (
                <button className="btn primary small" disabled={busy === r.id} onClick={(e) => { e.stopPropagation(); join(r); }}>{busy === r.id ? t("browse.joining") : t("browse.joinRoom")}</button>
              )}
            </div>
          ))}
          {!loading && ((tab === "people" && !space && term.trim().length > 1 && !people.length) || ((tab !== "people" || space) && !shownRooms.length)) && (
            <p className="empty">{space ? t("browse.emptySpace") : t("browse.empty")}</p>
          )}
        </div>
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
