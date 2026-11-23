import { useEffect, useState, type ReactNode } from "react";
import { ContextMenu } from "./ContextMenu";
import { Avatar } from "./Avatar";
import { backend, type TeamView } from "./backend";
import { ChevronIcon } from "./Icons";
import { isUnread } from "./store";
import type { Conversation } from "./types";
import { t } from "./i18n";

interface Props {
  teams: TeamView[];
  convs: Conversation[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  onBrowseTeam: (team: TeamView) => void;
  onBrowse: () => void;
  onLeaveTeam: (team: TeamView) => void;
  onAccept: (key: string) => void;
  onDecline: (key: string) => void;
  onTeamInfo: (team: TeamView) => void;
  onNewTeam: () => void;
  /** Create a new channel in this team. */
  onNewChannel: (team: TeamView) => void;
}

/** Teams view sidebar: your spaces as teams, with the channels you're in. */
const ORDER_KEY = "Trixcomm.teams.order";
type Order = { pinned: string[]; order: string[] };
const loadOrder = (): Order => {
  try { return { pinned: [], order: [], ...JSON.parse(localStorage.getItem(ORDER_KEY) ?? "{}") }; } catch { return { pinned: [], order: [] }; }
};

/** Teams view sidebar: your spaces as teams (sub-spaces nested), with the channels you're in. */
export function TeamsPane({ teams, convs, selectedId, onSelect, onBrowseTeam, onBrowse, onLeaveTeam, onAccept, onDecline, onTeamInfo, onNewTeam, onNewChannel }: Props) {
  const [headMenu, setHeadMenu] = useState(false);
  const invites = convs.filter((c) => c.kind === "team" && c.invitedBy);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menu, setMenu] = useState<{ team: TeamView; x: number; y: number } | null>(null);
  const [channelMenu, setChannelMenu] = useState<{ team: TeamView; conv: Conversation; x: number; y: number } | null>(null);
  const [adding, setAdding] = useState<TeamView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = (e: unknown) => setError(String(e));
  // Pinned teams first, then the order you moved them into, then by name (kept on this device).
  const [order, setOrderState] = useState<Order>(loadOrder);
  const setOrder = (next: Order) => {
    setOrderState(next);
    try { localStorage.setItem(ORDER_KEY, JSON.stringify(next)); } catch { /* private mode */ }
  };
  useEffect(() => {
    const close = () => { setMenu(null); setChannelMenu(null); setHeadMenu(false); };
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);
  const byId = new Map(convs.map((c) => [c.id, c]));
  const rank = (t: TeamView) => {
    const pin = order.pinned.indexOf(t.key);
    const pos = order.order.indexOf(t.key);
    return [pin < 0 ? 1 : 0, pin < 0 ? 0 : pin, pos < 0 ? Number.MAX_SAFE_INTEGER : pos] as const;
  };
  // Pinned (this device) first, then the order moved into here, then the order synced
  // from Element (space order), then by name.
  const sortTeams = (list: TeamView[]) =>
    [...list].sort((a, b) => {
      const [ra, rb] = [rank(a), rank(b)];
      const server = a.order && b.order ? (a.order < b.order ? -1 : a.order > b.order ? 1 : 0) : a.order ? -1 : b.order ? 1 : 0;
      return ra[0] - rb[0] || ra[1] - rb[1] || ra[2] - rb[2] || server || a.name.localeCompare(b.name);
    });
  // A sub-team shows under its parent when we're in that one too, else at the top level.
  // Spaces can contain each other; a loop is cut so every team still shows once.
  const byKey = new Map(teams.map((t) => [t.key, t]));
  const parentOf = (t: TeamView): string | null => {
    const seen = new Set([t.key]);
    for (let p = t.parent; p && byKey.has(p); p = byKey.get(p)!.parent) {
      if (seen.has(p)) return null;
      seen.add(p);
    }
    return t.parent && byKey.has(t.parent) ? t.parent : null;
  };
  const childrenOf = (key: string | null) => sortTeams(teams.filter((t) => parentOf(t) === key));
  const top = childrenOf(null);

  const move = (team: TeamView, step: -1 | 1) => {
    const siblings = childrenOf(parentOf(team)).map((t) => t.key);
    const i = siblings.indexOf(team.key);
    const j = i + step;
    if (j < 0 || j >= siblings.length) return;
    [siblings[i], siblings[j]] = [siblings[j]!, siblings[i]!];
    setOrder({ ...order, order: [...siblings, ...order.order.filter((k) => !siblings.includes(k))] });
    // Top-level order also goes to the server so Element (and other devices) follow it.
    if (!parentOf(team)) siblings.forEach((key, n) => void backend.setTeamOrder(key, String(n + 1).padStart(4, "0")).catch(() => {}));
  };
  const togglePin = (team: TeamView) =>
    setOrder({ ...order, pinned: order.pinned.includes(team.key) ? order.pinned.filter((k) => k !== team.key) : [...order.pinned, team.key] });

  const unreadIn = (team: TeamView): number =>
    team.channels.map((id) => byId.get(id)).filter((c) => c && isUnread(c) && !c.muted).length + childrenOf(team.key).reduce((n, sub) => n + unreadIn(sub), 0);

  const renderTeam = (team: TeamView, depth: number): ReactNode => {
    const channels = team.channels.map((id) => byId.get(id)).filter((c): c is Conversation => !!c);
    const subs = childrenOf(team.key);
    const unread = unreadIn(team);
    const open = !collapsed[team.key];
    return (
      <div className={`team ${depth ? "sub-team" : ""}`} key={team.key}>
        <button className="team-head" onClick={() => setCollapsed({ ...collapsed, [team.key]: open })} title={team.topic ?? team.name}
          onContextMenu={(e) => { e.preventDefault(); setMenu({ team, x: e.clientX, y: e.clientY }); }}>
          <ChevronIcon open={open} />
          <Avatar account={team.account} media={team.avatar ?? undefined} name={team.name} className="small space" />
          <span className={`team-name ${unread && !open ? "unread" : ""}`}>{team.name}</span>
          {order.pinned.includes(team.key) && <span className="team-pin" title={t("teams.pinned")}>📌</span>}
          {!open && unread > 0 && <span className="count">{unread}</span>}
        </button>
        {open && (
          <div className="channels">
            {channels.map((c) => (
              <button key={c.id} className={`channel ${c.id === selectedId ? "selected" : ""} ${isUnread(c) && !c.muted ? "unread" : ""}`} onClick={() => onSelect(c.id)}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setChannelMenu({ team, conv: c, x: e.clientX, y: e.clientY }); }}>
                <span className="channel-name">{c.name}</span>
                {c.mentions > 0 && <span className="mention">@</span>}
                {c.unread > 0 && !c.muted && <span className="count">{c.unread > 99 ? "99+" : c.unread}</span>}
              </button>
            ))}
            {team.notJoined > 0 && (
              <button className="channel more" onClick={() => onBrowseTeam(team)}>
                {t("teams.moreChannels", { count: team.notJoined })}
              </button>
            )}
            {channels.length === 0 && team.notJoined === 0 && subs.length === 0 && <span className="channel none">{t("teams.noChannels")}</span>}
          </div>
        )}
        {open && subs.length > 0 && <div className="sub-teams">{subs.map((sub) => renderTeam(sub, depth + 1))}</div>}
      </div>
    );
  };

  return (
    <aside className="chat-list">
      <header className="pane-head">
        <h1>{t("teams.title")}</h1>
        <div className="head-actions">
          <span className="emoji-anchor">
            <button className={`icon-btn ${headMenu ? "on" : ""}`} title={t("teams.joinOrCreate")} onClick={(e) => { e.stopPropagation(); setHeadMenu(!headMenu); }}>＋</button>
            {headMenu && (
              <div className="menu head-menu" onClick={(e) => e.stopPropagation()}>
                <button className="menu-item" onClick={() => { setHeadMenu(false); onNewTeam(); }}>{t("teams.create")}</button>
                <button className="menu-item" onClick={() => { setHeadMenu(false); onBrowse(); }}>{t("teams.join")}</button>
              </div>
            )}
          </span>
        </div>
      </header>
      <div className="list-scroll">
        {invites.length > 0 && (
          <div className="section">
            <div className="section-head static">{t("teams.invites")} <span className="count">{invites.length}</span></div>
            {invites.map((c) => (
              <div key={c.id} className="row invite">
                <Avatar account={c.orgId} media={c.avatar} name={c.name} className="space" />
                <span className="row-text">
                  <span className="row-name">{c.name}</span>
                  <span className="row-preview">{t("chat.invitedToTeam", { name: c.invitedBy ?? "" })}</span>
                </span>
                <span className="invite-actions">
                  <button className="btn primary small" onClick={() => onAccept(c.id)}>{t("common.accept")}</button>
                  <button className="icon-btn" title={t("common.decline")} onClick={() => onDecline(c.id)}>✕</button>
                </span>
              </div>
            ))}
          </div>
        )}
        {top.length === 0 && invites.length === 0 && (
          <div className="empty">
            <p>{t("teams.none")}</p>
            <button className="btn primary small" onClick={onNewTeam}>{t("teams.create")}</button>
            <button className="btn small" onClick={onBrowse}>{t("teams.browse")}</button>
          </div>
        )}
        {top.map((team) => renderTeam(team, 0))}
      </div>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y}>
          <button className="menu-item" onClick={() => { setMenu(null); onTeamInfo(menu.team); }}>{t("teams.info")}</button>
          <button className="menu-item" onClick={() => { setMenu(null); onNewChannel(menu.team); }}>{t("teams.newChannel")}</button>
          <button className="menu-item" onClick={() => { setMenu(null); onBrowseTeam(menu.team); }}>{t("teams.browseChannels")}</button>
          <button className="menu-item" onClick={() => { setAdding(menu.team); setMenu(null); }}>{t("teams.addRooms")}</button>
          <button className="menu-item" onClick={() => { togglePin(menu.team); setMenu(null); }}>{order.pinned.includes(menu.team.key) ? t("teams.unpin") : t("teams.pin")}</button>
          <button className="menu-item" onClick={() => { move(menu.team, -1); setMenu(null); }}>{t("teams.moveUp")}</button>
          <button className="menu-item" onClick={() => { move(menu.team, 1); setMenu(null); }}>{t("teams.moveDown")}</button>
          <div className="menu-sep" />
          <button className="menu-item danger" onClick={() => { setMenu(null); onLeaveTeam(menu.team); }}>{t("teams.leave")}</button>
        </ContextMenu>
      )}
      {channelMenu && (
        <ContextMenu x={channelMenu.x} y={channelMenu.y}>
          <button className="menu-item danger" onClick={() => {
            const { team, conv } = channelMenu; setChannelMenu(null);
            if (confirm(t("teams.removeRoomConfirm", { room: conv.name, team: team.name }))) backend.setTeamRoom(team.key, conv.id.split("|")[1]!, false).catch(report);
          }}>{t("teams.removeRoom")}</button>
        </ContextMenu>
      )}
      {adding && <AddRooms team={adding} convs={convs} onClose={() => setAdding(null)} onError={report} />}
      {error && <div className="notice" role="alert">{error} <button className="link" onClick={() => setError(null)}>{t("common.dismiss")}</button></div>}
    </aside>
  );
}

