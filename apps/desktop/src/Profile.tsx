import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Avatar } from "./Avatar";
import { backend, isLive, type Profile } from "./backend";
import { t } from "./i18n";
import type { Conversation } from "./types";

/** Opens the profile card for `userId` near the clicked element. */
export type OpenProfile = (account: string, userId: string, at: { x: number; y: number }) => void;

export const ProfileContext = createContext<OpenProfile>(() => {});
export const useOpenProfile = () => useContext(ProfileContext);

interface Props {
  account: string;
  userId: string;
  at: { x: number; y: number };
  convs: Conversation[];
  onClose: () => void;
  /** Open a conversation (after starting a chat, or a shared room). */
  onOpen: (key: string) => void;
  onNotice: (message: string) => void;
}

/** Teams-style profile card: who someone is, presence, shared rooms, and a Chat button. */
export function ProfileCard({ account, userId, at, convs, onClose, onOpen, onNotice }: Props) {
  const [profile, setProfile] = useState<Profile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pos, setPos] = useState(at);
  const card = useRef<HTMLDivElement>(null);
  const dm = convs.find((c) => c.orgId === account && c.dmUser === userId);
  const shared = (profile?.shared ?? []).map((k) => convs.find((c) => c.id === k)).filter((c): c is Conversation => !!c && c.kind !== "direct");

  useEffect(() => {
    if (!isLive) return setError(t("desktopOnly.profiles"));
    backend.profile(account, userId).then(setProfile).catch((e) => setError(String(e)));
  }, [account, userId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    const onDown = (e: MouseEvent) => card.current && !card.current.contains(e.target as Node) && onClose();
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
    };
  }, [onClose]);

  // Keep the card on screen.
  useLayoutEffect(() => {
    const r = card.current?.getBoundingClientRect();
    if (!r) return;
    setPos({ x: Math.max(8, Math.min(at.x, window.innerWidth - r.width - 8)), y: Math.max(8, Math.min(at.y, window.innerHeight - r.height - 8)) });
  }, [at, profile]);

  const chat = () => {
    if (dm) return onOpen(dm.id);
    backend.createChat(account, [userId], null).then((out) => out.open && onOpen(out.open)).catch((e) => onNotice(String(e)));
  };

  const name = profile?.name ?? userId;
  return (
    <div className="profile-card" ref={card} style={{ left: pos.x, top: pos.y }} role="dialog" aria-label={name}>
      <div className="profile-head">
        <span className="avatar-wrap">
          <Avatar account={account} media={profile?.avatar ?? undefined} name={name} className="big" />
          {dm?.presence && <span className={`presence-dot big p-${dm.presence}`} />}
        </span>
        <div className="profile-names">
          <b>{name}</b>
          <button className="link user-id" title={t("profile.copyId")} onClick={() => navigator.clipboard.writeText(userId).catch(() => {})}>{userId}</button>
          {dm?.presence && <span className="muted">{t(`presence.${dm.presence}`)}{dm.status ? ` · ${dm.status}` : ""}</span>}
          {profile?.verified !== null && profile?.verified !== undefined && (
            <span className={`verified ${profile.verified ? "yes" : "no"}`}>{profile.verified ? t("profile.verified") : t("profile.notVerified")}</span>
          )}
        </div>
      </div>
      <div className="profile-actions">
        <button className="btn primary small" onClick={chat}>{t("profile.chat")}</button>
        <button className="btn small" onClick={() => navigator.clipboard.writeText(userId).catch(() => {})}>{t("profile.copyId")}</button>
      </div>
      {shared.length > 0 && (
        <div className="profile-shared">
          <h3>{t("profile.shared", { count: shared.length })}</h3>
          {shared.slice(0, 6).map((c) => (
            <button key={c.id} className="link" onClick={() => onOpen(c.id)}>{c.kind === "channel" && c.team ? `${c.team} › ${c.name}` : c.name}</button>
          ))}
        </div>
      )}
      {!profile && !error && <p className="muted">{t("common.loading")}</p>}
      {error && <p className="error">{error}</p>}
    </div>
  );
}
