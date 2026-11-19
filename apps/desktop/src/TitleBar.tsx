import { useEffect, useRef, useState } from "react";
import { LockIcon, MoreIcon, MuteIcon, PlusIcon, SearchIcon } from "./Icons";
import { DND_FOREVER, dndEnd } from "./dnd";
import { Avatar } from "./Avatar";
import { useOrgs, type OrgFilter } from "./store";
import { backend, formatTime, isLive, type SearchHit } from "./backend";
import type { PresenceState } from "./types";
import { locale, t } from "./i18n";
import { matches } from "./shortcuts";
import { markTerm } from "./searchQuery";


interface Props {
  orgFilter: OrgFilter;
  query: string;
  onQuery: (q: string) => void;
  onAddAccount: () => void;
  onSignOut: (orgId: string) => void;
  onSecurity: (orgId: string) => void;
  onSettings: () => void;
  onPresence: (orgId: string, presence: PresenceState, status?: string) => void;
  /** Do not disturb: until when, while it's on. */
  dnd: number | null;
  onDnd: (until: number | null) => void;
  /** Open a search result: conversation key + message id. */
  onOpenMessage: (conversation: string, message: string) => void;
}

/** Do not disturb: on (until when, switch off), or the choice of how long. */
function DndChoice({ dnd, onDnd, onDone }: { dnd: number | null; onDnd: (until: number | null) => void; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [time, setTime] = useState("");
  const set = (until: number) => { onDnd(until); setOpen(false); onDone(); };
  const inMinutes = (m: number) => Date.now() + m * 60_000;
  const endOfToday = () => { const d = new Date(); d.setHours(23, 59, 59, 0); return d.getTime(); };
  // A time of day: today, or tomorrow once it has passed.
  const at = (hhmm: string) => {
    const [h, m] = hhmm.split(":").map(Number);
    const d = new Date();
    d.setHours(h ?? 0, m ?? 0, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  };
  if (dnd) {
    return (
      <div className="dnd-on">
        <span className="presence inline p-busy p-dnd" />
        <span>{dnd === DND_FOREVER ? t("dnd.on") : t("dnd.onUntil", { time: dndEnd(dnd) })}</span>
        <button className="link" onClick={() => onDnd(null)}>{t("dnd.off")}</button>
      </div>
    );
  }
  return (
    <div className="dnd-choice">
      <button className="menu-item" onClick={() => setOpen(!open)} title={t("dnd.hint")}><MuteIcon /> {t("dnd.title")}<span className="spacer" />{open ? "▾" : "›"}</button>
      {open && (
        <div className="dnd-options">
          <button className="menu-item" onClick={() => set(inMinutes(30))}>{t("dnd.for30")}</button>
          <button className="menu-item" onClick={() => set(inMinutes(60))}>{t("dnd.for1h")}</button>
          <button className="menu-item" onClick={() => set(inMinutes(120))}>{t("dnd.for2h")}</button>
          <button className="menu-item" onClick={() => set(endOfToday())}>{t("dnd.today")}</button>
          <button className="menu-item" onClick={() => set(DND_FOREVER)}>{t("dnd.forever")}</button>
          <form className="dnd-until" onSubmit={(e) => { e.preventDefault(); if (time) set(at(time)); }}>
            <label>{t("dnd.until")} <input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>
            <button className="btn small" disabled={!time}>{t("dnd.start")}</button>
          </form>
          <p className="hint small">{t("dnd.hint")}</p>
        </div>
      )}
    </div>
  );
}

export function TitleBar({ orgFilter, query, onQuery, onAddAccount, onSignOut, onSecurity, onSettings, onPresence, dnd, onDnd, onOpenMessage }: Props) {
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [showHits, setShowHits] = useState(false);
  const [indexed, setIndexed] = useState<number | null>(null);
  const [matchCase, setMatchCase] = useState(false);
  useEffect(() => {
    if (isLive && showHits) backend.searchStatus().then(setIndexed).catch(() => setIndexed(null));
  }, [showHits]);
  // Message search across all chats (debounced); the chat list filters on the same query.
  useEffect(() => {
    if (!isLive || query.trim().length < 2) return setHits([]);
    const timer = window.setTimeout(() => {
      backend.searchMessages(query, null, matchCase).then((all) => setHits(all.filter((h) => orgFilter === "all" || h.conversation.startsWith(`${orgFilter}|`)))).catch(() => setHits([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, orgFilter, matchCase]);
  const orgs = useOrgs();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  // In "All" mode the profile menu lists every account; otherwise just the current one.
  const accounts = orgFilter === "all" ? orgs : orgs.filter((o) => o.id === orgFilter);
  const me = accounts[0];

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    // ⌘E / Ctrl+E focuses search, like Teams.
    const onKey = (e: KeyboardEvent) => {
      if (matches(e, "search")) {
        e.preventDefault();
        search.current?.focus();
        search.current?.select();
      }
    };
    window.addEventListener("mousedown", onClick);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onClick);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  if (!me) return <div className="titlebar" data-tauri-drag-region />;

  return (
    <div className="titlebar" data-tauri-drag-region>
      <div className="search" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setShowHits(false)}>
        <SearchIcon size={16} />
        <input ref={search} value={query} onChange={(e) => { onQuery(e.target.value); setShowHits(true); }} onFocus={() => setShowHits(true)}
          onKeyDown={(e) => { if (e.key === "Escape") { onQuery(""); setShowHits(false); } }}
          placeholder={orgFilter === "all" ? t("titlebar.searchAll") : t("titlebar.searchOrg", { org: me.name })} />
        <button type="button" className={`search-case ${matchCase ? "on" : ""}`} title={t("search.matchCase")} aria-pressed={matchCase}
          onMouseDown={(e) => e.preventDefault()} onClick={() => setMatchCase(!matchCase)}>Aa</button>
        {showHits && query.trim().length >= 2 && isLive && (
          <div className="menu search-results">
            <div className="menu-title">{t("search.messages")}</div>
            {hits.length === 0 && <p className="empty small">{t("search.none")}</p>}
            {hits.map((h) => (
              <button key={h.message} className="search-hit" onClick={() => { setShowHits(false); onOpenMessage(h.conversation, h.message); }}>
                <span className="hit-top"><b>{h.conversationName}</b><span className="row-time">{formatTime(h.at)}</span></span>
                <span className="hit-text">{h.senderName || t("search.you")}: <Highlight text={h.snippet} query={query.trim()} /></span>
              </button>
            ))}
            <p className="hint small">{indexed !== null ? t("search.hintIndexed", { count: indexed, formatted: indexed.toLocaleString(locale()) }) : t("search.hint")}</p>
            <p className="hint small">{t("search.syntax")}</p>
          </div>
        )}
      </div>
      <div className="titlebar-right" ref={ref}>
        <button className="icon-btn" title={t("titlebar.settings")} onClick={onSettings}><MoreIcon /></button>
        <button className="me" onClick={() => setOpen(!open)} title={t("titlebar.accounts")}>
          <Avatar account={me.id} media={me.avatar} name={me.displayName} className="small" />
          <span className={`presence p-${me.presence} ${dnd ? "p-dnd" : ""}`} />
        </button>
        {open && (
          <div className="menu account-menu">
            <DndChoice dnd={dnd} onDnd={onDnd} onDone={() => setOpen(false)} />
            <div className="menu-sep" />
            {accounts.map((o) => (
              <div className="account" key={o.id}>
                <div className="account-head">
                  <span className="account-org">{o.name}</span>
                  <button className="link" onClick={() => { setOpen(false); onSignOut(o.id); }}>{t("titlebar.signOut")}</button>
                </div>
                <div className="account-user">
                  <Avatar account={o.id} media={o.avatar} name={o.displayName} />
                  <span>
                    <b>{o.displayName}</b>
                    <small>{o.userId}</small>
                  </span>
                </div>
                <div className="presence-picker">
                  {(["available", "away", "offline"] as PresenceState[]).map((p) => (
                    <button key={p} className={`menu-item ${o.presence === p ? "on" : ""}`} onClick={() => onPresence(o.id, p, o.status)}>
                      <span className={`presence inline p-${p}`} /> {p === "offline" ? t("presence.appearOffline") : t(`presence.${p}`)}
                    </button>
                  ))}
                </div>
                <button className="menu-item" onClick={() => { setOpen(false); onSecurity(o.id); }}><LockIcon /> {t("titlebar.security")}</button>
              </div>
            ))}
            <div className="menu-sep" />
            <button className="menu-item" onClick={() => { setOpen(false); onAddAccount(); }}><PlusIcon /> {t("titlebar.addAccount")}</button>
          </div>
        )}
      </div>
    </div>
  );
}

/** Marks the whole query, or else its first word (full-history hits match word by word). */
export function Highlight({ text, query }: { text: string; query: string }) {
  const lower = text.toLowerCase();
  let q = markTerm(query).toLowerCase();
  let i = lower.indexOf(q);
  if (i < 0) {
    q = q.split(/\s+/)[0] ?? "";
    i = q ? lower.indexOf(q) : -1;
  }
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}
