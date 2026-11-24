import { useEffect, useRef, useState } from "react";
import { ContextMenu } from "./ContextMenu";
import { CallIcon, ChevronIcon, ComposeIcon, DraftIcon, MoreIcon, MuteIcon, SearchIcon } from "./Icons";
import { Avatar } from "./Avatar";
import { OrgAvatar } from "./OrgSwitcher";
import { matches } from "./shortcuts";
import { isUnread, useOrg, useOrgs, type Action, type OrgFilter } from "./store";
import { OfflineBanner } from "./Offline";
import type { Conversation } from "./types";
import { t } from "./i18n";
import { markTerm } from "./searchQuery";

// No "meeting chats": Matrix has no meeting rooms yet; it returns with calls.
type Filter = "unread" | "chats" | "rooms" | "channels";

const filters: { id: Filter; match: (c: Conversation) => boolean }[] = [
  { id: "unread", match: isUnread },
  { id: "chats", match: (c) => c.kind !== "channel" && c.kind !== "room" },
  { id: "rooms", match: (c) => c.kind === "room" },
  { id: "channels", match: (c) => c.kind === "channel" },
];

interface Props {
  query: string;
  convs: Conversation[];
  orgFilter: OrgFilter;
  selectedId: string | null;
  dispatch: (a: Action) => void;
  onNewChat: (mode?: "chat" | "room") => void;
  onAccept: (id: string) => void;
  onDecline: (id: string) => void;
  onBrowse: () => void;
  onLeave: (conv: Conversation) => void;
  /** Whether you may delete this conversation for everyone (asked when its menu opens). */
  canDelete: (conv: Conversation) => Promise<boolean>;
  onDelete: (conv: Conversation) => void;
}

