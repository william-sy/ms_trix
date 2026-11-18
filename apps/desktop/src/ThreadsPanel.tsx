import { useEffect, useState } from "react";
import { Avatar } from "./Avatar";
import { backend, formatTime, type ThreadInfo } from "./backend";
import { t } from "./i18n";

/** Every thread in a conversation (or only yours), newest activity first; click to open one. */
export function ThreadsPanel({ account, conversation, onOpen, onClose }: { account: string; conversation: string; onOpen: (root: string) => void; onClose: () => void }) {
  const [mine, setMine] = useState(false);
  const [threads, setThreads] = useState<ThreadInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    setThreads(null);
    setError(null);
    backend.threads(conversation, mine).then((list) => live && setThreads(list)).catch((e) => live && setError(String(e)));
    return () => { live = false; };
  }, [conversation, mine]);
  return (
    <aside className="thread-pane threads-list">
      <header className="chat-head">
        <h2>{t("threads.title")}</h2>
        <span className="spacer" />
        <button className="icon-btn" title={t("common.closeEsc")} onClick={onClose}>✕</button>
      </header>
      <div className="threads-filter">
        <div className="segmented small" role="radiogroup">
          {([false, true] as const).map((m) => (
            <button key={String(m)} role="radio" aria-checked={mine === m} className={mine === m ? "on" : ""} onClick={() => setMine(m)}>{t(m ? "threads.mine" : "threads.all")}</button>
          ))}
        </div>
      </div>
      <div className="messages">
        {error && <p className="error">{error}</p>}
        {!error && !threads && <p className="empty">{t("common.loading")}</p>}
        {threads?.length === 0 && <p className="empty">{t(mine ? "threads.noneMine" : "threads.none")}</p>}
        {threads?.map((th) => (
          <button key={th.root} className="thread-item" onClick={() => onOpen(th.root)}>
            <Avatar account={account} media={th.senderAvatar ?? undefined} name={th.senderName} className="small" />
            <span className="thread-item-text">
              <span className="hit-top"><b>{th.senderName}</b><span className="row-time">{formatTime(th.sentAt)}</span></span>
              <span className="thread-item-preview">{th.preview || "…"}</span>
              <span className="thread-item-meta">
                {th.latestName ? t("chatView.threadSummary", { count: th.replies, name: th.latestName }) : t("chatView.threadReplies", { count: th.replies })}
                {th.latestAt ? ` · ${formatTime(th.latestAt)}` : ""}
              </span>
            </span>
          </button>
        ))}
      </div>
    </aside>
  );
}
