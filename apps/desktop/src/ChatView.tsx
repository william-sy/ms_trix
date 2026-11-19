import { Fragment, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent } from "react";
import { Avatar } from "./Avatar";
import { backend, formatTime, isLive, type ScheduledMessage, type SearchHit, type UploadProgress } from "./backend";
import { Highlight } from "./TitleBar";
import { Lightbox, MediaBody, MediaMenu, useMediaUi, type MediaActions } from "./Media";
import { EmojiPicker } from "./EmojiPicker";
import { RichText } from "./RichText";
import { CallIcon, CameraIcon, LockIcon, MoreIcon, SearchIcon, ThreadsIcon } from "./Icons";
import { ThreadsPanel } from "./ThreadsPanel";
import { IdentityBanner } from "./IdentityBanner";
import { OrgAvatar } from "./OrgSwitcher";
import { useOrg, useOrgs, type Action } from "./store";
import { CloudFilePicker } from "./CloudFilePicker";
import { Composer } from "./Composer";
import { ForwardDialog } from "./ForwardDialog";
import type { Attachment, CloudFile, Conversation, Member, Message, Outgoing } from "./types";
import { locale, t } from "./i18n";
import { currentSettings } from "./settings";
import { matches } from "./shortcuts";
import { ChatEffect } from "./ChatEffect";
import { useCalls } from "./calls";
import { lastCameraOn, useTalkCalls } from "./talkCalls";
import { KeyHelpContext } from "./Security";
import { SharedPane } from "./SharedPane";
import { PollCard, PollDialog } from "./Poll";
import { effectFor, type EffectName } from "./effects";
import { RoomPanel } from "./RoomPanel";
import { LinkPreview, previewLink } from "./LinkPreview";
import { useScheduled, whenLabel } from "./scheduled";
import { parseQuery, queryMatches } from "./searchQuery";
import { useOpenProfile } from "./Profile";
import { summarize } from "./roomEvents";
import { capabilities } from "./mock";

interface Props {
  conv: Conversation;
  messages: Message[];
  dispatch: (a: Action) => void;
  onNotice: (message: string) => void;
  /** Loads the page before the oldest message; resolves to whether more exist. */
  /** `limit`: page size; bigger when jumping far back. */
  onLoadOlder: (limit?: number) => Promise<boolean>;
  onLoadThread: (root: string) => Promise<void>;
  onCommand: (name: string, args: string) => void;
  attachments: Attachment[];
  /** File upload in progress for this chat. */
  upload?: UploadProgress;
  /** Quick preview of a message that isn't loaded (older search matches). */
  onPreview?: (message: string) => void;
  /** Files waiting in a thread's own composer. */
  threadAttachments: (root: string) => Attachment[];
  /** With `root`: for that thread's composer. */
  onPickFiles: (root?: string) => void;
  onAddFiles: (files: File[], root?: string) => void;
  onRemoveAttachment: (id: string, root?: string) => void;
  onAccept: () => void;
  onDecline: () => void;
  onLeave: () => void;
  /** Every chat, for picking where to forward a message. */
  allConvs: Conversation[];
  /** Message to scroll to and highlight (from the Activity feed). */
  focusMessage?: string | null;
}

