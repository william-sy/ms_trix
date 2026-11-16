import { useEffect, useState } from "react";
import { ChevronIcon, ComposeIcon, DraftIcon, MoreIcon, MuteIcon, SearchIcon } from "./Icons";
import { Avatar } from "./Avatar";
import { OrgAvatar } from "./OrgSwitcher";
import { isUnread, useOrg, type Action, type OrgFilter } from "./store";
import type { Conversation } from "./types";
import { t } from "./i18n";

// No "meeting chats": Matrix has no meeting rooms yet; it returns with calls.
type Filter = "unread" | "chats" | "channels";

const filters: { id: Filter; match: (c: Conversation) => boolean }[] = [
  { id: "unread", match: isUnread },
  { id: "chats", match: (c) => c.kind !== "channel" },
  { id: "channels", match: (c) => c.kind === "channel" },
];

interface Props {
  query: string;
  convs: Conversation[];
  orgFilter: OrgFilter;
  selectedId: string | null;
  dispatch: (a: Action) => void;
  onNewChat: () => void;
  onAccept: (id: string) => void;
  onDecline: (id: string) => void;
  onBrowse: () => void;
  onLeave: (conv: Conversation) => void;
}

export function ChatList({ query, convs, orgFilter, selectedId, dispatch, onNewChat, onAccept, onDecline, onBrowse, onLeave }: Props) {
  const [listQuery, setListQuery] = useState<string | null>(null);
  const [headMenu, setHeadMenu] = useState(false);
  const [filter, setFilter] = useState<Filter | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ id: string; x: number; y: number } | null>(null);

  useEffect(() => {
    const close = () => { setMenu(null); setHeadMenu(false); };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  const f = filters.find((x) => x.id === filter);
  const q = query.trim().toLowerCase();
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
  const favourites = visible.filter((c) => c.favourite && !c.invitedBy);
  const rest = visible.filter((c) => !c.favourite && !c.invitedBy);
  const chats = rest.filter((c) => c.kind !== "channel");
  const channels = rest.filter((c) => c.kind === "channel");
  const showOrgBadge = orgFilter === "all";

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
              </div>
            )}
          </span>
          <button className={`icon-btn ${listQuery !== null ? "on" : ""}`} title={t("chat.filterByName")} onClick={() => setListQuery(listQuery === null ? "" : null)}><SearchIcon /></button>
          <button className="icon-btn" title={t("chat.newChat")} onClick={onNewChat}><ComposeIcon /></button>
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
                  <span className="row-preview">{t("chat.invitedBy", { name: c.invitedBy ?? "" })}</span>
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
        {section("channels", t("chat.section.channels"), channels)}
        {visible.length === 0 && <p className="empty">{q ? t("chat.noMatch", { query: query.trim() }) : t("chat.caughtUp")}</p>}
      </div>

      {menu && menuConv && (
        <div className="menu context" style={{ left: menu.x, top: menu.y }} onClick={(e) => e.stopPropagation()}>
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
          <div className="menu-sep" />
          <button className="menu-item danger" onClick={() => { setMenu(null); onLeave(menuConv); }}>{t("chat.leave")}</button>
        </div>
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
