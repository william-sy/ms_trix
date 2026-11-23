// A phishing check for links, on this computer only (nothing is looked up anywhere): link text
// showing another address than where the link goes, look-alike letters (a Cyrillic "а" in
// "pаypal"), names close to domains you use, and address tricks (user@host, an IP address).

export type LinkWarning =
  | { kind: "mismatch"; shown: string; real: string }
  | { kind: "lookalike"; real: string; like: string }
  | { kind: "letters"; real: string; like?: string }
  | { kind: "userinfo"; real: string }
  | { kind: "ip"; real: string };

/** Sites people often get phished with; your own accounts' domains are added to these. */
const WELL_KNOWN = [
  "eduroam.org", "microsoft.com", "microsoftonline.com", "office.com", "outlook.com", "live.com",
  "google.com", "gmail.com", "apple.com", "icloud.com", "paypal.com", "amazon.com", "facebook.com", "instagram.com", "linkedin.com",
  "github.com", "dropbox.com", "ing.nl", "rabobank.nl", "abnamro.nl", "digid.nl", "belastingdienst.nl", "postnl.nl", "bol.com",
  "matrix.org", "element.io", "nextcloud.com",
];

/** Parts of a domain name that dress up a borrowed name ("paypal-nl", "paypal-login"). */
const DRESSING = new Set(["nl", "com", "eu", "login", "logon", "signin", "secure", "account", "accounts", "verify", "auth", "sso", "mail", "support", "service", "update", "portal", "online", "help"]);

/** Second-level endings, so the site of "shop.example.co.uk" is "example.co.uk". */
const SECOND_LEVEL = new Set(["co.uk", "ac.uk", "gov.uk", "org.uk", "com.au", "co.nz", "co.jp", "com.br", "co.za"]);

/** The site a host belongs to ("login.example.org" → "example.org"), roughly. */
export function siteOf(host: string): string {
  const labels = host.toLowerCase().replace(/\.$/, "").split(".");
  if (labels.length <= 2) return labels.join(".");
  const lastTwo = labels.slice(-2).join(".");
  return labels.slice(SECOND_LEVEL.has(lastTwo) ? -3 : -2).join(".");
}

const nameOf = (site: string) => site.slice(0, site.lastIndexOf(".") < 0 ? undefined : site.lastIndexOf("."));

/** Your accounts' domains: the server part of Matrix IDs (@you:matrix.example.org → example.org). */
export function ownDomains(userIds: string[]): string[] {
  return [...new Set(userIds.map((id) => /^@[^:]+:([^:/]+)/.exec(id)?.[1]).filter((h): h is string => !!h).map(siteOf))];
}

/** Decodes one punycode label (without "xn--"), RFC 3492; null when it isn't valid. */
export function punycode(label: string): string | null {
  const base = 36, tMin = 1, tMax = 26;
  const adapt = (delta: number, points: number, first: boolean) => {
    delta = first ? Math.floor(delta / 700) : delta >> 1;
    delta += Math.floor(delta / points);
    let k = 0;
    for (; delta > ((base - tMin) * tMax) >> 1; k += base) delta = Math.floor(delta / (base - tMin));
    return k + Math.floor(((base - tMin + 1) * delta) / (delta + 38));
  };
  const dash = label.lastIndexOf("-");
  const out = dash > 0 ? [...label.slice(0, dash)].map((c) => c.codePointAt(0)!) : [];
  let n = 128, i = 0, bias = 72;
  for (let at = dash > 0 ? dash + 1 : 0; at < label.length;) {
    const old = i;
    for (let w = 1, k = base; ; k += base) {
      if (at >= label.length) return null;
      const c = label.charCodeAt(at++);
      const digit = c >= 48 && c <= 57 ? c - 22 : c >= 65 && c <= 90 ? c - 65 : c >= 97 && c <= 122 ? c - 97 : base;
      if (digit >= base) return null;
      i += digit * w;
      const t = k <= bias ? tMin : k >= bias + tMax ? tMax : k - bias;
      if (digit < t) break;
      w *= base - t;
    }
    bias = adapt(i - old, out.length + 1, old === 0);
    n += Math.floor(i / (out.length + 1));
    i %= out.length + 1;
    out.splice(i++, 0, n);
  }
  try { return String.fromCodePoint(...out); } catch { return null; }
}

