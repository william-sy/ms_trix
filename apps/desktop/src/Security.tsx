import { useState, type FormEvent } from "react";
import { backend, type SecurityStatus } from "./backend";
import { LockIcon } from "./Icons";
import type { Org } from "./types";
import { t } from "./i18n";

/** Unverified device means other people's clients warn about our messages. */
export const needsAttention = (s?: SecurityStatus) => !!s && s.recovery !== "unknown" && !s.deviceVerified;

export function SecurityBanner({ org, status, onFix, onDismiss }: { org: Org; status: SecurityStatus; onFix: () => void; onDismiss: () => void }) {
  return (
    <div className="notice warn" role="alert">
      <LockIcon />
      {status.recovery === "disabled" ? (
        <span>{t("security.bannerNoRecovery", { org: org.name })}</span>
      ) : (
        <span>{t("security.banner", { org: org.name })}</span>
      )}
      {status.recovery !== "disabled" && <button className="btn primary small" onClick={onFix}>{t("security.enterKey")}</button>}
      <button className="link" onClick={onDismiss}>{t("security.later")}</button>
    </div>
  );
}

const describe = (s?: SecurityStatus) => {
  if (!s || s.recovery === "unknown") return t("security.checking");
  if (s.deviceVerified && s.recovery === "enabled") return t("security.verifiedUnlocked");
  if (s.deviceVerified) return t("security.verified");
  return t("security.notVerified");
};

export function RecoveryDialog({ org, status, onClose, onUpdated }: { org: Org; status?: SecurityStatus; onClose: () => void; onUpdated: (s: SecurityStatus) => void }) {
  const [key, setKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const done = status?.deviceVerified && status.recovery === "enabled";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      onUpdated(await backend.recover(org.id, key));
      setKey("");
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="login-card">
        <button className="icon-btn close" onClick={onClose} title={t("common.close")}>✕</button>
        <h1>{t("security.title")}</h1>
        <p className="muted">{org.name} · {org.userId}</p>
        <p className={`status-line ${status?.deviceVerified ? "ok" : "bad"}`}><LockIcon /> {describe(status)}</p>
        {!done && status?.recovery !== "disabled" && (
          <form onSubmit={submit}>
            <label>
              {t("security.keyLabel")}
              <input className="mono" type="password" autoFocus value={key} onChange={(e) => setKey(e.target.value)} placeholder="EsT1 abcd efgh …" autoComplete="off" spellCheck={false} />
            </label>
            <p className="hint">{t("security.keyHint")}</p>
            <button className="btn primary wide" disabled={busy || !key.trim()}>{busy ? t("security.verifying") : t("security.verify")}</button>
          </form>
        )}
        {status?.recovery === "disabled" && (
          <p className="hint">{t("security.noRecovery")}</p>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  );
}
