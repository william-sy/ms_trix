import { useCallback, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from "react";
import { isTalkModerator, talkRoom } from "./TalkSettings";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { backend, isLive, pickedUrl, subscribe, videoThumb, type ActivityItem, type Connection, type PickedFile, type DirectoryRoom, type SecurityStatus, type TeamView, type UploadProgress, type Verification } from "./backend";
import { BellIcon, CalendarIcon, CallIcon, ChatIcon, FilesIcon, MoreIcon, NotesIcon, TeamsIcon } from "./Icons";
import { NotesPane } from "./NotesPane";
import { FilesPane } from "./FilesPane";
import { SHOW_IN_FILES, type FilesReveal } from "./filesNav";
import { capabilities } from "./mock";
import { ChatList } from "./ChatList";
import { ChatView } from "./ChatView";
import { Login } from "./Login";
import { OrgSwitcher } from "./OrgSwitcher";
import { KeyHelpContext, RecoveryDialog, SecurityBanner, needsAttention } from "./Security";
import { setUpdateBlocked, UpdateBanner, useAutoUpdateCheck } from "./updates";
import { TitleBar } from "./TitleBar";
import { SettingsDialog, type SettingsTab } from "./SettingsDialog";
import { matches } from "./shortcuts";
import { PRESENCE_KEY, useAutoAway, useMeetingNow } from "./presence";
import { dndActive, dndStatus, setDnd, useDnd } from "./dnd";
import { warmUpEffects } from "./cameraEffects";
import { applySettings, currentSettings, loadSettings, onSettingsChanged, saveSettings, type Settings } from "./settings";
import type { Attachment, Conversation, Outgoing, PresenceState } from "./types";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|bmp)$/i;
const VIDEO_EXT = /\.(mp4|m4v|mov|webm)$/i;
import { OrgsContext, initialState, isUnread, reducer, timeline, unreadByOrg, type Action, type OrgFilter } from "./store";
import { loadDrafts } from "./drafts";
import { rememberChats } from "./chatLinks";
import { NewChatDialog } from "./NewChatDialog";
import { BrowseDialog } from "./BrowseDialog";
import { ProfileCard, ProfileContext, type OpenProfile } from "./Profile";
import { ActivityPane, serverEntry } from "./ActivityPane";
import { TeamsPane } from "./TeamsPane";
import { RoomPanel } from "./RoomPanel";
import { JoinRoomDialog } from "./JoinRoomDialog";
import { CallsContext, useMatrixCalls } from "./calls";
import { CallScreen } from "./CallScreen";
import { TalkRing } from "./TalkCallScreen";
import { lastCameraOn, TalkCallsContext, useTalkCallHost } from "./talkCalls";
import { CallsPane } from "./CallsPane";
import { CalendarPane, type CalendarRequest } from "./CalendarPane";
import { DatePopover, DateRefContext, type DateRefInfo } from "./DateRef";
import { MeetingReminder } from "./MeetingReminder";
import { ContextDialog } from "./ContextDialog";
import { HashtagContext, HashtagPanel } from "./Hashtags";
import { InAppLinkContext } from "./LinkPreview";
import { useServerNotifications } from "./serverNotifications";
import { ImageCropper } from "./ImageCropper";
import { VerificationDialog } from "./VerificationDialog";
import { RoomLinkContext, type OpenRoomLink } from "./roomLinks";
import { TranslatorsContext } from "./Translate";
import { commandText, dateLocale, friendlyError, rustTexts, t } from "./i18n";

/**
 * Whether a Nextcloud account uses calendars: the Calendar app is in its navigation (the calendar
 * store itself exists without it). Servers without that API: a calendar we can write in.
 */
async function hasCalendar(account: string): Promise<boolean> {
  try {
    return (await backend.cloudApps(account)).includes("calendar");
  } catch (e) {
    if (/not signed in|network/i.test(String(e))) throw e;
    return (await backend.calendars(account)).some((c) => c.writable);
  }
}

/**
 * The accounts (of `ids`) where `check` says yes. Asked until the account answers: at start it may
 * still be connecting, or the network may be down; any other answer (no, not found, not
 * supported) is final.
 */
