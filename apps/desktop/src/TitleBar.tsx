import { useEffect, useRef, useState } from "react";
import { LockIcon, MoreIcon, PlusIcon, SearchIcon } from "./Icons";
import { Avatar } from "./Avatar";
import { useOrgs, type OrgFilter } from "./store";
import { backend, formatTime, isLive, type SearchHit } from "./backend";
import type { PresenceState } from "./types";
import { locale, t } from "./i18n";
import { matches } from "./shortcuts";


interface Props {
  orgFilter: OrgFilter;
  query: string;
  onQuery: (q: string) => void;
  onAddAccount: () => void;
  onSignOut: (orgId: string) => void;
  onSecurity: (orgId: string) => void;
  onSettings: () => void;
  onPresence: (orgId: string, presence: PresenceState, status?: string) => void;
  /** Open a search result: conversation key + message id. */
  onOpenMessage: (conversation: string, message: string) => void;
}

export function TitleBar({ orgFilter, query, onQuery, onAddAccount, onSignOut, onSecurity, onSettings, onPresence, onOpenMessage }: Props) {
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [showHits, setShowHits] = useState(false);
  const [indexed, setIndexed] = useState<number | null>(null);
  useEffect(() => {
    if (isLive && showHits) backend.searchStatus().then(setIndexed).catch(() => setIndexed(null));
  }, [showHits]);
  // Message search across all chats (debounced); the chat list filters on the same query.
  useEffect(() => {
    if (!isLive || query.trim().length < 2) return setHits([]);
    const timer = window.setTimeout(() => {
      backend.searchMessages(query).then((all) => setHits(all.filter((h) => orgFilter === "all" || h.conversation.startsWith(`${orgFilter}|`)))).catch(() => setHits([]));
    }, 250);
    return () => window.clearTimeout(timer);
  }, [query, orgFilter]);
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
          </div>
        )}
      </div>
      <div className="titlebar-right" ref={ref}>
        <button className="icon-btn" title={t("titlebar.settings")} onClick={onSettings}><MoreIcon /></button>
        <button className="me" onClick={() => setOpen(!open)} title={t("titlebar.accounts")}>
          <Avatar account={me.id} media={me.avatar} name={me.displayName} className="small" />
          <span className={`presence p-${me.presence}`} />
        </button>
        {open && (
          <div className="menu account-menu">
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
  let q = query.toLowerCase();
  let i = lower.indexOf(q);
  if (i < 0) {
    q = q.split(/\s+/)[0] ?? "";
    i = q ? lower.indexOf(q) : -1;
  }
  if (i < 0) return <>{text}</>;
  return <>{text.slice(0, i)}<mark>{text.slice(i, i + q.length)}</mark>{text.slice(i + q.length)}</>;
}
