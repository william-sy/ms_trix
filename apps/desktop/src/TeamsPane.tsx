import { useState } from "react";
import { Avatar } from "./Avatar";
import type { TeamView } from "./backend";
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
}

/** Teams view sidebar: your spaces as teams, with the channels you're in. */
export function TeamsPane({ teams, convs, selectedId, onSelect, onBrowseTeam, onBrowse }: Props) {
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const byId = new Map(convs.map((c) => [c.id, c]));
  const sorted = [...teams].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <aside className="chat-list">
      <header className="pane-head">
        <h1>{t("teams.title")}</h1>
        <div className="head-actions">
          <button className="icon-btn" title={t("teams.join")} onClick={onBrowse}>＋</button>
        </div>
      </header>
      <div className="list-scroll">
        {sorted.length === 0 && (
          <div className="empty">
            <p>{t("teams.none")}</p>
            <button className="btn primary small" onClick={onBrowse}>{t("teams.browse")}</button>
          </div>
        )}
        {sorted.map((team) => {
          const channels = team.channels.map((id) => byId.get(id)).filter((c): c is Conversation => !!c);
          const unread = channels.filter((c) => isUnread(c) && !c.muted).length;
          const open = !collapsed[team.key];
          return (
            <div className="team" key={team.key}>
              <button className="team-head" onClick={() => setCollapsed({ ...collapsed, [team.key]: open })} title={team.topic ?? team.name}>
                <ChevronIcon open={open} />
                <Avatar account={team.account} media={team.avatar ?? undefined} name={team.name} className="small space" />
                <span className={`team-name ${unread && !open ? "unread" : ""}`}>{team.name}</span>
                {!open && unread > 0 && <span className="count">{unread}</span>}
              </button>
              {open && (
                <div className="channels">
                  {channels.map((c) => (
                    <button key={c.id} className={`channel ${c.id === selectedId ? "selected" : ""} ${isUnread(c) && !c.muted ? "unread" : ""}`} onClick={() => onSelect(c.id)}>
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
                  {channels.length === 0 && team.notJoined === 0 && <span className="channel none">{t("teams.noChannels")}</span>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </aside>
  );
}