/** Pick rooms you're in to put in this team (they keep their members; only the team changes). */
function AddRooms({ team, convs, onClose, onError }: { team: TeamView; convs: Conversation[]; onClose: () => void; onError: (e: unknown) => void }) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const candidates = convs.filter((c) => c.orgId === team.account && !c.invitedBy && c.kind !== "direct" && c.kind !== "team" && !team.channels.includes(c.id))
    .sort((a, b) => a.name.localeCompare(b.name));
  const add = async () => {
    setBusy(true);
    try {
      for (const id of picked) await backend.setTeamRoom(team.key, id.split("|")[1]!, true);
      onClose();
    } catch (e) {
      onError(e);
      setBusy(false);
    }
  };
  return (
    <div className="login-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="login-card new-chat">
        <button className="icon-btn close" onClick={onClose} title={t("common.closeEsc")}>✕</button>
        <h1>{t("teams.addRoomsTo", { team: team.name })}</h1>
        <div className="results add-rooms">
          {candidates.length === 0 && <p className="empty">{t("teams.noRoomsToAdd")}</p>}
          {candidates.map((c) => (
            <label key={c.id} className="result toggle-row">
              <input type="checkbox" checked={picked.has(c.id)} onChange={(e) => { const next = new Set(picked); if (e.target.checked) next.add(c.id); else next.delete(c.id); setPicked(next); }} />
              <Avatar account={c.orgId} media={c.avatar} name={c.name} className="small" />
              <span className="result-text"><b>{c.name}</b>{c.team && <small>{c.team}</small>}</span>
            </label>
          ))}
        </div>
        <button className="btn primary wide" disabled={busy || picked.size === 0} onClick={add}>{t("teams.addCount", { count: picked.size })}</button>
      </div>
    </div>
  );
}
