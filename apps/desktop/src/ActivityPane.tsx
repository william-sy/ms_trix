import { useState } from "react";
import { Avatar } from "./Avatar";
import { formatTime, type ActivityItem } from "./backend";
import { t } from "./i18n";

type Filter = "all" | "mention" | "reply" | "reaction" | "unread";

const filters: Filter[] = ["all", "unread", "mention", "reply", "reaction"];

const describe = (a: ActivityItem) =>
  a.kind === "mention" ? t("activity.mentioned", { room: a.conversationName })
    : a.kind === "reply" ? t("activity.replied", { room: a.conversationName })
    : t("activity.reacted", { emoji: a.reaction ?? "", room: a.conversationName });

interface Props {
  items: ActivityItem[];
  /** Items newer than this were unseen when the feed was opened. */
  seenAt: number;
  /** Items opened individually since. */
  readIds: Set<string>;
  selected: string | null;
  onOpen: (item: ActivityItem) => void;
  onMarkAllRead: () => void;
}

/** Teams-style Activity feed: mentions, replies and reactions aimed at you. */
export function ActivityPane({ items, seenAt, readIds, selected, onOpen, onMarkAllRead }: Props) {
  const unseen = (a: ActivityItem) => a.at > seenAt && !readIds.has(a.id);
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
              <span className={`activity-kind k-${a.kind}`}>{a.kind === "mention" ? "@" : a.kind === "reply" ? "↩" : a.reaction}</span>
            </span>
            <span className="row-text">
              <span className="row-top">
                <span className="row-name"><b>{a.senderName}</b> {describe(a)}</span>
                <span className="row-time">{formatTime(a.at)}</span>
              </span>
              <span className="row-preview">{a.preview}</span>
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}
