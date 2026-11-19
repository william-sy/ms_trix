import { useEffect, useState } from "react";
import { backend, mediaUrl } from "./backend";
import { formatSize } from "./Composer";
import { t } from "./i18n";
import type { CloudFile, Org } from "./types";

interface Props {
  /** Nextcloud accounts to browse; the chat's own account first. */
  accounts: Org[];
  /** Shares these (files and folders), one after another. */
  onPick: (account: string, files: CloudFile[]) => Promise<void>;
  /** One file only (e.g. a picture): no boxes to tick, folders just open. */
  single?: boolean;
  onClose: () => void;
}

const LAST = "trix.cloudFolder";

/** Pick a file from Nextcloud Files to share into the chat instead of uploading a copy. */
export function CloudFilePicker({ accounts, onPick, onClose, single }: Props) {
  const [account, setAccount] = useState(accounts[0]?.id ?? "");
  const [path, setPath] = useState(() => { try { return localStorage.getItem(LAST) ?? "/"; } catch { return "/"; } });
  const [files, setFiles] = useState<CloudFile[] | null>(null);
  const [filter, setFilter] = useState("");
  // Ticked files and folders, also from other folders than the one in view.
  const [selected, setSelected] = useState<Map<string, CloudFile>>(new Map());
  const toggle = (f: CloudFile) => setSelected((s) => {
    if (single) return new Map(s.has(f.path) ? [] : [[f.path, f]]);
    const next = new Map(s);
    if (next.has(f.path)) next.delete(f.path); else next.set(f.path, f);
    return next;
  });
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
    setError(null);
    backend.cloudFiles(account, path)
      .then((list) => { if (live) { setFiles(list); try { localStorage.setItem(LAST, path); } catch { /* not remembered */ } } })
      // A remembered folder may be gone; fall back to the root once.
      .catch((e) => { if (!live) return; if (path !== "/") setPath("/"); else setError(String(e)); });
    return () => { live = false; };
  }, [account, path]);

  const crumbs = path.split("/").filter(Boolean);
  const shown = (files ?? []).filter((f) => !filter || f.name.toLowerCase().includes(filter.toLowerCase()));
  const share = (list: CloudFile[]) => {
    if (!list.length) return;
    setBusy(true);
    onPick(account, list).catch((e) => { setError(String(e)); setBusy(false); });
  };

  return (
    <div className="login-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="login-card cloud-picker">
        <button className="icon-btn close" onClick={onClose} title={t("common.closeEsc")}>✕</button>
        <h1>{t("cloud.title")}</h1>
        <div className="cloud-bar">
          {accounts.length > 1 && (
            <select value={account} onChange={(e) => { setAccount(e.target.value); setPath("/"); setSelected(new Map()); }}>
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
          {shown.map((f) => {
            const on = selected.has(f.path);
            return (
            <button key={f.path} role="option" aria-selected={on} className={`cloud-row ${on ? "selected" : ""}`}
              onClick={() => (f.dir ? setPath(f.path) : toggle(f))} onDoubleClick={() => !f.dir && share([f])}>
              {/* A folder opens on click; its box shares the whole folder. */}
              {!single && <span role="checkbox" aria-checked={on} className={`cloud-check ${on ? "on" : ""}`} title={t("cloud.tick")}
                onClick={(e) => { e.stopPropagation(); toggle(f); }} onDoubleClick={(e) => e.stopPropagation()}>{on ? "✓" : ""}</span>}
              <span className="cloud-icon">
                {f.dir ? "📁" : f.fileId && /^(image|video)\//.test(f.mime ?? "")
                  ? <img src={mediaUrl(account, `file:${f.fileId}:${f.path}`, 64)} alt="" onError={(e) => { e.currentTarget.replaceWith("📄"); }} />
                  : "📄"}
              </span>
              <span className="cloud-name">{f.name}</span>
              <span className="muted">{f.dir ? "" : formatSize(f.size)}</span>
              <span className="muted">{f.modified ? new Date(f.modified).toLocaleDateString() : ""}</span>
            </button>
            );
          })}
        </div>
        {error && <p className="error">{error}</p>}
        {!single && <p className="muted small">{t("cloud.hint")}</p>}
        <div className="edit-actions">
          {selected.size > 0 && <span className="muted small cloud-count">{t("cloud.selected", { count: selected.size })}</span>}
          <button className="btn small" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn primary small" disabled={!selected.size || busy} onClick={() => share([...selected.values()])}>
            {busy ? t("cloud.sharing") : selected.size > 1 ? t("cloud.shareCount", { count: selected.size }) : t("cloud.share")}
          </button>
        </div>
      </div>
    </div>
  );
}
