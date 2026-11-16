import { useEffect, useState } from "react";
import { Avatar } from "./Avatar";
import { backend, type RoomDetails } from "./backend";
import { t } from "./i18n";
import { LockIcon } from "./Icons";
import { useOpenProfile } from "./Profile";
import type { Conversation, Member } from "./types";

interface Props {
  conv: Conversation;
  onClose: () => void;
  onNotice: (message: string) => void;
}

/** Room info: picture, name, topic, notifications and members, editable when allowed. */
export function RoomPanel({ conv, onClose, onNotice }: Props) {
  const openProfile = useOpenProfile();
  const [details, setDetails] = useState<RoomDetails | null>(null);
  const [editing, setEditing] = useState<"name" | "topic" | null>(null);
  const [draft, setDraft] = useState("");
  const [memberQuery, setMemberQuery] = useState("");
  const [inviting, setInviting] = useState(false);

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

  const changeAvatar = () => backend.pickRoomAvatar(conv.id).then((changed) => { if (changed) reload(); }).catch((e) => onNotice(String(e)));

  if (!details) {
    return (
      <aside className="thread-pane room-panel">
        <header className="chat-head"><h2>{t("room.info")}</h2><span className="spacer" /><button className="icon-btn" title={t("common.close")} onClick={onClose}>✕</button></header>
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
        <h2>{t("room.info")}</h2>
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

        <section>
          <h4>{t("room.notifications")}</h4>
          <div className="segmented small" role="radiogroup">
            {(["all", "mentions", "mute"] as const).map((level) => (
              <button key={level} role="radio" aria-checked={details.notifications === level} className={details.notifications === level ? "on" : ""} onClick={() => setLevel(level)}>
                {t(`room.notify.${level}`)}
              </button>
            ))}
          </div>
        </section>

        <section>
          <div className="members-head">
            <h4>{t("room.members", { count: details.members.length })}</h4>
            {details.canInvite && !details.isDirect && <button className="btn small" onClick={() => setInviting(true)}>{t("room.invite")}</button>}
          </div>
          {details.members.length > 8 && <input className="member-search" value={memberQuery} placeholder={t("room.searchMembers")} onChange={(e) => setMemberQuery(e.target.value)} />}
          <div className="members">
            {members.map((m) => (
              <button key={m.userId} className="member" onClick={(e) => openProfile(conv.orgId, m.userId, { x: e.clientX - 300, y: e.clientY })}>
                <Avatar account={conv.orgId} media={m.avatar ?? undefined} name={m.name} className="small" />
                <span className="member-name">{m.name}</span>
                {m.role && <span className={`role role-${m.role}`}>{t(`room.role.${m.role}`)}</span>}
              </button>
            ))}
          </div>
        </section>
      </div>
      {inviting && <InviteDialog conv={conv} onClose={() => setInviting(false)} onDone={(name) => { setInviting(false); onNotice(t("room.invited", { name })); reload(); }} onNotice={onNotice} />}
    </aside>
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
