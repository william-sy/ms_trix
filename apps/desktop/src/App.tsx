import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { backend, isLive, subscribe, type ActivityItem, type DirectoryRoom, type SecurityStatus, type TeamView } from "./backend";
import { BellIcon, CallIcon, ChatIcon, MoreIcon, TeamsIcon } from "./Icons";
import { capabilities } from "./mock";
import { ChatList } from "./ChatList";
import { ChatView } from "./ChatView";
import { Login } from "./Login";
import { OrgSwitcher } from "./OrgSwitcher";
import { RecoveryDialog, SecurityBanner, needsAttention } from "./Security";
import { TitleBar } from "./TitleBar";
import { SettingsDialog } from "./SettingsDialog";
import { applySettings, loadSettings, saveSettings, type Settings } from "./settings";
import type { Attachment, Conversation, PresenceState } from "./types";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|heic|bmp)$/i;
import { OrgsContext, initialState, isUnread, reducer, timeline, unreadByOrg, type Action, type OrgFilter } from "./store";
import { NewChatDialog } from "./NewChatDialog";
import { BrowseDialog } from "./BrowseDialog";
import { ProfileCard, ProfileContext, type OpenProfile } from "./Profile";
import { ActivityPane } from "./ActivityPane";
import { TeamsPane } from "./TeamsPane";
import { t } from "./i18n";

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [booting, setBooting] = useState(isLive);
  const [addingAccount, setAddingAccount] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [dragging, setDragging] = useState(false);
  // Conversation to open once it shows up (after /join or /query).
  const [pendingOpen, setPendingOpen] = useState<string | null>(null);
  const [staged, setStaged] = useState<Record<string, Attachment[]>>({});
  // Our own status per account, as last set from this app.
  const [ownPresence, setOwnPresence] = useState<Record<string, { presence: PresenceState; status?: string }>>({});
  const setPresence = (orgId: string, presence: PresenceState, status?: string) => {
    setOwnPresence((s) => ({ ...s, [orgId]: { presence, status } }));
    if (isLive) backend.setPresence(orgId, presence, status ?? null).catch((e) => setNotice(String(e)));
  };
  const [settings, setSettingsState] = useState(loadSettings);
  const [showSettings, setShowSettings] = useState(false);
  const [newChat, setNewChat] = useState(false);
  const [profileFor, setProfileFor] = useState<{ account: string; userId: string; at: { x: number; y: number } } | null>(null);
  const openProfile = useCallback<OpenProfile>((account, userId, at) => setProfileFor({ account, userId, at }), []);
  const [browse, setBrowse] = useState<false | { space?: DirectoryRoom }>(false);
  const [view, setView] = useState<"activity" | "chat" | "teams">("chat");
  const [teams, setTeams] = useState<TeamView[]>([]);
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [activitySelected, setActivitySelected] = useState<string | null>(null);
  const [focusMessage, setFocusMessage] = useState<string | null>(null);
  // Activity newer than this is "unread"; bumped when you open the feed.
  const [seenAt, setSeenAt] = useState(() => { try { return Number(localStorage.getItem("ms_trix.activity.seenAt") ?? 0); } catch { return 0; } });
  const [feedSeenAt, setFeedSeenAt] = useState(seenAt);
  const [readActivity, setReadActivity] = useState<Set<string>>(new Set());
  const markActivitySeen = (at: number) => {
    setSeenAt(at);
    try { localStorage.setItem("ms_trix.activity.seenAt", String(at)); } catch { /* private mode */ }
  };
  const openView = (v: typeof view) => {
    if (v === "activity") {
      setFeedSeenAt(seenAt); // keep this visit's unread dots until marked read
      setReadActivity(new Set());
      markActivitySeen(Date.now());
    }
    setView(v);
  };
  const setSettings = (s: Settings) => { setSettingsState(s); saveSettings(s); applySettings(s); };
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = state.selectedId;
  const [security, setSecurity] = useState<Record<string, SecurityStatus>>({});
  const [securityFor, setSecurityFor] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());
  const selectOrg = useCallback((org: OrgFilter) => dispatch({ type: "selectOrg", org }), []);

  useEffect(() => {
    if (!isLive) return;
    let off: (() => void) | undefined;
    subscribe({
      accounts: (orgs) => dispatch({ type: "setOrgs", orgs }),
      conversations: (convs) => dispatch({ type: "upsertConvs", convs }),
      removed: (keys) => dispatch({ type: "removeConvs", keys }),
      messages: (items) => dispatch({ type: "appendMessages", items }),
      restored: () => setBooting(false),
      teams: setTeams,
      activity: setActivity,
      accountError: (userId, error) => setNotice(t("app.reconnectFailed", { user: userId, error })),
    }).then(async (unlisten) => {
      off = unlisten;
      dispatch({ type: "setOrgs", orgs: await backend.accounts() });
      dispatch({ type: "upsertConvs", convs: await backend.conversations() });
      setTeams(await backend.teams());
      setActivity(await backend.activity());
      if (await backend.restored()) setBooting(false);
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
    if (isLive) getCurrentWindow().setBadgeCount(unreadTotal || undefined).catch(() => {});
  }, [unreadTotal]);

  // Drop files anywhere on the window to send them to the open chat.
  useEffect(() => {
    if (!isLive) return;
    const off = getCurrentWebview().onDragDropEvent((e) => {
      const p = e.payload;
      if (p.type === "enter" || p.type === "over") setDragging(!!selectedRef.current);
      else if (p.type === "leave") setDragging(false);
      else if (p.type === "drop") {
        setDragging(false);
        const key = selectedRef.current;
        if (key && p.paths.length) backend.describeFiles(p.paths).then((files) => stagePaths(key, files)).catch((err) => setNotice(String(err)));
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
    backend.acceptInvite(key).then(() => setPendingOpen(key)).catch((e) => setNotice(String(e)));
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
  const openBrowse = (space?: DirectoryRoom) => (isLive ? setBrowse({ space }) : setNotice(t("desktopOnly.browse")));
  const openMessage = (conversation: string, message: string) => {
    setView("chat");
    setQuery("");
    setFocusMessage(message);
    act({ type: "select", id: conversation });
  };
  const openNewChat = () => (isLive ? setNewChat(true) : setNotice(t("desktopOnly.newChat")));

  const runCommand = (key: string, name: string, args: string) => {
    if (!isLive) return setNotice(t("desktopOnly.command", { name }));
    backend.runCommand(key, name, args)
      .then((out) => { setNotice(out.message); if (out.open) setPendingOpen(out.open); })
      .catch((e) => setNotice(String(e)));
  };
  // Files wait in the composer (per chat) until the user presses Send.
  const stage = (key: string, items: Attachment[]) => setStaged((s) => ({ ...s, [key]: [...(s[key] ?? []), ...items] }));
  const stagePaths = (key: string, files: { path: string; name: string; size: number }[]) => {
    const items = files.map((f) => ({ id: crypto.randomUUID(), name: f.name, size: f.size, path: f.path }));
    stage(key, items);
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
  const addFiles = (key: string, files: File[]) =>
    stage(key, files.map((file) => ({
      id: crypto.randomUUID(),
      name: file.name && file.name !== "image.png" ? file.name : `pasted-${new Date().toISOString().replace(/[:.]/g, "-")}.png`,
      size: file.size,
      file,
      preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined,
    })));
  const removeStaged = (key: string, id: string) =>
    setStaged((s) => {
      const gone = s[key]?.find((a) => a.id === id);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return { ...s, [key]: (s[key] ?? []).filter((a) => a.id !== id) };
    });
  const sendAttachments = async (key: string, items: Attachment[], caption: string) => {
    setStaged((s) => ({ ...s, [key]: [] }));
    if (!isLive) return setNotice(t("desktopOnly.files"));
    try {
      for (const [i, a] of items.entries()) {
        // One caption for the batch, on the last file.
        const text = i === items.length - 1 && caption ? caption : null;
        if (a.file) await backend.sendFileBytes(key, a.name, a.file.type || null, Array.from(new Uint8Array(await a.file.arrayBuffer())), text);
        else if (a.path) await backend.sendFilePaths(key, [a.path], text);
      }
    } catch (e) {
      setNotice(String(e));
    } finally {
      items.forEach((a) => a.preview && URL.revokeObjectURL(a.preview));
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
      case "send":
        if (action.message.attachments?.length) return void sendAttachments(action.id, action.message.attachments, action.message.text);
        return void backend.send(action.id, action.message).catch(report);
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
  const loadOlder = async (key: string) => {
    if (!isLive) return false;
    const more = await backend.loadOlder(key);
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
  const inOrg = (key: string) => state.orgFilter === "all" || key.startsWith(`${state.orgFilter}|`);
  const teamChannels = new Set(teams.filter((t) => inOrg(t.key)).flatMap((t) => t.channels));
  const teamsBadge = state.convs.filter((c) => teamChannels.has(c.id) && isUnread(c) && !c.muted).length;
  const attention = state.orgs.find((o) => needsAttention(security[o.id]) && !dismissed.has(o.id));
  const securityOrg = state.orgs.find((o) => o.id === securityFor);

  return (
    <OrgsContext.Provider value={state.orgs.map((o) => ({ ...o, ...ownPresence[o.id] }))}>
    <ProfileContext.Provider value={openProfile}>
      <div className="app">
        <nav className="rail">
          <OrgSwitcher current={state.orgFilter} unread={unread} onSelect={selectOrg} onAddAccount={addAccount} />
          <RailItem icon={<BellIcon />} label={t("rail.activity")} active={view === "activity"} badge={activity.filter((a) => a.at > seenAt && inOrg(a.conversation)).length} onClick={() => openView("activity")} />
          <RailItem icon={<ChatIcon />} label={t("rail.chat")} active={view === "chat"} badge={chatBadge} onClick={() => openView("chat")} />
          {can("teams") && <RailItem icon={<TeamsIcon />} label={t("rail.teams")} active={view === "teams"} badge={teamsBadge} onClick={() => openView("teams")} />}
          {can("calls") && <RailItem icon={<CallIcon />} label={t("rail.calls")} />}
          <RailItem icon={<MoreIcon />} label="" soon />
        </nav>
        <div className="main">
          <TitleBar orgFilter={state.orgFilter} query={query} onQuery={setQuery} onSettings={() => setShowSettings(true)} onPresence={setPresence} onOpenMessage={openMessage} onAddAccount={addAccount} onSignOut={signOut} onSecurity={setSecurityFor} />
          {attention && (
            <SecurityBanner org={attention} status={security[attention.id]!} onFix={() => setSecurityFor(attention.id)}
              onDismiss={() => setDismissed(new Set([...dismissed, attention.id]))} />
          )}
          {notice && (
            <div className="notice" role="alert">
              {notice} <button className="link" onClick={() => setNotice(null)}>{t("common.dismiss")}</button>
            </div>
          )}
          <div className="panes">
            {view === "chat" && (
              <ChatList query={query} onLeave={leaveChat} onNewChat={openNewChat} onBrowse={openBrowse} onAccept={acceptInvite} onDecline={declineInvite} convs={state.convs} orgFilter={state.orgFilter} selectedId={state.selectedId} dispatch={act} />
            )}
            {view === "teams" && (
              <TeamsPane teams={teams.filter((t) => state.orgFilter === "all" || t.account === state.orgFilter)} convs={state.convs} selectedId={state.selectedId}
                onSelect={(id) => act({ type: "select", id })} onBrowse={() => openBrowse()}
                onBrowseTeam={(t) => openBrowse({ id: t.spaceId, alias: null, name: t.name, topic: t.topic, members: 0, avatar: t.avatar, isSpace: true, joined: t.key })} />
            )}
            {view === "activity" && (
              <ActivityPane items={activity.filter((a) => inOrg(a.conversation))} seenAt={feedSeenAt} readIds={readActivity} selected={activitySelected}
                onMarkAllRead={() => { const now = Date.now(); setFeedSeenAt(now); markActivitySeen(now); }}
                onOpen={(a) => { setActivitySelected(a.id); setReadActivity((s) => new Set(s).add(a.id)); setFocusMessage(a.message); act({ type: "select", id: a.conversation }); }} />
            )}
            {selected ? (
              <ChatView conv={selected} messages={timeline(state, selected)} dispatch={act} onNotice={setNotice} focusMessage={focusMessage}
                onLoadOlder={() => loadOlder(selected.id)} onLoadThread={(root) => loadThread(selected.id, root)}
                onCommand={(name, args) => runCommand(selected.id, name, args)} attachments={staged[selected.id] ?? []}
                onPickFiles={() => pickFiles(selected.id)} onAddFiles={(files) => addFiles(selected.id, files)} onRemoveAttachment={(id) => removeStaged(selected.id, id)}
                onAccept={() => acceptInvite(selected.id)} onDecline={() => declineInvite(selected.id)} onLeave={() => leaveChat(selected)} />
            ) : (
              <main className="chat-view empty-view"><p>{state.convs.length ? t("app.selectChat") : t("app.syncing")}</p></main>
            )}
          </div>
        </div>
      </div>
      {dragging && selected && <div className="drop-overlay">{t("app.dropToAttach", { name: selected.name })}</div>}
      {browse && <BrowseDialog orgId={browse.space ? browse.space.joined!.split("|")[0] : state.orgFilter === "all" ? undefined : state.orgFilter}
        initialSpace={browse.space} onClose={() => setBrowse(false)} onOpen={setPendingOpen} />}
      {newChat && <NewChatDialog orgId={state.orgFilter === "all" ? undefined : state.orgFilter} onClose={() => setNewChat(false)} onOpen={setPendingOpen} />}
      {showSettings && <SettingsDialog settings={settings} onChange={setSettings} onClose={() => setShowSettings(false)} />}
      {profileFor && (
        <ProfileCard {...profileFor} convs={state.convs} onClose={() => setProfileFor(null)} onNotice={setNotice}
          onOpen={(key) => { setProfileFor(null); setView("chat"); setPendingOpen(key); }} />
      )}
      {securityOrg && (
        <RecoveryDialog org={securityOrg} status={security[securityOrg.id]} onClose={() => setSecurityFor(null)}
          onUpdated={(s) => setSecurity((prev) => ({ ...prev, [securityOrg.id]: s }))} />
      )}
      {addingAccount && <Login dialog onDone={() => setAddingAccount(false)} onCancel={() => setAddingAccount(false)} />}
    </ProfileContext.Provider>
    </OrgsContext.Provider>
  );
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
