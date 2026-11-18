import { useEffect, useState } from "react";
import { backend, mediaUrl } from "./backend";
import { formatSize } from "./Composer";
import { t } from "./i18n";
import type { CloudFile, Org } from "./types";

interface Props {
  /** Nextcloud accounts to browse; the chat's own account first. */
  accounts: Org[];
  onPick: (account: string, file: CloudFile) => Promise<void>;
  onClose: () => void;
}

const LAST = "trix.cloudFolder";

/** Pick a file from Nextcloud Files to share into the chat instead of uploading a copy. */
export function CloudFilePicker({ accounts, onPick, onClose }: Props) {
  const [account, setAccount] = useState(accounts[0]?.id ?? "");
  const [path, setPath] = useState(() => { try { return localStorage.getItem(LAST) ?? "/"; } catch { return "/"; } });
  const [files, setFiles] = useState<CloudFile[] | null>(null);
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState<CloudFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let live = true;
    setFiles(null);
    setSelected(null);
    setError(null);
    backend.cloudFiles(account, path)
      .then((list) => { if (live) { setFiles(list); try { localStorage.setItem(LAST, path); } catch { /* not remembered */ } } })
      // A remembered folder may be gone; fall back to the root once.
      .catch((e) => { if (!live) return; if (path !== "/") setPath("/"); else setError(String(e)); });
    return () => { live = false; };
  }, [account, path]);

  const crumbs = path.split("/").filter(Boolean);
  const shown = (files ?? []).filter((f) => !filter || f.name.toLowerCase().includes(filter.toLowerCase()));
  const share = (file: CloudFile) => {
    setBusy(true);
    onPick(account, file).catch((e) => { setError(String(e)); setBusy(false); });
  };

  return (
    <div className="login-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="login-card cloud-picker">
        <button className="icon-btn close" onClick={onClose} title={t("common.closeEsc")}>✕</button>
        <h1>{t("cloud.title")}</h1>
        <div className="cloud-bar">
          {accounts.length > 1 && (
            <select value={account} onChange={(e) => { setAccount(e.target.value); setPath("/"); }}>
              {accounts.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
          )}
          <nav className="cloud-crumbs">
            <button className="link" onClick={() => setPath("/")}>{t("cloud.root")}</button>
            {crumbs.map((c, i) => (
              <span key={i}> › <button className="link" onClick={() => setPath(`/${crumbs.slice(0, i + 1).join("/")}`)}>{c}</button></span>
            ))}
          </nav>
          <input placeholder={t("cloud.filter")} value={filter} onChange={(e) => setFilter(e.target.value)} />
        </div>
        <div className="cloud-list" role="listbox">
          {!files && !error && <div className="spinner" aria-label={t("common.loading")} />}
          {files && shown.length === 0 && <p className="empty">{t("cloud.empty")}</p>}
          {shown.map((f) => (
            <button key={f.path} role="option" aria-selected={selected?.path === f.path} className={`cloud-row ${selected?.path === f.path ? "selected" : ""}`}
              onClick={() => (f.dir ? setPath(f.path) : setSelected(f))} onDoubleClick={() => !f.dir && share(f)}>
              <span className="cloud-icon">
                {f.dir ? "📁" : f.fileId && /^(image|video)\//.test(f.mime ?? "")
                  ? <img src={mediaUrl(account, `file:${f.fileId}:${f.path}`, 64)} alt="" onError={(e) => { e.currentTarget.replaceWith("📄"); }} />
                  : "📄"}
              </span>
              <span className="cloud-name">{f.name}</span>
              <span className="muted">{f.dir ? "" : formatSize(f.size)}</span>
              <span className="muted">{f.modified ? new Date(f.modified).toLocaleDateString() : ""}</span>
            </button>
          ))}
        </div>
        {error && <p className="error">{error}</p>}
        <p className="muted small">{t("cloud.hint")}</p>
        <div className="edit-actions">
          <button className="btn small" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn primary small" disabled={!selected || busy} onClick={() => selected && share(selected)}>{busy ? t("cloud.sharing") : t("cloud.share")}</button>
        </div>
      </div>
    </div>
  );
}
