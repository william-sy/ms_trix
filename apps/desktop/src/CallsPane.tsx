import { Avatar } from "./Avatar";
import { formatTime } from "./backend";
import { useCalls, type CallRecord } from "./calls";
import { CallIcon, CameraIcon } from "./Icons";
import { t } from "./i18n";
import type { Conversation } from "./types";
import { formatDuration } from "./voice";

interface Props {
  convs: Conversation[];
  onOpen: (conversation: string) => void;
}

const missed = (r: CallRecord) => r.direction === "in" && !r.duration && r.outcome !== "answered_elsewhere";

const outcomeText = (r: CallRecord) =>
  r.duration ? formatDuration(r.duration)
    : missed(r) ? t("calls.missed")
    : r.outcome === "answered_elsewhere" ? t("mxcall.ended.elsewhere")
    : r.outcome === "rejected" ? t("mxcall.ended.rejected")
    : r.outcome === "invite_timeout" ? t("mxcall.ended.noAnswer")
    : r.direction === "out" ? t("calls.cancelled") : t("calls.declined");

/** Calls view: recent Matrix calls on this device, with call-back buttons. */
export function CallsPane({ convs, onOpen }: Props) {
  const calls = useCalls();
  if (!calls) return null;
  const byId = new Map(convs.map((c) => [c.id, c]));
  const busy = !!calls.call && calls.call.phase !== "ended";

  return (
    <aside className="chat-list">
      <header className="pane-head">
        <h1>{t("calls.title")}</h1>
        <div className="head-actions">
          {calls.history.length > 0 && <button className="btn small" onClick={() => confirm(t("calls.clearConfirm")) && calls.clearHistory()}>{t("calls.clear")}</button>}
        </div>
      </header>
      <div className="list-scroll">
        {calls.history.length === 0 && <p className="empty">{t("calls.empty")}</p>}
        {calls.history.map((r) => {
          const conv = byId.get(r.conversation);
          const name = conv?.name ?? r.peer;
          return (
            <div key={r.id} className={`row call-row ${missed(r) ? "missed" : ""}`} role="button" tabIndex={0} onClick={() => conv && onOpen(conv.id)}>
              <Avatar account={r.conversation.split("|")[0]!} media={conv?.avatar} name={name} />
              <span className="row-text">
                <span className="row-top">
                  <span className="row-name">{name}</span>
                  <span className="row-time">{formatTime(r.at)}</span>
                </span>
                <span className="row-preview">
                  <span className="call-dir" title={r.direction === "in" ? t("calls.incoming") : t("calls.outgoing")}>{r.direction === "in" ? "↙" : "↗"}</span>{" "}
                  {r.video ? t("calls.video") : t("calls.voice")} · {outcomeText(r)}
                </span>
              </span>
              {conv?.dmUser && (
                <span className="call-row-actions" onClick={(e) => e.stopPropagation()}>
                  <button className="icon-btn" title={t("mxcall.voice")} disabled={busy} onClick={() => calls.start(conv.id, conv.orgId, conv.dmUser!, false)}><CallIcon /></button>
                  <button className="icon-btn" title={t("mxcall.video")} disabled={busy} onClick={() => calls.start(conv.id, conv.orgId, conv.dmUser!, true)}><CameraIcon /></button>
                </span>
              )}
            </div>
          );
        })}
        <p className="hint small">{t("calls.hint")}</p>
      </div>
    </aside>
  );
}
