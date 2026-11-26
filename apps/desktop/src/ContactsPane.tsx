import { useEffect, useMemo, useState } from "react";
import { Avatar } from "./Avatar";
import { backend } from "./backend";
import { t } from "./i18n";
import { useOpenLink } from "./LinkPreview";
import type { Contact, Member, Org, ServerTeam, ServerTeamDetails } from "./types";

// Contacts: the people in your Nextcloud address books, and anyone on your Nextcloud by searching
// (the server's own list of all its accounts can be very long, so it isn't listed). A name opens
// its card: chat or call in Talk when they have an account on that Nextcloud, a Matrix chat for a
// Matrix id on the card, and their addresses and numbers (mail and phone links). Teams: your
// Nextcloud Teams, with what's shared with them (a Talk conversation, folders, boards) and members.

/** Address books per account, read once per run (Refresh reads them again). */
const loaded = new Map<string, Promise<Contact[]>>();
const contactsOf = (account: string, again = false) => {
  let list = again ? undefined : loaded.get(account);
  if (!list) {
    list = backend.contacts(account);
    loaded.set(account, list);
    // In the log: how many from which address book (no names of people).
    void list.then((cards) => {
      const books = new Map<string, number>();
      for (const c of cards) books.set(c.book, (books.get(c.book) ?? 0) + 1);
      void backend.logUi(`contacts for ${account}: ${cards.length}${books.size ? ` (${[...books].map(([b, n]) => `${b} ${n}`).join(", ")})` : ""}`).catch(() => {});
    }, (e) => void backend.logUi(`contacts for ${account}: ${String(e)}`).catch(() => {}));
    list.catch(() => loaded.delete(account));
  }
  return list;
};

/** Teams per account, read once per run (Refresh reads them again). */
const teamsLoaded = new Map<string, Promise<ServerTeam[]>>();
const teamsOf = (account: string, again = false) => {
  let list = again ? undefined : teamsLoaded.get(account);
  if (!list) {
    list = backend.serverTeams(account);
    teamsLoaded.set(account, list);
    void list.then((found) => backend.logUi(`teams for ${account}: ${found.length}`), (e) => backend.logUi(`teams for ${account}: ${String(e)}`)).catch(() => {});
    list.catch(() => teamsLoaded.delete(account));
  }
  return list;
};

/** Accounts found by address (a card without a cloud id): per account and address, null for none. */
const byAddress = new Map<string, Promise<string | null>>();
const userByEmail = (account: string, email: string) => {
  const key = `${account} ${email.toLowerCase()}`;
  let found = byAddress.get(key);
  if (!found) {
    found = backend.searchUsers(account, email).then((hits) => (hits.length === 1 ? hits[0]!.userId : null), () => null);
    byAddress.set(key, found);
  }
  return found;
};

type Person = { account: string; contact: Contact } | { account: string; member: Member };
type Picked = Person | { account: string; team: ServerTeam };
const pickedKey = (p: Picked) => `${p.account} ${"contact" in p ? p.contact.id : "member" in p ? p.member.userId : `team:${p.team.id}`}`;

interface Props {
  /** The Nextcloud accounts in view. */
  orgs: Org[];
  /** A Matrix account, for Matrix ids on cards. */
  matrix?: Org;
  /** Opens (or starts) the 1:1 chat with `user` on `account`, and with `call` its call too. */
  onChat: (account: string, user: string, call?: boolean) => void;
}

const matches = (c: Contact, q: string) => {
  const digits = q.replace(/\D/g, "");
  return [c.name, c.org ?? "", c.title ?? "", ...c.emails].some((s) => s.toLowerCase().includes(q))
    || (digits.length >= 3 && c.phones.some((p) => p.number.replace(/\D/g, "").includes(digits)));
};

