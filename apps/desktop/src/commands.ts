// Slash commands handled in the composer before anything is sent.
import { effects, type EffectName } from "./effects";
import { t, type Key } from "./i18n";

export type CommandResult =
  | { kind: "send"; text: string; emote?: boolean; html?: string; msgtype?: string }
  | { kind: "info"; message: string }
  /** Show the list of commands (a popup above the composer). */
  | { kind: "help" }
  /** Handled by the protocol adapter (join, invite, ...). */
  | { kind: "remote"; name: string; args: string };

const remote = (name: string) => (args: string): CommandResult => ({ kind: "remote", name, args });

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const textOf = (html: string) => new DOMParser().parseFromString(html, "text/html").body.textContent ?? "";

/** Every character its own colour, around the hue circle (like Element's /rainbow). */
function rainbow(text: string): string {
  const chars = [...text];
  return chars
    .map((c, i) => {
      if (!c.trim()) return c;
      const hue = Math.round((i / chars.length) * 360);
      const color = hslToHex(hue, 100, 45);
      return `<font color="${color}" data-mx-color="${color}">${escapeHtml(c)}</font>`;
    })
    .join("");
}

function hslToHex(h: number, s: number, l: number): string {
  const a = (s / 100) * Math.min(l / 100, 1 - l / 100);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = l / 100 - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// `usage` is syntax and stays untranslated; `help` is a translation key.
const commands: Record<string, { usage: string; help: Key; run: (args: string) => CommandResult }> = {
  me: { usage: "<action>", help: "cmd.me", run: (a) => ({ kind: "send", text: a, emote: true }) },
  shrug: { usage: "[message]", help: "cmd.shrug", run: (a) => ({ kind: "send", text: `¯\\\\\\_(ツ)\\_/¯ ${a}`.trim() }) },
  tableflip: { usage: "[message]", help: "cmd.tableflip", run: (a) => ({ kind: "send", text: `(╯°□°）╯︵ ┻━┻ ${a}`.trim() }) },
  unflip: { usage: "[message]", help: "cmd.unflip", run: (a) => ({ kind: "send", text: `┬──┬ ノ( ゜-゜ノ) ${a}`.trim() }) },
  lenny: { usage: "[message]", help: "cmd.lenny", run: (a) => ({ kind: "send", text: `( ͡° ͜ʖ ͡°) ${a}`.trim() }) },
  plain: { usage: "<message>", help: "cmd.plain", run: (a) => ({ kind: "send", text: a.replace(/([\\`*_~>#[\]-])/g, "\\$1") }) },
  spoiler: { usage: "<message>", help: "cmd.spoiler", run: (a) => ({ kind: "send", text: a, html: `<span data-mx-spoiler>${escapeHtml(a)}</span>` }) },
  html: { usage: "<html>", help: "cmd.html", run: (a) => ({ kind: "send", text: textOf(a), html: a }) },
  rainbow: { usage: "<message>", help: "cmd.rainbow", run: (a) => ({ kind: "send", text: a, html: rainbow(a) }) },
  rainbowme: { usage: "<action>", help: "cmd.rainbowme", run: (a) => ({ kind: "send", text: a, emote: true, html: rainbow(a) }) },
  join: { usage: "<#room:server>", help: "cmd.join", run: remote("join") },
  goto: { usage: "<#room:server>", help: "cmd.goto", run: remote("goto") },
  part: { usage: "", help: "cmd.part", run: remote("part") },
  invite: { usage: "<@user:server>", help: "cmd.invite", run: remote("invite") },
  query: { usage: "<@user:server>", help: "cmd.query", run: remote("query") },
  msg: { usage: "<@user:server> <message>", help: "cmd.msg", run: remote("msg") },
  topic: { usage: "[topic]", help: "cmd.topic", run: remote("topic") },
  roomname: { usage: "<name>", help: "cmd.roomname", run: remote("roomname") },
  nick: { usage: "<name>", help: "cmd.nick", run: remote("nick") },
  whois: { usage: "<@user:server>", help: "cmd.whois", run: remote("whois") },
  ...Object.fromEntries(
    (Object.keys(effects) as EffectName[]).map((name) => [
      name,
      { usage: "[message]", help: `cmd.${name}` as Key, run: (a: string): CommandResult => ({ kind: "send", text: a || effects[name].body, msgtype: effects[name].msgtype }) },
    ]),
  ),
  poll: { usage: "", help: "cmd.poll", run: remote("poll") },
  jumptodate: { usage: "<YYYY-MM-DD>", help: "cmd.jumptodate", run: remote("jumptodate") },
  myavatar: { usage: "", help: "cmd.myavatar", run: remote("myavatar") },
  myroomavatar: { usage: "", help: "cmd.myroomavatar", run: remote("myroomavatar") },
  roomavatar: { usage: "", help: "cmd.roomavatar", run: remote("roomavatar") },
  converttodm: { usage: "", help: "cmd.converttodm", run: remote("converttodm") },
  converttoroom: { usage: "", help: "cmd.converttoroom", run: remote("converttoroom") },
  upgraderoom: { usage: "<version>", help: "cmd.upgraderoom", run: remote("upgraderoom") },
  holdcall: { usage: "", help: "cmd.holdcall", run: remote("holdcall") },
  unholdcall: { usage: "", help: "cmd.unholdcall", run: remote("unholdcall") },
  verify: { usage: "<@user:server> <session> <fingerprint>", help: "cmd.verify", run: remote("verify") },
  discardsession: { usage: "", help: "cmd.discardsession", run: remote("discardsession") },
  myroomnick: { usage: "[name]", help: "cmd.myroomnick", run: remote("myroomnick") },
  remove: { usage: "<@user:server> [reason]", help: "cmd.remove", run: remote("remove") },
  ban: { usage: "<@user:server> [reason]", help: "cmd.ban", run: remote("ban") },
  unban: { usage: "<@user:server> [reason]", help: "cmd.unban", run: remote("unban") },
  op: { usage: "<@user:server> [level]", help: "cmd.op", run: remote("op") },
  deop: { usage: "<@user:server>", help: "cmd.deop", run: remote("deop") },
  ignore: { usage: "<@user:server>", help: "cmd.ignore", run: remote("ignore") },
  unignore: { usage: "<@user:server>", help: "cmd.unignore", run: remote("unignore") },
  help: {
    usage: "",
    help: "cmd.help",
    run: () => ({ kind: "help" }),
  },
};

export function runCommand(input: string): CommandResult {
  if (!input.startsWith("/") || input.startsWith("//")) return { kind: "send", text: input.replace(/^\/\//, "/") };
  const [, name = "", args = ""] = input.match(/^\/(\S+)\s*([\s\S]*)$/) ?? [];
  const command = commands[name.toLowerCase()];
  if (!command) return { kind: "info", message: t("cmd.unknown", { name }) };
  return command.run(args.trim());
}

export const commandList = Object.entries(commands).map(([name, c]) => ({ name, usage: c.usage, help: c.help }));
