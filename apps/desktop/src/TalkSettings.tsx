import { useEffect, useRef, useState } from "react";
import { backend } from "./backend";
import { CloudFilePicker } from "./CloudFilePicker";
import { EmojiPicker } from "./EmojiPicker";
import { t } from "./i18n";
import { useOrg } from "./store";
import type { Conversation } from "./types";

// A Talk conversation's own settings, as in Talk's "Conversation settings" (SURF's version):
// talks to Talk's REST API through the host. Options the server doesn't report are left out.

type Any = any; // eslint-disable-line @typescript-eslint/no-explicit-any

const V4 = "/ocs/v2.php/apps/spreed/api/v4";
/** A Talk conversation's room endpoint (`call_api` allows it). */
export const talkRoom = (conv: Conversation) => `${V4}/room/${conv.id.slice(conv.id.indexOf("|") + 1)}`;
/** Owner, moderator or guest moderator: may change settings and delete the conversation. */
export const isTalkModerator = (room: { participantType?: unknown }) => [1, 2, 6].includes(Number(room.participantType));
const V1 = "/ocs/v2.php/apps/spreed/api/v1";

/** Talk's participant permission bits. */
const PERM = { custom: 1, callStart: 2, callJoin: 4, lobbyIgnore: 8, audio: 16, video: 32, screen: 64, chat: 128 } as const;
const ALL = PERM.callStart | PERM.callJoin | PERM.lobbyIgnore | PERM.audio | PERM.video | PERM.screen | PERM.chat;
const RESTRICTED = PERM.callJoin | PERM.chat;
const ADVANCED: Exclude<keyof typeof PERM, "custom">[] = ["callStart", "callJoin", "lobbyIgnore", "audio", "video", "screen", "chat"];

const EXPIRY = [0, 3600, 28800, 86400, 604800, 2419200];

