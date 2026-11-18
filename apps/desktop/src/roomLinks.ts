import { createContext, useContext } from "react";

export interface RoomLink {
  /** Room id (!…) or address (#…). */
  address: string;
  /** Servers that can help find a room by id. */
  via: string[];
  /** Message to jump to, when the link points at one. */
  event?: string;
}

const ROOM = /^[!#][^:/\s]+:[^/?\s]+$/;

/**
 * Understands matrix.to links, matrix: URIs and Element web links to rooms.
 *   https://matrix.to/#/#room:server.org
 *   https://matrix.to/#/!id:server.org/$event?via=server.org
 *   matrix:r/room:server.org   matrix:roomid/id:server.org/e/event?via=…
 *   https://app.element.io/#/room/#room:server.org
 */
export function parseRoomLink(href: string): RoomLink | null {
  let path: string | undefined;
  let query = "";
  const web = /^https:\/\/(?:matrix\.to\/#\/|[^/]+\/(?:[^#]*)#\/room\/)(.+)$/.exec(href);
  if (web) {
    [path, query = ""] = web[1]!.split("?");
    const [room, event] = path!.split("/").map(decodeURIComponent);
    path = event ? `${room}/${event}` : room;
  } else if (href.startsWith("matrix:")) {
    const [rest, q = ""] = href.slice("matrix:".length).split("?");
    query = q;
    const parts = rest!.split("/").map(decodeURIComponent);
    const sigil = parts[0] === "r" ? "#" : parts[0] === "roomid" ? "!" : null;
    if (!sigil || !parts[1]) return null;
    path = `${sigil}${parts[1]}${parts[2] === "e" && parts[3] ? `/$${parts[3]}` : ""}`;
  }
  if (!path) return null;
  const [address, event] = path.split("/");
  if (!address || !ROOM.test(address)) return null;
  const via = new URLSearchParams(query).getAll("via");
  return { address, via, event: event?.startsWith("$") ? event : undefined };
}

export type OpenRoomLink = (account: string, link: RoomLink) => void;
export const RoomLinkContext = createContext<OpenRoomLink>(() => {});
export const useOpenRoomLink = () => useContext(RoomLinkContext);
