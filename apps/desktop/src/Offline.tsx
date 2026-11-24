import { useEffect, useState } from "react";
import { backend, isLive } from "./backend";
import { t } from "./i18n";
import type { Org } from "./types";

// An account whose server can't be reached keeps its saved chats and says so. It retries by
// itself every few seconds; Reconnect tries at once.

export function ReconnectButton({ accounts, className = "btn small" }: { accounts: string[]; className?: string }) {
  // Shown for a while: a failed try looks the same as before, so there's nothing to wait for.
  const [trying, setTrying] = useState(false);
  useEffect(() => {
    if (!trying) return;
    const timer = window.setTimeout(() => setTrying(false), 10_000);
    return () => window.clearTimeout(timer);
  }, [trying]);
  const reconnect = (e: React.MouseEvent) => {
    e.stopPropagation();
    setTrying(true);
    for (const account of accounts) backend.reconnect(account).catch(() => {});
  };
  return (
    <button className={className} disabled={trying || !isLive} onClick={reconnect}>
      {trying ? t("offline.trying") : t("offline.reconnect")}
    </button>
  );
}

/** Above the chat list: the accounts in view that are offline, so their chats are the saved ones. */
export function OfflineBanner({ orgs }: { orgs: Org[] }) {
  const offline = orgs.filter((o) => o.offline);
  if (!offline.length) return null;
  return (
    <div className="offline-banner" title={offline.map((o) => `${o.name}: ${o.offline}`).join("\n")}>
      <span className="offline-dot" />
      <span className="offline-text">{offline.length === 1 ? t("offline.one", { name: offline[0].name }) : t("offline.many", { n: offline.length })}</span>
      <ReconnectButton accounts={offline.map((o) => o.id)} />
    </div>
  );
}