export function ChatView({ conv, messages, dispatch, onNotice, onLoadOlder, onLoadThread, onCommand, attachments, threadAttachments, onPickFiles, onAddFiles, onRemoveAttachment, onAccept, onDecline, onLeave, focusMessage, upload, onPreview, allConvs }: Props) {
  const posts = conv.kind === "channel";
  const openProfile = useOpenProfile();
  // Send later: what's waiting here, and a scheduled message put back in the composer to edit.
  const scheduled = useScheduled(conv.id);
  const [seed, setSeed] = useState<{ text: string; n: number } | null>(null);
  useEffect(() => setSeed(null), [conv.id]);
  const [panel, setPanel] = useState(false);
  const [threadsOpen, setThreadsOpen] = useState(false);
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
  // Calls open the protocol's own call screen in a separate window (Talk for now).
  const canCall = capabilities[org.protocol].calls && !conv.invitedBy;
  // Matrix: 1:1 calls in direct chats (group calls need MatrixRTC, which the server lacks).
  const calls = useCalls();
  const canMatrixCall = isLive && org.protocol === "matrix" && conv.kind === "direct" && !!conv.dmUser && !conv.invitedBy;
  const inThisCall = calls?.call && calls.call.conversation === conv.id && calls.call.phase !== "ended";
  const talkCalls = useTalkCalls();
  const inThisTalkCall = talkCalls?.call && talkCalls.call.conversation === conv.id && talkCalls.call.phase !== "ended";
  const talkBusy = !!talkCalls?.call && talkCalls.call.phase !== "ended";
  const openCall = () =>
    isLive ? backend.openCall(conv.id, t("call.window", { name: conv.name })).catch((e) => onNotice(String(e))) : onNotice(t("desktopOnly.newChat"));
  const scroller = useRef<HTMLDivElement>(null);
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [forwarding, setForwarding] = useState<Message | null>(null);
  const [threadId, setThreadId] = useState<string | null>(null);
  const mediaUi = useMediaUi();
  // Who read which of your messages: Message status (⋯ or right-click on the message).
  const [statusOf, setStatusOf] = useState<Message | null>(null);
  // Own messages show WhatsApp-like ticks: ⏱ sending, ✓ sent, ✓✓ read by someone.
  const seenUpTo = Math.max(-1, ...(conv.readers ?? []).map((r) => r.pos));
  const tickOf = (m: Message): Tick | undefined =>
    !m.fromMe || m.system ? undefined : m.status ?? (m.local ? "sent" : m.pos !== undefined && m.pos <= seenUpTo ? "seen" : "sent");
  const localActions = (m: Message) => (m.local ? {
    onRetry: () => dispatch({ type: "retrySend", id: conv.id, txn: m.local!.txn }),
    onDiscard: () => dispatch({ type: "discardLocal", id: conv.id, txn: m.local!.txn }),
  } : { ...messageActions(m), onStatus: m.fromMe && !m.system ? () => setStatusOf(m) : undefined });
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
  const searchInput = useRef<HTMLInputElement>(null);
  const [hit, setHit] = useState(0);
  const q = search?.trim().toLowerCase() ?? "";
  // The same syntax as the main search: words, "exact phrases", *wildcards*.
  const parsed = useMemo(() => parseQuery(q), [q]);
  const hits = q ? mainList.filter((m) => !m.system && queryMatches(parsed, `${m.body} ${m.media?.name ?? ""}`)) : [];
  const currentHit = hits.length ? hits[Math.min(hit, hits.length - 1)] : undefined;
  // Full-history matches (local index) that aren't among the loaded messages.
  const [historyHits, setHistoryHits] = useState<SearchHit[]>([]);
  useEffect(() => {
    if (!isLive || q.length < 2) return setHistoryHits([]);
    const timer = window.setTimeout(() => backend.searchMessages(q, conv.id).then(setHistoryHits).catch(() => setHistoryHits([])), 250);
    return () => window.clearTimeout(timer);
  }, [q, conv.id]);
  const olderHits = historyHits.filter((h) => !messages.some((m) => m.id === h.message));

  // Chat effects play for messages that arrive while the chat is open, not for history.
  const [effect, setEffect] = useState<EffectName | null>(null);
  const newest = mainList[mainList.length - 1];
  const lastSeen = useRef<{ conv: string; id?: string }>({ conv: conv.id });
  useEffect(() => {
    const prev = lastSeen.current;
    lastSeen.current = { conv: conv.id, id: newest?.id };
    if (prev.conv !== conv.id || !prev.id || !newest || newest.id === prev.id || newest.system) return;
    const name = effectFor(newest.body);
    if (name) setEffect(name);
  }, [conv.id, newest?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // ⌘F / Ctrl+F: search in this chat.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (matches(e, "findInChat")) {
        e.preventDefault();
        setSearch((s) => s ?? "");
        setHit(0);
        requestAnimationFrame(() => searchInput.current?.select());
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    setReplyTo(null);
    setThreadId(null);
    setHasMore(true);
    setSearch(null);
    setPanel(false);
    setThreadsOpen(false);
  }, [conv.id]);

  // Stick to the bottom for new messages; keep the reading position when older ones are prepended.
  // New chat: start at the bottom. New message at the end: follow it if we were at the bottom.
  // Older messages added at the top: keep what's on screen in place. Anything else (a picture
  // finishing loading, a reaction) leaves the scroll position alone.
  const scrollState = useRef({ conv: "", firstId: "", lastId: "", height: 0, top: 0 });
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const prev = scrollState.current;
    const firstId = mainList[0]?.id ?? "";
    const lastId = mainList[mainList.length - 1]?.id ?? "";
    if (prev.conv !== conv.id) el.scrollTop = el.scrollHeight;
    else if (lastId !== prev.lastId) {
      if (prev.height - prev.top - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
    } else if (firstId !== prev.firstId && el.scrollHeight !== prev.height) el.scrollTop = prev.top + (el.scrollHeight - prev.height);
    scrollState.current = { conv: conv.id, firstId, lastId, height: el.scrollHeight, top: el.scrollTop };
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

  // More than a screen up from the newest message: offer a jump back down.
  const [awayFromLatest, setAwayFromLatest] = useState(false);
  useEffect(() => setAwayFromLatest(false), [conv.id]);
  const toLatest = () => scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    setAwayFromLatest(el.scrollHeight - el.scrollTop - el.clientHeight > el.clientHeight);
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

  // Jump target: a search hit picked here, or a message opened from Activity / global search.
  const [jump, setJump] = useState<string | null>(null);
  const [tab, setTab] = useState<"chat" | "shared">("chat");
  const [pollDialog, setPollDialog] = useState(false);
  const [cloudPicker, setCloudPicker] = useState(false);
  // Nextcloud accounts to attach files from; this chat's own account first (shares become file messages).
  const allOrgs = useOrgs();
  const cloudAccounts = isLive ? allOrgs.filter((o) => o.protocol === "talk").sort((a, b) => Number(b.id === conv.orgId) - Number(a.id === conv.orgId)) : [];
  const attachCloud = async (account: string, file: CloudFile) => {
    const link = await backend.attachCloudFile(account, file.path, conv.id, null);
    if (link) send({ text: `📎 ${file.name}\n${link}` });
    setCloudPicker(false);
  };
  useEffect(() => setTab("chat"), [conv.id]);
  const target = jump ?? focusMessage;
  useEffect(() => setJump(null), [conv.id]);
  // Not loaded yet: page back until it is (bounded), then the effect below scrolls to it.
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const [seeking, setSeeking] = useState(false);
  useEffect(() => {
    if (!target || messagesRef.current.some((x) => x.id === target)) return;
    let cancelled = false;
    (async () => {
      setSeeking(true);
      try {
        // Bounded (about 10,000 messages back): a deleted message would otherwise page
        // through the whole history.
        for (let page = 0; page < 40 && !cancelled; page++) {
          const more = await onLoadOlder(250);
          setHasMore(more);
          await new Promise((r) => requestAnimationFrame(r)); // let the new messages render
          if (!more || messagesRef.current.some((x) => x.id === target)) break;
        }
        if (!cancelled && !messagesRef.current.some((x) => x.id === target)) onNotice(t("chatView.jumpNotFound"));
      } catch (e) {
        onNotice(String(e));
      } finally {
        if (!cancelled) setSeeking(false);
      }
    })();
    return () => { cancelled = true; setSeeking(false); };
  }, [target, conv.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // /jumptodate: load back until that day is reached, then jump to its first message.
  const jumpToDate = async (args: string) => {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(args.trim());
    const ts = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime() : NaN;
    if (Number.isNaN(ts)) return onNotice(t("chatView.jumpDateUsage"));
    setSeeking(true);
    try {
      for (let page = 0; page < 200; page++) {
        const [, oldest] = await backend.messageAt(conv.id, ts);
        if (oldest !== null && oldest <= ts) break;
        const more = await onLoadOlder(250);
        setHasMore(more);
        if (!more) break;
      }
      const [first] = await backend.messageAt(conv.id, ts);
      if (first) setJump(first);
      else onNotice(t("chatView.jumpDateNone"));
    } catch (e) {
      onNotice(String(e));
    } finally {
      setSeeking(false);
    }
  };

  // Scroll to the jump target once it's loaded; thread replies open their thread.
  useEffect(() => {
    if (!target) return;
    const m = messages.find((x) => x.id === target);
    if (!m) return;
    if (m.threadRoot) setThreadId(m.threadRoot);
    requestAnimationFrame(() => {
      const el = document.querySelector(`[data-msg="${CSS.escape(m.threadRoot ?? m.id)}"]`);
      el?.scrollIntoView({ block: "center" });
      el?.classList.add("flash");
      window.setTimeout(() => el?.classList.remove("flash"), 1600);
    });
  }, [target, messages.length > 0 && messages.some((x) => x.id === target)]); // eslint-disable-line react-hooks/exhaustive-deps

  const openThread = (id: string) => {
    setPanel(false);
    setThreadsOpen(false);
    setThreadId(id);
    onLoadThread(id).catch((e) => onNotice(String(e)));
  };

  const send = (m: Outgoing) => dispatch({ type: "send", id: conv.id, message: m });
  const isInvite = !!conv.invitedBy;
  const messageActions = (m: Message) => ({
    onReact: (emoji: string) => dispatch({ type: "react", id: conv.id, target: m.id, emoji }),
    onEdit: (text: string) => dispatch({ type: "edit", id: conv.id, target: m.id, text }),
    onDelete: () => confirm(t("chatView.deleteConfirm")) && dispatch({ type: "delete", id: conv.id, target: m.id }),
    onForward: () => setForwarding(m),
  });
  const threadRoot = threadId ? byId.get(threadId) : undefined;

  return (
    <div className={`chat-area ${posts ? "posts" : ""}`}>
      {effect && <ChatEffect name={effect} onDone={() => setEffect(null)} />}
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
            <button className={`tab ${tab === "chat" ? "on" : ""}`} onClick={() => setTab("chat")}>{conv.kind === "channel" ? t("chatView.tab.posts") : t("chatView.tab.chat")}</button>
            <button className={`tab ${tab === "shared" ? "on" : ""}`} onClick={() => setTab("shared")}>{t("chatView.tab.shared")}</button>
            {conv.kind === "meeting" && <button className="tab" disabled title={t("common.comingSoon")}>{t("chatView.tab.recap")}</button>}
          </nav>
          <span className="spacer" />
          <span className="org-pill" title={`${org.name} · ${org.protocol}`}>
            <OrgAvatar org={org} size={16} /> {org.name}
          </span>
          {conv.encrypted && <span className="e2ee" title={t("chatView.encrypted")}><LockIcon /></span>}
          {canMatrixCall && (inThisCall ? (
            <button className="btn primary small call-join" onClick={() => calls?.setMinimized(false)}><CallIcon /> {t("mxcall.show")}</button>
          ) : (
            <>
              <button className="icon-btn" title={t("mxcall.voice")} disabled={!!calls?.call && calls.call.phase !== "ended"} onClick={() => calls?.start(conv.id, conv.orgId, conv.dmUser!, false)}><CallIcon /></button>
              <button className="icon-btn" title={t("mxcall.video")} disabled={!!calls?.call && calls.call.phase !== "ended"} onClick={() => calls?.start(conv.id, conv.orgId, conv.dmUser!, true)}><CameraIcon /></button>
            </>
          ))}
          {/* Talk: calls run in ms_trix's own call screen; Talk's window stays in the ⋯ menu. */}
          {canCall && (inThisTalkCall ? (
            <button className="btn primary small call-join" onClick={() => talkCalls?.show()}><CallIcon /> {t("mxcall.show")}</button>
          ) : conv.callActive ? (
            <button className="btn primary small call-join" title={t("call.joinTitle")} disabled={talkBusy} onClick={() => talkCalls?.start(conv.id, lastCameraOn())}><CallIcon /> {t("call.join")}</button>
          ) : (
            <>
              <button className="icon-btn" title={t("mxcall.voice")} disabled={talkBusy} onClick={() => talkCalls?.start(conv.id, false)}><CallIcon /></button>
              <button className="icon-btn" title={t("mxcall.video")} disabled={talkBusy} onClick={() => talkCalls?.start(conv.id, true)}><CameraIcon /></button>
            </>
          ))}
          {isLive && org.protocol === "matrix" && !isInvite && (
            <button className={`icon-btn ${threadsOpen ? "on" : ""}`} title={t("threads.title")} onClick={() => { setPanel(false); setThreadId(null); setThreadsOpen(!threadsOpen); }}><ThreadsIcon /></button>
          )}
          <button className={`icon-btn ${search !== null ? "on" : ""}`} title={t("chatView.search")} onClick={() => { setSearch(search === null ? "" : null); setHit(0); }}><SearchIcon /></button>
          <span className="emoji-anchor">
            <button className={`icon-btn ${headMenu ? "on" : ""}`} title={t("common.moreOptions")} onClick={(e) => { e.stopPropagation(); setHeadMenu(!headMenu); }}><MoreIcon /></button>
            {headMenu && (
              <div className="menu head-menu right" onClick={(e) => e.stopPropagation()}>
                {conv.dmUser && <button className="menu-item" onClick={(e) => { setHeadMenu(false); openProfile(conv.orgId, conv.dmUser!, { x: e.clientX - 300, y: e.clientY }); }}>{t("chatView.menu.viewProfile")}</button>}
                <button className="menu-item" onClick={() => { setHeadMenu(false); setThreadId(null); setThreadsOpen(false); setPanel(true); }}>{conv.kind === "direct" ? t("chatView.menu.people") : t("chatView.menu.info")}</button>
                {canCall && <button className="menu-item" onClick={() => { setHeadMenu(false); openCall(); }}>{t("talkcall.openInTalk")}</button>}
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
            <input ref={searchInput} autoFocus value={search} placeholder={t("chatView.search")} onChange={(e) => { setSearch(e.target.value); setHit(0); }}
              onKeyDown={(e) => {
                if (e.key === "Escape") setSearch(null);
                if (e.key === "Enter") setHit((h) => (hits.length ? (h + (e.shiftKey ? hits.length - 1 : 1)) % hits.length : 0));
              }} />
            <span className="muted">{q ? (hits.length ? t("chatView.searchCount", { n: Math.min(hit, hits.length - 1) + 1, total: hits.length }) : t("chatView.noMatches")) : ""}</span>
            <button className="icon-btn" title={t("chatView.previous")} disabled={!hits.length} onClick={() => setHit((h) => (h + hits.length - 1) % hits.length)}>↑</button>
            <button className="icon-btn" title={t("chatView.next")} disabled={!hits.length} onClick={() => setHit((h) => (h + 1) % hits.length)}>↓</button>
            <button className="icon-btn" title={t("common.closeEsc")} onClick={() => setSearch(null)}>✕</button>
          </div>
        )}
        {search !== null && olderHits.length > 0 && (
          <div className="history-hits">
            <div className="menu-title">{t("chatView.olderMatches", { count: olderHits.length })}</div>
            {olderHits.map((h) => (
              <button key={h.message} className="search-hit" onClick={() => (onPreview ? onPreview(h.message) : setJump(h.message))}>
                <span className="hit-top"><b>{h.senderName || t("search.you")}</b><span className="row-time">{formatTime(h.at)}</span></span>
                <span className="hit-text"><Highlight text={h.snippet} query={q} /></span>
              </button>
            ))}
          </div>
        )}
        {seeking && <div className="seeking">{t("chatView.seeking")}</div>}

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
        {!isInvite && tab === "shared" && (
          <SharedPane account={conv.orgId} conversation={conv.id} media={mediaUi.actions} onJump={(id) => { setTab("chat"); setJump(id); }} />
        )}
        {!isInvite && tab === "chat" && <>
        {org.protocol === "matrix" && conv.encrypted && <IdentityBanner account={conv.orgId} conversation={conv.id} onNotice={onNotice} />}
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
            const next = mainList[i + 1];
            // Like Teams: messages from the same person within a few minutes form one block
            // with one header; a post that has replies always stands on its own.
            const grouped = !!prev && follows(prev, m) && !(posts && replies.get(prev.id)?.length);
            const runContinues = !!next && follows(m, next) && !(posts && replies.get(m.id)?.length);
            return (
              <Fragment key={m.id}>
              {newDay(prev, m) && <div className="day-divider"><span>{dayLabel(m.ts!)}</span></div>}
              <MessageItem m={m} account={conv.orgId} conversation={conv.id} grouped={grouped} lastInRun={!runContinues} quoted={m.replyTo ? byId.get(m.replyTo) ?? null : undefined}
                thread={replies.get(m.id)} onReply={m.local ? undefined : () => setReplyTo(m)} onThread={m.local ? undefined : () => openThread(m.id)} media={mediaUi.actions} {...localActions(m)} tick={tickOf(m)}
                query={q || undefined} current={currentHit?.id === m.id} postMode={posts} />
              </Fragment>
            );
          })}
          {scheduled.map((s) => (
            <ScheduledItem key={s.id} message={s} account={conv.orgId}
              onEdit={() => void backend.cancelScheduled(s.id).then((m) => m && setSeed({ text: m.text, n: Date.now() })).catch((e) => onNotice(String(e)))} />
          ))}
        </div>
        {/* Outside the scroller (a zero-height strip just below it), so showing it
            doesn't change the scroll height and make the list jump. */}
        <div className="jump-latest-anchor">
          {awayFromLatest && <button className="jump-latest" onClick={toLatest} title={t("chatView.toLatest")}>↓ {t("chatView.toLatest")}</button>}
        </div>

        {!!conv.typing?.length && <div className="typing">{typingLabel(conv.typing)}</div>}
        {upload && upload.total > 0 && (
          <div className="upload-progress" title={upload.name}>
            <span>{t("chatView.uploading", { name: upload.name, percent: Math.round((upload.sent / upload.total) * 100) })}</span>
            <progress max={upload.total} value={upload.sent} />
          </div>
        )}
        <Composer key={`${conv.id}:${seed?.n ?? 0}`} initial={seed?.text ?? conv.draft} replyTo={replyTo} placeholder={posts ? t("chatView.newPost") : undefined} onCancelReply={() => setReplyTo(null)} onTyping={(t) => isLive && currentSettings().shareTyping && backend.setTyping(conv.id, t).catch(() => {})}
          onCommand={(name, args) => {
            if (name === "jumptodate") return void jumpToDate(args);
            if (name === "poll") return setPollDialog(true);
            // Hold applies to the call in this chat, handled by the call engine here.
            if (name === "holdcall" || name === "unholdcall") {
              if (!inThisCall || calls?.call?.phase !== "connected") return onNotice(t("mxcall.noCall"));
              return calls.setHold(name === "holdcall");
            }
            onCommand(name, args);
          }} getMembers={getMembers}
          attachments={attachments} onPickFiles={onPickFiles} onPickCloud={cloudAccounts.length && !isInvite ? () => setCloudPicker(true) : undefined} onAddFiles={onAddFiles} onRemoveAttachment={onRemoveAttachment}
          onSend={(m) => { send({ ...m, replyTo: replyTo?.id }); setReplyTo(null); }} onNotice={onNotice}
          onSchedule={isLive ? (m, at) => {
            backend.scheduleMessage(conv.id, { ...m, replyTo: replyTo?.id }, at).catch((e) => onNotice(String(e)));
            setReplyTo(null);
          } : undefined}
          onVoice={isLive ? (v) => backend.sendVoice(conv.id, v).catch((e) => onNotice(String(e))) : undefined}
          account={conv.orgId} getPacks={isLive && org.protocol === "matrix" ? () => backend.imagePacks(conv.id) : undefined}
          onSticker={isLive && org.protocol === "matrix" ? (img) => backend.sendSticker(conv.id, img.url, img.body ?? img.shortcode).catch((e) => onNotice(String(e))) : undefined} />
        </>}
      </main>

      {threadId && (
        // Files dropped here go into this thread (see the drop handler in App).
        <aside className="thread-pane" data-thread-root={threadId}>
          <header className="chat-head">
            <h2>{t("chatView.thread")}</h2>
            <span className="spacer" />
            <button className="icon-btn" title={t("chatView.closeThread")} onClick={() => setThreadId(null)}>✕</button>
          </header>
          <div className="messages">
            {threadRoot ? <MessageItem m={threadRoot} account={conv.orgId} conversation={conv.id} grouped={false} media={mediaUi.actions} {...messageActions(threadRoot)} /> : <p className="empty">{t("chatView.threadRootMissing")}</p>}
            <div className="thread-divider">{t("chatView.threadReplies", { count: replies.get(threadId)?.length ?? 0 })}</div>
            {(replies.get(threadId) ?? []).map((m, i, all) => (
              <MessageItem key={m.id} m={m} account={conv.orgId} conversation={conv.id} grouped={i > 0 && all[i - 1]!.sender === m.sender} media={mediaUi.actions} {...localActions(m)} tick={tickOf(m)} />
            ))}
          </div>
          <Composer key={threadId} placeholder={t("composer.threadPlaceholder")} onSend={(m) => send({ ...m, threadRoot: threadId })} onNotice={onNotice} getMembers={getMembers}
            attachments={threadAttachments(threadId)} onPickFiles={() => onPickFiles(threadId)} onAddFiles={(files) => onAddFiles(files, threadId)} onRemoveAttachment={(id) => onRemoveAttachment(id, threadId)} />
        </aside>
      )}

      {threadsOpen && !threadId && <ThreadsPanel account={conv.orgId} conversation={conv.id} onOpen={openThread} onClose={() => setThreadsOpen(false)} />}
      {panel && !threadId && <RoomPanel conv={conv} onClose={() => setPanel(false)} onNotice={onNotice} />}
      {cloudPicker && <CloudFilePicker accounts={cloudAccounts} onPick={attachCloud} onClose={() => setCloudPicker(false)} />}
      {statusOf && <MessageStatus conv={conv} message={statusOf} onClose={() => setStatusOf(null)} />}
      {pollDialog && <PollDialog conversation={conv.id} onClose={() => setPollDialog(false)} onError={onNotice} />}
      {forwarding && <ForwardDialog message={forwarding} from={conv.id} convs={allConvs} onClose={() => setForwarding(null)}
        onDone={(name) => { setForwarding(null); onNotice(t("forward.done", { name })); }} />}
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

/** Who has read one of your messages, and who hasn't yet (the chat's other members). */
function MessageStatus({ conv, message, onClose }: { conv: Conversation; message: Message; onClose: () => void }) {
  const org = useOrg(conv.orgId);
  const [members, setMembers] = useState<Member[] | null>(isLive ? null : []);
  useEffect(() => {
    if (isLive) backend.members(conv.id).then(setMembers).catch(() => setMembers([]));
  }, [conv.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const read = (conv.readers ?? []).filter((r) => message.pos !== undefined && r.pos >= message.pos && r.userId !== org.userId);
  const unread = (members ?? []).filter((p) => p.userId !== org.userId && !read.some((r) => r.userId === p.userId));
  const person = (p: { userId: string; name: string; avatar?: string | null }) => (
    <div key={p.userId} className="status-person">
      <Avatar account={conv.orgId} media={p.avatar ?? undefined} name={p.name} className="small" />
      <span>{p.name}</span>
    </div>
  );
  return (
    <div className="login-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="login-card message-status">
        <button className="icon-btn close" onClick={onClose} title={t("common.closeEsc")}>✕</button>
        <h1>{t("status.title")}</h1>
        <p className="status-quote">{message.media ? `📎 ${message.media.name}` : message.body}</p>
        <p className="muted">{t("status.sent", { time: message.time })}</p>
        <h4>✓✓ {t("status.read", { count: read.length })}</h4>
        {read.length ? read.map(person) : <p className="muted">{t("status.nobodyYet")}</p>}
        <h4>✓ {t("status.notRead", { count: unread.length })}</h4>
        {members === null ? <p className="muted">{t("common.loading")}</p> : unread.length ? unread.map(person) : <p className="muted">{t("status.everyone")}</p>}
        <p className="hint">{t("status.hint")}</p>
      </div>
    </div>
  );
}

// Messages that are only a few emoji are shown large, like Element does.
const emojiOnly = /^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️|\s)+$/u;
/** A message made of just a few custom emoji (and spaces) shows big, like plain emoji. */
const onlyCustomEmoji = (html?: string) =>
  !!html && /data-mx-emoticon/.test(html) && html.replace(/<img[^>]*data-mx-emoticon[^>]*>/g, "").replace(/<\/?p>|&nbsp;|\s/g, "") === "" && (html.match(/data-mx-emoticon/g)?.length ?? 0) <= 5;
const isJumbo = (body: string) => emojiOnly.test(body) && [...new Intl.Segmenter().segment(body.trim())].length <= 5 && !/^[\d#*\s]+$/.test(body);

/** Messages this close together from the same person share one header, like Teams. */
const GROUP_GAP = 5 * 60_000;

const sameDay = (a: number, b: number) => new Date(a).toDateString() === new Date(b).toDateString();

/** Whether `m` continues the block `prev` started. */
const follows = (prev: Message, m: Message) =>
  !prev.system && !m.system && prev.sender === m.sender && !m.replyTo && !!prev.ts && !!m.ts && m.ts - prev.ts < GROUP_GAP && sameDay(prev.ts, m.ts);

const newDay = (prev: Message | undefined, m: Message) => !!m.ts && (!prev?.ts || !sameDay(prev.ts, m.ts));

const shortTime = (ts: number) => new Date(ts).toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" });

/** "Today", "Yesterday", or the date (with the year when it isn't this year). */
function dayLabel(ts: number): string {
  const now = Date.now();
  if (sameDay(ts, now)) return t("chatView.today");
  if (sameDay(ts, now - 86_400_000)) return t("chatView.yesterday");
  const d = new Date(ts);
  return d.toLocaleDateString(locale(), { weekday: "long", day: "numeric", month: "long", ...(d.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}) });
}

type Tick = "sending" | "sent" | "seen" | "failed";

interface ItemProps {
  conversation?: string;
  m: Message;
  account: string;
  grouped: boolean;
  /** Last of a block from one sender (channels show "Reply" once per block). */
  lastInRun?: boolean;
  /** undefined: not a reply; null: reply to a message that isn't loaded. */
  quoted?: Message | null;
  thread?: Message[];
  onReply?: () => void;
  onThread?: () => void;
  onReact?: (emoji: string) => void;
  onEdit?: (text: string) => void;
  onDelete?: () => void;
  /** Our own message's state: ⏱ sending, ✓ sent, ✓✓ read, or not sent. */
  tick?: Tick;
  /** A message that couldn't be sent: try again, or drop it. */
  onRetry?: () => void;
  onDiscard?: () => void;
  onForward?: () => void;
  media: MediaActions;
  /** Your own message: who has read it. */
  onStatus?: () => void;
  postMode?: boolean;
  query?: string;
  current?: boolean;
}

const QUICK_REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"];

/** A message waiting to be sent later, at the bottom of the chat. */
function ScheduledItem({ message, account, onEdit }: { message: ScheduledMessage; account: string; onEdit: () => void }) {
  // Mentions read as names, not as their markdown links.
  const text = message.text.replace(/\[([^\]]+)\]\(https:\/\/matrix\.to\/[^)]+\)/g, "$1");
  return (
    <div className="scheduled-msg">
      <div className="scheduled-bubble"><RichText body={text} account={account} /></div>
      <div className="scheduled-meta">
        🕓 {t("schedule.at", { time: whenLabel(message.at) })}
        {message.error && <span className="scheduled-error" title={message.error}> · {t("schedule.retrying")}</span>}
        {" · "}<button className="link" onClick={() => void backend.sendScheduledNow(message.id)}>{t("schedule.sendNow")}</button>
        {" · "}<button className="link" onClick={onEdit}>{t("schedule.edit")}</button>
        {" · "}<button className="link" onClick={() => void backend.cancelScheduled(message.id)}>{t("schedule.delete")}</button>
      </div>
    </div>
  );
}

function MessageItem({ m, account, conversation, grouped, lastInRun = true, quoted, thread, onReply, onThread, onReact, onEdit, onDelete, onForward, media, onStatus, query, current, postMode, tick, onRetry, onDiscard }: ItemProps) {
  const keyHelp = useContext(KeyHelpContext)(account);
  const visual = m.media?.kind === "image" || m.media?.kind === "sticker";
  const previewUrl = useMemo(() => (m.deleted || m.media || m.poll ? undefined : previewLink(m.body, m.html)), [m.deleted, m.media, m.poll, m.body, m.html]);
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
  // Right-click on a message: the same menu as ⋯, at the pointer.
  const onContextMenu = (e: ReactMouseEvent) => {
    if (editing || m.deleted || m.encrypted || m.local || !(onReply || onReact || onStatus)) return;
    e.preventDefault();
    e.stopPropagation();
    const [width, height] = [180, 200];
    const left = Math.max(8, Math.min(e.clientX, window.innerWidth - width - 8));
    const up = e.clientY + height + 8 > window.innerHeight;
    setPopupStyle(up ? { position: "fixed", left, right: "auto", bottom: window.innerHeight - e.clientY, top: "auto" } : { position: "fixed", left, right: "auto", top: e.clientY, bottom: "auto" });
    setPopup("more");
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
    <div data-msg={m.id} className={`msg ${m.fromMe ? "mine" : ""} ${grouped ? "grouped" : ""} ${current ? "current-hit" : ""}`} onContextMenu={onContextMenu}>
      {!m.fromMe && (
        <span className="msg-avatar">
          {grouped ? m.ts && <span className="hover-time">{shortTime(m.ts)}</span> : (
            <button className="avatar-btn" onClick={(e) => m.senderId && openProfile(account, m.senderId, { x: e.clientX + 8, y: e.clientY })}>
              <Avatar account={account} media={m.avatar} name={m.sender} className="small" />
            </button>
          )}
        </span>
      )}
      <div className="msg-col">
        {!grouped && (
          <div className="msg-meta">
            {!m.fromMe && <button className="sender" onClick={(e) => m.senderId && openProfile(account, m.senderId, { x: e.clientX, y: e.clientY + 12 })}>{m.sender}</button>} <span title={m.time}>{m.ts ? shortTime(m.ts) : m.time}</span>
          </div>
        )}
        <div className="bubble-wrap" title={grouped ? m.time : undefined}>
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
            <div className={`bubble ${m.encrypted ? "deleted" : ""} ${visual ? "media" : ""} ${m.media?.kind === "sticker" ? "sticker" : ""} ${(isJumbo(m.body) || onlyCustomEmoji(m.html)) && !m.media ? "jumbo" : ""} ${m.deleted ? "deleted" : ""}`}>
              {quoted !== undefined && !m.deleted && (
                <div className="quote">
                  {quoted ? <><b>{quoted.sender}</b><span>{quoted.media ? `📎 ${quoted.media.name}` : quoted.deleted ? t("message.deletedShort") : quoted.body}</span></> : <span>{t("message.replyToEarlier")}</span>}
                </div>
              )}
              {m.untrusted ? <span className="waiting-key" title={t("message.untrustedHint")}>{t("message.untrusted")}</span>
                : m.encrypted ? <span className="waiting-key" title={t("message.waitingKeyHint")}>{t("message.waitingKey")}
                  {keyHelp && <> · <button className="link" onClick={keyHelp.fix}>{keyHelp.label}</button></>}</span>
                : m.deleted ? <span>{t("message.deleted")}</span>
                : m.poll ? <PollCard conversation={conversation ?? ""} poll={m.poll} question={m.body} />
                : m.media ? <>
                    <MediaBody media={m.media} account={account} actions={media} />
                    {m.media.caption && <div className="caption"><RichText body={m.media.caption} account={account} query={query} /></div>}
                  </>
                : <>
                    <RichText body={m.body} html={m.html} account={account} query={query} />
                    {previewUrl && <LinkPreview url={previewUrl} />}
                  </>}
              {m.edited && !m.deleted && <span className="edited" title={t("message.editedTitle")}>{t("message.edited")}</span>}
              {tick && tick !== "failed" && <span className={`msg-tick ${tick}`} title={t(`message.tick.${tick}`)}>{tick === "sending" ? "⏱" : tick === "seen" ? "✓✓" : "✓"}</span>}
            </div>
          )}
          {tick === "failed" && (
            <div className="msg-failed" role="alert">
              {t("message.notSent")} · <button className="link" onClick={onRetry}>{t("message.retry")}</button> · <button className="link" onClick={onDiscard}>{t("message.delete")}</button>
            </div>
          )}
          {!editing && !m.deleted && !m.encrypted && (onReply || onThread || onReact || onStatus) && (
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
                <button className={`icon-btn ${popup === "more" ? "on" : ""}`} title={t("common.moreOptions")} onClick={(e) => openPopup("more", e, 200, 180)}>⋯</button>
                {popup === "more" && (
                  <div className="menu more-menu" style={popupStyle} onClick={(e) => e.stopPropagation()}>
                    {canEdit && <button className="menu-item" onClick={() => { setDraft(m.body); setEditing(true); setPopup(null); }}>{t("message.edit")}</button>}
                    {onForward && !m.poll && <button className="menu-item" onClick={() => { setPopup(null); onForward(); }}>{t("forward.action")}</button>}
                    {!m.media && <button className="menu-item" onClick={() => { navigator.clipboard.writeText(m.body).catch(() => {}); setPopup(null); }}>{t("message.copy")}</button>}
                    {onStatus && <button className="menu-item" onClick={() => { setPopup(null); onStatus(); }}>{t("status.title")}</button>}
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
        {postMode && lastInRun && !thread?.length && onThread && !m.deleted && <button className="thread-summary" onClick={onThread}>{t("message.replyPost")}</button>}
        {thread && thread.length > 0 && (
          <button className="thread-summary" onClick={onThread}>
            {t("chatView.threadSummary", { count: thread.length, name: thread[thread.length - 1]!.sender })}
          </button>
        )}
      </div>
    </div>
    </div>
  );
}
