// Words for room events (joins, renames, ...) shown as grey timeline lines.
import { t } from "./i18n";

export type RoomEventKind =
  | "joined" | "left" | "invited" | "inviteDeclined" | "inviteRevoked" | "kicked" | "banned" | "unbanned"
  | "displayName" | "avatar" | "roomName" | "topic" | "roomAvatar" | "encrypted" | "verificationRequest" | "call"
  // Protocol-rendered system text (Talk's "You started a call", ...), shown as is.
  | "other";

export interface RoomEvent {
  kind: RoomEventKind;
  actor: string;
  target: string | null;
  value: string | null;
}

export function describeEvent(e: RoomEvent): string {
  const vars = { actor: e.actor, target: e.target ?? "", value: e.value ?? "" };
  switch (e.kind) {
    case "other":
      return e.value ?? "";
    case "verificationRequest":
      return t("event.verificationRequest", vars);
    case "call":
      return e.value === "invite_video" ? t("event.call.video", vars)
        : e.value === "invite_voice" ? t("event.call.voice", vars)
        : e.value === "missed" ? t("event.call.missed", vars)
        : e.value === "declined" ? t("event.call.declined", vars)
        : t("event.call.ended", vars);
    case "topic":
      return e.value ? t("event.topic", vars) : t("event.topicRemoved", vars);
    case "roomName":
      return e.value ? t("event.roomName", vars) : t("event.roomNameRemoved", vars);
    case "displayName":
      return e.value ? t("event.displayName", vars) : t("event.displayNameRemoved", vars);
    default:
      return t(`event.${e.kind}`, vars);
  }
}

/** "Anna, Tom and 3 others joined"-style summary for a collapsed run of events. */
export function summarize(events: RoomEvent[]): string {
  const joined = events.filter((e) => e.kind === "joined").map((e) => e.actor);
  const left = events.filter((e) => e.kind === "left").map((e) => e.actor);
  const names = (list: string[]) =>
    list.length <= 2 ? list.join(t("event.and")) : t("event.andOthers", { names: list.slice(0, 2).join(", "), count: list.length - 2 });
  const parts: string[] = [];
  if (joined.length) parts.push(t("event.summaryJoined", { names: names([...new Set(joined)]) }));
  if (left.length) parts.push(t("event.summaryLeft", { names: names([...new Set(left)]) }));
  const other = events.length - joined.length - left.length;
  if (other) parts.push(t("event.summaryOther", { count: other }));
  return parts.join(" · ");
}
