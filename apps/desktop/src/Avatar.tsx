import { useState } from "react";
import { mediaUrl } from "./backend";

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
  const [failed, setFailed] = useState(false);
  const src = media && !failed ? mediaUrl(account, media, 96) : undefined;
  return (
    <span className={`avatar ${className}`}>
      {src ? <img src={src} alt="" onError={() => setFailed(true)} /> : channel ? "#" : initials(name)}
    </span>
  );
}