const unicodeHost = (host: string) => host.split(".").map((l) => (l.startsWith("xn--") ? punycode(l.slice(4)) ?? l : l)).join(".");

/** Cyrillic and Greek letters that look like Latin ones, and other common stand-ins. */
const CONFUSABLE: Record<string, string> = {
  а: "a", в: "b", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ј: "j", ѕ: "s", һ: "h", ԁ: "d", ӏ: "l", ԛ: "q", ԝ: "w", ь: "b", к: "k", м: "m", н: "h", т: "t",
  α: "a", ο: "o", ν: "v", τ: "t", ρ: "p", ι: "i", κ: "k", ε: "e", υ: "u", χ: "x",
};

/** What a name reads like: look-alike letters replaced, and 0/1/rn/vv as o/l/m/w. */
function skeleton(name: string): string {
  return [...name].map((c) => CONFUSABLE[c] ?? c).join("").replace(/0/g, "o").replace(/1/g, "l").replace(/rn/g, "m").replace(/vv/g, "w");
}

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const here = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = here;
    }
  }
  return row[b.length]!;
}

const LATIN = /\p{Script=Latin}/u;
const LOOKALIKE_SCRIPT = /[\p{Script=Cyrillic}\p{Script=Greek}]/u;

/** A host written in look-alike letters: mixed scripts in one label, or Cyrillic/Greek posing as Latin. */
function letterTrick(host: string): string | undefined {
  for (const label of host.split(".")) {
    if (!LOOKALIKE_SCRIPT.test(label)) continue;
    const mapped = skeleton(label);
    if (LATIN.test(label) || /^[a-z0-9-]+$/.test(mapped)) return host.split(".").map(skeleton).join(".");
  }
  return undefined;
}

/** Shown text that is itself an address (or a bare domain): its host. */
function shownHost(text: string): string | undefined {
  const m = /^\s*(?:https?:\/\/)?((?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,})(?:[/:?#]\S*)?\s*$/u.exec(text);
  return m?.[1]?.toLowerCase();
}

/** What's wrong with a link to `href` shown as `shown` (its text), given your own domains. */
export function checkLink(href: string, shown?: string, own: string[] = []): LinkWarning[] {
  let url: URL;
  try { url = new URL(href); } catch { return []; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return [];
  const host = url.hostname.toLowerCase();
  const pretty = unicodeHost(host);
  const site = siteOf(pretty);
  const out: LinkWarning[] = [];

  if (url.username || url.password) out.push({ kind: "userinfo", real: pretty });
  if (/^\d+(\.\d+){3}$/.test(host) || host.startsWith("[")) out.push({ kind: "ip", real: host });

  const fromText = shown && shownHost(shown);
  if (fromText && siteOf(unicodeHost(fromText)) !== site) out.push({ kind: "mismatch", shown: fromText, real: pretty });

  const trick = letterTrick(pretty);
  if (trick) out.push({ kind: "letters", real: host, like: trick !== pretty ? trick : undefined });

  const trusted = [...new Set([...own, ...WELL_KNOWN])];
  if (!trusted.includes(site)) {
    const name = nameOf(site), read = skeleton(name), parts = read.split(/[-.]/);
    const like = trusted.find((t) => {
      const tn = nameOf(t);
      // login.paypal.com.example.net: the real site's name in front of another one.
      if (pretty.startsWith(`${t}.`) || pretty.includes(`.${t}.`)) return true;
      if (read === tn) return name !== tn || own.includes(t); // look-alike letters, or your own name under another ending
      if (tn.length >= 5 && distance(read, tn) <= (tn.length >= 8 ? 2 : 1)) return true;
      return parts.length > 1 && parts.includes(tn) && (tn.length >= 6 || parts.some((p) => p !== tn && DRESSING.has(p)));
    });
    if (like) out.push({ kind: "lookalike", real: pretty, like });
  }
  return out;
}