export function TalkSettings({ conv, onNotice, onChanged, onGone }: { conv: Conversation; onNotice: (m: string) => void; onChanged: () => void; onGone: () => void }) {
  const org = useOrg(conv.orgId);
  const token = conv.id.slice(conv.id.indexOf("|") + 1);
  const room = talkRoom(conv);
  const [data, setData] = useState<Any>(null);
  const [server, setServer] = useState("");
  const [bans, setBans] = useState<Any[] | null>(null);
  const [drafts, setDrafts] = useState<Any[] | null>(null);
  const [password, setPassword] = useState<string | null>(null);
  const [picker, setPicker] = useState<"emoji" | "files" | null>(null);
  const [advanced, setAdvanced] = useState(false);
  const csv = useRef<HTMLInputElement>(null);

  const api = async (method: string, path: string, form: Record<string, string> = {}) => {
    const [json, base] = await backend.callApi(conv.orgId, method, path, Object.entries(form));
    setServer(base);
    return JSON.parse(json) as Any;
  };
  const reload = () => api("GET", room).then(setData).catch((e) => onNotice(String(e)));
  useEffect(() => { setData(null); setBans(null); setDrafts(null); void reload(); }, [conv.id]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Runs a change, then shows the conversation as the server now has it. */
  const change = (method: string, path: string, form: Record<string, string> = {}) =>
    api(method, path, form).then(() => { void reload(); onChanged(); }).catch((e) => onNotice(String(e)));

  if (!data) return <p className="empty">{t("common.loading")}</p>;

  const moderator = isTalkModerator(data);
  const has = (field: string) => field in data;
  const isPublic = Number(data.type) === 3;
  const link = `${server}/index.php/call/${token}`;
  const perms = Number(data.defaultPermissions) || 0;
  const permMode = perms === 0 || (perms & ~PERM.custom) === ALL ? "all" : (perms & ~PERM.custom) === RESTRICTED ? "restricted" : "advanced";
  const toggle = (label: string, on: boolean, set: (on: boolean) => void, hint?: string, disabled = false) => (
    <label className="talk-toggle">
      <input type="checkbox" checked={on} disabled={disabled} onChange={(e) => set(e.target.checked)} />
      <span>{label}{hint && <small>{hint}</small>}</span>
    </label>
  );

  const pictureFromFiles = async (account: string, file: { path: string; name: string; mime?: string | null }) => {
    const bytes = await backend.cloudFileBytes(account, file.path);
    const mime = file.mime === "image/jpeg" ? "image/jpeg" : "image/png";
    await backend.callApiUpload(conv.orgId, `${room}/avatar`, "file", file.name, mime, bytes);
    setPicker(null);
    onChanged();
  };

  return (
    <div className="talk-settings">
      {moderator && Number(data.type) !== 1 && (
        <section>
          <h4>{t("talk.picture")}</h4>
          <div className="talk-row">
            <button className="btn small" onClick={() => setPicker(picker === "emoji" ? null : "emoji")}>😀 {t("talk.pictureEmoji")}</button>
            <button className="btn small" onClick={() => setPicker("files")}>📁 {t("talk.pictureFiles")}</button>
            {data.isCustomAvatar && <button className="btn small" onClick={() => change("DELETE", `${room}/avatar`)}>{t("talk.pictureRemove")}</button>}
          </div>
          <p className="hint">{t("talk.pictureHint")}</p>
          {picker === "emoji" && (
            <EmojiPicker style={{ position: "relative", zIndex: 2 }} onClose={() => setPicker(null)}
              onPick={(emoji) => { setPicker(null); void change("POST", `${room}/avatar/emoji`, { emoji }); }} />
          )}
        </section>
      )}

      <section>
        <h4>{t("talk.personal")}</h4>
        <div className="talk-radio">
          {([[1, "all"], [2, "mentions"], [3, "off"]] as const).map(([level, key]) => (
            <label key={level}>
              <input type="radio" name={`notify-${token}`} checked={(Number(data.notificationLevel) || (Number(data.type) === 1 ? 1 : 2)) === level}
                onChange={() => change("POST", `${room}/notify`, { level: String(level) })} />
              {t(`talk.notify.${key}`)}
            </label>
          ))}
        </div>
        {has("notificationCalls") && toggle(t("talk.notifyCalls"), Number(data.notificationCalls) === 1, (on) => change("POST", `${room}/notify-calls`, { level: on ? "1" : "0" }))}
        {has("isImportant") && toggle(t("talk.important"), !!data.isImportant, (on) => change(on ? "POST" : "DELETE", `${room}/important`), t("talk.importantHint"))}
        {has("isSensitive") && toggle(t("talk.sensitive"), !!data.isSensitive, (on) => change(on ? "POST" : "DELETE", `${room}/sensitive`), t("talk.sensitiveHint"))}
      </section>

      {moderator && Number(data.type) !== 1 && (
        <>
          <section>
            <h4>{t("talk.moderation")}</h4>
            {has("listable") && toggle(t("talk.listable"), Number(data.listable) > 0, (on) => change("PUT", `${room}/listable`, { scope: on ? "1" : "0" }))}
            {has("mentionPermissions") && toggle(t("talk.mentionAll"), Number(data.mentionPermissions) === 0, (on) => change("PUT", `${room}/mention-permissions`, { mentionPermissions: on ? "0" : "1" }))}
          </section>

          <section>
            <h4>{t("talk.guests")}</h4>
            {toggle(t("talk.guestsLink"), isPublic, (on) => change(on ? "POST" : "DELETE", `${room}/public`))}
            {isPublic && toggle(t("talk.password"), !!data.hasPassword || password !== null, (on) => {
              if (on) setPassword("");
              else { setPassword(null); void change("PUT", `${room}/password`, { password: "" }); }
            })}
            {password !== null && (
              <div className="talk-row">
                <input type="password" autoFocus value={password} placeholder={t("talk.passwordNew")} onChange={(e) => setPassword(e.target.value)} />
                <button className="btn small primary" disabled={!password} onClick={() => { void change("PUT", `${room}/password`, { password }); setPassword(null); }}>{t("common.save")}</button>
              </div>
            )}
            <div className="talk-row">
              <button className="btn small" onClick={() => { void navigator.clipboard.writeText(link).then(() => onNotice(t("talk.linkCopied"))); }}>📋 {t("talk.copyLink")}</button>
              <button className="btn small" onClick={() => api("POST", `${room}/participants/resend-invitations`).then(() => onNotice(t("talk.invitationsSent"))).catch((e) => onNotice(String(e)))}>✉ {t("talk.resendInvitations")}</button>
            </div>
          </section>

          {has("recordingConsent") && (
            <section>
              <h4>{t("talk.recordingConsent")}</h4>
              {toggle(t("talk.recordingConsentAsk"), Number(data.recordingConsent) > 0, (on) => change("PUT", `${room}/recording-consent`, { recordingConsent: on ? "1" : "0" }))}
            </section>
          )}

          {has("messageExpiration") && (
            <section>
              <h4>{t("talk.expiry")}</h4>
              <p className="hint">{t("talk.expiryHint")}</p>
              <select value={String(data.messageExpiration ?? 0)} onChange={(e) => change("POST", `${room}/message-expiration`, { seconds: e.target.value })}>
                {(EXPIRY.includes(Number(data.messageExpiration)) ? EXPIRY : [...EXPIRY, Number(data.messageExpiration)]).map((s) => (
                  <option key={s} value={String(s)}>{expiryLabel(s)}</option>
                ))}
              </select>
            </section>
          )}

          <section>
            <h4>{t("talk.bans")}</h4>
            {bans === null ? (
              <button className="btn small" onClick={() => api("GET", `${V1}/ban/${token}`).then((b) => setBans(Array.isArray(b) ? b : [])).catch((e) => onNotice(String(e)))}>{t("talk.manageBans")}</button>
            ) : bans.length === 0 ? <p className="hint">{t("talk.noBans")}</p> : (
              <div className="members">
                {bans.map((b) => (
                  <div key={b.id} className="member">
                    <span className="member-main"><span className="member-name">{b.bannedDisplayName || b.bannedId}</span>{b.internalNote && <small className="muted"> · {b.internalNote}</small>}</span>
                    <button className="btn small" onClick={() => api("DELETE", `${V1}/ban/${token}?banId=${encodeURIComponent(b.id)}`).then(() => setBans(bans.filter((x) => x.id !== b.id))).catch((e) => onNotice(String(e)))}>{t("room.unban")}</button>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <h4>{t("talk.meeting")}</h4>
            {toggle(t("talk.lobby"), Number(data.lobbyState) === 1, (on) => change("PUT", `${room}/webinar/lobby`, { state: on ? "1" : "0" }))}
            <h5>{t("talk.importEmails")}</h5>
            <p className="hint">{t("talk.importEmailsHint")}</p>
            <button className="btn small" onClick={() => csv.current?.click()}>⬆ {t("talk.importEmails")}</button>
            <input ref={csv} type="file" accept=".csv,text/csv" hidden onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (!file) return;
              void file.arrayBuffer().then((buf) => backend.callApiUpload(conv.orgId, `${room}/import-emails`, "file", file.name, "text/csv", [...new Uint8Array(buf)]))
                .then((out) => { const r = JSON.parse(out); onNotice(t("talk.importedEmails", { count: Number(r?.invites ?? 0) })); void reload(); })
                .catch((err) => onNotice(String(err)));
            }} />
            <h5>{t("talk.pollDrafts")}</h5>
            {drafts === null ? (
              <button className="btn small" onClick={() => api("GET", `${V1}/poll/${token}/drafts`).then((d) => setDrafts(Array.isArray(d) ? d : [])).catch((e) => onNotice(String(e)))}>{t("talk.browseDrafts")}</button>
            ) : drafts.length === 0 ? <p className="hint">{t("talk.noDrafts")}</p> : (
              <div className="members">
                {drafts.map((d) => (
                  <div key={d.id} className="member">
                    <span className="member-main"><span className="member-name">📊 {d.question}</span></span>
                    <button className="btn small" onClick={() => backend.createPoll(conv.id, d.question, d.options ?? [], Number(d.maxVotes) || 0, Number(d.resultMode) !== 1)
                      .then(() => onNotice(t("talk.draftPosted"))).catch((e) => onNotice(String(e)))}>{t("talk.postDraft")}</button>
                  </div>
                ))}
              </div>
            )}
          </section>

          {has("defaultPermissions") && (
            <section>
              <h4>{t("talk.permissions")}</h4>
              <p className="hint">{t("talk.permissionsHint")}</p>
              <div className="talk-radio column">
                {(["all", "restricted"] as const).map((mode) => (
                  <label key={mode}>
                    <input type="radio" name={`perm-${token}`} checked={permMode === mode} onChange={() => change("PUT", `${room}/permissions/default`, { permissions: String(mode === "all" ? 0 : RESTRICTED) })} />
                    <span>{t(`talk.perm.${mode}`)}<small>{t(`talk.perm.${mode}Hint`)}</small></span>
                  </label>
                ))}
                <label>
                  <input type="radio" name={`perm-${token}`} checked={permMode === "advanced" || advanced} onChange={() => setAdvanced(true)} />
                  <span>{t("talk.perm.advanced")}</span>
                </label>
              </div>
              {(permMode === "advanced" || advanced) && (
                <div className="talk-perms">
                  {ADVANCED.map((p) => {
                    const current = perms === 0 ? ALL : perms;
                    return toggle(t(`talk.perm.${p}`), (current & PERM[p]) !== 0, (on) =>
                      change("PUT", `${room}/permissions/default`, { permissions: String(((current & ~PERM.custom) & ~PERM[p]) | (on ? PERM[p] : 0)) }));
                  })}
                </div>
              )}
            </section>
          )}
        </>
      )}

      <section className="talk-danger">
        <h4>{t("talk.danger")}</h4>
        {moderator && Number(data.type) !== 1 && toggle(t("talk.lock"), Number(data.readOnly) === 1, (on) => change("PUT", `${room}/read-only`, { state: on ? "1" : "0" }))}
        {has("isArchived") && toggle(t("talk.archive"), !!data.isArchived, (on) => backend.setArchived(conv.id, on).then(() => { void reload(); onChanged(); }).catch((e) => onNotice(String(e))), t("talk.archiveHint"))}
        <p className="warning">{t("talk.cannotUndo")}</p>
        {data.canLeaveConversation !== false && (
          <button className="btn small" onClick={() => confirm(t("talk.leaveConfirm")) && backend.leave(conv.id).then(onGone).catch((e) => onNotice(String(e)))}>{t("talk.leave")}</button>
        )}
        {data.canDeleteConversation && (
          <button className="btn small danger" onClick={() => confirm(t("talk.deleteConfirm", { name: conv.name })) && api("DELETE", room).then(onGone).catch((e) => onNotice(String(e)))}>{t("talk.delete")}</button>
        )}
        {moderator && (
          <button className="btn small danger" onClick={() => confirm(t("talk.clearConfirm")) && api("DELETE", `${V1}/chat/${token}`).then(() => onNotice(t("talk.cleared"))).catch((e) => onNotice(String(e)))}>{t("talk.clear")}</button>
        )}
      </section>

      {picker === "files" && (
        <CloudFilePicker accounts={[org]} onClose={() => setPicker(null)} onPick={pictureFromFiles} />
      )}
    </div>
  );
}

function expiryLabel(seconds: number): string {
  if (!seconds) return t("talk.expiry.off");
  if (seconds % 604800 === 0) return t("talk.expiry.weeks", { count: seconds / 604800 });
  if (seconds % 86400 === 0) return t("talk.expiry.days", { count: seconds / 86400 });
  return t("talk.expiry.hours", { count: Math.round(seconds / 3600) });
}
