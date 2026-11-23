import type { Capabilities, Conversation, Message, Org, Protocol } from "./types";

// Calls flip on once the MatrixRTC integration lands.
export const capabilities: Record<Protocol, Capabilities> = {
  matrix: { teams: true, calls: false },
  // Talk has no spaces; calls open Talk's own call screen in a window.
  talk: { teams: false, calls: true },
  // ntfy: topics to watch (and publish to); no calls, no teams.
  ntfy: { teams: false, calls: false },
  xmpp: { teams: false, calls: false },
  irc: { teams: false, calls: false },
};

export const orgs: Org[] = [
  { id: "lab", name: "Harbour Lab", protocol: "matrix", userId: "@william:harbourlab.example", displayName: "William van Beek", color: "#e4572e", presence: "available" },
  { id: "matrixorg", name: "Matrix.org", protocol: "matrix", userId: "@willem:matrix.org", displayName: "Willem", color: "#0dbd8b", presence: "available" },
  { id: "libera", name: "Libera.Chat", protocol: "irc", userId: "willem", displayName: "willem", color: "#7c6fd8", presence: "away" },
];

const c = (p: Partial<Conversation> & Pick<Conversation, "id" | "orgId" | "name" | "preview" | "time" | "sortKey">): Conversation => ({
  kind: "group",
  favourite: false,
  muted: false,
  encrypted: true,
  unread: 0,
  mentions: 0,
  marked: false,
  ...p,
});

export const conversations: Conversation[] = [
  c({ id: "lab-webinar", orgId: "lab", kind: "meeting", name: "Harbour Lab webinar 2026", preview: "Recording is ready", time: "12/11", sortKey: 100, unread: 2 }),
  c({ id: "lab-iris", orgId: "lab", kind: "direct", name: "Iris Bakker", preview: "Open lunches on December 1st and 8th!", time: "11:28", sortKey: 99, favourite: true }),
  c({ id: "lab-ett", orgId: "lab", kind: "channel", team: "Experimental Tech", name: "General", preview: "Sam: Would robotics be something for us?", time: "11:31", sortKey: 98, unread: 5, mentions: 1 }),
  c({ id: "lab-strategy", orgId: "lab", kind: "channel", team: "Experimental Tech", name: "Strategy", preview: "Noor: Look at other labs", time: "Thu", sortKey: 90 }),
  c({ id: "lab-ai", orgId: "lab", kind: "group", name: "Omgaan met AI", preview: "Tom: Die laatste. Dat wordt um…", time: "13/08", sortKey: 40, muted: true, draft: "Ik denk dat we" }),
  c({ id: "mx-rust", orgId: "matrixorg", kind: "channel", team: "Matrix Rust SDK", name: "#matrix-rust-sdk", preview: "Sliding sync is now the default", time: "10:02", sortKey: 97, unread: 12, encrypted: false }),
  c({ id: "mx-tauri", orgId: "matrixorg", kind: "group", name: "Tauri + Matrix builders", preview: "You: anyone tried UniFFI for mobile?", time: "Mon", sortKey: 60, favourite: true }),
  c({ id: "mx-anna", orgId: "matrixorg", kind: "direct", name: "Anna de Vries", preview: "Sure, let's pair on the unread model", time: "09:15", sortKey: 95, marked: true }),
  c({ id: "irc-rust", orgId: "libera", kind: "channel", team: "Libera.Chat", name: "#rust", preview: "ferris: async traits are stable now", time: "08:40", sortKey: 80, unread: 37, encrypted: false, muted: true }),
  c({ id: "irc-trixcomm", orgId: "libera", kind: "channel", team: "Libera.Chat", name: "#trixcomm", preview: "Plugin adapter demo", time: "Sun", sortKey: 30, encrypted: false }),
];

const generic = (name: string): Message[] => [
  { id: "g1", sender: name, time: "Thursday 09:12", body: "Hey! This conversation is mock data for the UI shell." },
  { id: "g2", sender: "You", time: "Thursday 09:14", body: "Nice, real messages arrive once the Matrix adapter lands.", fromMe: true },
];

export const messages: Record<string, Message[]> = {
  "lab-webinar": [
    { id: "1", sender: "Iris Bakker", time: "Thursday 11:28", body: "Open lunches on December 1st and December 8th! More info in the blog post 🙂" },
    { id: "2", sender: "Sam Lee", time: "Thursday 11:31", body: "Would robotics be something for the Experimental Tech Platform?" },
    { id: "3", sender: "Noor Jansen", time: "Thursday 11:31", body: "On the strategy:\n\nI think it would be interesting to look into strategies of other labs – especially because they have very different governance structures and financial streams." },
    { id: "4", sender: "Iris Bakker", time: "Thursday 11:33", body: "Yes, good point. We have done this analysis of other labs and their strategies. It was very insightful.", reactions: [{ key: "👍", count: 2, mine: false, senders: ["Sam Lee", "Noor Jansen"] }] },
    { id: "5", sender: "Iris Bakker", time: "Thursday 11:33", body: "At the last conference there was an interesting panel on research strategies. Very nice!" },
    { id: "6", sender: "Sam Lee", time: "Thursday 11:34", body: "Or is it only comute?" },
    { id: "7", sender: "Sam Lee", time: "Thursday 11:34", body: "*Compute" },
    { id: "8", sender: "", time: "Thursday 11:35", body: "Eva Smit stopped recording.", system: true },
    { id: "9", sender: "", time: "Thursday 12:00", body: "Meeting ended: 2h 9m 32s", system: true },
  ],
};

export const messagesFor = (conv: Conversation): Message[] => messages[conv.id] ?? generic(conv.name);