export function ContactsPane({ orgs, matrix, onChat }: Props) {
  const [tab, setTab] = useState<"people" | "teams">("people");
  const [books, setBooks] = useState<Record<string, Contact[] | string>>({});
  const [teams, setTeams] = useState<Record<string, ServerTeam[] | string>>({});
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<Record<string, Member[]>>({});
  const [picked, setPicked] = useState<Picked | null>(null);
  const accounts = orgs.map((o) => o.id).join(" ");

  const load = (again = false) => {
    for (const org of orgs) {
      contactsOf(org.id, again).then((list) => setBooks((b) => ({ ...b, [org.id]: list })), (e) => setBooks((b) => ({ ...b, [org.id]: String(e) })));
      teamsOf(org.id, again).then((list) => setTeams((x) => ({ ...x, [org.id]: list })), (e) => setTeams((x) => ({ ...x, [org.id]: String(e) })));
    }
  };
  useEffect(() => load(), [accounts]); // eslint-disable-line react-hooks/exhaustive-deps

  // Anyone on the Nextcloud, as you type (a moment after the last key).
  const q = query.trim().toLowerCase();
  useEffect(() => {
    if (q.length < 2) return setPeople({});
    const timer = window.setTimeout(() => {
      for (const org of orgs) backend.searchUsers(org.id, q).then((hits) => setPeople((p) => ({ ...p, [org.id]: hits })), () => {});
    }, 300);
    return () => window.clearTimeout(timer);
  }, [q, accounts]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = useMemo(() => orgs.map((org) => {
    const list = books[org.id];
    const cards = Array.isArray(list) ? (q ? list.filter((c) => matches(c, q)) : list) : [];
    const known = new Set(cards.map((c) => c.user).filter(Boolean));
    return { org, error: typeof list === "string" ? list : null, loading: list === undefined, cards, people: q ? (people[org.id] ?? []).filter((m) => !known.has(m.userId)) : [] };
  }), [orgs, books, people, q]);
  const nothing = shown.every((s) => !s.loading && !s.cards.length && !s.people.length);
  const isPicked = (key: string) => !!picked && pickedKey(picked) === key;
  const teamsShown = orgs.map((org) => {
    const list = teams[org.id];
    return { org, error: typeof list === "string" ? list : null, loading: list === undefined, teams: Array.isArray(list) ? list.filter((x) => !q || x.name.toLowerCase().includes(q) || (x.description ?? "").toLowerCase().includes(q)) : [] };
  });

  return (
    <>
      <aside className="chat-list contacts-list">
        <header className="pane-head">
          <h1>{t("contacts.title")}</h1>
          <div className="head-actions">
            <button className="btn small" title={t("contacts.refreshHint")} onClick={() => load(true)}>{t("contacts.refresh")}</button>
          </div>
        </header>
        <div className="contacts-search">
          <input type="search" value={query} placeholder={t(tab === "teams" ? "contacts.searchTeams" : "contacts.search")} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <div className="filters">
          {(["people", "teams"] as const).map((x) => <button key={x} className={`pill ${tab === x ? "on" : ""}`} onClick={() => setTab(x)}>{t(`contacts.${x}`)}</button>)}
        </div>
        {tab === "teams" ? (
          <div className="list-scroll">
            {teamsShown.map(({ org, error, loading, teams: list }) => (
              <div key={org.id} className="section">
                {orgs.length > 1 && <div className="section-head">{org.name}</div>}
                {loading && <p className="empty">{t("contacts.loading")}</p>}
                {/* No Teams app on that Nextcloud: nothing to say. */}
                {error && !/not found|404/i.test(error) && <p className="empty">{t("contacts.teamsFailed", { error })}</p>}
                {list.map((x) => (
                  <button key={x.id} className={`row contact-row ${isPicked(`${org.id} team:${x.id}`) ? "selected" : ""}`} onClick={() => setPicked({ account: org.id, team: x })}>
                    <Avatar account={org.id} name={x.name} className="kind-group" />
                    <span className="row-text"><span className="row-name">{x.name}</span><span className="row-preview">{t("contacts.teamMembers", { count: x.members })}</span></span>
                  </button>
                ))}
              </div>
            ))}
            {teamsShown.every((x) => !x.loading && !x.teams.length) && <p className="empty">{t(q ? "contacts.noMatch" : "contacts.teamsEmpty")}</p>}
          </div>
        ) : (
        <div className="list-scroll">
          {shown.map(({ org, error, loading, cards, people: found }) => (
            <div key={org.id} className="section">
              {(orgs.length > 1 || (q && (cards.length > 0 || found.length > 0))) && (
                <div className="section-head">{orgs.length > 1 ? org.name : t("contacts.yours")}</div>
              )}
              {loading && <p className="empty">{t("contacts.loading")}</p>}
              {error && <p className="empty">{t("contacts.failed", { error })}</p>}
              {cards.map((c) => (
                <button key={c.id} className={`row contact-row ${isPicked(`${org.id} ${c.id}`) ? "selected" : ""}`} onClick={() => setPicked({ account: org.id, contact: c })}>
                  <Avatar account={org.id} media={c.user ? `user:${c.user}` : undefined} name={c.name} />
                  <span className="row-text">
                    <span className="row-name">{c.name}</span>
                    <span className="row-preview">{[c.title, c.org].filter(Boolean).join(", ") || c.emails[0] || c.phones[0]?.number || ""}</span>
                  </span>
                </button>
              ))}
              {found.length > 0 && <div className="section-head">{t("contacts.onServer", { name: org.name })}</div>}
              {found.map((m) => (
                <button key={m.userId} className={`row contact-row ${isPicked(`${org.id} ${m.userId}`) ? "selected" : ""}`} onClick={() => setPicked({ account: org.id, member: m })}>
                  <Avatar account={org.id} media={m.avatar ?? undefined} name={m.name} />
                  <span className="row-text"><span className="row-name">{m.name}</span><span className="row-preview">{m.userId}</span></span>
                </button>
              ))}
            </div>
          ))}
          {nothing && <p className="empty">{t(q ? "contacts.noMatch" : "contacts.empty")}</p>}
        </div>
        )}
      </aside>
      {!picked ? <main className="chat-view empty-view"><p>{t("contacts.pick")}</p></main>
        : "team" in picked ? <TeamCard key={pickedKey(picked)} account={picked.account} team={picked.team} onPerson={(member) => setPicked({ account: picked.account, member })} />
        : <ContactCard key={pickedKey(picked)} picked={picked} org={orgs.find((o) => o.id === picked.account)} matrix={matrix} onChat={onChat} />}
    </>
  );
}

/** A team: what's shared with it (opened in the app where it can: a Talk conversation, a folder) and its members. */
function TeamCard({ account, team, onPerson }: { account: string; team: ServerTeam; onPerson: (member: Member) => void }) {
  const [details, setDetails] = useState<ServerTeamDetails | string | null>(null);
  const openLink = useOpenLink();
  useEffect(() => {
    backend.serverTeam(account, team.id).then(setDetails, (e) => setDetails(String(e)));
  }, [account, team.id]);
  const roles: Record<string, string> = { owner: t("contacts.role.owner"), admin: t("contacts.role.admin"), moderator: t("contacts.role.moderator") };
  return (
    <main className="chat-view contact-card">
      <div className="contact-head">
        <Avatar account={account} name={team.name} className="contact-avatar kind-group" />
        <div>
          <h2>{team.name}</h2>
          <p className="muted">{t("contacts.teamMembers", { count: team.members })}</p>
        </div>
      </div>
      {team.description && <p className="contact-text">{team.description}</p>}
      {team.link && <div className="contact-actions"><button className="btn" onClick={() => void backend.openUrl(team.link!).catch(() => {})}>{t("contacts.openTeam")}</button></div>}
      {details === null && <p className="muted">{t("contacts.loading")}</p>}
      {typeof details === "string" && <p className="muted">{t("contacts.teamsFailed", { error: details })}</p>}
      {details && typeof details !== "string" && (
        <>
          <h3 className="contact-section">{t("contacts.shared")}</h3>
          {details.resources.length === 0 && <p className="muted contact-note">{t("contacts.sharedNone")}</p>}
          <div className="team-resources">
            {details.resources.map((r, i) => (
              <button key={i} className="row contact-row" title={r.url} onClick={() => openLink(r.url)}>
                <span className="team-resource-kind">{r.emoji ?? r.providerName}</span>
                <span className="row-text"><span className="row-name">{r.label}</span></span>
              </button>
            ))}
          </div>
          <h3 className="contact-section">{t("contacts.members")}</h3>
          <div className="team-members">
            {details.members.map((m, i) => {
              const row = (
                <>
                  <Avatar account={account} media={m.user ? `user:${m.user}` : undefined} name={m.name} className={m.kind === "user" || m.kind === "email" || m.kind === "contact" ? "" : "kind-group"} />
                  <span className="row-text">
                    <span className="row-name">{m.name}</span>
                    {(roles[m.role] || m.pending || m.kind === "group" || m.kind === "team") && (
                      <span className="row-preview">{[roles[m.role], m.kind === "group" ? t("contacts.kind.group") : m.kind === "team" ? t("contacts.kind.team") : null, m.pending ? t("contacts.invited") : null].filter(Boolean).join(" · ")}</span>
                    )}
                  </span>
                </>
              );
              return m.user ? <button key={i} className="row contact-row" onClick={() => onPerson({ userId: m.user!, name: m.name, avatar: `user:${m.user}` })}>{row}</button>
                : <div key={i} className="row contact-row static">{row}</div>;
            })}
          </div>
        </>
      )}
    </main>
  );
}

function ContactCard({ picked, org, matrix, onChat }: { picked: Person; org?: Org; matrix?: Org; onChat: Props["onChat"] }) {
  const { account } = picked;
  const contact = "contact" in picked ? picked.contact : null;
  const name = contact?.name ?? ("member" in picked ? picked.member.name : "");
  // Their account on this Nextcloud: from the card's cloud id, else looked up by its addresses.
  // undefined: still looking; null: none.
  const [user, setUser] = useState<string | null | undefined>(() =>
    contact ? contact.user ?? (contact.emails.length ? undefined : null) : "member" in picked ? picked.member.userId : null);
  useEffect(() => {
    if (!contact || contact.user || !contact.emails.length) return;
    let live = true;
    void (async () => {
      for (const email of contact.emails) {
        const found = await userByEmail(account, email);
        if (found) return live && setUser(found);
      }
      if (live) setUser(null);
    })();
    return () => { live = false; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <main className="chat-view contact-card">
      <div className="contact-head">
        <Avatar account={account} media={user ? `user:${user}` : "member" in picked ? picked.member.avatar ?? undefined : undefined} name={name} className="contact-avatar" />
        <div>
          <h2>{name}</h2>
          {contact && (contact.title || contact.org) && <p className="muted">{[contact.title, contact.org].filter(Boolean).join(", ")}</p>}
        </div>
      </div>
      <div className="contact-actions">
        {user && (
          <>
            <button className="btn primary" onClick={() => onChat(account, user)}>{t("contacts.chat")}</button>
            <button className="btn" onClick={() => onChat(account, user, true)}>{t("contacts.call")}</button>
          </>
        )}
        {user === undefined && <span className="muted">{t("contacts.looking")}</span>}
        {contact?.matrix && matrix && <button className="btn" title={contact.matrix} onClick={() => onChat(matrix.id, contact.matrix!)}>{t("contacts.matrixChat")}</button>}
      </div>
      {user === null && contact && <p className="muted contact-note">{t("contacts.notOnServer", { name: org?.name ?? "" })}</p>}
      <dl className="contact-details">
        {contact?.emails.map((email) => (
          <div key={email}><dt>{t("contacts.email")}</dt><dd><button className="link" onClick={() => void backend.openUrl(`mailto:${email}`).catch(() => {})}>{email}</button></dd></div>
        ))}
        {contact?.phones.map((p, i) => (
          <div key={i}>
            <dt>{p.kind ? t(`contacts.phone.${p.kind}` as "contacts.phone.mobile") : t("contacts.phone")}</dt>
            <dd><button className="link" title={t("contacts.phoneHint")} onClick={() => void backend.openUrl(`tel:${p.number.replace(/[^\d+]/g, "")}`).catch(() => {})}>{p.number}</button></dd>
          </div>
        ))}
        {contact?.matrix && <div><dt>Matrix</dt><dd>{contact.matrix}</dd></div>}
        {user && <div><dt>{t("contacts.account")}</dt><dd>{user}{org ? ` · ${org.name}` : ""}</dd></div>}
        {contact?.note && <div><dt>{t("contacts.note")}</dt><dd className="contact-text">{contact.note}</dd></div>}
        {contact && <div><dt>{t("contacts.book")}</dt><dd>{contact.book}</dd></div>}
      </dl>
    </main>
  );
}
