import { useEffect, useState } from "react";
import { backend } from "./backend";
import { CameraIcon } from "./Icons";
import { t } from "./i18n";
import type { Org } from "./types";

/**
 * "Meet now" (Talk's "Start meeting now"): a public Talk conversation with a title; copy its
 * link to send around, or start the call right away.
 */
export function MeetNow({ orgs, onStart, onNotice }: { orgs: Org[]; onStart: (key: string) => void; onNotice: (m: string) => void }) {
  const talk = orgs.filter((o) => o.protocol === "talk");
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [account, setAccount] = useState(talk[0]?.id ?? "");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!talk.length) return null;

  const create = async (start: boolean) => {
    setBusy(true);
    try {
      const [json, server] = await backend.callApi(account || talk[0]!.id, "POST", "/ocs/v2.php/apps/spreed/api/v4/room",
        [["roomType", "3"], ["roomName", title.trim() || t("meet.defaultTitle")]]);
      const token = String(JSON.parse(json)?.token ?? "");
      if (!token) throw new Error("no conversation token");
      const link = `${server}/index.php/call/${token}`;
      await navigator.clipboard.writeText(link).catch(() => {});
      onNotice(t("meet.linkCopied"));
      setOpen(false);
      setTitle("");
      if (start) onStart(`${account || talk[0]!.id}|${token}`);
    } catch (e) {
      onNotice(String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="bg-anchor">
      <button className="btn small call-join" onClick={() => setOpen(!open)}><CameraIcon /> {t("meet.now")}</button>
      {open && (
        <div className="menu meet-now" onClick={(e) => e.stopPropagation()}>
          <b>{t("meet.giveTitle")}</b>
          <input autoFocus value={title} placeholder={t("meet.defaultTitle")} onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && !busy && void create(false)} />
          {talk.length > 1 && (
            <select value={account} onChange={(e) => setAccount(e.target.value)}>
              {talk.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )}
          <button className="btn small" disabled={busy} onClick={() => void create(false)}>{t("meet.createCopy")}</button>
          <button className="btn small primary" disabled={busy} onClick={() => void create(true)}>{t("meet.start")}</button>
        </div>
      )}
    </span>
  );
}
