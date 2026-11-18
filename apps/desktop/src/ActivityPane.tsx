import { useState } from "react";
import { Avatar } from "./Avatar";
import { formatTime, type ActivityItem } from "./backend";
import { t } from "./i18n";

type Filter = "all" | "mention" | "reply" | "reaction" | "keyword" | "unread";

const filters: Filter[] = ["all", "unread", "mention", "reply", "reaction", "keyword"];

const describe = (a: ActivityItem) =>
  a.kind === "mention" ? t("activity.mentioned", { room: a.conversationName })
    : a.kind === "reply" ? t("activity.replied", { room: a.conversationName })
    : a.kind === "keyword" ? t("activity.keyword", { room: a.conversationName })
    : t("activity.reacted", { emoji: a.reaction ?? "", room: a.conversationName });

const badge = (a: ActivityItem) => (a.kind === "mention" ? "@" : a.kind === "reply" ? "↩" : a.kind === "keyword" ? "#" : a.reaction);

interface Props {
  items: ActivityItem[];
  isUnread: (item: ActivityItem) => boolean;
  selected: string | null;
  onOpen: (item: ActivityItem) => void;
  onSetRead: (item: ActivityItem, read: boolean) => void;
  onMarkAllRead: () => void;
}

/** Teams-style Activity feed: mentions, replies, reactions and keywords aimed at you. */
export function ActivityPane({ items, isUnread: unseen, selected, onOpen, onSetRead, onMarkAllRead }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const shown = items.filter((a) => filter === "all" || (filter === "unread" ? unseen(a) : a.kind === filter));
  const anyUnseen = items.some(unseen);

  return (
    <aside className="chat-list">
      <header className="pane-head">
        <h1>{t("activity.title")}</h1>
        <div className="head-actions">
          <button className="btn small" disabled={!anyUnseen} onClick={onMarkAllRead}>{t("activity.markAllRead")}</button>
        </div>
      </header>
      <div className="filters">
        {filters.map((f) => (
          <button key={f} className={`pill ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>{t(`activity.filter.${f}`)}</button>
        ))}
      </div>
      <div className="list-scroll">
        {shown.length === 0 && <p className="empty">{t("activity.empty")}</p>}
        {shown.map((a) => (
          <button key={a.id} className={`activity ${a.id === selected ? "selected" : ""} ${unseen(a) ? "unseen" : ""}`} onClick={() => onOpen(a)}>
            <span className="avatar-wrap">
              <Avatar account={a.conversation.split("|")[0]!} media={a.senderAvatar ?? undefined} name={a.senderName} />
              <span className={`activity-kind k-${a.kind}`}>{badge(a)}</span>
            </span>
            <span className="row-text">
              <span className="row-top">
                <span className="row-name"><b>{a.senderName}</b> {describe(a)}</span>
                <span className="row-time">{formatTime(a.at)}</span>
              </span>
              <span className="row-preview">{a.preview}</span>
            </span>
            <span className="activity-toggle" role="button" title={unseen(a) ? t("activity.markRead") : t("activity.markUnread")}
              onClick={(e) => { e.stopPropagation(); onSetRead(a, unseen(a)); }} />
          </button>
        ))}
      </div>
    </aside>
  );
}
