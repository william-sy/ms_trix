import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { Avatar } from "./Avatar";
import { backend, isLive } from "./backend";
import { Lightbox, MediaBody, MediaMenu, useMediaUi, type MediaActions } from "./Media";
import { EmojiPicker } from "./EmojiPicker";
import { RichText } from "./RichText";
import { LockIcon, MoreIcon, SearchIcon } from "./Icons";
import { OrgAvatar } from "./OrgSwitcher";
import { useOrg, type Action } from "./store";
import { Composer } from "./Composer";
import type { Attachment, Conversation, Message, Outgoing } from "./types";
import { t } from "./i18n";
import { RoomPanel } from "./RoomPanel";
import { useOpenProfile } from "./Profile";
import { summarize } from "./roomEvents";

interface Props {
  conv: Conversation;
  messages: Message[];
  dispatch: (a: Action) => void;
  onNotice: (message: string) => void;
  /** Loads the page before the oldest message; resolves to whether more exist. */
  onLoadOlder: () => Promise<boolean>;
  onLoadThread: (root: string) => Promise<void>;
  onCommand: (name: string, args: string) => void;
  attachments: Attachment[];
  onPickFiles: () => void;
  onAddFiles: (files: File[]) => void;
  onRemoveAttachment: (id: string) => void;
  onAccept: () => void;
  onDecline: () => void;
  onLeave: () => void;
  /** Message to scroll to and highlight (from the Activity feed). */
  focusMessage?: string | null;
}

