import { useEffect, useState } from "react";
import { backend, isLive, type IdentityWarning } from "./backend";
import { t } from "./i18n";

const EVERY = 60_000;

/**
 * Invisible crypto: a warning above the messages when someone's encryption identity changed
 * since you last saw it. Usually a new login after losing their devices; it can also mean someone
 * is listening in, so check with them if it's unexpected. OK accepts the new identity.
 */
export function IdentityBanner({ account, conversation, onNotice }: { account: string; conversation: string; onNotice: (m: string) => void }) {
  const [warnings, setWarnings] = useState<IdentityWarning[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (!isLive) return;
    let live = true;
    const load = () => void backend.identityWarnings(conversation).then((w) => live && setWarnings(w)).catch(() => {});
    setWarnings([]);
    load();
    const timer = window.setInterval(load, EVERY);
    window.addEventListener("focus", load);
    return () => { live = false; window.clearInterval(timer); window.removeEventListener("focus", load); };
  }, [conversation]);
  if (!warnings.length) return null;
  const accept = (w: IdentityWarning) => {
    setBusy(w.userId);
    backend.acceptIdentity(account, w.userId)
      .then(() => setWarnings((list) => list.filter((x) => x.userId !== w.userId)))
      .catch((e) => onNotice(String(e)))
      .finally(() => setBusy(null));
  };
  return (
    <div className="identity-banner" role="alert">
      {warnings.map((w) => (
        <div key={w.userId} className={`identity-warning ${w.wasVerified ? "serious" : ""}`}>
          <span>⚠️ {t(w.wasVerified ? "identity.verifiedChanged" : "identity.changed", { name: w.name })}</span>
          <button className="btn small" disabled={busy === w.userId} onClick={() => accept(w)}>{t(w.wasVerified ? "identity.withdraw" : "identity.ok")}</button>
        </div>
      ))}
    </div>
  );
}
