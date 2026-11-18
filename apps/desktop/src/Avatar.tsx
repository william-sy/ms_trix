import { useEffect, useState } from "react";
import { ACCOUNTS_CHANGED, mediaUrl } from "./backend";

export const initials = (name: string) =>
  name.replace(/[#@]/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");

interface Props {
  account: string;
  media?: string;
  name: string;
  className?: string;
  /** Square-ish channel style. */
  channel?: boolean;
}

/** Profile/room picture with an initials fallback while loading or when missing. */
export function Avatar({ account, media, name, className = "", channel }: Props) {
  // Right after start the account may still be reconnecting, so a failed picture is
  // retried a few times (2 s, 4 s, 8 s, ...) before falling back to initials for good.
  const [tries, setTries] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setTries(0); setFailed(false); }, [account, media]);
  // An account (re)connecting makes its pictures loadable: try again at once.
  useEffect(() => {
    const again = () => { setTries((n) => n + 1); setFailed(false); };
    window.addEventListener(ACCOUNTS_CHANGED, again);
    return () => window.removeEventListener(ACCOUNTS_CHANGED, again);
  }, []);
  useEffect(() => {
    if (!failed || tries >= 5) return;
    const timer = window.setTimeout(() => { setTries((n) => n + 1); setFailed(false); }, 2000 * 2 ** tries);
    return () => window.clearTimeout(timer);
  }, [failed, tries]);
  const url = media && !failed ? mediaUrl(account, media, 96) : undefined;
  const src = url && tries ? `${url}${url.includes("?") ? "&" : "?"}retry=${tries}` : url;
  return (
    <span className={`avatar ${className}`}>
      {src ? <img src={src} alt="" onError={() => setFailed(true)} /> : channel ? "#" : initials(name)}
    </span>
  );
}