export function ChatView({ conv, messages, dispatch, onNotice, onLoadOlder, onLoadThread, onCommand, attachments, onPickFiles, onAddFiles, onRemoveAttachment, onAccept, onDecline, onLeave, focusMessage }: Props) {
  const posts = conv.kind === "channel";
  const openProfile = useOpenProfile();
  const [panel, setPanel] = useState(false);
  const [expandedRuns, setExpandedRuns] = useState<Set<string>>(new Set());
  const toggleRun = (id: string) => setExpandedRuns((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const [headMenu, setHeadMenu] = useState(false);
  useEffect(() => {
    if (!headMenu) return;
    const close = () => setHeadMenu(false);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [headMenu]);
  const setLevel = (level: string) => backend.setNotificationLevel(conv.id, level).catch((e) => onNotice(String(e)));
  const getMembers = useMemo(() => (isLive ? () => backend.members(conv.id) : undefined), [conv.id]);
  const org = useOrg(conv.orgId);
  const scroller = useRef<HTMLDivElement>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const mediaUi = useMediaUi();
  const seen = seenLabel(conv, main(messages));
  const readBy = useMemo(() => readPositions(conv, main(messages)), [conv, messages]);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);
  // Thread replies live in the thread panel; the main timeline shows a summary on the root.
  const mainList = main(messages);
  // Each room event (system line) mapped to the run of consecutive events it belongs to.
  const runs = useMemo(() => {
    const out = new Map<string, Message[]>();
    let run: Message[] = [];
    for (const m of [...mainList, null]) {
      if (m?.system) { run.push(m); continue; }
      for (const r of run) out.set(r.id, run);
      run = [];
    }
    return out;
  }, [mainList]);
  const replies = useMemo(() => {
    const out = new Map<string, Message[]>();
    for (const m of messages) if (m.threadRoot) out.set(m.threadRoot, [...(out.get(m.threadRoot) ?? []), m]);
    return out;
  }, [messages]);

  const [hasMore, setHasMore] = useState(true);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [search, setSearch] = useState<string | null>(null);
  const [hit, setHit] = useState(0);
  const q = search?.trim().toLowerCase() ?? "";
  const hits = q ? mainList.filter((m) => !m.system && `${m.body} ${m.media?.name ?? ""}`.toLowerCase().includes(q)) : [];
  const currentHit = hits.length ? hits[Math.min(hit, hits.length - 1)] : undefined;

  useEffect(() => {
    setReplyTo(null);
    setThreadId(null);
    setHasMore(true);
    setSearch(null);
    setPanel(false);
  }, [conv.id]);

  // Stick to the bottom for new messages; keep the reading position when older ones are prepended.
  const scrollState = useRef({ conv: "", lastId: "", height: 0, top: 0 });
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const prev = scrollState.current;
    const lastId = mainList[mainList.length - 1]?.id ?? "";
    if (prev.conv !== conv.id) el.scrollTop = el.scrollHeight;
    else if (lastId !== prev.lastId) {
      if (prev.height - prev.top - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
    } else if (el.scrollHeight !== prev.height) el.scrollTop = prev.top + (el.scrollHeight - prev.height);
    scrollState.current = { conv: conv.id, lastId, height: el.scrollHeight, top: el.scrollTop };
  }, [conv.id, mainList]);

  const loadOlder = async () => {
    if (loadingOlder || !hasMore) return;
    setLoadingOlder(true);
    try {
      setHasMore(await onLoadOlder());
    } catch (e) {
      onNotice(String(e));
    } finally {
      setLoadingOlder(false);
    }
  };

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    scrollState.current = { ...scrollState.current, height: el.scrollHeight, top: el.scrollTop };
    if (el.scrollTop < 80) loadOlder();
  };

  useEffect(() => {
    if (currentHit) document.querySelector(`[data-msg="${CSS.escape(currentHit.id)}"]`)?.scrollIntoView({ block: "center" });
  }, [currentHit?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // A short chat can't be scrolled up, so keep fetching until it fills the view.
  useEffect(() => {
    const el = scroller.current;
    if (el && hasMore && !loadingOlder && el.scrollHeight <= el.clientHeight + 40) loadOlder();
  }, [conv.id, mainList.length, hasMore, loadingOlder]); // eslint-disable-line react-hooks/exhaustive-deps

  // Jump to a message from the Activity feed once it's loaded; thread replies open their thread.
  useEffect(() => {
    if (!focusMessage) return;
    const m = messages.find((x) => x.id === focusMessage);
    if (!m) return;
    if (m.threadRoot) setThreadId(m.threadRoot);
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-msg="${CSS.escape(m.threadRoot ?? m.id)}"]`);
      el?.scrollIntoView({ block: "center" });
      el?.classList.add("flash");
      window.setTimeout(() => el?.classList.remove("flash"), 1600);
    });
  }, [focusMessage, messages.length > 0 && messages.some((x) => x.id === focusMessage)]); // eslint-disable-line react-hooks/exhaustive-deps

  const openThread = (id: string) => {
    setPanel(false);
    setThreadId(id);
    onLoadThread(id).catch((e) => onNotice(String(e)));
  };

  const send = (m: Outgoing) => dispatch({ type: "send", id: conv.id, message: m });
  const isInvite = !!conv.invitedBy;
  const messageActions = (m: Message) => ({
    onReact: (emoji: string) => dispatch({ type: "react", id: conv.id, target: m.id, emoji }),
    onEdit: (text: string) => dispatch({ type: "edit", id: conv.id, target: m.id, text }),
    onDelete: () => confirm(t("chatView.deleteConfirm")) && dispatch({ type: "delete", id: conv.id, target: m.id }),
  });
  const threadRoot = threadId ? byId.get(threadId) : undefined;

  return (
    <div className={`chat-area ${posts ? "posts" : ""}`}>
      <main className="chat-view">
        <header className="chat-head">
          <button className="head-avatar" onClick={(e) => conv.dmUser ? openProfile(conv.orgId, conv.dmUser, { x: e.clientX, y: e.clientY + 16 }) : setPanel(!panel)}>
            <Avatar account={conv.orgId} media={conv.avatar} name={conv.name} className={`kind-${conv.kind}`} channel={conv.kind === "channel"} />
          </button>
          <div className="head-title">
            <h2>{conv.kind === "channel" && conv.team ? `${conv.team} › ${conv.name}` : conv.name}</h2>
            {conv.presence && (
              <span className="head-presence"><span className={`presence inline p-${conv.presence}`} /> {t(`presence.${conv.presence}`)}{conv.status ? ` · ${conv.status}` : ""}</span>
            )}
          </div>
          <nav className="tabs">
            <button className="tab on">{conv.kind === "channel" ? t("chatView.tab.posts") : t("chatView.tab.chat")}</button>
            <button className="tab" disabled title={t("chatView.tab.sharedSoon")}>{t("chatView.tab.shared")}</button>
            {conv.kind === "meeting" && <button className="tab" disabled title={t("common.comingSoon")}>{t("chatView.tab.recap")}</button>}
          </nav>
          <span className="spacer" />
          <span className="org-pill" title={`${org.name} · ${org.protocol}`}>
            <OrgAvatar org={org} size={16} /> {org.name}
          </span>
          {conv.encrypted && <span className="e2ee" title={t("chatView.encrypted")}><LockIcon /></span>}
          <button className={`icon-btn ${search !== null ? "on" : ""}`} title={t("chatView.search")} onClick={() => { setSearch(search === null ? "" : null); setHit(0); }}><SearchIcon /></button>
          <span className="emoji-anchor">
            <button className={`icon-btn ${headMenu ? "on" : ""}`} title={t("common.moreOptions")} onClick={(e) => { e.stopPropagation(); setHeadMenu(!headMenu); }}><MoreIcon /></button>
            {headMenu && (
              <div className="menu head-menu right" onClick={(e) => e.stopPropagation()}>
                {conv.dmUser && <button className="menu-item" onClick={(e) => { setHeadMenu(false); openProfile(conv.orgId, conv.dmUser!, { x: e.clientX - 300, y: e.clientY }); }}>{t("chatView.menu.viewProfile")}</button>}
                <button className="menu-item" onClick={() => { setHeadMenu(false); setThreadId(null); setPanel(true); }}>{conv.kind === "direct" ? t("chatView.menu.people") : t("chatView.menu.info")}</button>
                <div className="menu-sep" />
                <div className="menu-title">{t("chatView.menu.notifications")}</div>
                {(["all", "mentions", "mute"] as const).map((level) => (
                  <button key={level} className={`menu-item ${notifyLevel(conv) === level ? "on" : ""}`} onClick={() => { setHeadMenu(false); setLevel(level); }}>{t(`room.notify.${level}`)}</button>
                ))}
                <div className="menu-sep" />
                <button className="menu-item" onClick={() => { setHeadMenu(false); dispatch({ type: "toggleFavourite", id: conv.id }); }}>{conv.favourite ? t("chat.removeFavorite") : t("chat.addFavorite")}</button>
                <button className="menu-item danger" onClick={() => { setHeadMenu(false); onLeave(); }}>{t("chat.leave")}</button>
              </div>
            )}
          </span>
        </header>

        {search !== null && (
          <div className="chat-search">
            <SearchIcon size={16} />
            <input autoFocus value={search} placeholder={t("chatView.search")} onChange={(e) => { setSearch(e.target.value); setHit(0); }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setSearch(null);
                if (e.key === "Enter") setHit((h) => (hits.length ? (h + (e.shiftKey ? hits.length - 1 : 1)) % hits.length : 0));
              }} />
            <span className="muted">{q ? (hits.length ? t("chatView.searchCount", { n: Math.min(hit, hits.length - 1) + 1, total: hits.length }) : t("chatView.noMatches")) : ""}</span>
            <button className="icon-btn" title={t("chatView.previous")} disabled={!hits.length} onClick={() => setHit((h) => (h + hits.length - 1) % hits.length)}>↑</button>
            <button className="icon-btn" title={t("chatView.next")} disabled={!hits.length} onClick={() => setHit((h) => (h + 1) % hits.length)}>↓</button>
            {hasMore && <button className="btn small" disabled={loadingOlder} onClick={loadOlder}>{loadingOlder ? t("common.loading") : t("chatView.searchOlder")}</button>}
            <button className="icon-btn" title={t("common.closeEsc")} onClick={() => setSearch(null)}>✕</button>
          </div>
        )}

        {isInvite && (
          <div className="invite-view">
            <Avatar account={conv.orgId} media={conv.avatar} name={conv.name} className={`big kind-${conv.kind}`} channel={conv.kind === "channel"} />
            <h2>{conv.name}</h2>
            <p>{t("chatView.invitedYou", { name: conv.invitedBy ?? "", what: conv.kind === "direct" ? t("chatView.inviteChat") : t("chatView.inviteRoom") })}</p>
            <div className="invite-buttons">
              <button className="btn" onClick={() => onDecline()}>{t("common.decline")}</button>
              <button className="btn primary" onClick={() => onAccept()}>{t("common.accept")}</button>
            </div>
          </div>
        )}
        {!isInvite && <>
        <div className="messages" ref={scroller} onScroll={onScroll}>
          <div className="history-edge">{loadingOlder ? t("chatView.loadingOlder") : hasMore ? "" : t("chatView.beginning")}</div>
          {mainList.map((m, i) => {
            if (m.system) {
              // Runs of 3+ room events collapse into one summary line, like Element.
              const run = runs.get(m.id)!;
              const first = run[0]!;
              if (run.length < 3 || expandedRuns.has(first.id)) {
                return (
                  <div key={m.id} className="system-msg">
                    <span>{m.time}</span> {m.body}
                    {run.length >= 3 && m.id === run[run.length - 1]!.id && <button className="link" onClick={() => toggleRun(first.id)}>{t("event.hide")}</button>}
                  </div>
                );
              }
              if (m.id !== first.id) return null;
              return (
                <div key={m.id} className="system-msg">
                  <span>{m.time}</span> {summarize(run.filter((x) => x.event).map((x) => x.event!))}
                  <button className="link" onClick={() => toggleRun(first.id)}>{t("event.showAll")}</button>
                </div>
              );
            }
            const prev = mainList[i - 1];
            // Channels show every post as its own card, like Teams.
            const grouped = !posts && !!prev && !prev.system && prev.sender === m.sender && !m.replyTo;
            return (
              <MessageItem key={m.id} m={m} account={conv.orgId} grouped={grouped} quoted={m.replyTo ? byId.get(m.replyTo) ?? null : undefined}
                thread={replies.get(m.id)} onReply={() => setReplyTo(m)} onThread={() => openThread(m.id)} media={mediaUi.actions} {...messageActions(m)}
                status={seen && seen.messageId === m.id ? seen : undefined} readBy={readBy.get(m.id)} query={q || undefined} current={currentHit?.id === m.id} postMode={posts} />
            );
          })}
        </div>

        {!!conv.typing?.length && <div className="typing">{typingLabel(conv.typing)}</div>}
        <Composer key={conv.id} initial={conv.draft} replyTo={replyTo} placeholder={posts ? t("chatView.newPost") : undefined} onCancelReply={() => setReplyTo(null)} onTyping={(t) => isLive && backend.setTyping(conv.id, t).catch(() => {})}
          onCommand={onCommand} getMembers={getMembers}
          attachments={attachments} onPickFiles={onPickFiles} onAddFiles={onAddFiles} onRemoveAttachment={onRemoveAttachment}
          onSend={(m) => { send({ ...m, replyTo: replyTo?.id }); setReplyTo(null); }} onNotice={onNotice} />
        </>}
      </main>

      {threadId && (
        <aside className="thread-pane">
          <header className="chat-head">
            <h2>{t("chatView.thread")}</h2>
            <span className="spacer" />
            <button className="icon-btn" title={t("chatView.closeThread")} onClick={() => setThreadId(null)}>✕</button>
          </header>
          <div className="messages">
            {threadRoot ? <MessageItem m={threadRoot} account={conv.orgId} grouped={false} media={mediaUi.actions} {...messageActions(threadRoot)} /> : <p className="empty">{t("chatView.threadRootMissing")}</p>}
            <div className="thread-divider">{t("chatView.threadReplies", { count: replies.get(threadId)?.length ?? 0 })}</div>
            {(replies.get(threadId) ?? []).map((m, i, all) => (
              <MessageItem key={m.id} m={m} account={conv.orgId} grouped={i > 0 && all[i - 1]!.sender === m.sender} media={mediaUi.actions} {...messageActions(m)} />
            ))}
          </div>
          <Composer key={threadId} placeholder={t("composer.threadPlaceholder")} onSend={(m) => send({ ...m, threadRoot: threadId })} onNotice={onNotice} getMembers={getMembers} />
        </aside>
      )}

      {panel && !threadId && <RoomPanel conv={conv} onClose={() => setPanel(false)} onNotice={onNotice} />}
      {mediaUi.viewing && <Lightbox media={mediaUi.viewing} account={conv.orgId} onClose={() => mediaUi.setViewing(null)} onNotice={onNotice} />}
      {mediaUi.menu && (
        <MediaMenu {...mediaUi.menu} account={conv.orgId} onView={() => mediaUi.setViewing(mediaUi.menu!.media)} onClose={() => mediaUi.setMenu(null)} onNotice={onNotice} />
      )}
    </div>
  );
}

const main = (messages: Message[]) => messages.filter((m) => !m.threadRoot);

const notifyLevel = (c: Conversation) => (c.muted ? "mute" : c.mentionsOnly ? "mentions" : "all");

const typingLabel = (names: string[]) =>
  names.length === 1 ? t("chatView.typing1", { a: names[0]! })
    : names.length === 2 ? t("chatView.typing2", { a: names[0]!, b: names[1]! })
    : t("chatView.typingMany", { a: names[0]!, count: names.length - 1 });

type ReaderInfo = NonNullable<Conversation["readers"]>[number];

/** Element-style read markers: each person sits under the last message they've read. */
function readPositions(conv: Conversation, messages: Message[]): Map<string, ReaderInfo[]> {
  const out = new Map<string, ReaderInfo[]>();
  const visible = messages.filter((m) => !m.system && m.pos !== undefined);
  for (const reader of conv.readers ?? []) {
    let at: Message | undefined;
    for (const m of visible) {
      if (m.pos! <= reader.pos) at = m;
      else break;
    }
    if (at) out.set(at.id, [...(out.get(at.id) ?? []), reader]);
  }
  return out;
}

interface Seen {
  messageId: string;
  label: string;
  readers: { name: string; avatar?: string | null }[];
}

/** Teams-style status under your latest message: Sent, or Seen (by whom). */
function seenLabel(conv: Conversation, messages: Message[]): Seen | null {
  const mine = [...messages].reverse().find((m) => m.fromMe && !m.system);
  if (!mine) return null;
  const readers = (conv.readers ?? []).filter((r) => mine.pos !== undefined && r.pos >= mine.pos);
  if (readers.length === 0) return { messageId: mine.id, label: t("chatView.sent"), readers };
  if (conv.kind === "direct") return { messageId: mine.id, label: t("chatView.seen"), readers };
  const names = readers.map((r) => r.name.split(" ")[0]);
  return { messageId: mine.id, label: t("chatView.seenBy", { names: names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} +${names.length - 3}` }), readers };
}

