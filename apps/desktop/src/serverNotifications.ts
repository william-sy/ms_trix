import { useEffect, useState } from "react";
import { backend, isLive } from "./backend";
import type { ServerAction, ServerNotification } from "./types";

// Nextcloud's own notifications in Activity: a file shared with you, a calendar invitation, a Deck
// card, an announcement, a call recording that's ready. Talk's chat and call notifications are left
// out (the app has those itself). Asked every two minutes per Nextcloud account, and when the
// window comes to the front (unchanged is a cheap "not modified"); new ones also pop up.

export interface ServerItem extends ServerNotification {
  account: string;
  /** Unique across accounts, for the feed's read and cleared lists. */
  key: string;
}

const EVERY = 120_000;
/** After a failure (not signed in yet at start, server away, no notifications app): soon, then less often. */
const retryAfter = (failures: number) => Math.min(600_000, 10_000 * 2 ** failures);
/** Coming to the front asks again, but not more often than this. */
const FOCUS_GAP = 20_000;

interface Known {
  etag: string | null;
  items: ServerItem[];
  at: number;
}

const known = new Map<string, Known>();
const listeners = new Set<() => void>();
const changed = () => listeners.forEach((l) => l());

/** Talk's own chat, call and conversation notifications: shown by the app already. */
const fromChats = (n: ServerNotification) => n.app === "spreed" && ["chat", "call", "room"].includes(n.objectType);

export const subjectText = (n: ServerNotification) => n.subject.map((p) => p.text).join("");

async function refresh(account: string, force = false): Promise<boolean> {
  const before = known.get(account);
  try {
    const got = await backend.serverNotifications(account, force ? null : before?.etag ?? null);
    if (!got) {
      known.set(account, { ...before!, at: Date.now() });
      return true;
    }
    const [list, etag] = got;
    const items = list.filter((n) => !fromChats(n)).map((n) => ({ ...n, account, key: `nc:${account}:${n.id}` }));
    if (!before) void backend.logUi(`server notifications for ${account}: ${list.length}, ${items.length} besides the chats`).catch(() => {});
    // Pop-ups only for ones that came in while the app runs (not the ones already there at start).
    if (before) {
      const seen = new Set(before.items.map((n) => n.id));
      for (const n of items) if (!seen.has(n.id) && n.alert) void backend.notify(subjectText(n), n.message).catch(() => {});
    }
    known.set(account, { etag, items, at: Date.now() });
    changed();
    return true;
  } catch (e) {
    // Not signed in yet just after start is normal; logged are the other reasons.
    if (!before && !/not signed in/.test(String(e))) void backend.logUi(`server notifications for ${account}: ${String(e)}`).catch(() => {});
    return false;
  }
}

/** The notifications of these Nextcloud accounts, newest first; kept current while in use. */
export function useServerNotifications(accounts: string[]): ServerItem[] {
  const [, render] = useState(0);
  const key = accounts.join(" ");
  useEffect(() => {
    if (!isLive || !accounts.length) return;
    const update = () => render((n) => n + 1);
    listeners.add(update);
    const timers = new Map<string, number>();
    let stopped = false;
    const round = async (account: string, failures: number) => {
      const ok = await refresh(account);
      if (!stopped) timers.set(account, window.setTimeout(() => void round(account, ok ? 0 : failures + 1), ok ? EVERY : retryAfter(failures)));
    };
    accounts.forEach((a) => void round(a, 0));
    const onFocus = () => accounts.forEach((a) => { if (Date.now() - (known.get(a)?.at ?? 0) > FOCUS_GAP) void refresh(a); });
    window.addEventListener("focus", onFocus);
    return () => {
      stopped = true;
      timers.forEach((t) => window.clearTimeout(t));
      listeners.delete(update);
      window.removeEventListener("focus", onFocus);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return accounts.flatMap((a) => known.get(a)?.items ?? []).sort((a, b) => b.at - a.at);
}

const drop = (item: ServerItem) => {
  const k = known.get(item.account);
  if (!k) return;
  known.set(item.account, { ...k, items: k.items.filter((n) => n.id !== item.id) });
  changed();
};

/** Removes it on the server, so Nextcloud's web and phone apps lose it too. */
export async function dismissServerItem(item: ServerItem) {
  await backend.dismissServerNotification(item.account, item.id);
  drop(item);
}

/**
 * One of its buttons, as the server describes it. Talk's "Share to chat" and "Dismiss" for a
 * recording want the file and the notification's time with them, which the server leaves to the
 * client. Afterwards the list is asked again: the server usually removes the notification.
 */
export async function runServerAction(item: ServerItem, action: ServerAction) {
  const form: [string, string][] = [];
  if (item.app === "spreed" && item.objectType === "recording") {
    form.push(["timestamp", String(Math.floor(item.at / 1000))]);
    const file = item.subject.find((p) => p.kind === "file")?.id;
    if (file && action.link.endsWith("/share-chat")) form.push(["fileId", file]);
  }
  await backend.serverNotificationAction(item.account, action.link, action.method, form);
  await refresh(item.account, true);
}
