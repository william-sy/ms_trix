import { useState } from "react";
import { Avatar } from "./Avatar";
import { formatTime, type ActivityItem } from "./backend";
import { t } from "./i18n";
import { showInFiles } from "./filesNav";
import { useOpenLink } from "./LinkPreview";
import { dismissServerItem, runServerAction, type ServerItem } from "./serverNotifications";

type Filter = "all" | "mention" | "reply" | "reaction" | "keyword" | "unread" | "nextcloud";

const filters: Filter[] = ["all", "unread", "mention", "reply", "reaction", "keyword"];

const describe = (a: ActivityItem) =>
  a.kind === "mention" ? t("activity.mentioned", { room: a.conversationName })
    : a.kind === "reply" ? t("activity.replied", { room: a.conversationName })
    : a.kind === "keyword" ? t("activity.keyword", { room: a.conversationName })
    : t("activity.reacted", { emoji: a.reaction ?? "", room: a.conversationName });

const badge = (a: ActivityItem) => (a.kind === "mention" ? "@" : a.kind === "reply" ? "↩" : a.kind === "keyword" ? "#" : a.reaction);

/** What the feed's read and cleared lists know a Nextcloud notification by. */
export const serverEntry = (n: ServerItem) => ({ id: n.key, at: n.at });

interface Props {
  items: ActivityItem[];
  /** Nextcloud's own notifications (shares, invitations, …), and whether there are Nextcloud accounts. */
  server: ServerItem[];
  nextcloud: boolean;
  isUnread: (item: { id: string; at: number }) => boolean;
  selected: string | null;
  onOpen: (item: ActivityItem) => void;
  onSetRead: (item: { id: string }, read: boolean) => void;
  onMarkAllRead: () => void;
  /** Takes one item out of the feed (on this computer). */
  onRemove: (item: ActivityItem) => void;
  /** Empties the feed (on this computer); new activity shows up again. */
  onClear: () => void;
  /** Right after clearing: brings it back. */
  onUndoClear?: () => void;
  onNotice: (message: string) => void;
}

