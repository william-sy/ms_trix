import { useEffect, useState } from "react";
import { backend, mediaUrl } from "./backend";
import { formatSize } from "./Composer";
import { ContextMenu } from "./ContextMenu";
import { ChatPickerDialog } from "./ForwardDialog";
import { locale, t } from "./i18n";
import type { CloudFile, Conversation, Org } from "./types";

// Nextcloud Files in the rail (like OneDrive in Teams): your folders, recently changed files and
// a search through everything; upload by dropping files on it; open a file in Nextcloud
// (documents in Nextcloud Office) or on this computer, download it, copy a link, send it into a
// chat (shared into a Talk chat on the same Nextcloud, a link elsewhere), or delete it.

type Section = "files" | "recent";

const FOLDER = "trix.filesFolder";
const ACCOUNT = "trix.filesAccount";

const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* not kept */ } };

/** Pictures, videos and PDFs have a preview in Nextcloud. */
const previewable = (f: CloudFile) => !f.dir && !!f.fileId && /^(image|video)\/|^application\/pdf$/.test(f.mime ?? "");

function icon(f: CloudFile) {
  if (f.dir) return "📁";
  const mime = f.mime ?? "";
  const ext = f.name.split(".").pop()?.toLowerCase() ?? "";
  if (mime.startsWith("image/")) return "🖼️";
  if (mime.startsWith("video/")) return "🎞️";
  if (mime.startsWith("audio/")) return "🎵";
  if (mime === "application/pdf") return "📕";
  if (/^(xlsx?|ods|csv)$/.test(ext)) return "📊";
  if (/^(pptx?|odp|key)$/.test(ext)) return "📽️";
  if (/^(zip|tar|gz|7z|rar)$/.test(ext)) return "🗜️";
  if (/^(md|txt)$/.test(ext)) return "📝";
  return "📄";
}

const folderOf = (path: string) => path.slice(0, path.lastIndexOf("/")) || "/";