function useAccountsWith(ids: string[], check: (id: string) => Promise<boolean>): string[] {
  const [yes, setYes] = useState<string[]>([]);
  const asked = useRef(new Set<string>());
  const tries = useRef(0);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    for (const id of ids) {
      if (asked.current.has(id)) continue;
      asked.current.add(id);
      check(id).then((ok) => { if (ok) setYes((list) => [...new Set([...list, id])]); }, (e) => {
        if (!/not signed in|network/i.test(String(e))) return;
        asked.current.delete(id);
        // Soon at first, then less often.
        window.setTimeout(() => setRetry((n) => n + 1), Math.min(30_000, 3000 * 2 ** tries.current++));
      });
    }
  }, [ids.join("|"), retry]); // eslint-disable-line react-hooks/exhaustive-deps
  return yes;
}

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [booting, setBooting] = useState(isLive);
  const [addingAccount, setAddingAccount] = useState(false);
  const [notice, setNoticeRaw] = useState<string | null>(null);
  // Everything shown in the notice bar gets common errors in plain words.
  const setNotice = useCallback((message: string | null) => setNoticeRaw(message && friendlyError(message)), []);
  const [query, setQuery] = useState("");
  // Files being dragged over the window: onto the chat, or onto an open thread.
  const [dragging, setDragging] = useState<false | "chat" | "thread">(false);
  // Conversation to open once it shows up (after /join or /query).
  const [pendingOpen, setPendingOpen] = useState<string | null>(null);
  const [staged, setStaged] = useState<Record<string, Attachment[]>>({});
  // Our own status per account, as chosen in this app; remembered across restarts.
  const [ownPresence, setOwnPresence] = useState<Record<string, { presence: PresenceState; status?: string }>>(() => {
    try { return JSON.parse(localStorage.getItem(PRESENCE_KEY) ?? "{}"); } catch { return {}; }
  });
  const setPresence = (orgId: string, presence: PresenceState, status?: string) => {
    // Picking a status yourself ends do not disturb.
    if (dndActive()) setDnd(null);
    setOwnPresence((s) => {
      const next = { ...s, [orgId]: { presence, status } };
      try { localStorage.setItem(PRESENCE_KEY, JSON.stringify(next)); } catch { /* private mode */ }
      return next;
    });
    if (isLive) backend.setPresence(orgId, presence, status ?? null).catch((e) => setNotice(String(e)));
  };
  const [settings, setSettingsState] = useState(loadSettings);
  // Matrix 1:1 calls; ringing also shows a system notification in case the window is hidden.
  const convsRef = useRef(state.convs);
  convsRef.current = state.convs;
  // Links to these chats in messages show as pills (chatLinks.ts).
  rememberChats(state.convs);
  // Talk calls run in a webview of their own, docked in the app or in a window of their own.
  const talkCalls = useTalkCallHost((id) => {
    const conv = state.convs.find((c) => c.id === id);
    const account = conv?.orgId ?? id.split("|")[0]!;
    const me = state.orgs.find((o) => o.id === account);
    return { account, name: conv?.name ?? "", avatar: conv?.avatar, me: me && { name: me.displayName, avatar: me.avatar } };
  }, (e) => setNotice(e));
  const calls = useMatrixCalls((e) => setNotice(String(e)), (conversation, peer, video) => {
    const name = convsRef.current.find((c) => c.id === conversation)?.name ?? peer;
    backend.notifyCall(name, video ? t("mxcall.incomingVideo") : t("mxcall.incomingVoice")).catch(() => {});
    if (!dndActive()) backend.requestAttention().catch(() => {});
  });
  // Updating restarts the app, which would end a call.
  useAutoUpdateCheck();
  const inCall = !!calls.call || !!(talkCalls.call && talkCalls.call.phase !== "ended");
  useEffect(() => setUpdateBlocked(inCall), [inCall]);
  // Which Nextcloud accounts have Notes, and which a calendar (not every Nextcloud has them).
  const talkIds = isLive ? state.orgs.filter((o) => o.protocol === "talk").map((o) => o.id) : [];
  const notesAccounts = useAccountsWith(talkIds, (id) => backend.notes(id).then(() => true));
  const calendarAccounts = useAccountsWith(talkIds, hasCalendar);
  // Which translate messages (any chat's, Matrix too).
  const translateAccounts = useAccountsWith(talkIds, (id) => backend.canTranslate(id));
  // Do not disturb shows you as busy everywhere (on Talk: "do not disturb"), with when it ends as
  // your status message unless you have one; when it ends, your own status comes back.
  const dnd = useDnd();
  // A meeting in your calendar does the same on Matrix while you're available (Nextcloud sets
  // "In a meeting" for Talk itself).
  const meetingUntil = useMeetingNow(settings.meetingStatus ? calendarAccounts : []);
  const orgIds = state.orgs.map((o) => o.id);
  const matrixIds = new Set(state.orgs.filter((o) => o.protocol === "matrix").map((o) => o.id));
  const meetingStatus = meetingUntil && t("presence.inMeeting", { time: new Date(meetingUntil).toLocaleTimeString(dateLocale(), { hour: "2-digit", minute: "2-digit" }) });
  const shownPresence = dnd
    ? Object.fromEntries(orgIds.map((id) => [id, { presence: "busy" as PresenceState, status: ownPresence[id]?.status || dndStatus(dnd) }]))
    : meetingStatus
      ? { ...ownPresence, ...Object.fromEntries(orgIds.filter((id) => matrixIds.has(id) && (ownPresence[id]?.presence ?? "available") === "available")
          .map((id) => [id, { presence: "busy" as PresenceState, status: ownPresence[id]?.status || meetingStatus }])) }
      : ownPresence;
  // Sent when do not disturb or a meeting starts or ends, only to the accounts it changes (an
  // account just signed in gets its status from useAutoAway's restore).
  const presenceSent = useRef<Record<string, string>>({});
  useEffect(() => {
    const before = presenceSent.current;
    presenceSent.current = Object.fromEntries(orgIds.map((id) => [id, JSON.stringify(shownPresence[id] ?? null)]));
    if (!isLive) return;
    for (const id of orgIds) {
      if (before[id] === undefined || before[id] === presenceSent.current[id]) continue;
      backend.setPresence(id, shownPresence[id]?.presence ?? "available", shownPresence[id]?.status ?? null).catch(() => {});
    }
  }, [dnd, meetingStatus, orgIds.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  const autoAway = useAutoAway(orgIds, shownPresence, settings.awayAfter);
  // ntfy add-on: the core forwards notifications while it's on ("away": no input for the
  // auto-away time, or 5 minutes when auto-away is off).
  const ntfy = settings.ntfy;
  useEffect(() => {
    if (!isLive) return;
    const on = ntfy.enabled && ntfy.topic.trim() && ntfy.server.trim();
    backend.setNtfy(on ? { server: ntfy.server.trim(), topic: ntfy.topic.trim(), onlyAway: ntfy.when === "away", awayAfterSecs: (settings.awayAfter || 5) * 60, includeText: ntfy.includeText } : null).catch(() => {});
  }, [ntfy.enabled, ntfy.server, ntfy.topic, ntfy.when, ntfy.includeText, settings.awayAfter]);
  const [showSettings, setShowSettings] = useState<false | SettingsTab>(false);
  const [newChat, setNewChat] = useState<false | "chat" | "room" | "team">(false);
  const [newChannelIn, setNewChannelIn] = useState<TeamView | null>(null);
  const [profileFor, setProfileFor] = useState<{ account: string; userId: string; at: { x: number; y: number } } | null>(null);
  const openProfile = useCallback<OpenProfile>((account, userId, at) => setProfileFor({ account, userId, at }), []);
  const [browse, setBrowse] = useState<false | { space?: DirectoryRoom }>(false);
  // The emoji verification on screen; flows the user closed stay closed.
  const [verification, setVerification] = useState<Verification | null>(null);
  const closedFlows = useRef(new Set<string>());
  const [uploads, setUploads] = useState<Record<string, UploadProgress>>({});
  // Team settings reuse the room info panel, on the team's (space's) key.
  const [teamInfo, setTeamInfo] = useState<TeamView | null>(null);
  const [cropFor, setCropFor] = useState<{ kind: "me"; account: string } | { kind: "room" | "memberRoom"; key: string } | null>(null);
  const [joinPreview, setJoinPreview] = useState<{ account: string; room: DirectoryRoom; via: string[] } | null>(null);
  const [view, setView] = useState<"activity" | "chat" | "teams" | "calls" | "calendar" | "notes" | "files">("chat");
  const viewRef = useRef(view);
  viewRef.current = view;
  // Show in Files (from a chat): the Files view, at that file.
  const [filesReveal, setFilesReveal] = useState<FilesReveal | null>(null);
  useEffect(() => {
    const onShow = (e: Event) => {
      const { account, path } = (e as CustomEvent<{ account: string; path: string }>).detail;
      setFilesReveal({ account, path, at: Date.now() });
      setView("files");
    };
    window.addEventListener(SHOW_IN_FILES, onShow);
    return () => window.removeEventListener(SHOW_IN_FILES, onShow);
  }, []);
  const [teams, setTeams] = useState<TeamView[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [activitySelected, setActivitySelected] = useState<string | null>(null);
  // A message to scroll to (from Activity, search or a link), only for its own conversation:
  // other chats would page back through their whole history looking for it. The chat clears it
  // once it has jumped there.
  const [focusMessage, setFocusState] = useState<{ conversation: string; message: string } | null>(null);
  const setFocusMessage = (conversation: string, message: string | null) => setFocusState(message ? { conversation, message } : null);
  // Activity newer than seenAt counts on the rail badge; opening the feed clears it.
  // The dots in the feed stay until read: everything up to readAt, plus single items.
  // The first camera use in a run of the app sets up macOS's camera system, which takes seconds
  // (finding the cameras, an iPhone among them). Done once in the background a little after
  // start, the camera itself staying off, so a first call opens it as fast as later ones.
  useEffect(() => {
    if (!isLive || !navigator.mediaDevices) return;
    const timer = window.setTimeout(() => {
      const asked = performance.now();
      // Not counted: until this page has used the camera itself, WebKit lists one per kind.
      navigator.mediaDevices.enumerateDevices().then(
        () => void backend.logUi(`devices ready after ${Math.round(performance.now() - asked)} ms (warm-up for calls)`).catch(() => {}),
        () => {},
      );
    }, 6000);
    return () => window.clearTimeout(timer);
  }, []);
  const [seenAt, setSeenAt] = useStored("Trixcomm.activity.seenAt", 0);
  const [activityRead, setActivityRead] = useStored<{ at: number; read: string[]; unread: string[] }>("Trixcomm.activity.read", () => ({ at: seenAt, read: [], unread: [] }));
  const activityUnread = (a: { id: string; at: number }) => activityRead.unread.includes(a.id) || (a.at > activityRead.at && !activityRead.read.includes(a.id));
  // Nextcloud's own notifications (shares, invitations, …) share the feed, its badge and read state.
  const serverItems = useServerNotifications(useMemo(() => state.orgs.filter((o) => o.protocol === "talk").map((o) => o.id), [state.orgs]));
  const setActivityItemRead = (a: { id: string }, read: boolean) => {
    const known = new Set([...activity.map((x) => x.id), ...serverItems.map((n) => n.key)]); // forget items that fell out of the feed
    const keep = (ids: string[]) => ids.filter((id) => id !== a.id && known.has(id));
    setActivityRead({ at: activityRead.at, read: read ? [...keep(activityRead.read), a.id] : keep(activityRead.read), unread: read ? keep(activityRead.unread) : [...keep(activityRead.unread), a.id] });
  };
  // Cleared from the feed, on this computer: everything up to `at`, plus single items.
  const [activityCleared, setActivityCleared] = useStored<{ at: number; ids: string[] }>("Trixcomm.activity.cleared", () => ({ at: 0, ids: [] }));
  const [undoClear, setUndoClear] = useState<{ at: number; ids: string[] } | null>(null);
  const activityShown = (a: { id: string; at: number }) => a.at > activityCleared.at && !activityCleared.ids.includes(a.id);
  const removeActivity = (a: ActivityItem) => {
    const known = new Set(activity.map((x) => x.id));
    setActivityCleared({ at: activityCleared.at, ids: [...activityCleared.ids.filter((id) => known.has(id)), a.id] });
  };
  // Missed calls newer than this count on the Calls rail badge.
  const [callsSeenAt, setCallsSeenAt] = useStored("Trixcomm.calls.seenAt", Date.now());
  const openView = (v: typeof view) => {
    if (v === "activity") setSeenAt(Date.now());
    if (v === "calls") setCallsSeenAt(Date.now());
    setView(v);
  };
  const setSettings = (s: Settings) => {
    if (isLive && (s.shareReceipts !== settings.shareReceipts || s.shareTyping !== settings.shareTyping)) {
      backend.setPrivacy(s.shareReceipts, s.shareTyping).catch((e) => setNotice(String(e)));
    }
    // Only what changed here, onto the stored settings: a call's own page may have changed others
    // (its devices) that this copy hasn't caught up with.
    const changed = Object.fromEntries(Object.entries(s).filter(([k, v]) => v !== settings[k as keyof Settings]));
    const next: Settings = { ...loadSettings(), ...changed };
    setSettingsState(next);
    saveSettings(next);
    applySettings(next);
  };
  // Settings changed elsewhere (a call's background choice) must not be overwritten by a stale copy.
  useEffect(() => onSettingsChanged(setSettingsState), []);
  // With a camera background chosen, load the person detection once the app has settled,
  // so calls don't wait for it.
  useEffect(() => {
    const timer = window.setTimeout(warmUpEffects, 8000);
    return () => window.clearTimeout(timer);
  }, []);
  useEffect(() => {
    if (isLive) backend.setCloseToTray(settings.closeToTray, t("tray.open"), t("tray.quit")).catch(() => {});
  }, [settings.closeToTray]);
  // Previews and notifications are worded by the host; give it this language's texts.
  useEffect(() => {
    if (isLive) backend.setTexts(rustTexts()).catch(() => {});
  }, [settings.language]);
  // The host decides which notifications to show and how they sound.
  useEffect(() => {
    if (isLive) backend.setNotifyPrefs(settings.notify, settings.sounds).catch(() => {});
  }, [settings.notify, settings.sounds]);
  // Keywords also live on the server as Matrix push rules (so Element and phones use them too).
  // Once the accounts are up: take in keywords set elsewhere, then push our list out.
  const keywordsMerged = useRef(false);
  const orgKey = state.orgs.map((o) => o.id).join("|");
  useEffect(() => {
    if (!isLive || booting || !orgKey) return;
    backend.serverKeywords().then((server) => {
      const s = currentSettings();
      const local = s.notify.keywords;
      const extra = server.filter((k) => !local.some((l) => l.toLowerCase() === k.toLowerCase()));
      const merged = [...local, ...extra];
      if (extra.length) setSettings({ ...s, notify: { ...s.notify, keywords: merged } });
      keywordsMerged.current = true;
      return backend.syncKeywords(merged);
    }).catch(() => {});
  }, [booting, orgKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (isLive && keywordsMerged.current) backend.syncKeywords(settings.notify.keywords).catch((e) => setNotice(String(e)));
  }, [settings.notify.keywords]);
  // The host starts out sharing both; only tell it when that's not the choice.
  useEffect(() => {
    if (isLive && !(settings.shareReceipts && settings.shareTyping)) backend.setPrivacy(settings.shareReceipts, settings.shareTyping).catch(() => {});
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = state.selectedId;
  const [security, setSecurity] = useState<Record<string, SecurityStatus>>({});
  const [securityFor, setSecurityFor] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const selectOrg = useCallback((org: OrgFilter) => dispatch({ type: "selectOrg", org }), []);
  // A file to show on an account outside the organization in view: all of them, so Files has it.
  useEffect(() => {
    if (filesReveal && state.orgFilter !== "all" && state.orgFilter !== filesReveal.account) selectOrg("all");
  }, [filesReveal?.at]); // eslint-disable-line react-hooks/exhaustive-deps

  // Start with the chat list from last time (if any) instead of a spinner; once every
  // account is back, the live list replaces it and chats that are gone disappear.
  useEffect(() => {
    if (!isLive) return;
    void loadDrafts().then((drafts) => dispatch({ type: "setDrafts", drafts }));
    backend.cachedChatList().then((cached) => {
      if (!cached?.convs.length) return;
      dispatch({ type: "setOrgs", orgs: cached.orgs });
      dispatch({ type: "upsertConvs", convs: cached.convs });
      setBooting(false);
    }).catch(() => {});
  }, []);
  const restoredRef = useRef(false);
  // Each account's link to its server: Offline (with Reconnect) in the account lists.
  const [connections, setConnections] = useState<Record<string, Connection>>({});
  const connectionsRef = useRef(connections);
  const reconcile = async () => {
    restoredRef.current = true;
    setBooting(false);
    const live = await backend.conversations();
    dispatch({ type: "upsertConvs", convs: live });
    dropGone(live, (account) => connectionsRef.current[account]?.connected ?? true);
    dispatch({ type: "setOrgs", orgs: await backend.accounts() });
  };
  // Saved chats the server no longer has. An account that hasn't synced yet (its server may be
  // down) keeps them until it has.
  const dropGone = (live: Conversation[], synced: (account: string) => boolean) => {
    const keep = new Set(live.map((c) => c.id));
    const stale = stateRef.current.convs.filter((c) => synced(c.orgId) && !keep.has(c.id)).map((c) => c.id);
    if (stale.length) dispatch({ type: "removeConvs", keys: stale });
  };
  const setConnection = (account: string, connection: Connection) => {
    const was = connectionsRef.current[account];
    connectionsRef.current = { ...connectionsRef.current, [account]: connection };
    setConnections(connectionsRef.current);
    if (connection.connected && !was?.connected && restoredRef.current) void backend.conversations().then((live) => dropGone(live, (a) => a === account));
  };
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(() => {
    if (!isLive) return;
    let off: (() => void) | undefined;
    subscribe({
      // Until every account is back, keep the saved ones that haven't reconnected yet
      // (their chats are on screen already; without them their badges show "?").
      accounts: (orgs) => dispatch({ type: "setOrgs", orgs: restoredRef.current ? orgs : [...orgs, ...stateRef.current.orgs.filter((o) => !orgs.some((n) => n.id === o.id))] }),
      conversations: (convs) => dispatch({ type: "upsertConvs", convs }),
      removed: (keys) => dispatch({ type: "removeConvs", keys }),
      messages: (items) => dispatch({ type: "appendMessages", items }),
      restored: () => void reconcile(),
      teams: setTeams,
      activity: setActivity,
      upload: (p) => setUploads((u) => ({ ...u, [p.conversation]: p })),
      verification: (v) => {
        if (closedFlows.current.has(v.flowId)) return;
        // A new flow only replaces one that has ended.
        setVerification((cur) => (!cur || cur.flowId === v.flowId || cur.state.kind === "done" || cur.state.kind === "cancelled" ? v : cur));
      },
      accountError: (userId, error) => setNotice(t("app.reconnectFailed", { user: userId, error })),
      connection: setConnection,
    }).then(async (unlisten) => {
      off = unlisten;
      connectionsRef.current = { ...(await backend.connections()), ...connectionsRef.current };
      setConnections(connectionsRef.current);
      // Early on, accounts are still reconnecting; don't replace the saved list with an empty one.
      const orgs = await backend.accounts();
      if (orgs.length) dispatch({ type: "setOrgs", orgs });
      dispatch({ type: "upsertConvs", convs: await backend.conversations() });
      setTeams(await backend.teams());
      setActivity(await backend.activity());
      if (await backend.restored()) void reconcile();
    });
    return () => off?.();
  }, []);

  // Encryption status is only known after the first sync, so retry while unknown.
  useEffect(() => {
    if (!isLive) return;
    const timers: number[] = [];
    const check = (orgId: string, attempt: number) =>
      backend.securityStatus(orgId).then((s) => {
        setSecurity((prev) => ({ ...prev, [orgId]: s }));
        if (s.recovery === "unknown" && attempt < 10) timers.push(window.setTimeout(() => check(orgId, attempt + 1), 3000));
      }).catch(() => {});
    state.orgs.forEach((o) => check(o.id, 0));
    return () => timers.forEach(clearTimeout);
  }, [state.orgs]);

  // Dock/taskbar badge: number of unread, unmuted chats across all orgs.
  const unreadTotal = state.convs.filter((c) => isUnread(c) && !c.muted).length;
  useEffect(() => {
    if (!isLive) return;
    getCurrentWindow().setBadgeCount(unreadTotal || undefined).catch(() => {});
    backend.setTrayUnread(unreadTotal, unreadTotal ? t("tray.unread", { count: unreadTotal }) : "Trixcomm").catch(() => {});
  }, [unreadTotal]);

  // App-wide shortcuts (see shortcuts.ts); the handler is refreshed every render.
  const onShortcut = useRef<(e: KeyboardEvent) => void>(() => {});
  onShortcut.current = (e) => {
    if (matches(e, "activity")) openView("activity");
    else if (matches(e, "chat")) openView("chat");
    else if (matches(e, "teams")) openView("teams");
    else if (matches(e, "markUnread") && state.selectedId) act({ type: "markUnread", id: state.selectedId });
    else if (matches(e, "settings")) setShowSettings("general");
    else if (matches(e, "list")) setShowSettings("shortcuts");
    else if (matches(e, "newChat")) openNewChat();
    else return;
    e.preventDefault();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => onShortcut.current(e);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Drop files anywhere on the window to send them to the open chat; over an open thread, into
  // that thread's reply box.
  useEffect(() => {
    if (!isLive) return;
    // The thread under a position (device pixels), looking underneath the drop overlay too.
    const threadAt = (position: { x: number; y: number }) => {
      const ratio = window.devicePixelRatio || 1;
      return document.elementsFromPoint(position.x / ratio, position.y / ratio)
        .map((el) => (el as HTMLElement).closest<HTMLElement>("[data-thread-root]")?.dataset.threadRoot).find(Boolean);
    };
    const off = getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      // In Files, they're uploaded to the folder in view instead.
      if (viewRef.current === "files") {
        if (p.type === "drop") window.dispatchEvent(new CustomEvent("trix:files-drop", { detail: p.paths }));
        else window.dispatchEvent(new CustomEvent("trix:files-drag", { detail: p.type !== "leave" }));
        return;
      }
      if (p.type === "enter" || p.type === "over") setDragging(selectedRef.current ? (threadAt(p.position) ? "thread" : "chat") : false);
      else if (p.type === "leave") setDragging(false);
      else if (p.type === "drop") {
        setDragging(false);
        const key = selectedRef.current;
        const root = threadAt(p.position);
        if (key && p.paths.length) backend.describeFiles(p.paths).then((files) => stagePaths(stagingKey(key, root), files)).catch((err) => setNotice(String(err)));
      }
    });
    return () => { off.then((f) => f()); };
  }, []);

  useEffect(() => {
    if (pendingOpen && state.convs.some((c) => c.id === pendingOpen)) {
      dispatch({ type: "selectOrg", org: "all" });
      dispatch({ type: "setSelected", id: pendingOpen });
      setPendingOpen(null);
    }
  }, [pendingOpen, state.convs]);

  const acceptInvite = (key: string) => {
    if (!isLive) return setNotice(t("desktopOnly.invites"));
    // An accepted team invite turns into a team, not a chat: show the Teams view.
    const isTeam = state.convs.find((c) => c.id === key)?.kind === "team";
    backend.acceptInvite(key).then(() => (isTeam ? setView("teams") : setPendingOpen(key))).catch((e) => setNotice(String(e)));
  };
  const declineInvite = (key: string) => {
    if (!isLive) return setNotice(t("desktopOnly.invites"));
    if (state.selectedId === key) dispatch({ type: "setSelected", id: null });
    backend.leave(key).catch((e) => setNotice(String(e)));
  };
  const leaveChat = (conv: Conversation) => {
    if (!isLive) return setNotice(t("desktopOnly.invites"));
    if (!confirm(t("chat.leaveConfirm", { name: conv.name }))) return;
    if (state.selectedId === conv.id) dispatch({ type: "setSelected", id: null });
    backend.leave(conv.id).catch((e) => setNotice(String(e)));
  };
  // Talk conversations you moderate can be deleted for everyone (Matrix rooms can't be deleted).
  const isTalk = (conv: Conversation) => state.orgs.find((o) => o.id === conv.orgId)?.protocol === "talk";
  const canDeleteChat = async (conv: Conversation) => {
    if (!isLive || !isTalk(conv)) return false;
    const [json] = await backend.callApi(conv.orgId, "GET", talkRoom(conv), []);
    return isTalkModerator(JSON.parse(json));
  };
  const deleteChat = (conv: Conversation) => {
    if (!confirm(t("talk.deleteConfirm", { name: conv.name }))) return;
    backend.callApi(conv.orgId, "DELETE", talkRoom(conv), [])
      .then(() => dispatch({ type: "removeConvs", keys: [conv.id] }))
      .catch((e) => setNotice(String(e)));
  };
  // Leaves every channel of the team we're in, then the team (space) itself.
  const leaveTeam = async (team: TeamView) => {
    if (!isLive) return setNotice(t("desktopOnly.invites"));
    if (!confirm(t("teams.leaveConfirm", { name: team.name, count: team.channels.length }))) return;
    if (state.selectedId && team.channels.includes(state.selectedId)) dispatch({ type: "setSelected", id: null });
    try {
      for (const key of team.channels) await backend.leave(key);
      await backend.leave(team.key);
    } catch (e) {
      setNotice(String(e));
    }
  };
  const openBrowse = (space?: DirectoryRoom) => (isLive ? setBrowse({ space }) : setNotice(t("desktopOnly.browse")));
  const showInChat = (conversation: string, message: string) => {
    setView("chat");
    setQuery("");
    setFocusMessage(conversation, message);
    act({ type: "select", id: conversation });
  };
  // A result that isn't loaded yet opens as a quick preview first; paging back to it can take a while.
  const [preview, setPreview] = useState<{ conversation: string; message: string } | null>(null);
  // A #hashtag clicked in a message: the messages that use it.
  // A date clicked in a message, and what it asked of the calendar.
  const [dateRef, setDateRef] = useState<DateRefInfo | null>(null);
  const [calendarRequest, setCalendarRequest] = useState<CalendarRequest | null>(null);
  const [hashtag, setHashtag] = useState<string | null>(null);
  const openMessage = (conversation: string, message: string) =>
    isLive && !(state.messages[conversation] ?? []).some((m) => m.id === message) ? setPreview({ conversation, message }) : showInChat(conversation, message);
  // A Talk link to one of our servers: its conversation opens here (joined first when we aren't in
  // it yet), and a call going on there opens its pre-join screen. No new call is started.
  const talkCallsRef = useRef(talkCalls);
  talkCallsRef.current = talkCalls;
  const openInApp = useCallback((key: string) => {
    const open = () => {
      const conv = convsRef.current.find((c) => c.id === key);
      if (!conv) return false;
      setView("chat");
      act({ type: "select", id: key });
      if (conv.callActive) talkCallsRef.current.start(key, lastCameraOn());
      return true;
    };
    if (open()) return;
    const at = key.indexOf("|");
    backend.joinRoom(key.slice(0, at), key.slice(at + 1)).then(() => {
      // Once it shows up in the chat list.
      let tries = 0;
      const timer = window.setInterval(() => { if (open() || ++tries > 30) window.clearInterval(timer); }, 500);
    }, (e) => setNotice(String(e)));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  // A room link: open the room (at the linked message) if we're in it, else offer to join.
  const orgsRef = useRef(state.orgs);
  orgsRef.current = state.orgs;
  const openRoomLink = useCallback<OpenRoomLink>((from, link) => {
    if (!isLive) return setNotice(t("desktopOnly.browse"));
    // Matrix links in a Talk chat go through a Matrix account.
    const orgs = orgsRef.current;
    const account = orgs.find((o) => o.id === from && o.protocol === "matrix")?.id ?? orgs.find((o) => o.protocol === "matrix")?.id;
    if (!account) return setNotice(t("roomLink.failed", { address: link.address, error: t("roomLink.noMatrix") }));
    backend.roomPreview(account, link.address, link.via).then((room) => {
      if (room.joined && room.isSpace) return setView("teams");
      if (!room.joined) return setJoinPreview({ account, room, via: link.via });
      setView("chat");
      setQuery("");
      if (link.event) setFocusMessage(room.joined!, link.event);
      setPendingOpen(room.joined);
    }).catch((e) => setNotice(t("roomLink.failed", { address: link.address, error: String(e) })));
  }, []);
  const openNewChat = (mode: "chat" | "room" | "team" = "chat") => (isLive ? setNewChat(mode) : setNotice(t("desktopOnly.newChat")));
  const openNewChannel = (team: TeamView) => (isLive ? (setNewChannelIn(team), setNewChat("room")) : setNotice(t("desktopOnly.newChat")));

  const runCommand = (key: string, name: string, args: string) => {
    if (!isLive) return setNotice(t("desktopOnly.command", { name }));
    // Picture commands open the cropper here instead of going to the server.
    if (name === "myavatar") return setCropFor({ kind: "me", account: key.split("|")[0]! });
    if (name === "roomavatar") return setCropFor({ kind: "room", key });
    if (name === "myroomavatar") return setCropFor({ kind: "memberRoom", key });
    backend.runCommand(key, name, args)
      .then((out) => { setNotice(commandText(out) || null); if (out.open) setPendingOpen(out.open); })
      .catch((e) => setNotice(String(e)));
  };
  // Files wait in the composer (per chat, and per thread) until the user presses Send.
  const stagingKey = (key: string, threadRoot?: string) => (threadRoot ? `${key}#${threadRoot}` : key);
  const stage = (key: string, items: Attachment[]) => setStaged((s) => ({ ...s, [key]: [...(s[key] ?? []), ...items] }));
  /** Makes a still for a staged video: shown in the tray and sent with it. */
  const addStill = (key: string, id: string, src: string) =>
    videoThumb(src).then((thumb) => {
      const preview = URL.createObjectURL(new Blob([new Uint8Array(thumb.data)], { type: "image/jpeg" }));
      setStaged((s) => ({ ...s, [key]: (s[key] ?? []).map((a) => (a.id === id ? { ...a, preview, thumb } : a)) }));
    }).catch(() => { /* sent without a still */ });
  const stagePaths = (key: string, files: PickedFile[]) => {
    const items = files.map((f) => ({ id: crypto.randomUUID(), name: f.name, size: f.size, path: f.path }));
    stage(key, items);
    files.forEach((f, i) => VIDEO_EXT.test(f.name) && void addStill(key, items[i]!.id, pickedUrl(f.token)));
    // Thumbnails for images; the webview can't load local paths directly.
    for (const item of items.filter((i) => IMAGE_EXT.test(i.name))) {
      backend.filePreview(item.path).then((bytes) => {
        const preview = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
        setStaged((s) => ({ ...s, [key]: (s[key] ?? []).map((a) => (a.id === item.id ? { ...a, preview } : a)) }));
      }).catch(() => {});
    }
  };
  const pickFiles = (key: string) =>
    isLive ? void backend.pickFiles().then((files) => stagePaths(key, files)).catch((e) => setNotice(String(e))) : setNotice(t("desktopOnly.files"));
  const addFiles = (key: string, files: File[]) => {
    const items = files.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name && file.name !== "image.png" ? file.name : `pasted-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
      size: file.size,
      file,
      preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
    }));
    stage(key, items);
    for (const item of items.filter((i) => i.file.type.startsWith("video/"))) {
      const src = URL.createObjectURL(item.file);
      void addStill(key, item.id, src).finally(() => URL.revokeObjectURL(src));
    }
  };
  const removeStaged = (key: string, id: string) =>
    setStaged((s) => {
      const gone = s[key]?.find((a) => a.id === id);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return { ...s, [key]: (s[key] ?? []).filter((a) => a.id !== id) };
    });
  const sendAttachments = async (key: string, items: Attachment[], caption: string, threadRoot?: string, replyTo?: string) => {
    setStaged((s) => ({ ...s, [stagingKey(key, threadRoot)]: [] }));
    if (!isLive) return setNotice(t("desktopOnly.files"));
    try {
      for (const [i, a] of items.entries()) {
        // One caption for the batch, on the last file; a reply goes with it too.
        const last = i === items.length - 1;
        const text = last && caption ? caption : null;
        const reply = last ? replyTo ?? null : null;
        if (a.file) await backend.sendFileBytes(key, a.name, a.file.type || null, Array.from(new Uint8Array(await a.file.arrayBuffer())), text, a.thumb ?? null, threadRoot ?? null, reply);
        else if (a.path) await backend.sendFilePaths(key, [a.path], text, a.thumb ?? null, threadRoot ?? null, reply);
      }
    } catch (e) {
      setNotice(String(e));
    } finally {
      items.forEach((a) => a.preview && URL.revokeObjectURL(a.preview));
      setUploads(({ [key]: _, ...rest }) => rest);
    }
  };

  // Tell the engine which chat is on screen; it decides what counts as read.
  useEffect(() => {
    if (!isLive) return;
    backend.focus(state.selectedId);
    if (state.selectedId) {
      const key = state.selectedId;
      backend.messages(key).then((messages) => dispatch({ type: "setMessages", key, messages }));
    }
  }, [state.selectedId]);

  const messagesRef = useRef(state.messages);
  messagesRef.current = state.messages;
  /** Sends `message` for our copy `txn` (shown already); marks it sent or failed. */
  const sendLocal = (key: string, txn: string, message: Outgoing) =>
    backend.send(key, message)
      .then((realId) => dispatch({ type: "localSent", key, txn, realId }))
      .catch((e) => { dispatch({ type: "localStatus", key, txn, status: "failed" }); setNotice(String(e)); });
  const act = useCallback((action: Action) => {
    if (!isLive) return dispatch(action);
    const report = (e: unknown) => setNotice(String(e));
    switch (action.type) {
      case "select":
        return dispatch({ type: "setSelected", id: action.id });
      case "markUnread":
        return void backend.markUnread(action.id).catch(report);
      case "markRead":
        return void backend.markRead(action.id).catch(report);
      case "toggleFavourite": {
        const conv = state.convs.find((c) => c.id === action.id);
        dispatch(action); // optimistic; the next sync confirms it
        return void backend.setFavourite(action.id, !conv?.favourite).catch(report);
      }
      case "toggleArchive": {
        const conv = state.convs.find((c) => c.id === action.id);
        dispatch(action); // optimistic; the next sync confirms it
        if (!conv?.archived && state.selectedId === action.id) dispatch({ type: "setSelected", id: null });
        return void backend.setArchived(action.id, !conv?.archived).catch(report);
      }
      case "send": {
        if (action.message.attachments?.length) return void sendAttachments(action.id, action.message.attachments, action.message.text, action.message.threadRoot, action.message.replyTo);
        // Shown at once (like WhatsApp), with ⏱ until the server has it.
        const txn = crypto.randomUUID();
        const me = [...(messagesRef.current[action.id] ?? [])].reverse().find((m) => m.fromMe && !m.system && !m.local);
        const { text, emote, html, replyTo, threadRoot } = action.message;
        // Formatted as it will be sent (a code block, a list, bold), not raw Markdown until the
        // server's copy arrives; rendering takes a millisecond. Shown first, then sent, so the
        // copy is there to be replaced.
        const formatted = html || emote ? Promise.resolve(html ?? null) : backend.renderMarkdown(text).catch(() => null);
        return void formatted.then((rendered) => {
          const now = Date.now();
          dispatch({ type: "localSend", key: action.id, message: {
            id: `local:${txn}`, sender: me?.sender ?? "", senderId: me?.senderId, avatar: me?.avatar, fromMe: true, ts: now,
            time: new Date(now).toLocaleString(dateLocale(), { weekday: "long", hour: "2-digit", minute: "2-digit" }),
            body: emote ? `* ${me?.sender ?? ""} ${text}` : text, html: rendered ?? undefined, replyTo, threadRoot, status: "sending", local: { txn, outgoing: action.message },
          } });
          return sendLocal(action.id, txn, action.message);
        });
      }
      case "retrySend": {
        const local = messagesRef.current[action.id]?.find((m) => m.local?.txn === action.txn)?.local;
        if (!local) return;
        dispatch({ type: "localStatus", key: action.id, txn: action.txn, status: "sending" });
        return void sendLocal(action.id, action.txn, local.outgoing);
      }
      case "discardLocal":
        return dispatch(action);
      case "react":
        return void backend.toggleReaction(action.id, action.target, action.emoji).catch(report);
      case "edit":
        return void backend.editMessage(action.id, action.target, action.text).catch(report);
      case "delete":
        return void backend.deleteMessage(action.id, action.target).catch(report);
      default:
        return dispatch(action);
    }
  }, [state.convs]);

  const addAccount = () => (isLive ? setAddingAccount(true) : setNotice(t("desktopOnly.accounts")));

  const refetch = (key: string) => backend.messages(key).then((messages) => dispatch({ type: "setMessages", key, messages }));
  const loadOlder = async (key: string, limit?: number) => {
    if (!isLive) return false;
    const more = await backend.loadOlder(key, limit ?? null);
    await refetch(key);
    return more;
  };
  const loadThread = async (key: string, root: string) => {
    if (!isLive) return;
    await backend.loadThread(key, root);
    await refetch(key);
  };

  const signOut = (orgId: string) => {
    const org = state.orgs.find((o) => o.id === orgId);
    if (!isLive || !org || !confirm(t("app.signOutConfirm", { user: org.userId }))) return;
    backend.signOut(orgId).catch((e) => setNotice(String(e)));
  };


  if (booting) return <div className="login-screen"><div className="spinner" aria-label={t("common.connecting")} /></div>;
  if (isLive && state.orgs.length === 0) return <Login onDone={() => {}} />;

  const unread = unreadByOrg(state.convs);
  const inScope = state.convs.filter((c) => state.orgFilter === "all" || c.orgId === state.orgFilter);
  const chatBadge = inScope.filter((c) => isUnread(c) && !c.muted).length;
  const selected = state.convs.find((c) => c.id === state.selectedId);
  // Only show features that at least one account in view can actually do.
  const caps = state.orgs.filter((o) => state.orgFilter === "all" || o.id === state.orgFilter).map((o) => capabilities[o.protocol]);
  const can = (k: keyof (typeof caps)[number]) => caps.some((c) => c[k]);
  // Reminders cover every Nextcloud account, whatever organization is in view.
  const cloudOrgs = isLive ? state.orgs.filter((o) => o.protocol === "talk" && (state.orgFilter === "all" || o.id === state.orgFilter)) : [];
  const notesOrgs = cloudOrgs.filter((o) => notesAccounts.includes(o.id));
  // Calendar and meeting reminders only for the Nextcloud accounts that have a calendar.
  const calendarOrgsAll = isLive ? state.orgs.filter((o) => calendarAccounts.includes(o.id)) : [];
  const calendarOrgs = cloudOrgs.filter((o) => calendarAccounts.includes(o.id));
  const inOrg = (key: string) => state.orgFilter === "all" || key.startsWith(`${state.orgFilter}|`);
  const shownServer = serverItems.filter((n) => inOrg(`${n.account}|`) && activityShown(serverEntry(n)));
  const teamChannels = new Set(teams.filter((t) => inOrg(t.key)).flatMap((t) => t.channels));
  const teamsBadge = state.convs.filter((c) => teamChannels.has(c.id) && isUnread(c) && !c.muted).length;
  const attention = state.orgs.find((o) => needsAttention(security[o.id]) && !dismissed.has(o.id));
  const securityOrg = state.orgs.find((o) => o.id === securityFor);

  return (
    <OrgsContext.Provider value={state.orgs.map((o) => ({ ...o, color: settings.orgColors[o.id] ?? o.color, ...shownPresence[o.id], ...(autoAway.has(o.id) ? { presence: "away" as const } : {}), offline: connections[o.id]?.error ?? undefined }))}>
    <ProfileContext.Provider value={openProfile}>
    <RoomLinkContext.Provider value={openRoomLink}>
    <HashtagContext.Provider value={setHashtag}>
    <InAppLinkContext.Provider value={openInApp}>
    <DateRefContext.Provider value={setDateRef}>
    <TranslatorsContext.Provider value={translateAccounts}>
    <CallsContext.Provider value={calls}>
    <TalkCallsContext.Provider value={talkCalls}>
    <KeyHelpContext.Provider value={(orgId) => {
      // Unreadable messages: verifying this session or setting up key backup brings the keys.
      const s = security[orgId];
      if (!s) return null;
      if (!s.deviceVerified) return { label: t("keyHelp.verify"), fix: () => setSecurityFor(orgId) };
      if (s.recovery === "disabled" || s.recovery === "incomplete") return { label: t("keyHelp.backup"), fix: () => setSecurityFor(orgId) };
      return null;
    }}>
      <div className="app">
        <nav className="rail">
          <OrgSwitcher current={state.orgFilter} unread={unread} onSelect={selectOrg} onAddAccount={addAccount} />
          <RailItem icon={<BellIcon />} label={t("rail.activity")} active={view === "activity"} badge={activity.filter((a) => a.at > seenAt && inOrg(a.conversation) && activityShown(a)).length + shownServer.filter((n) => n.at > seenAt).length} onClick={() => openView("activity")} />
          <RailItem icon={<ChatIcon />} label={t("rail.chat")} active={view === "chat"} badge={chatBadge} onClick={() => openView("chat")} />
          {can("teams") && <RailItem icon={<TeamsIcon />} label={t("rail.teams")} active={view === "teams"} badge={teamsBadge} onClick={() => openView("teams")} />}
          {/* A calls overview (history, ongoing calls) comes later; calls start from a chat. */}
          {(can("calls") || state.orgs.some((o) => o.protocol === "matrix")) && (
            <RailItem icon={<CallIcon />} label={t("rail.calls")} active={view === "calls"} onClick={() => openView("calls")}
              badge={calls.history.filter((r) => r.direction === "in" && !r.duration && r.outcome !== "answered_elsewhere" && r.at > callsSeenAt).length} />
          )}
          {/* Nextcloud Calendar (CalDAV) for the Nextcloud accounts in view. */}
          {calendarOrgs.length > 0 && <RailItem icon={<CalendarIcon />} label={t("rail.calendar")} active={view === "calendar"} onClick={() => openView("calendar")} />}
          {/* Nextcloud Notes, for the Nextcloud accounts that have the Notes app. */}
          {notesOrgs.length > 0 && <RailItem icon={<NotesIcon />} label={t("rail.notes")} active={view === "notes"} onClick={() => openView("notes")} />}
          {/* Nextcloud Files, for the Nextcloud accounts in view. */}
          {cloudOrgs.length > 0 && <RailItem icon={<FilesIcon />} label={t("rail.files")} active={view === "files"} onClick={() => openView("files")} />}
          <RailItem icon={<MoreIcon />} label="" soon />
        </nav>
        <div className="main">
          <TitleBar orgFilter={state.orgFilter} query={query} onQuery={setQuery} onSettings={() => setShowSettings("general")} onPresence={setPresence} dnd={dnd} onDnd={setDnd} onOpenMessage={openMessage} onAddAccount={addAccount} onSignOut={signOut} onSecurity={setSecurityFor} />
          {attention && (
            <SecurityBanner org={attention} status={security[attention.id]!} onFix={() => setSecurityFor(attention.id)}
              onDismiss={() => setDismissed(new Set([...dismissed, attention.id]))} />
          )}
          <UpdateBanner />
          {notice && (
            <div className="notice" role="alert">
              {notice} <button className="link" onClick={() => setNotice(null)}>{t("common.dismiss")}</button>
            </div>
          )}
          <div className="panes">
            {view === "chat" && (
              <ChatList query={query} onLeave={leaveChat} canDelete={canDeleteChat} onDelete={deleteChat} onNewChat={openNewChat} onBrowse={openBrowse} onAccept={acceptInvite} onDecline={declineInvite} convs={state.convs} orgFilter={state.orgFilter} selectedId={state.selectedId} dispatch={act} />
            )}
            {view === "teams" && (
              <TeamsPane teams={teams.filter((t) => state.orgFilter === "all" || t.account === state.orgFilter)} convs={state.convs} selectedId={state.selectedId}
                onSelect={(id) => act({ type: "select", id })} onBrowse={() => openBrowse()} onLeaveTeam={leaveTeam}
                onAccept={acceptInvite} onDecline={declineInvite} onTeamInfo={setTeamInfo} onNewTeam={() => openNewChat("team")} onNewChannel={openNewChannel}
                onBrowseTeam={(t) => openBrowse({ id: t.spaceId, alias: null, name: t.name, topic: t.topic, members: 0, avatar: t.avatar, isSpace: true, joined: t.key, joinRule: null })} />
            )}
            {view === "calendar" && (
              <CalendarPane orgs={calendarOrgs} convs={state.convs} request={calendarRequest} onOpenChat={(id) => { setView("chat"); act({ type: "select", id }); }}
                onJoinCall={(id) => { setView("chat"); act({ type: "select", id }); talkCalls.start(id, lastCameraOn()); }} />
            )}
            {view === "notes" && <NotesPane orgs={notesOrgs} />}
            {view === "files" && <FilesPane orgs={cloudOrgs} convs={state.convs} reveal={filesReveal} />}
            {view === "calls" && <CallsPane convs={state.convs} onOpen={(id) => { setView("chat"); act({ type: "select", id }); }} />}
            {view === "activity" && (
              <ActivityPane items={activity.filter((a) => inOrg(a.conversation) && activityShown(a))} isUnread={activityUnread} selected={activitySelected}
                server={shownServer} nextcloud={state.orgs.some((o) => o.protocol === "talk" && inOrg(`${o.id}|`))} onNotice={setNotice}
                onMarkAllRead={() => setActivityRead({ at: Date.now(), read: [], unread: [] })} onSetRead={setActivityItemRead}
                onRemove={removeActivity}
                onClear={() => { setUndoClear(activityCleared); setActivityCleared({ at: Date.now(), ids: [] }); setActivityRead({ at: Date.now(), read: [], unread: [] }); }}
                onUndoClear={undoClear ? () => { setActivityCleared(undoClear); setUndoClear(null); } : undefined}
                onOpen={(a) => { setActivitySelected(a.id); if (activityUnread(a)) setActivityItemRead(a, true); setFocusMessage(a.conversation, a.message); act({ type: "select", id: a.conversation }); }} />
            )}
            {teamInfo && view === "teams" && (
              <RoomPanel key={teamInfo.key} onClose={() => setTeamInfo(null)} onNotice={setNotice}
                conv={{ id: teamInfo.key, orgId: teamInfo.account, kind: "team", name: teamInfo.name, preview: "", time: "", sortKey: 0, favourite: false, muted: false, encrypted: false, unread: 0, mentions: 0, marked: false, avatar: teamInfo.avatar ?? undefined }} />
            )}
            {/* The calendar, notes and files fill the whole width, like Teams; the other views are a list beside the chat. */}
            {view === "calendar" || view === "notes" || view === "files" ? null : selected ? (
              <ChatView conv={selected} messages={timeline(state, selected)} dispatch={act} onNotice={setNotice} focusMessage={focusMessage?.conversation === selected.id ? focusMessage.message : null} onFocused={() => setFocusState(null)}
                onLoadOlder={(limit) => loadOlder(selected.id, limit)} onLoadThread={(root) => loadThread(selected.id, root)}
                onCommand={(name, args) => runCommand(selected.id, name, args)} attachments={staged[selected.id] ?? []} upload={uploads[selected.id]} onPreview={(m) => setPreview({ conversation: selected.id, message: m })}
                threadAttachments={(root) => staged[stagingKey(selected.id, root)] ?? []}
                onPickFiles={(root) => pickFiles(stagingKey(selected.id, root))} onAddFiles={(files, root) => addFiles(stagingKey(selected.id, root), files)} onRemoveAttachment={(id, root) => removeStaged(stagingKey(selected.id, root), id)}
                onAccept={() => acceptInvite(selected.id)} onDecline={() => declineInvite(selected.id)} onLeave={() => leaveChat(selected)} allConvs={state.convs} />
            ) : (
              <main className="chat-view empty-view"><p>{state.convs.length ? t("app.selectChat") : t("app.syncing")}</p></main>
            )}
          </div>
        </div>
      </div>
      {dragging && selected && <div className="drop-overlay">{dragging === "thread" ? t("app.dropToThread") : t("app.dropToAttach", { name: selected.name })}</div>}
      {browse && <BrowseDialog orgId={browse.space ? browse.space.joined!.split("|")[0] : state.orgFilter === "all" ? undefined : state.orgFilter}
        initialSpace={browse.space} onClose={() => setBrowse(false)} onOpen={setPendingOpen} />}
      {verification && (
        <VerificationDialog verification={verification} onClose={() => { closedFlows.current.add(verification.flowId); setVerification(null); }} />
      )}
      {cropFor && (
        <ImageCropper title={cropFor.kind === "room" ? t("room.changePicture") : t("settings.accounts.changePicture")} onClose={() => setCropFor(null)}
          onCrop={(png) => (cropFor.kind === "me" ? backend.setAvatar(cropFor.account, png)
            : cropFor.kind === "room" ? backend.setRoomAvatar(cropFor.key, png) : backend.setRoomMemberAvatar(cropFor.key, png))} />
      )}
      {dateRef && (
        <DatePopover info={dateRef} calendarOrgs={calendarOrgs} onClose={() => setDateRef(null)}
          onOpenCalendar={(date) => { setDateRef(null); setCalendarRequest({ date, n: Date.now() }); openView("calendar"); }}
          onAdd={(date, time, details) => { setDateRef(null); setCalendarRequest({ date, time, details, create: true, n: Date.now() }); openView("calendar"); }} />
      )}
      {hashtag && <HashtagPanel tag={hashtag} conversation={selected?.id} conversationName={selected?.name} onOpen={openMessage} onClose={() => setHashtag(null)} />}
      {preview && (
        <ContextDialog {...preview} title={state.convs.find((c) => c.id === preview.conversation)?.name ?? ""}
          onClose={() => setPreview(null)} onShowInChat={() => { setPreview(null); showInChat(preview.conversation, preview.message); }} />
      )}
      {joinPreview && (
        <JoinRoomDialog {...joinPreview} onClose={() => setJoinPreview(null)}
          onJoined={(key, room) => { setJoinPreview(null); if (room.isSpace) setView("teams"); else if (key) { setView("chat"); setPendingOpen(key); } }} />
      )}
      {newChat && <NewChatDialog initialMode={newChat} orgId={state.orgFilter === "all" ? undefined : state.orgFilter} onOpen={setPendingOpen}
        team={newChannelIn ? { account: newChannelIn.account, spaceId: newChannelIn.spaceId, name: newChannelIn.name } : undefined}
        onClose={() => { setNewChat(false); setNewChannelIn(null); }} />}
      {showSettings && <SettingsDialog initialTab={showSettings} settings={settings} onChange={setSettings} onClose={() => setShowSettings(false)} />}
      {profileFor && (
        <ProfileCard {...profileFor} convs={state.convs} onClose={() => setProfileFor(null)} onNotice={setNotice}
          onOpen={(key) => { setProfileFor(null); setView("chat"); setPendingOpen(key); }} />
      )}
      {securityOrg && (
        <RecoveryDialog org={securityOrg} status={security[securityOrg.id]} onClose={() => setSecurityFor(null)}
          onUpdated={(s) => setSecurity((prev) => ({ ...prev, [securityOrg.id]: s }))} />
      )}
      {addingAccount && <Login dialog onDone={() => setAddingAccount(false)} onCancel={() => setAddingAccount(false)} />}
      </KeyHelpContext.Provider>
      <CallScreen calls={calls} conversation={state.convs.find((c) => c.id === calls.call?.conversation)} />
      {calendarOrgsAll.length > 0 && (
        <MeetingReminder orgs={calendarOrgsAll} convs={state.convs} minutes={settings.reminderMinutes}
          onOpenChat={(id) => { setView("chat"); act({ type: "select", id }); }}
          onJoin={(id) => { setView("chat"); act({ type: "select", id }); talkCalls.start(id, lastCameraOn()); }} />
      )}
      {isLive && (
        <TalkRing convs={state.convs} talkOrgs={new Set(state.orgs.filter((o) => o.protocol === "talk").map((o) => o.id))}
          busy={talkCalls.call && talkCalls.call.phase !== "ended" ? talkCalls.call.conversation : null}
          onJoin={(id) => { setView("chat"); act({ type: "select", id }); talkCalls.start(id, lastCameraOn()); }} />
      )}
    </TalkCallsContext.Provider>
    </CallsContext.Provider>
    </TranslatorsContext.Provider>
    </DateRefContext.Provider>
    </InAppLinkContext.Provider>
    </HashtagContext.Provider>
    </RoomLinkContext.Provider>
    </ProfileContext.Provider>
    </OrgsContext.Provider>
  );
}

/** useState that survives restarts (localStorage, per device). */
function useStored<T>(key: string, initial: T | (() => T)) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw !== null) return JSON.parse(raw) as T;
    } catch { /* private mode or bad JSON */ }
    return initial instanceof Function ? initial() : initial;
  });
  const set = (next: T) => {
    setValue(next);
    try { localStorage.setItem(key, JSON.stringify(next)); } catch { /* private mode */ }
  };
  return [value, set] as const;
}

function RailItem({ icon, label, active, badge, soon, onClick }: { icon: ReactNode; label: string; active?: boolean; badge?: number; soon?: boolean; onClick?: () => void }) {
  return (
    <button className={`rail-item ${active ? "active" : ""}`} title={soon ? t("rail.soon", { label: label || t("rail.more") }) : label} disabled={soon} onClick={onClick}>
      {icon}
      {!!badge && <span className="badge">{badge}</span>}
      {label && <span className="rail-label">{label}</span>}
    </button>
  );
}