// Messages that are only a few emoji are shown large, like Element does.
const emojiOnly = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u;
const isJumbo = (body: string) => emojiOnly.test(body) && [...new Intl.Segmenter().segment(body.trim())].length <= 5 && !/^[\d#*\s]+$/.test(body);

interface ItemProps {
  m: Message;
  account: string;
  grouped: boolean;
  /** undefined: not a reply; null: reply to a message that isn't loaded. */
  quoted?: Message | null;
  thread?: Message[];
  onReply?: () => void;
  onThread?: () => void;
  onReact?: (emoji: string) => void;
  onEdit?: (text: string) => void;
  onDelete?: () => void;
  media: MediaActions;
  status?: Seen;
  /** People whose read marker is at this message. */
  readBy?: ReaderInfo[];
  postMode?: boolean;
  query?: string;
  current?: boolean;
}

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

function MessageItem({ m, account, grouped, quoted, thread, onReply, onThread, onReact, onEdit, onDelete, media, status, readBy, query, current, postMode }: ItemProps) {
  const visual = m.media?.kind === "image" || m.media?.kind === "sticker";
  const openProfile = useOpenProfile();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [popup, setPopup] = useState<"emoji" | "more" | null>(null);
  const [popupStyle, setPopupStyle] = useState<CSSProperties>({});
  // Popups float above everything (position: fixed) so the message list can't clip
  // them, and open upwards when there's no room below.
  const openPopup = (kind: "emoji" | "more", e: ReactMouseEvent, height: number, width: number) => {
    e.stopPropagation();
    if (popup === kind) return setPopup(null);
    const r = e.currentTarget.getBoundingClientRect();
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
    const up = r.bottom + height + 8 > window.innerHeight;
    setPopupStyle(up ? { position: "fixed", left, right: "auto", bottom: window.innerHeight - r.top + 4, top: "auto" } : { position: "fixed", left, right: "auto", top: r.bottom + 4, bottom: "auto" });
    setPopup(kind);
  };
  const canEdit = m.fromMe && !m.media && !m.deleted && !!onEdit;
  const canDelete = m.fromMe && !m.deleted && !!onDelete;

  useEffect(() => {
    if (popup !== "more") return;
    const close = () => setPopup(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, [popup]);

  const saveEdit = () => {
    const text = draft.trim();
    if (text && text !== m.body) onEdit?.(text);
    setEditing(false);
  };

  return (
    <div className={`msg-row ${m.fromMe ? "mine" : ""}`}>
    <div data-msg={m.id} className={`msg ${m.fromMe ? "mine" : ""} ${grouped ? "grouped" : ""} ${current ? "current-hit" : ""}`}>
      {!m.fromMe && (
        <span className="msg-avatar">
          {!grouped && (
            <button className="avatar-btn" onClick={(e) => m.senderId && openProfile(account, m.senderId, { x: e.clientX + 8, y: e.clientY })}>
              <Avatar account={account} media={m.avatar} name={m.sender} className="small" />
            </button>
          )}
        </span>
      )}
      <div className="msg-col">
        {!grouped && (
          <div className="msg-meta">
            {!m.fromMe && <button className="sender" onClick={(e) => m.senderId && openProfile(account, m.senderId, { x: e.clientX, y: e.clientY + 12 })}>{m.sender}</button>} {m.time}
          </div>
        )}
        <div className="bubble-wrap">
          {editing ? (
            <div className="bubble editing">
              <textarea autoFocus value={draft} rows={Math.min(8, draft.split("\n").length + 1)} onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); saveEdit(); }
                  if (e.key === "Escape") setEditing(false);
                }} />
              <div className="edit-actions">
                <span className="muted">{t("message.editHint")}</span>
                <button className="btn small" onClick={() => setEditing(false)}>{t("common.cancel")}</button>
                <button className="btn primary small" onClick={saveEdit}>{t("common.save")}</button>
              </div>
            </div>
          ) : (
            <div className={`bubble ${m.encrypted ? "deleted" : ""} ${visual ? "media" : ""} ${m.media?.kind === "sticker" ? "sticker" : ""} ${isJumbo(m.body) && !m.media ? "jumbo" : ""} ${m.deleted ? "deleted" : ""}`}>
              {quoted !== undefined && !m.deleted && (
                <div className="quote">
                  {quoted ? <><b>{quoted.sender}</b><span>{quoted.media ? `📎 ${quoted.media.name}` : quoted.deleted ? t("message.deletedShort") : quoted.body}</span></> : <span>{t("message.replyToEarlier")}</span>}
                </div>
              )}
              {m.encrypted ? <span className="waiting-key" title={t("message.waitingKeyHint")}>{t("message.waitingKey")}</span>
                : m.deleted ? <span>{t("message.deleted")}</span>
                : m.media ? <MediaBody media={m.media} account={account} actions={media} />
                : <RichText body={m.body} html={m.html} account={account} query={query} />}
              {m.edited && !m.deleted && <span className="edited" title={t("message.editedTitle")}>{t("message.edited")}</span>}
            </div>
          )}
          {!editing && !m.deleted && !m.encrypted && (onReply || onThread || onReact) && (
            <div className={`msg-actions ${popup ? "pinned" : ""}`}>
              {onReact && QUICK_REACTIONS.map((e) => (
                <button key={e} className="icon-btn quick" title={t("message.reactWith", { emoji: e })} onClick={() => onReact(e)}>{e}</button>
              ))}
              {onReact && (
                <span className="emoji-anchor">
                  <button className={`icon-btn ${popup === "emoji" ? "on" : ""}`} title={t("message.moreReactions")} onClick={(e) => openPopup("emoji", e, 320, 352)}>＋</button>
                  {popup === "emoji" && <EmojiPicker style={popupStyle} onPick={(e) => { onReact(e); setPopup(null); }} onClose={() => setPopup(null)} />}
                </span>
              )}
              {onReact && <span className="sep" />}
              {onReply && <button className="icon-btn" title={t("message.reply")} onClick={onReply}>↩</button>}
              {onThread && <button className="icon-btn" title={t("chatView.replyInThread")} onClick={onThread}>💬</button>}
              <span className="emoji-anchor">
                <button className={`icon-btn ${popup === "more" ? "on" : ""}`} title={t("common.moreOptions")} onClick={(e) => openPopup("more", e, 130, 160)}>⋯</button>
                {popup === "more" && (
                  <div className="menu more-menu" style={popupStyle} onClick={(e) => e.stopPropagation()}>
                    {canEdit && <button className="menu-item" onClick={() => { setDraft(m.body); setEditing(true); setPopup(null); }}>{t("message.edit")}</button>}
                    {!m.media && <button className="menu-item" onClick={() => { navigator.clipboard.writeText(m.body).catch(() => {}); setPopup(null); }}>{t("message.copy")}</button>}
                    {canDelete && <button className="menu-item danger" onClick={() => { setPopup(null); onDelete?.(); }}>{t("message.delete")}</button>}
                  </div>
                )}
              </span>
            </div>
          )}
        </div>
        {!!m.reactions?.length && (
          <div className="reactions">
            {m.reactions.map((r) => (
              <button key={r.key} className={`reaction ${r.mine ? "mine" : ""}`} title={r.senders.join(", ")} onClick={() => onReact?.(r.key)} disabled={!onReact}>
                {r.key} <span>{r.count}</span>
              </button>
            ))}
          </div>
        )}
        {status && <div className="seen">{status.label}</div>}
        {postMode && !thread?.length && onThread && !m.deleted && <button className="thread-summary" onClick={onThread}>{t("message.replyPost")}</button>}
        {thread && thread.length > 0 && (
          <button className="thread-summary" onClick={onThread}>
            {t("chatView.threadSummary", { count: thread.length, name: thread[thread.length - 1]!.sender })}
          </button>
        )}
      </div>
    </div>
    {/* Element-style read markers in the right margin: who read up to here. */}
    {!!readBy?.length && (
      <div className="read-markers" title={t("chatView.readUpTo", { names: readBy.map((r) => r.name).join(", ") })}>
        {readBy.slice(0, 3).map((r) => <Avatar key={r.userId} account={account} media={r.avatar ?? undefined} name={r.name} className="tiny" />)}
        {readBy.length > 3 && <span className="more-readers">+{readBy.length - 3}</span>}
      </div>
    )}
    </div>
  );
}