function modified(f: CloudFile) {
  if (!f.modified) return "";
  const d = new Date(f.modified);
  if (Number.isNaN(d.getTime())) return "";
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString(locale(), { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString(locale(), { day: "numeric", month: "short", year: "numeric" });
}

export function FilesPane({ orgs, convs }: { orgs: Org[]; convs: Conversation[] }) {
  const [account, setAccountState] = useState(() => orgs.find((o) => o.id === read(ACCOUNT))?.id ?? orgs[0]?.id ?? "");
  const [section, setSection] = useState<Section>("files");
  const [path, setPathState] = useState(() => read(`${FOLDER}.${account}`) ?? "/");
  const [query, setQuery] = useState("");
  const [files, setFiles] = useState<CloudFile[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [menu, setMenu] = useState<{ file: CloudFile; x: number; y: number } | null>(null);
  const [sending, setSending] = useState<CloudFile | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [upload, setUpload] = useState<{ done: number; total: number } | null>(null);
  const [dropping, setDropping] = useState(false);

  const setAccount = (id: string) => { setAccountState(id); write(ACCOUNT, id); setPathState(read(`${FOLDER}.${id}`) ?? "/"); };
  const setPath = (p: string) => { setPathState(p); write(`${FOLDER}.${account}`, p); setSection("files"); setQuery(""); };
  const searching = query.trim().length >= 2;

  // An account that left the view (organization switched): the first one that's there.
  useEffect(() => {
    if (!orgs.some((o) => o.id === account) && orgs[0]) setAccount(orgs[0].id);
  }, [orgs.map((o) => o.id).join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!account) return;
    let live = true;
    setError(null);
    const timer = window.setTimeout(() => {
      setFiles(null);
      const load = searching ? backend.cloudSearch(account, query.trim()) : section === "recent" ? backend.cloudRecent(account) : backend.cloudFiles(account, path);
      load.then((list) => live && setFiles(list), (e) => {
        if (!live) return;
        // A remembered folder may be gone; back to the top once.
        if (!searching && section === "files" && path !== "/") setPath("/");
        else { setError(String(e)); setFiles([]); }
      });
    }, searching ? 300 : 0);
    return () => { live = false; window.clearTimeout(timer); };
  }, [account, section, path, searching ? query.trim() : "", reload]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const close = () => setMenu(null);
    window.addEventListener("click", close);
    return () => window.removeEventListener("click", close);
  }, []);

  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(null), 4000);
    return () => window.clearTimeout(timer);
  }, [notice]);

  // Files dropped on the window while this view is open (App routes them here); into the folder in view.
  const uploadPaths = async (paths: string[]) => {
    if (!paths.length || !account) return;
    const folder = section === "files" && !searching ? path : "/";
    setUpload({ done: 0, total: paths.length });
    try {
      for (const [i, p] of paths.entries()) {
        await backend.cloudUploadPaths(account, folder, [p]);
        setUpload({ done: i + 1, total: paths.length });
      }
      setNotice(t("files.uploaded", { count: paths.length, folder: folder === "/" ? t("files.root") : folder.split("/").pop()! }));
      if (section !== "files" || searching) setPath(folder);
      setReload((n) => n + 1);
    } catch (e) {
      setError(String(e));
      setReload((n) => n + 1);
    } finally {
      setUpload(null);
    }
  };
  useEffect(() => {
    const onDrag = (e: Event) => setDropping((e as CustomEvent<boolean>).detail);
    const onDrop = (e: Event) => { setDropping(false); void uploadPaths((e as CustomEvent<string[]>).detail); };
    window.addEventListener("trix:files-drag", onDrag);
    window.addEventListener("trix:files-drop", onDrop);
    return () => { window.removeEventListener("trix:files-drag", onDrag); window.removeEventListener("trix:files-drop", onDrop); };
  });

  const pickAndUpload = () => backend.pickFiles().then((picked) => uploadPaths(picked.map((p) => p.path))).catch((e) => setError(String(e)));

  const makeFolder = async (name: string) => {
    const clean = name.trim().replace(/[/\\]/g, "-");
    if (!clean) return;
    try {
      await backend.cloudMkdir(account, `${path === "/" ? "" : path}/${clean}`);
      setNaming(null);
      setReload((n) => n + 1);
    } catch (e) {
      setError(String(e));
    }
  };

  const media = (f: CloudFile) => `file:${f.fileId ?? ""}:${f.path}`;
  const remove = (f: CloudFile) => {
    if (!confirm(t(f.dir ? "files.deleteFolderConfirm" : "files.deleteConfirm", { name: f.name }))) return;
    backend.cloudDelete(account, f.path)
      .then(() => { setFiles((list) => list?.filter((x) => x.path !== f.path) ?? null); setNotice(t("files.deleted", { name: f.name })); })
      .catch((e) => setError(String(e)));
  };

  const act = (what: "web" | "local" | "download" | "link" | "send" | "folder" | "delete", f: CloudFile) => {
    setMenu(null);
    const fail = (e: unknown) => setError(String(e));
    if (what === "web") return f.fileId ? void backend.openCloudFile(account, f.fileId).catch(fail) : undefined;
    if (what === "local") return void backend.openMedia(account, media(f), f.name).catch(fail);
    if (what === "download") return void backend.saveMedia(account, media(f), f.name).then((saved) => saved && setNotice(t("files.saved", { name: f.name })), fail);
    if (what === "link") return void backend.cloudShareLink(account, f.path).then((link) => navigator.clipboard.writeText(link)).then(() => setNotice(t("files.linkCopied")), fail);
    if (what === "send") return setSending(f);
    if (what === "delete") return remove(f);
    setPath(folderOf(f.path));
  };
  const open = (f: CloudFile) => (f.dir ? setPath(f.path) : act("web", f));

  // Into a chat: shared into a Talk chat on this Nextcloud, otherwise as a link in a message.
  const sendTo = async (f: CloudFile, target: Conversation, note: string | null) => {
    const link = await backend.attachCloudFile(account, f.path, target.id, note);
    if (link) await backend.send(target.id, { text: `${note ? `${note}\n` : ""}${f.dir ? "📁" : "📎"} ${f.name}\n${link}` });
    setSending(null);
    setNotice(t("files.sent", { name: f.name, chat: target.name }));
  };

  const crumbs = path.split("/").filter(Boolean);
  const flat = searching || section === "recent";

  return (
    <div className="files-pane">
      <nav className="files-nav">
        {orgs.length > 1 && (
          <select value={account} onChange={(e) => setAccount(e.target.value)} title={t("files.account")}>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
        )}
        <button className={`files-nav-item ${section === "files" && !searching ? "active" : ""}`} onClick={() => setPath(path)}>📁 {t("files.myFiles")}</button>
        <button className={`files-nav-item ${section === "recent" && !searching ? "active" : ""}`} onClick={() => { setSection("recent"); setQuery(""); }}>🕘 {t("files.recent")}</button>
      </nav>
      <section className={`files-main ${dropping ? "dropping" : ""}`}>
        <header className="files-head">
          {searching ? <h2>{t("files.results", { query: query.trim() })}</h2>
            : section === "recent" ? <h2>{t("files.recent")}</h2>
            : (
              <nav className="files-crumbs">
                <button className="link" onClick={() => setPath("/")}>{t("files.myFiles")}</button>
                {crumbs.map((c, i) => (
                  <span key={i}> › <button className="link" onClick={() => setPath(`/${crumbs.slice(0, i + 1).join("/")}`)}>{c}</button></span>
                ))}
              </nav>
            )}
          <span className="spacer" />
          <input className="files-search" type="search" placeholder={t("files.search")} value={query} onChange={(e) => setQuery(e.target.value)} />
          {section === "files" && !searching && <button className="btn small" onClick={() => setNaming("")}>{t("files.newFolder")}</button>}
          <button className="btn primary small" disabled={!!upload} onClick={() => void pickAndUpload()}>{t("files.upload")}</button>
          <button className="icon-btn" title={t("files.reload")} onClick={() => setReload((n) => n + 1)}>↻</button>
        </header>
        {naming !== null && (
          <form className="files-naming" onSubmit={(e) => { e.preventDefault(); void makeFolder(naming); }}>
            <input autoFocus value={naming} placeholder={t("files.folderName")} onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setNaming(null)} />
            <button className="btn small primary" disabled={!naming.trim()}>{t("files.create")}</button>
            <button type="button" className="btn small" onClick={() => setNaming(null)}>{t("common.cancel")}</button>
          </form>
        )}
        {upload && <p className="files-status">{t("files.uploading", { done: upload.done, total: upload.total })}</p>}
        {notice && <p className="files-status" role="status">{notice}</p>}
        {error && <p className="error files-status">{error} <button className="link" onClick={() => setError(null)}>{t("common.dismiss")}</button></p>}
        <div className="files-list" role="list">
          <div className="files-row files-columns" aria-hidden>
            <span />
            <span>{t("files.name")}</span>
            <span>{t("files.modified")}</span>
            <span>{t("files.size")}</span>
            <span />
          </div>
          {!files && <div className="spinner" aria-label={t("common.loading")} />}
          {files && files.length === 0 && !error && (
            <p className="empty">{searching ? t("files.noResults") : section === "recent" ? t("files.noRecent") : t("files.emptyFolder")}</p>
          )}
          {files?.map((f) => (
            <div key={f.path} role="listitem" className="files-row" onDoubleClick={() => open(f)}
              onContextMenu={(e) => { e.preventDefault(); setMenu({ file: f, x: e.clientX, y: e.clientY }); }}>
              <span className="files-icon">
                {previewable(f) ? <img src={mediaUrl(account, media(f), 64)} alt="" loading="lazy" onError={(e) => e.currentTarget.replaceWith(icon(f))} /> : icon(f)}
              </span>
              <span className="files-name">
                <button className="link" title={f.dir ? undefined : t("files.openWeb")} onClick={() => open(f)}>{f.name}</button>
                {flat && <small className="muted">{folderOf(f.path) === "/" ? t("files.myFiles") : folderOf(f.path).slice(1)}</small>}
              </span>
              <span className="muted">{modified(f)}</span>
              <span className="muted">{f.dir ? "" : formatSize(f.size)}</span>
              <span className="files-actions">
                {!f.dir && <button className="icon-btn" title={t("files.copyLink")} onClick={() => act("link", f)}>🔗</button>}
                <button className="icon-btn" title={t("files.more")} onClick={(e) => { e.stopPropagation(); setMenu({ file: f, x: e.clientX, y: e.clientY }); }}>⋯</button>
              </span>
            </div>
          ))}
        </div>
        {dropping && <div className="files-drop">{t("files.dropHere", { folder: section === "files" && !searching && path !== "/" ? crumbs[crumbs.length - 1]! : t("files.myFiles") })}</div>}
      </section>
      {menu && (
        <ContextMenu x={menu.x} y={menu.y}>
          {menu.file.dir ? (
            <button className="menu-item" onClick={() => { setMenu(null); setPath(menu.file.path); }}>{t("files.openFolder")}</button>
          ) : (
            <>
              <button className="menu-item" disabled={!menu.file.fileId} onClick={() => act("web", menu.file)}>{t("files.openWeb")}</button>
              <button className="menu-item" onClick={() => act("local", menu.file)}>{t("files.openLocal")}</button>
              <button className="menu-item" onClick={() => act("download", menu.file)}>{t("files.download")}</button>
            </>
          )}
          <div className="menu-sep" />
          <button className="menu-item" onClick={() => act("link", menu.file)}>{t("files.copyLink")}</button>
          <button className="menu-item" onClick={() => act("send", menu.file)}>{t("files.sendToChat")}</button>
          {flat && <button className="menu-item" onClick={() => act("folder", menu.file)}>{t("files.showInFolder")}</button>}
          <div className="menu-sep" />
          <button className="menu-item danger" onClick={() => act("delete", menu.file)}>{t("files.delete")}</button>
        </ContextMenu>
      )}
      {sending && (
        <ChatPickerDialog title={t("files.sendTitle")} convs={convs} onClose={() => setSending(null)}
          preview={<><b>{icon(sending)} {sending.name}</b><span>{sending.dir ? t("files.folderLinkHint") : t("files.sendHint")}</span></>}
          onSend={(target, note) => sendTo(sending, target, note)} />
      )}
    </div>
  );
}
