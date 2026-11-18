import { useEffect, useState } from "react";
import { ContextMenu } from "./ContextMenu";
import { Avatar } from "./Avatar";
import { ImageCropper } from "./ImageCropper";
import { backend, type RoomDetails, type RoomMember } from "./backend";
import { commandText, t } from "./i18n";
import { LockIcon } from "./Icons";
import { useOpenProfile } from "./Profile";
import { useOrg } from "./store";
import { TalkSettings } from "./TalkSettings";
import type { Conversation, Member } from "./types";

interface Props {
  conv: Conversation;
  onClose: () => void;
  onNotice: (message: string) => void;
}

/** Room info: picture, name, topic, notifications and members, editable when allowed. */
export function RoomPanel({ conv, onClose, onNotice }: Props) {
  const openProfile = useOpenProfile();
  // Talk conversations get Talk's own settings (TalkSettings) instead of the Matrix ones.
  const talk = useOrg(conv.orgId).protocol === "talk";
  const [details, setDetails] = useState<RoomDetails | null>(null);
  const [editing, setEditing] = useState<"name" | "topic" | null>(null);
  const [draft, setDraft] = useState("");
  const [memberQuery, setMemberQuery] = useState("");
  const [inviting, setInviting] = useState(false);
  const [cropping, setCropping] = useState(false);

  const reload = () => backend.roomDetails(conv.id).then(setDetails).catch((e) => onNotice(String(e)));
  useEffect(() => {
    setDetails(null);
    setEditing(null);
    reload();
  }, [conv.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    if (!editing) return;
    try {
      await backend.updateRoom(conv.id, { [editing]: draft });
      setEditing(null);
      reload();
    } catch (e) {
      onNotice(String(e));
    }
  };

  const setLevel = (level: string) =>
    backend.setNotificationLevel(conv.id, level).then(reload).catch((e) => onNotice(String(e)));

  // Moderation goes through the same server calls as /op, /remove, /ban and /unban.
  const [memberMenu, setMemberMenu] = useState<{ member: RoomMember; x: number; y: number } | null>(null);
  useEffect(() => {
    const close = () => setMemberMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);
  const moderate = (name: string, args: string) =>
    backend.runCommand(conv.id, name, args).then((out) => { if (out.message) onNotice(commandText(out)); reload(); }).catch((e) => onNotice(String(e)));
  // Remove / ban ask for an optional reason first.
  const [asking, setAsking] = useState<{ action: "remove" | "ban"; member: RoomMember } | null>(null);
  const [aliasDraft, setAliasDraft] = useState<string | null>(null);
  const saveAlias = () => {
    const name = aliasDraft?.trim();
    setAliasDraft(null);
    if (name) backend.setRoomAlias(conv.id, name).then(reload).catch((e) => onNotice(String(e)));
  };
  const turnOnEncryption = () => {
    if (!confirm(t("room.encryptConfirm"))) return;
    backend.enableEncryption(conv.id).then(reload).catch((e) => onNotice(String(e)));
  };

  const changeAvatar = () => setCropping(true);

  if (!details) {
    return (
      <aside className="thread-pane room-panel">
        <header className="chat-head"><h2>{conv.kind === "team" ? t("teams.info") : t("room.info")}</h2><span className="spacer" /><button className="icon-btn" title={t("common.close")} onClick={onClose}>✕</button></header>
        <p className="empty">{t("common.loading")}</p>
      </aside>
    );
  }

  const q = memberQuery.trim().toLowerCase();
  const members = details.members.filter((m) => !q || `${m.name} ${m.userId}`.toLowerCase().includes(q));
  const editable = (field: "name" | "topic", value: string | null, empty: string) =>
    editing === field ? (
      <div className="inline-edit">
        {field === "topic" ? (
          <textarea autoFocus rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setEditing(null)} />
        ) : (
          <input autoFocus value={draft} onChange={(e) => setDraft(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") save(); if (e.key === "Escape") setEditing(null); }} />
        )}
        <div className="edit-actions">
          <button className="btn small" onClick={() => setEditing(null)}>{t("common.cancel")}</button>
          <button className="btn primary small" onClick={save}>{t("common.save")}</button>
        </div>
      </div>
    ) : (
      <div className={`field ${details.canEdit ? "editable" : ""}`} onClick={() => { if (details.canEdit) { setDraft(value ?? ""); setEditing(field); } }} title={details.canEdit ? t("room.clickToEdit") : undefined}>
        {value || <span className="muted">{empty}</span>}
      </div>
    );

  return (
    <aside className="thread-pane room-panel">
      <header className="chat-head">
        <h2>{conv.kind === "team" ? t("teams.info") : t("room.info")}</h2>
        <span className="spacer" />
        <button className="icon-btn" title={t("common.close")} onClick={onClose}>✕</button>
      </header>
      <div className="room-panel-body">
        <div className="room-identity">
          <button className={`room-avatar ${details.canEdit && !details.isDirect ? "editable" : ""}`} disabled={!details.canEdit || details.isDirect} onClick={changeAvatar} title={details.canEdit ? t("room.changePicture") : undefined}>
            <Avatar account={conv.orgId} media={details.avatar ?? undefined} name={details.name} className={`big kind-${conv.kind}`} channel={conv.kind === "channel"} />
          </button>
          {details.isDirect ? <h3>{details.name}</h3> : editable("name", details.name, "")}
          {details.alias && <span className="muted mono-ish">{details.alias}</span>}
          <span className={`enc ${details.encrypted ? "on" : ""}`}><LockIcon /> {details.encrypted ? t("room.encrypted") : t("room.notEncrypted")}</span>
        </div>

        {!details.isDirect && (
          <section>
            <h4>{t("room.topic")}</h4>
            {editable("topic", details.topic, details.canEdit ? t("room.addTopic") : t("room.noTopic"))}
          </section>
        )}

        {!talk && <section>
          <h4>{t("room.notifications")}</h4>
          <div className="segmented small" role="radiogroup">
            {(["all", "mentions", "mute"] as const).map((level) => (
              <button key={level} role="radio" aria-checked={details.notifications === level} className={details.notifications === level ? "on" : ""} onClick={() => setLevel(level)}>
                {t(`room.notify.${level}`)}
              </button>
            ))}
          </div>
        </section>}

        <section>
          <div className="members-head">
            <h4>{t("room.members", { count: details.members.length })}</h4>
            {details.canInvite && !details.isDirect && <button className="btn small" onClick={() => setInviting(true)}>{t("room.invite")}</button>}
          </div>
          {details.members.length > 8 && <input className="member-search" value={memberQuery} placeholder={t("room.searchMembers")} onChange={(e) => setMemberQuery(e.target.value)} />}
          <div className="members">
            {members.map((m) => {
              // Only people below you can be changed, like the server enforces.
              const canManage = !details.isDirect && m.level < details.myLevel && (details.canKick || details.canBan || details.canSetRoles);
              return (
                <div key={m.userId} className="member">
                  <button className="member-main" onClick={(e) => openProfile(conv.orgId, m.userId, { x: e.clientX - 300, y: e.clientY })}>
                    <Avatar account={conv.orgId} media={m.avatar ?? undefined} name={m.name} className="small" />
                    <span className="member-name">{m.name}</span>
                    {m.role && <span className={`role role-${m.role}`}>{t(`room.role.${m.role}`)}</span>}
                  </button>
                  {canManage && (
                    <button className="icon-btn member-more" title={t("common.moreOptions")}
                      onClick={(e) => { e.stopPropagation(); setMemberMenu({ member: m, x: Math.min(e.clientX, window.innerWidth - 220), y: e.clientY }); }}>⋯</button>
                  )}
                </div>
              );
            })}
          </div>
        </section>

        {details.banned.length > 0 && details.canBan && (
          <section>
            <h4>{t("room.banned", { count: details.banned.length })}</h4>
            <div className="members">
              {details.banned.map((m) => (
                <div key={m.userId} className="member">
                  <span className="member-main">
                    <Avatar account={conv.orgId} media={m.avatar ?? undefined} name={m.name} className="small" />
                    <span className="member-name">{m.name}</span>
                  </span>
                  <button className="btn small" onClick={() => moderate("unban", m.userId)}>{t("room.unban")}</button>
                </div>
              ))}
            </div>
          </section>
        )}

        {talk && <TalkSettings conv={conv} onNotice={onNotice} onChanged={reload} onGone={onClose} />}

        {!talk && !details.isDirect && (details.canSetJoinRule || details.canSetAlias || details.canEncrypt || details.canSetHistory || details.canSetRoles || details.canSetAcl) && (
          <section className="room-settings">
            <h4>{t("room.settings")}</h4>
            {details.canSetJoinRule && (
              <div className="setting">
                <span>{t("room.whoCanJoin")}</span>
                <div className="segmented small" role="radiogroup">
                  {(details.inTeam || details.joinRule === "restricted" ? (["invite", "restricted", "public"] as const) : (["invite", "public"] as const)).map((rule) => (
                    <button key={rule} role="radio" aria-checked={details.joinRule === rule} className={details.joinRule === rule ? "on" : ""}
                      onClick={() => details.joinRule !== rule && backend.setJoinRule(conv.id, rule).then(reload).catch((e) => onNotice(String(e)))}>
                      {t(rule === "restricted" ? "room.join.team" : `room.join.${rule}`)}
                    </button>
                  ))}
                </div>
                {details.joinRule === "knock" && <p className="hint">{t("room.join.knock")}</p>}
              </div>
            )}
            {details.canSetAlias && (
              <div className="setting">
                <span>{t("room.address")}</span>
                {aliasDraft === null ? (
                  <button className="link" onClick={() => setAliasDraft(details.alias?.slice(1).split(":")[0] ?? "")}>{details.alias ?? t("room.addAddress")}</button>
                ) : (
                  <span className="alias-edit">#<input autoFocus value={aliasDraft} onChange={(e) => setAliasDraft(e.target.value.replace(/[\s#:]/g, ""))}
                    onKeyDown={(e) => { if (e.key === "Enter") saveAlias(); if (e.key === "Escape") setAliasDraft(null); }} onBlur={saveAlias} /></span>
                )}
              </div>
            )}
            {details.canSetHistory && (
              <div className="setting">
                <span>{t("room.history")}</span>
                <select value={details.historyVisibility} onChange={(e) => backend.setHistoryVisibility(conv.id, e.target.value).then(reload).catch((err) => onNotice(String(err)))}>
                  {(["shared", "invited", "joined", "world_readable"] as const).map((v) => <option key={v} value={v}>{t(`room.history.${v}`)}</option>)}
                </select>
              </div>
            )}
            {details.canSetRoles && details.permissions.length > 0 && (
              <details className="setting-group">
                <summary>{t("room.permissions")}</summary>
                {details.permissions.map(([key, level]) => (
                  <div key={key} className="setting">
                    <span>{t(`room.perm.${key}` as Parameters<typeof t>[0])}</span>
                    <select value={String(level)} onChange={(e) => backend.setPermission(conv.id, key, Number(e.target.value)).then(reload).catch((err) => onNotice(String(err)))}>
                      {/* Keep an unusual level selectable as it is. */}
                      {![0, 50, 100].includes(level) && <option value={String(level)}>{t("room.level.custom", { level })}</option>}
                      {[0, 50, 100].filter((l) => l <= details.myLevel).map((l) => <option key={l} value={String(l)}>{t(`room.level.${l}` as Parameters<typeof t>[0])}</option>)}
                    </select>
                  </div>
                ))}
              </details>
            )}
            {details.canSetAcl && <ServerAcl acl={details.serverAcl} onSave={(allow, deny) => backend.setServerAcl(conv.id, allow, deny).then(reload).catch((err) => onNotice(String(err)))} />}
            {details.canEncrypt && (
              <div className="setting">
                <span>{t("room.notEncrypted")}</span>
                <button className="btn small" onClick={turnOnEncryption}>{t("room.encryptOn")}</button>
              </div>
            )}
          </section>
        )}
      </div>
      {memberMenu && (
        <ContextMenu x={memberMenu.x} y={memberMenu.y}>
          {details.canSetRoles && ([["admin", 100], ["moderator", 50], ["member", 0]] as const)
            .filter(([, level]) => level <= details.myLevel && level !== memberMenu.member.level)
            .map(([role, level]) => (
              <button key={role} className="menu-item" onClick={() => { setMemberMenu(null); moderate(level ? "op" : "deop", level ? `${memberMenu.member.userId} ${level}` : memberMenu.member.userId); }}>
                {t(`room.makeRole.${role}`)}
              </button>
            ))}
          {(details.canKick || details.canBan) && <div className="menu-sep" />}
          {details.canKick && <button className="menu-item danger" onClick={() => { setAsking({ action: "remove", member: memberMenu.member }); setMemberMenu(null); }}>{t("room.remove")}</button>}
          {details.canBan && <button className="menu-item danger" onClick={() => { setAsking({ action: "ban", member: memberMenu.member }); setMemberMenu(null); }}>{t("room.ban")}</button>}
        </ContextMenu>
      )}
      {asking && (
        <ReasonDialog question={t(asking.action === "ban" ? "room.banReason" : "room.removeReason", { name: asking.member.name })}
          confirm={t(asking.action === "ban" ? "room.ban" : "room.remove").replace("…", "")} onClose={() => setAsking(null)}
          onConfirm={(reason) => { setAsking(null); moderate(asking.action, `${asking.member.userId} ${reason}`.trim()); }} />
      )}
      {cropping && <ImageCropper title={t("room.changePicture")} onCrop={(png) => backend.setRoomAvatar(conv.id, png).then(reload)} onClose={() => setCropping(false)} />}
      {inviting && <InviteDialog conv={conv} onClose={() => setInviting(false)} onDone={(name) => { setInviting(false); onNotice(t("room.invited", { name })); reload(); }} onNotice={onNotice} />}
    </aside>
  );
}

/** Matrix server ACL: which servers may take part. One server (or *.wildcard) per line. */
function ServerAcl({ acl, onSave }: { acl: [string[], string[]] | null; onSave: (allow: string[], deny: string[]) => void }) {
  const [allow, setAllow] = useState((acl?.[0] ?? ["*"]).join("\n"));
  const [deny, setDeny] = useState((acl?.[1] ?? []).join("\n"));
  const lines = (s: string) => s.split(/\s+/).map((l) => l.trim()).filter(Boolean);
  return (
    <details className="setting-group">
      <summary>{t("room.acl")}</summary>
      <p className="hint">{t("room.aclHint")}</p>
      <label className="acl-field">{t("room.aclAllow")}<textarea rows={3} value={allow} onChange={(e) => setAllow(e.target.value)} /></label>
      <label className="acl-field">{t("room.aclDeny")}<textarea rows={3} value={deny} placeholder="evil.example.org" onChange={(e) => setDeny(e.target.value)} /></label>
      <button className="btn small" onClick={() => onSave(lines(allow), lines(deny))}>{t("common.save")}</button>
    </details>
  );
}

function ReasonDialog({ question, confirm, onConfirm, onClose }: { question: string; confirm: string; onConfirm: (reason: string) => void; onClose: () => void }) {
  const [reason, setReason] = useState("");
  return (
    <div className="login-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="login-card reason-dialog" onSubmit={(e) => { e.preventDefault(); onConfirm(reason); }}>
        <p>{question}</p>
        <input autoFocus value={reason} placeholder={t("room.reasonPlaceholder")} onChange={(e) => setReason(e.target.value)} onKeyDown={(e) => e.key === "Escape" && onClose()} />
        <div className="edit-actions">
          <button type="button" className="btn small" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn primary small danger">{confirm}</button>
        </div>
      </form>
    </div>
  );
}

function InviteDialog({ conv, onClose, onDone, onNotice }: { conv: Conversation; onClose: () => void; onDone: (name: string) => void; onNotice: (m: string) => void }) {
  const [term, setTerm] = useState("");
  const [results, setResults] = useState<Member[]>([]);
  const query = term.trim();
  const typed: Member | null = /^@[^\s:]+:\S+$/.test(query) && !results.some((r) => r.userId === query) ? { userId: query, name: query } : null;

  useEffect(() => {
    if (query.length < 2) return setResults([]);
    const timer = window.setTimeout(() => backend.searchUsers(conv.orgId, query).then(setResults).catch(() => setResults([])), 300);
    return () => window.clearTimeout(timer);
  }, [query, conv.orgId]);

  const invite = (m: Member) => backend.inviteUser(conv.id, m.userId).then(() => onDone(m.name)).catch((e) => onNotice(String(e)));

  return (
    <div className="login-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="login-card new-chat">
        <button className="icon-btn close" onClick={onClose} title={t("common.closeEsc")}>✕</button>
        <h1>{t("room.inviteTo", { name: conv.name })}</h1>
        <input autoFocus value={term} onChange={(e) => setTerm(e.target.value)} placeholder={t("room.invitePlaceholder")} onKeyDown={(e) => e.key === "Escape" && onClose()} />
        <div className="results">
          {[...(typed ? [typed] : []), ...results].slice(0, 8).map((m) => (
            <div key={m.userId} className="result">
              <Avatar account={conv.orgId} media={m.avatar ?? undefined} name={m.name} />
              <span className="result-text"><b>{m.name}</b><small>{m.userId}</small></span>
              <button className="btn primary small" onClick={() => invite(m)}>{t("room.invite")}</button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
