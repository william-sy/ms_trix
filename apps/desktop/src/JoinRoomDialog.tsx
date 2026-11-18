import { useEffect, useState } from "react";
import { Avatar } from "./Avatar";
import { backend, type DirectoryRoom } from "./backend";
import { t } from "./i18n";

interface Props {
  account: string;
  room: DirectoryRoom;
  via: string[];
  onJoined: (key: string | null, room: DirectoryRoom) => void;
  onClose: () => void;
}

/** Shown when a room link points at a room you're not in yet. */
export function JoinRoomDialog({ account, room, via, onJoined, onClose }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const join = () => {
    setBusy(true);
    backend.joinRoom(account, room.alias ?? room.id, via[0] ?? null)
      .then((out) => onJoined(out.open, room))
      .catch((e) => { setError(String(e)); setBusy(false); });
  };

  return (
    <div className="login-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="login-card join-room">
        <button className="icon-btn close" onClick={onClose} title={t("common.closeEsc")}>✕</button>
        <Avatar account={account} media={room.avatar ?? undefined} name={room.name} className={`big ${room.isSpace ? "space" : "kind-channel"}`} channel={!room.isSpace} />
        <h1>{room.name}</h1>
        <p className="muted">{[room.alias, t("browse.members", { count: room.members })].filter(Boolean).join(" · ")}</p>
        {room.topic && <p className="topic">{room.topic}</p>}
        {error && <p className="error">{error}</p>}
        <div className="edit-actions">
          <button className="btn small" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn primary small" disabled={busy} onClick={join}>
            {busy ? t("browse.joining") : room.isSpace ? t("browse.joinSpace") : t("browse.joinRoom")}
          </button>
        </div>
      </div>
    </div>
  );
}
