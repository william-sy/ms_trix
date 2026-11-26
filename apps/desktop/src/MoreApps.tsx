import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { backend } from "./backend";
import { t } from "./i18n";
import { MoreIcon } from "./Icons";
import type { Org, ServerApp } from "./types";

// More in the rail: the apps your Nextcloud offers in its own web pages (Office, Photos, Music,
// Deck, …), as Nextcloud's app menu lists them; one click opens it in the browser. Asked when the
// menu first opens, then kept for the rest of the run. The ones the app has itself are left out.

/** Talk, Files, Notes, Calendar and Contacts. */
const IN_APP = new Set(["spreed", "files", "notes", "calendar", "contacts"]);

const loaded = new Map<string, Promise<ServerApp[]>>();
const appsOf = (account: string) => {
  let apps = loaded.get(account);
  if (!apps) {
    apps = backend.serverApps(account);
    loaded.set(account, apps);
    apps.catch(() => loaded.delete(account));
  }
  return apps;
};

export function MoreApps({ orgs }: { orgs: Org[] }) {
  const [open, setOpen] = useState(false);
  const [apps, setApps] = useState<Record<string, ServerApp[] | string>>({});
  const ref = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  // Within the window: moved up as far as it needs (the button sits halfway down the rail), and
  // scrolling inside when even that isn't enough.
  useLayoutEffect(() => {
    const el = menu.current;
    const anchor = ref.current;
    if (!open || !el || !anchor) return;
    const fit = () => {
      const top = anchor.getBoundingClientRect().top;
      const margin = 12;
      const height = Math.min(el.scrollHeight, window.innerHeight - 2 * margin);
      const up = Math.max(0, Math.min(top + height - (window.innerHeight - margin), top - margin));
      el.style.top = `${-up}px`;
      el.style.maxHeight = `${window.innerHeight - (top - up) - margin}px`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [open, apps]);

  useEffect(() => {
    if (!open) return;
    for (const org of orgs) {
      appsOf(org.id).then((list) => setApps((a) => ({ ...a, [org.id]: list })), (e) => setApps((a) => ({ ...a, [org.id]: String(e) })));
    }
    const away = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("mousedown", away);
    window.addEventListener("keydown", key);
    return () => { window.removeEventListener("mousedown", away); window.removeEventListener("keydown", key); };
  }, [open, orgs.map((o) => o.id).join(" ")]); // eslint-disable-line react-hooks/exhaustive-deps

  const launch = (app: ServerApp) => {
    setOpen(false);
    void backend.openUrl(app.href).catch(() => {});
  };

  return (
    <div className="more-apps" ref={ref}>
      <button className={`rail-item ${open ? "active" : ""}`} title={t("more.hint")} onClick={() => setOpen(!open)}>
        <MoreIcon />
        <span className="rail-label">{t("rail.more")}</span>
      </button>
      {open && (
        <div className="menu more-menu" role="menu" ref={menu}>
          <div className="menu-title">{t("more.title")}</div>
          {orgs.map((org) => {
            const list = apps[org.id];
            return (
              <section key={org.id}>
                {orgs.length > 1 && <div className="more-account">{org.name}</div>}
                {list === undefined ? <p className="more-note">{t("more.loading")}</p>
                  : typeof list === "string" ? <p className="more-note">{t("more.failed", { error: list })}</p>
                  : (
                    <div className="more-grid">
                      {list.filter((app) => !IN_APP.has(app.id)).map((app) => (
                        <button key={app.id} className="more-app" role="menuitem" title={app.href} onClick={() => launch(app)}>
                          <span className="more-icon">{app.icon && <img src={app.icon} alt="" draggable={false} />}</span>
                          <span className="more-name">{app.name}</span>
                        </button>
                      ))}
                    </div>
                  )}
              </section>
            );
          })}
          <p className="more-note">{t("more.inBrowser")}</p>
        </div>
      )}
    </div>
  );
}