/** Teams-style Activity feed: mentions, replies, reactions and keywords aimed at you, and what Nextcloud tells you. */
export function ActivityPane({ items, server, nextcloud, isUnread: unseen, selected, onOpen, onSetRead, onMarkAllRead, onRemove, onClear, onUndoClear, onNotice }: Props) {
  const [filter, setFilter] = useState<Filter>("all");
  const [busy, setBusy] = useState<string | null>(null);
  const openLink = useOpenLink();
  const chats = filter === "nextcloud" ? [] : items.filter((a) => filter === "all" || (filter === "unread" ? unseen(a) : a.kind === filter));
  const notices = filter === "all" || filter === "nextcloud" ? server : filter === "unread" ? server.filter((n) => unseen(serverEntry(n))) : [];
  const shown: { at: number; chat?: ActivityItem; notice?: ServerItem }[] = [...chats.map((a) => ({ at: a.at, chat: a })), ...notices.map((n) => ({ at: n.at, notice: n }))].sort((a, b) => b.at - a.at);
  const anyUnseen = items.some(unseen) || server.some((n) => unseen(serverEntry(n)));

  const openNotice = (n: ServerItem) => {
    if (unseen(serverEntry(n))) onSetRead(serverEntry(n), true);
    if (n.link) openLink(n.link);
  };
  const act = (n: ServerItem, job: () => Promise<void>) => {
    setBusy(n.key);
    job().catch((e) => onNotice(String(e))).finally(() => setBusy(null));
  };

  return (
    <aside className="chat-list">
      <header className="pane-head">
        <h1>{t("activity.title")}</h1>
        <div className="head-actions">
          <button className="btn small" disabled={!anyUnseen} onClick={onMarkAllRead}>{t("activity.markAllRead")}</button>
          <button className="btn small" disabled={!items.length && !server.length} title={t("activity.clearHint")} onClick={onClear}>{t("activity.clear")}</button>
        </div>
      </header>
      {onUndoClear && <div className="activity-cleared">{t("activity.cleared")} <button className="link" onClick={onUndoClear}>{t("activity.undo")}</button></div>}
      <div className="filters">
        {[...filters, ...(nextcloud ? ["nextcloud" as const] : [])].map((f) => (
          <button key={f} className={`pill ${filter === f ? "on" : ""}`} onClick={() => setFilter(f)}>{t(`activity.filter.${f}`)}</button>
        ))}
      </div>
      <div className="list-scroll">
        {shown.length === 0 && <p className="empty">{t(filter === "nextcloud" ? "activity.emptyNextcloud" : "activity.empty")}</p>}
        {shown.map(({ chat: a, notice: n }) => a ? (
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
            <span className="activity-remove" role="button" title={t("activity.remove")} onClick={(e) => { e.stopPropagation(); onRemove(a); }}>✕</span>
            <span className="activity-toggle" role="button" title={unseen(a) ? t("activity.markRead") : t("activity.markUnread")}
              onClick={(e) => { e.stopPropagation(); onSetRead(a, unseen(a)); }} />
          </button>
        ) : n && (() => {
          // A file it's about (a recording, a share) that's in your own files.
          const file = n.subject.find((p) => p.kind === "file" && p.path)?.path?.replace(/^\/+/, "");
          return (
          // A row with buttons of its own (Accept, Decline): a div, buttons can't hold buttons.
          <div key={n.key} role="button" tabIndex={0} className={`activity server-notice ${unseen(serverEntry(n)) ? "unseen" : ""} ${busy === n.key ? "busy" : ""}`}
            title={n.link ? t("activity.openNotice") : undefined} onClick={() => openNotice(n)} onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) openNotice(n); }}>
            <NoticePicture n={n} />
            <span className="row-text">
              <span className="row-top">
                <span className="row-name">{n.subject.map((p, i) => (p.kind ? <b key={i}>{p.text}</b> : <span key={i}>{p.text}</span>))}</span>
                <span className="row-time">{formatTime(n.at)}</span>
              </span>
              {n.message && <span className="row-preview">{n.message}</span>}
              {(n.actions.length > 0 || file) && (
                <span className="notice-actions">
                  {[...n.actions].sort((x, y) => Number(y.primary) - Number(x.primary)).map((action, i) => (
                    <button key={i} className={`btn small ${action.primary ? "primary" : ""}`} disabled={busy === n.key}
                      onClick={(e) => { e.stopPropagation(); if (action.method === "WEB") openLink(action.link); else act(n, () => runServerAction(n, action)); }}>{action.label}</button>
                  ))}
                  {file && <button className="btn small" onClick={(e) => { e.stopPropagation(); showInFiles(n.account, `/${file}`); }}>{t("files.showInFiles")}</button>}
                </span>
              )}
            </span>
            <span className="activity-remove" role="button" title={t("activity.dismiss")} onClick={(e) => { e.stopPropagation(); act(n, () => dismissServerItem(n)); }}>✕</span>
            <span className="activity-toggle" role="button" title={unseen(serverEntry(n)) ? t("activity.markRead") : t("activity.markUnread")}
              onClick={(e) => { e.stopPropagation(); onSetRead(serverEntry(n), unseen(serverEntry(n))); }} />
          </div>
          );
        })())}
      </div>
    </aside>
  );
}

/** The person it's about (their picture), with the app's icon on it; or just the app's icon. */
function NoticePicture({ n }: { n: ServerItem }) {
  const person = n.subject.find((p) => p.kind === "user" && p.id);
  const icon = n.icon && <img src={n.icon} alt="" draggable={false} />;
  return (
    <span className="avatar-wrap">
      {person ? <Avatar account={n.account} media={`user:${person.id}`} name={person.text} /> : <span className="notice-icon">{icon}</span>}
      {person && icon && <span className="activity-kind notice-app">{icon}</span>}
    </span>
  );
}
