// Slash commands handled in the composer before anything is sent.
import { t, type Key } from "./i18n";

export type CommandResult =
  | { kind: "send"; text: string; emote?: boolean }
  | { kind: "info"; message: string }
  /** Handled by the protocol adapter (join, invite, ...). */
  | { kind: "remote"; name: string; args: string };

const remote = (name: string) => (args: string): CommandResult => ({ kind: "remote", name, args });

// `usage` is syntax and stays untranslated; `help` is a translation key.
const commands: Record<string, { usage: string; help: Key; run: (args: string) => CommandResult }> = {
  me: { usage: "<action>", help: "cmd.me", run: (a) => ({ kind: "send", text: a, emote: true }) },
  shrug: { usage: "[message]", help: "cmd.shrug", run: (a) => ({ kind: "send", text: `¯\\\\\\_(ツ)\\_/¯ ${a}`.trim() }) },
  tableflip: { usage: "[message]", help: "cmd.tableflip", run: (a) => ({ kind: "send", text: `(╯°□°）╯︵ ┻━┻ ${a}`.trim() }) },
  unflip: { usage: "[message]", help: "cmd.unflip", run: (a) => ({ kind: "send", text: `┬──┬ ノ( ゜-゜ノ) ${a}`.trim() }) },
  lenny: { usage: "[message]", help: "cmd.lenny", run: (a) => ({ kind: "send", text: `( ͡° ͜ʖ ͡°) ${a}`.trim() }) },
  plain: { usage: "<message>", help: "cmd.plain", run: (a) => ({ kind: "send", text: a.replace(/([\\`*_~>#[\]-])/g, "\\$1") }) },
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
  help: {
    usage: "",
    help: "cmd.help",
    run: () => ({ kind: "info", message: Object.entries(commands).map(([name, c]) => `/${name} ${c.usage} — ${t(c.help)}`.replace("  ", " ")).join("\n") }),
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
