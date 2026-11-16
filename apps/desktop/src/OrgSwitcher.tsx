import { useEffect, useRef, useState, type ReactNode } from "react";
import { AllOrgsIcon, CheckIcon, PlusIcon } from "./Icons";
import { useOrgs, type OrgFilter } from "./store";
import type { Org } from "./types";
import { t } from "./i18n";

const isMac = navigator.platform.toLowerCase().includes("mac");
const mod = isMac ? "⌘" : "Ctrl+";

export function OrgAvatar({ org, size = 32 }: { org: Org; size?: number }) {
  return (
    <span className="org-avatar" style={{ background: org.color, width: size, height: size, fontSize: size * 0.45 }}>
      {org.name[0]}
    </span>
  );
}

interface Props {
  current: OrgFilter;
  unread: Record<string, number>;
  onSelect: (org: OrgFilter) => void;
  onAddAccount: () => void;
}

/** Top tile of the app rail: the spot where Teams shows the org logo. */
export function OrgSwitcher({ current, unread, onSelect, onAddAccount }: Props) {
  const orgs = useOrgs();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const currentOrg = orgs.find((o) => o.id === current);
  const elsewhere = Object.entries(unread).filter(([id]) => current !== "all" && id !== current).reduce((n, [, v]) => n + v, 0);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(isMac ? e.metaKey : e.ctrlKey)) return;
      const n = Number(e.key);
      if (Number.isNaN(n) || e.key === " ") return;
      if (n === 0) onSelect("all");
      else if (orgs[n - 1]) onSelect(orgs[n - 1].id);
      else return;
      e.preventDefault();
      setOpen(false);
    };
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [onSelect, orgs]);

  const pick = (org: OrgFilter) => {
    onSelect(org);
    setOpen(false);
  };

  return (
    <div className="org-switcher" ref={ref}>
      <button className={`org-tile ${open ? "active" : ""}`} onClick={() => setOpen(!open)} title={t("org.switch")}>
        {currentOrg ? <OrgAvatar org={currentOrg} /> : <span className="org-avatar all"><AllOrgsIcon /></span>}
        {elsewhere > 0 && <span className="badge">{elsewhere}</span>}
        <span className="rail-label">{currentOrg?.name ?? t("org.all")}</span>
      </button>

      {open && (
        <div className="menu org-menu" role="menu">
          <div className="menu-title">{t("org.title")}</div>
          <OrgRow selected={current === "all"} onClick={() => pick("all")} shortcut={`${mod}0`}
            icon={<span className="org-avatar all small"><AllOrgsIcon /></span>}
            name={t("org.allLong")} sub={t("org.combined")} count={Object.values(unread).reduce((a, b) => a + b, 0)} />
          {orgs.map((o, i) => (
            <OrgRow key={o.id} selected={current === o.id} onClick={() => pick(o.id)} shortcut={i < 9 ? `${mod}${i + 1}` : undefined}
              icon={<OrgAvatar org={o} size={28} />} name={o.name} sub={o.userId} protocol={o.protocol} count={unread[o.id] ?? 0} />
          ))}
          <div className="menu-sep" />
          <button className="menu-item" role="menuitem" onClick={() => { setOpen(false); onAddAccount(); }}><PlusIcon /> {t("org.add")}</button>
        </div>
      )}
    </div>
  );
}

function OrgRow(p: { selected: boolean; onClick: () => void; icon: ReactNode; name: string; sub: string; protocol?: string; count: number; shortcut?: string }) {
  return (
    <button className={`org-row ${p.selected ? "selected" : ""}`} role="menuitemradio" aria-checked={p.selected} onClick={p.onClick}>
      {p.icon}
      <span className="org-row-text">
        <span className="org-row-name">{p.name} {p.protocol && <span className={`proto proto-${p.protocol}`}>{p.protocol}</span>}</span>
        <span className="org-row-sub">{p.sub}</span>
      </span>
      {p.count > 0 && <span className="count">{p.count}</span>}
      {p.shortcut && <kbd>{p.shortcut}</kbd>}
      <span className="check">{p.selected && <CheckIcon />}</span>
    </button>
  );
}