export function ChatList({ query, convs, orgFilter, selectedId, dispatch, onNewChat, onAccept, onDecline, onBrowse, onLeave, canDelete, onDelete }: Props) {
  const [listQuery, setListQuery] = useState<string | null>(null);
  const [headMenu, setHeadMenu] = useState(false);
  const [filter, setFilter] = useState<Filter | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ archived: true });
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);
  const [deletable, setDeletable] = useState<string | null>(null);
  useEffect(() => {
    setDeletable(null);
    const conv = menu && convs.find((c) => c.id === menu.id);
    if (!conv) return;
    let live = true;
    void canDelete(conv).then((yes) => { if (live && yes) setDeletable(conv.id); }).catch(() => {});
    return () => { live = false; };
  }, [menu?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const close = () => { setMenu(null); setHeadMenu(false); };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  const f = filters.find((x) => x.id === filter);
  // Chat names are matched on the plain part of a search ("exact words" and *wildcards* stripped).
  const q = markTerm(query).trim().toLowerCase();
  const lq = listQuery?.trim().toLowerCase() ?? "";
  // Keep the selected chat visible under the Unread filter, otherwise it vanishes the moment you open it.
  const visible = convs
    .filter((c) => orgFilter === "all" || c.orgId === orgFilter)
    .filter((c) => !f || f.match(c) || (filter === "unread" && c.id === selectedId))
    .filter((c) => !q || `${c.team ?? ""} ${c.name} ${c.preview}`.toLowerCase().includes(q))
    .filter((c) => !lq || `${c.team ?? ""} ${c.name}`.toLowerCase().includes(lq))
    .sort((a, b) => b.sortKey - a.sortKey);
  const drafts = visible.filter((c) => c.draft);
  const invites = visible.filter((c) => c.invitedBy);
  // Archived chats come back into view while they have something unread (or are open).
  const tuckedAway = (c: Conversation) => !!c.archived && !isUnread(c) && c.id !== selectedId;
  const archived = visible.filter((c) => tuckedAway(c) && !c.invitedBy);
  const favourites = visible.filter((c) => c.favourite && !c.invitedBy && !tuckedAway(c));
  const rest = visible.filter((c) => !c.favourite && !c.invitedBy && !tuckedAway(c));
  const chats = rest.filter((c) => c.kind !== "channel" && c.kind !== "room");
  const rooms = rest.filter((c) => c.kind === "room");
  const channels = rest.filter((c) => c.kind === "channel");
  const showOrgBadge = orgFilter === "all";

  // ⌥↑/⌥↓ walk the list in on-screen order; with ⇧ only unread chats.
  const order = [...invites, ...[["fav", favourites], ["chats", chats], ["rooms", rooms], ["channels", channels], ["archived", archived]].flatMap(([key, items]) => (collapsed[key as string] ? [] : (items as Conversation[])))];
  const orderRef = useRef(order);
  orderRef.current = order;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const [step, unreadOnly] = matches(e, "prevChat") ? [-1, false] : matches(e, "nextChat") ? [1, false]
        : matches(e, "prevUnread") ? [-1, true] : matches(e, "nextUnread") ? [1, true] : [0, false];
      if (!step) return;
      const list = orderRef.current;
      const at = list.findIndex((c) => c.id === selectedId);
      for (let i = at + step; i >= 0 && i < list.length; i += step) {
        if (unreadOnly && !isUnread(list[i]!)) continue;
        e.preventDefault();
        dispatch({ type: "select", id: list[i]!.id });
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedId, dispatch]);

  const section = (key: string, title: string, items: Conversation[]) =>
    items.length > 0 && (
      <div className="section" key={key}>
        <button className="section-head" onClick={() => setCollapsed({ ...collapsed, [key]: !collapsed[key] })}>
          <ChevronIcon open={!collapsed[key]} /> {title}
        </button>
        {!collapsed[key] &&
          items.map((c) => (
            <Row key={c.id} conv={c} selected={c.id === selectedId} showOrg={showOrgBadge}
              onClick={() => dispatch({ type: "select", id: c.id })}
              onMenu={(x, y) => setMenu({ id: c.id, x, y })} />
          ))}
      </div>
    );

  const menuConv = menu && convs.find((c) => c.id === menu.id);
  const orgsInView = useOrgs().filter((o) => orgFilter === "all" || o.id === orgFilter);

  return (
    <aside className="chat-list">
      <header className="pane-head">
        <h1>{t("chat.title")}</h1>
        <div className="head-actions">
          <span className="emoji-anchor">
            <button className={`icon-btn ${headMenu ? "on" : ""}`} title={t("common.more")} onClick={(e) => { e.stopPropagation(); setHeadMenu(!headMenu); }}><MoreIcon /></button>
            {headMenu && (
              <div className="menu head-menu" onClick={(e) => e.stopPropagation()}>
                <button className="menu-item" onClick={() => { setHeadMenu(false); onBrowse(); }}>{t("chat.browse")}</button>
                <button className="menu-item" onClick={() => { setHeadMenu(false); onNewChat(); }}>{t("chat.newChat")}</button>
                <button className="menu-item" onClick={() => { setHeadMenu(false); onNewChat("room"); }}>{t("chat.newRoom")}</button>
              </div>
            )}
          </span>
          <button className={`icon-btn ${listQuery !== null ? "on" : ""}`} title={t("chat.filterByName")} onClick={() => setListQuery(listQuery === null ? "" : null)}><SearchIcon /></button>
          <button className="icon-btn" title={t("chat.newChat")} onClick={() => onNewChat()}><ComposeIcon /></button>
        </div>
      </header>
      {listQuery !== null && (
        <div className="list-filter">
          <input autoFocus value={listQuery} placeholder={t("chat.filterByName")} onChange={(e) => setListQuery(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setListQuery(null)} />
        </div>
      )}
      <div className="filters">
        {filters.map((x) => (
          <button key={x.id} className={`pill ${filter === x.id ? "on" : ""}`} onClick={() => setFilter(filter === x.id ? null : x.id)}>
            {t(`chat.filter.${x.id}`)}
          </button>
        ))}
      </div>
      <OfflineBanner orgs={orgsInView} />
      <div className="list-scroll">
        {drafts.length > 0 && (
          <div className="section">
            <button className="section-head" onClick={() => setCollapsed({ ...collapsed, quick: !collapsed.quick })}>
              <ChevronIcon open={!collapsed.quick} /> {t("chat.quickViews")}
            </button>
            {!collapsed.quick && <div className="quick-row"><DraftIcon /> {t("chat.drafts")} <span className="count subtle">{drafts.length}</span></div>}
          </div>
        )}
        {invites.length > 0 && (
          <div className="section">
            <div className="section-head static">{t("chat.invites")} <span className="count">{invites.length}</span></div>
            {invites.map((c) => (
              <div key={c.id} className={`row invite ${c.id === selectedId ? "selected" : ""}`} onClick={() => dispatch({ type: "select", id: c.id })} role="button" tabIndex={0}>
                <Avatar account={c.orgId} media={c.avatar} name={c.name} className={`kind-${c.kind}`} channel={c.kind === "channel"} />
                <span className="row-text">
                  <span className="row-name">{c.name}</span>
                  <span className="row-preview">{t(c.kind === "team" ? "chat.invitedToTeam" : "chat.invitedBy", { name: c.invitedBy ?? "" })}</span>
                </span>
                <span className="invite-actions">
                  <button className="btn primary small" onClick={(e) => { e.stopPropagation(); onAccept(c.id); }}>{t("common.accept")}</button>
                  <button className="icon-btn" title={t("common.decline")} onClick={(e) => { e.stopPropagation(); onDecline(c.id); }}>✕</button>
                </span>
              </div>
            ))}
          </div>
        )}
        {section("fav", t("chat.section.favorites"), favourites)}
        {section("chats", t("chat.section.chats"), chats)}
        {section("rooms", t("chat.section.rooms"), rooms)}
        {section("channels", t("chat.section.channels"), channels)}
        {section("archived", t("chat.section.archived", { count: archived.length }), archived)}
        {visible.length === 0 && <p className="empty">{q ? t("chat.noMatch", { query: query.trim() }) : t("chat.caughtUp")}</p>}
      </div>

      {menu && menuConv && (
        <ContextMenu x={menu.x} y={menu.y}>
          {isUnread(menuConv) ? (
            <button className="menu-item" onClick={() => { dispatch({ type: "markRead", id: menu.id }); setMenu(null); }}>{t("chat.markRead")}</button>
          ) : (
            <button className="menu-item" onClick={() => { dispatch({ type: "markUnread", id: menu.id }); setMenu(null); }}>{t("chat.markUnread")}</button>
          )}
          <button className="menu-item" onClick={() => { dispatch({ type: "toggleFavourite", id: menu.id }); setMenu(null); }}>
            {menuConv.favourite ? t("chat.removeFavorite") : t("chat.addFavorite")}
          </button>
          <button className="menu-item" onClick={() => { dispatch({ type: "toggleMute", id: menu.id }); setMenu(null); }}>
            {menuConv.muted ? t("chat.unmute") : t("chat.mute")}
          </button>
          <button className="menu-item" onClick={() => { dispatch({ type: "toggleArchive", id: menu.id }); setMenu(null); }}>
            {menuConv.archived ? t("chat.unarchive") : t("chat.archive")}
          </button>
          <div className="menu-sep" />
          <button className="menu-item danger" onClick={() => { setMenu(null); onLeave(menuConv); }}>{t("chat.leave")}</button>
          {deletable === menuConv.id && <button className="menu-item danger" onClick={() => { setMenu(null); onDelete(menuConv); }}>{t("talk.delete")}</button>}
        </ContextMenu>
      )}
    </aside>
  );
}

function Row({ conv, selected, showOrg, onClick, onMenu }: { conv: Conversation; selected: boolean; showOrg: boolean; onClick: () => void; onMenu: (x: number, y: number) => void }) {
  const unread = isUnread(conv);
  const org = useOrg(conv.orgId);
  const title = conv.kind === "channel" && conv.team ? `${conv.team} › ${conv.name}` : conv.name;
  return (
    <div
      className={`row ${selected ? "selected" : ""} ${unread ? "unread" : ""} ${conv.muted ? "muted" : ""}`}
      onClick={onClick}
      onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onMenu(e.clientX, e.clientY); }}
      role="button"
      tabIndex={0}
    >
      <span className="avatar-wrap">
        <Avatar account={conv.orgId} media={conv.avatar} name={conv.name} className={`kind-${conv.kind}`} channel={conv.kind === "channel"} />
        {showOrg && <span className="org-badge" title={org.name}><OrgAvatar org={org} size={14} /></span>}
        {conv.presence && <span className={`presence-dot p-${conv.presence}`} title={conv.status ? `${conv.presence} · ${conv.status}` : conv.presence} />}
      </span>
      <span className="row-text">
        <span className="row-top">
          <span className="row-name">{title}</span>
          {conv.callActive && <span className="call-live" title={t("call.active")}><CallIcon /></span>}
          <span className="row-time">{conv.time}</span>
        </span>
        <span className="row-bottom">
          <span className="row-preview">{conv.draft ? <><em className="draft">{t("chat.draft")}</em> {conv.draft}</> : conv.preview}</span>
          {conv.muted && <MuteIcon />}
          {conv.mentions > 0 && <span className="mention">@</span>}
          {/* Muted chats show no count, like Element/Teams; mentions still show the @. */}
          {conv.unread > 0 && !conv.muted ? <span className="count">{conv.unread > 99 ? "99+" : conv.unread}</span> : conv.marked && <span className="dot" title={t("chat.markedUnread")} />}
        </span>
      </span>
      <button className="row-more icon-btn" onClick={(e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); onMenu(r.left, r.bottom); }} title={t("common.moreOptions")}>
        <MoreIcon />
      </button>
    </div>
  );
}
