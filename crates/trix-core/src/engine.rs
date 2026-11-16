//! Owns the client-side state for all accounts: conversations, a window of
//! recent messages and the unread state machine per conversation.
//!
//! The engine is synchronous and does no I/O. Every call returns an
//! [`Outcome`]; the host forwards `effects` to the adapters and pushes the
//! changed views to the UI.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use serde::Serialize;

use crate::adapter::{AdapterEvent, History, ProtocolAdapter};
use crate::model::*;
use crate::unread::{UnreadEffect, UnreadInput, UnreadState};

/// Upper bound per conversation, scrollback included.
const MESSAGE_WINDOW: usize = 5000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    SendReceipt { conversation: ConversationId, thread_root: Option<MessageId>, up_to: MessageId },
    SyncMarkedUnread { conversation: ConversationId, value: bool },
}

#[derive(Debug, Default)]
pub struct Outcome {
    pub changed: Vec<ConversationId>,
    pub removed: Vec<ConversationId>,
    /// New or changed (reacted, edited, deleted) messages.
    pub new_messages: Vec<MessageView>,
    pub effects: Vec<Effect>,
    pub notifications: Vec<Notification>,
    pub teams_changed: bool,
    pub activity_changed: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TeamView {
    pub key: String,
    pub account: String,
    pub name: String,
    pub topic: Option<String>,
    pub avatar: Option<String>,
    /// Conversation keys of the channels we're in, in the team's order.
    pub channels: Vec<String>,
    /// Remote id, for browsing the channels we haven't joined.
    pub space_id: String,
    pub not_joined: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivityKind {
    Mention,
    Reply,
    Reaction,
}

/// Something that happened to you: the Activity feed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityItem {
    pub id: String,
    pub kind: ActivityKind,
    pub conversation: String,
    pub conversation_name: String,
    /// The message to jump to (for reactions: the reacted message).
    pub message: String,
    pub sender_name: String,
    pub sender_avatar: Option<String>,
    pub preview: String,
    pub reaction: Option<String>,
    pub at: Timestamp,
}

const ACTIVITY_LIMIT: usize = 300;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub conversation: String,
    pub conversation_name: String,
    pub message: String,
    /// Empty for our own messages.
    pub sender_name: String,
    pub snippet: String,
    pub at: Timestamp,
}

/// Up to ~40 characters of context around a match (byte offsets into `text`).
fn snippet(text: &str, at: usize, len: usize) -> String {
    // Offsets come from the lowercased text; a few characters change byte length
    // when lowercased, so fall back to the start rather than slicing mid-character.
    let (at, len) = if text.is_char_boundary(at) && text.is_char_boundary((at + len).min(text.len())) && at + len <= text.len() { (at, len) } else { (0, 0) };
    let start = text[..at].char_indices().rev().nth(40).map(|(i, _)| i).unwrap_or(0);
    let end = text[at + len..].char_indices().nth(80).map(|(i, _)| at + len + i).unwrap_or(text.len());
    let mut s = text[start..end].replace('\n', " ");
    if start > 0 {
        s.insert(0, '…');
    }
    if end < text.len() {
        s.push('…');
    }
    s
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Notification {
    pub conversation: String,
    pub title: String,
    pub body: String,
}

/// Messages older than this when they arrive are history, not news.
const NOTIFY_MAX_AGE_MS: u64 = 60_000;

/// Conversation as the UI renders it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConversationView {
    pub key: String,
    pub account: String,
    pub kind: &'static str,
    pub team: Option<String>,
    pub name: String,
    pub favourite: bool,
    pub muted: bool,
    pub mentions_only: bool,
    pub encrypted: bool,
    pub unread: usize,
    pub mentions: usize,
    pub marked: bool,
    pub preview: String,
    pub last_at: Timestamp,
    pub avatar: Option<String>,
    /// Other people's read positions, for "seen" indicators.
    pub readers: Vec<Reader>,
    pub typing: Vec<String>,
    /// For 1:1 chats, when the server shares presence.
    pub presence: Option<Presence>,
    pub status: Option<String>,
    /// Pending invite: who invited us.
    pub invited_by: Option<String>,
    /// The other person in a 1:1 chat.
    pub dm_user: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Reader {
    pub user_id: String,
    pub name: String,
    pub avatar: Option<String>,
    pub pos: TimelinePos,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MessageView {
    pub conversation: String,
    pub id: String,
    pub pos: TimelinePos,
    pub sender: String,
    pub sender_name: String,
    pub sent_at: Timestamp,
    pub body: String,
    pub html: Option<String>,
    pub media: Option<MediaView>,
    pub thread_root: Option<String>,
    pub reply_to: Option<String>,
    pub sender_avatar: Option<String>,
    pub from_me: bool,
    pub reactions: Vec<ReactionView>,
    pub edited: bool,
    pub deleted: bool,
    /// Waiting for its decryption key.
    pub encrypted: bool,
    /// Set for room events (joins, renames, ...), shown as a grey line.
    pub event: Option<EventView>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EventView {
    pub kind: RoomEventKind,
    pub actor: String,
    pub target: Option<String>,
    pub value: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReactionView {
    pub key: String,
    pub count: usize,
    pub mine: bool,
    pub senders: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaView {
    pub id: String,
    pub kind: FileKind,
    pub name: String,
    pub mime: Option<String>,
}

#[derive(Debug, Clone)]
struct ReactionRecord {
    id: MessageId,
    key: String,
    sender: String,
    sender_name: String,
    from_me: bool,
}

impl MessageView {
    fn build(m: &Message, reactions: Option<&Vec<ReactionRecord>>, edited: bool) -> Self {
        let (body, html, media) = match &m.body {
            MessageBody::Text { plain, html } => (plain.clone(), html.clone(), None),
            MessageBody::Notice { plain } => (plain.clone(), None, None),
            MessageBody::File { name, media, kind, mime, .. } => {
                (name.clone(), None, Some(MediaView { id: media.clone(), kind: *kind, name: name.clone(), mime: mime.clone() }))
            }
            MessageBody::Redacted | MessageBody::Event { .. } | MessageBody::Encrypted => (String::new(), None, None),
        };
        let event = match &m.body {
            MessageBody::Event { kind, actor, target, value } => Some(EventView { kind: *kind, actor: actor.clone(), target: target.clone(), value: value.clone() }),
            _ => None,
        };
        // Group by emoji, in order of first use.
        let mut grouped: Vec<ReactionView> = vec![];
        for r in reactions.into_iter().flatten() {
            match grouped.iter_mut().find(|g| g.key == r.key) {
                Some(g) => {
                    g.count += 1;
                    g.mine |= r.from_me;
                    g.senders.push(r.sender_name.clone());
                }
                None => grouped.push(ReactionView { key: r.key.clone(), count: 1, mine: r.from_me, senders: vec![r.sender_name.clone()] }),
            }
        }
        Self {
            conversation: m.conversation.key(),
            id: m.id.0.clone(),
            pos: m.pos,
            sender: m.sender.clone(),
            sender_name: m.sender_name.clone(),
            sent_at: m.sent_at,
            body,
            html,
            media,
            thread_root: m.thread_root.as_ref().map(|t| t.0.clone()),
            reply_to: m.reply_to.as_ref().map(|t| t.0.clone()),
            sender_avatar: m.sender_avatar.clone(),
            from_me: m.from_me,
            reactions: grouped,
            edited,
            deleted: matches!(m.body, MessageBody::Redacted),
            encrypted: matches!(m.body, MessageBody::Encrypted),
            event,
        }
    }
}

#[derive(Default)]
struct Entry {
    /// None until the adapter describes the conversation; messages can arrive first.
    conv: Option<Conversation>,
    unread: UnreadState,
    /// Sorted by position.
    messages: VecDeque<Message>,
    readers: HashMap<String, Reader>,
    typing: Vec<String>,
    /// Reactions per target message; they may arrive before the message.
    reactions: HashMap<MessageId, Vec<ReactionRecord>>,
    reaction_targets: HashMap<MessageId, MessageId>,
    /// Latest edit per message: (time, sender, new body); applied on arrival too.
    edits: HashMap<MessageId, (Timestamp, String, MessageBody)>,
    edited: HashSet<MessageId>,
    /// Placeholders that were just replaced by their decrypted message.
    decrypted: Vec<MessageId>,
}

impl Entry {
    fn view(&self, m: &Message) -> MessageView {
        MessageView::build(m, self.reactions.get(&m.id), self.edited.contains(&m.id))
    }

    fn view_of(&self, id: &MessageId) -> Option<MessageView> {
        self.messages.iter().find(|m| &m.id == id).map(|m| self.view(m))
    }

    /// Applies the stored edit for `id` if it comes from the original sender.
    fn apply_edit(&mut self, id: &MessageId) -> bool {
        let Some((_, sender, body)) = self.edits.get(id) else { return false };
        let Some(m) = self.messages.iter_mut().find(|m| &m.id == id) else { return false };
        if &m.sender != sender || matches!(m.body, MessageBody::Redacted) {
            return false;
        }
        m.body = body.clone();
        self.edited.insert(id.clone());
        true
    }

    fn latest_pos(&self, thread_root: &Option<MessageId>) -> Option<TimelinePos> {
        self.messages.iter().rev().find(|m| &m.thread_root == thread_root).map(|m| m.pos)
    }

    fn thread_roots(&self) -> Vec<MessageId> {
        let mut roots: Vec<MessageId> = self.messages.iter().filter_map(|m| m.thread_root.clone()).collect();
        roots.sort_by(|a, b| a.0.cmp(&b.0));
        roots.dedup();
        roots
    }

    /// True when the message is new. A decrypted version replaces its
    /// "waiting for key" placeholder in place (and also returns false).
    fn insert(&mut self, m: Message) -> bool {
        if let Some(existing) = self.messages.iter_mut().find(|x| x.id == m.id) {
            if matches!(existing.body, MessageBody::Encrypted) && !matches!(m.body, MessageBody::Encrypted) {
                *existing = m;
                let id = existing.id.clone();
                self.apply_edit(&id);
                self.decrypted.push(id);
            }
            return false;
        }
        let id = m.id.clone();
        let i = self.messages.partition_point(|x| x.pos < m.pos);
        self.messages.insert(i, m);
        if self.messages.len() > MESSAGE_WINDOW {
            self.messages.pop_front();
        }
        self.apply_edit(&id);
        true
    }
}

#[derive(Default)]
pub struct Engine {
    adapters: HashMap<AccountId, Arc<dyn ProtocolAdapter>>,
    convs: HashMap<ConversationId, Entry>,
    focused: Option<ConversationId>,
    window_focused: bool,
    presence: HashMap<String, (Presence, Option<String>)>,
    teams: HashMap<ConversationId, Team>,
    /// Newest first.
    activity: VecDeque<ActivityItem>,
}

impl Engine {
    pub fn new() -> Self {
        Self { window_focused: true, ..Default::default() }
    }

    pub fn add_adapter(&mut self, adapter: Arc<dyn ProtocolAdapter>) {
        self.adapters.insert(adapter.account().id, adapter);
    }

    pub fn adapter(&self, account: &AccountId) -> Option<Arc<dyn ProtocolAdapter>> {
        self.adapters.get(account).cloned()
    }

    pub fn remove_account(&mut self, account: &AccountId) -> (Option<Arc<dyn ProtocolAdapter>>, Outcome) {
        let mut out = Outcome::default();
        out.removed = self.convs.keys().filter(|id| &id.account == account).cloned().collect();
        self.convs.retain(|id, _| &id.account != account);
        if self.focused.as_ref().is_some_and(|f| &f.account == account) {
            self.focused = None;
        }
        (self.adapters.remove(account), out)
    }

    pub fn accounts(&self) -> Vec<Account> {
        self.adapters.values().map(|a| a.account().clone()).collect()
    }

    pub fn handle(&mut self, event: AdapterEvent, now: Timestamp) -> Outcome {
        let mut out = Outcome::default();
        match event {
            AdapterEvent::ConversationUpserted(conv) => {
                let id = conv.id.clone();
                self.convs.entry(id.clone()).or_default().conv = Some(conv);
                out.changed.push(id);
            }
            AdapterEvent::ConversationRemoved(id) => {
                if self.convs.remove(&id).is_some() {
                    out.removed.push(id.clone());
                }
                if self.teams.remove(&id).is_some() {
                    out.teams_changed = true;
                }
            }
            AdapterEvent::TeamUpserted(team) => {
                self.teams.insert(team.id.clone(), team);
                out.teams_changed = true;
            }
            AdapterEvent::Message(m) => {
                let id = m.conversation.clone();
                let input = UnreadInput::Incoming {
                    pos: m.pos,
                    thread_root: m.thread_root.clone(),
                    mentions_me: m.mentions_me,
                    from_me: m.from_me,
                    at: m.sent_at,
                };
                // Deleted messages and room events (joins, renames) never count as unread.
                let deleted = matches!(m.body, MessageBody::Redacted | MessageBody::Event { .. });
                let msg_id = m.id.clone();
                let notification = self.notification_for(&m, now);
                let entry = self.convs.entry(id.clone()).or_default();
                if !entry.insert(m) {
                    // A late-decrypted message: show it, but it was already counted.
                    let late = std::mem::take(&mut entry.decrypted);
                    for msg_id in late {
                        out.new_messages.extend(self.convs[&id].view_of(&msg_id));
                        out.activity_changed |= self.record_message_activity(&id, &msg_id);
                        out.changed.push(id.clone());
                    }
                    return out;
                }
                if !deleted {
                    let fx = entry.unread.apply(input);
                    self.push_effects(&id, fx, &mut out);
                }
                if self.is_visible(&id) {
                    self.read_all(&id, now, &mut out);
                }
                out.new_messages.extend(self.convs[&id].view_of(&msg_id));
                out.notifications.extend(notification);
                out.activity_changed |= self.record_message_activity(&id, &msg_id);
                out.changed.push(id);
            }
            AdapterEvent::OwnReadReceipt { conversation, thread_root, pos, at, all_threads } => {
                let input = if all_threads { UnreadInput::RemoteReadAll { pos, at } } else { UnreadInput::RemoteRead { pos, thread_root, at } };
                self.apply(&conversation, input, &mut out);
            }
            AdapterEvent::ReadBy { conversation, user_id, name, avatar, pos } => {
                let entry = self.convs.entry(conversation.clone()).or_default();
                if entry.readers.get(&user_id).is_some_and(|r| r.pos >= pos) {
                    return out;
                }
                entry.readers.insert(user_id.clone(), Reader { user_id, name, avatar, pos });
                out.changed.push(conversation);
            }
            AdapterEvent::Typing { conversation, names } => {
                self.convs.entry(conversation.clone()).or_default().typing = names;
                out.changed.push(conversation);
            }
            AdapterEvent::MarkedUnread { conversation, value, .. } => {
                self.apply(&conversation, UnreadInput::RemoteMarkedUnread { value }, &mut out);
            }
            AdapterEvent::MessageRedacted { conversation, id } => {
                let entry = self.convs.entry(conversation.clone()).or_default();
                let changed = if let Some(target) = entry.reaction_targets.remove(&id) {
                    if let Some(list) = entry.reactions.get_mut(&target) {
                        list.retain(|r| r.id != id);
                    }
                    target
                } else if let Some(m) = entry.messages.iter_mut().find(|m| m.id == id) {
                    m.body = MessageBody::Redacted;
                    entry.reactions.remove(&id);
                    entry.edits.remove(&id);
                    entry.edited.remove(&id);
                    id
                } else {
                    return out;
                };
                out.new_messages.extend(entry.view_of(&changed));
                out.changed.push(conversation);
            }
            AdapterEvent::Reaction { conversation, target, id, key, sender, sender_name, from_me, at } => {
                let entry = self.convs.entry(conversation.clone()).or_default();
                if entry.reaction_targets.contains_key(&id) {
                    return out;
                }
                entry.reaction_targets.insert(id.clone(), target.clone());
                let list = entry.reactions.entry(target.clone()).or_default();
                // One reaction per person per emoji, like other clients show it.
                if !list.iter().any(|r| r.sender == sender && r.key == key) {
                    list.push(ReactionRecord { id: id.clone(), key: key.clone(), sender, sender_name: sender_name.clone(), from_me });
                }
                out.new_messages.extend(entry.view_of(&target));
                // Someone reacted to one of our messages.
                if let Some(m) = entry.messages.iter().find(|m| m.id == target && m.from_me && !from_me) {
                    let item = ActivityItem {
                        id: id.0.clone(),
                        kind: ActivityKind::Reaction,
                        conversation: conversation.key(),
                        conversation_name: entry.conv.as_ref().map(|c| c.name.clone()).unwrap_or_default(),
                        message: target.0.clone(),
                        sender_name,
                        sender_avatar: None,
                        preview: m.body.plain_text(),
                        reaction: Some(key),
                        at,
                    };
                    out.activity_changed |= self.push_activity(item);
                }
                out.changed.push(conversation);
            }
            AdapterEvent::Edited { conversation, target, sender, body, at } => {
                let entry = self.convs.entry(conversation.clone()).or_default();
                if entry.edits.get(&target).is_some_and(|(t, _, _)| *t > at) {
                    return out;
                }
                entry.edits.insert(target.clone(), (at, sender, body));
                if entry.apply_edit(&target) {
                    out.new_messages.extend(entry.view_of(&target));
                    out.changed.push(conversation);
                }
            }
            AdapterEvent::PresenceChanged { user_id, presence, status } => {
                out.changed = self
                    .convs
                    .iter()
                    .filter(|(_, e)| e.conv.as_ref().and_then(|c| c.dm_user.as_ref()) == Some(&user_id))
                    .map(|(id, _)| id.clone())
                    .collect();
                self.presence.insert(user_id, (presence, status));
            }
            AdapterEvent::ConnectionLost { .. } | AdapterEvent::ConnectionRestored => {}
        }
        out
    }

    /// Adds older messages (scrollback, threads). They never count as unread:
    /// they predate what the live timeline already accounted for.
    pub fn add_history(&mut self, conversation: &ConversationId, history: History) -> Outcome {
        let mut out = Outcome::default();
        let mut added = false;
        for event in history.events {
            match event {
                AdapterEvent::Message(m) => {
                    let id = m.id.clone();
                    let entry = self.convs.entry(conversation.clone()).or_default();
                    if entry.insert(m) {
                        added = true;
                        out.activity_changed |= self.record_message_activity(conversation, &id);
                    } else if !entry.decrypted.is_empty() {
                        entry.decrypted.clear();
                        out.new_messages.extend(entry.view_of(&id));
                        added = true;
                    }
                }
                // Reactions, edits and deletions apply the same way as live ones.
                other => merge_outcome(&mut out, self.handle(other, 0)),
            }
        }
        if added && !out.changed.contains(conversation) {
            out.changed.push(conversation.clone());
        }
        out
    }

    pub fn teams(&self) -> Vec<TeamView> {
        self.teams
            .values()
            .map(|t| {
                let channels: Vec<String> = t
                    .children
                    .iter()
                    .map(|remote| ConversationId { account: t.id.account.clone(), remote: remote.clone() })
                    .filter(|id| self.convs.get(id).is_some_and(|e| e.conv.as_ref().is_some_and(|c| c.invited_by.is_none())))
                    .map(|id| id.key())
                    .collect();
                TeamView {
                    key: t.id.key(),
                    account: t.id.account.0.clone(),
                    name: t.name.clone(),
                    topic: t.topic.clone(),
                    avatar: t.avatar_url.clone(),
                    not_joined: t.children.len().saturating_sub(channels.len()),
                    channels,
                    space_id: t.id.remote.clone(),
                }
            })
            .collect()
    }

    /// Case-insensitive search over all loaded messages, newest first.
    pub fn search(&self, query: &str, limit: usize) -> Vec<SearchHit> {
        let q = query.trim().to_lowercase();
        if q.chars().count() < 2 {
            return vec![];
        }
        let mut hits: Vec<SearchHit> = self
            .convs
            .iter()
            .filter_map(|(id, e)| e.conv.as_ref().map(|c| (id, e, c)))
            .flat_map(|(id, e, c)| {
                let q = q.clone();
                e.messages.iter().filter_map(move |m| {
                    let text = m.body.plain_text();
                    let lower = text.to_lowercase();
                    let at = lower.find(&q)?;
                    Some(SearchHit {
                        conversation: id.key(),
                        conversation_name: c.name.clone(),
                        message: m.id.0.clone(),
                        sender_name: if m.from_me { String::new() } else { m.sender_name.clone() },
                        snippet: snippet(&text, at, q.len()),
                        at: m.sent_at,
                    })
                })
            })
            .collect();
        hits.sort_by(|a, b| b.at.cmp(&a.at));
        hits.truncate(limit);
        hits
    }

    pub fn activity(&self) -> Vec<ActivityItem> {
        self.activity.iter().cloned().collect()
    }

    /// Mentions of us and replies to our messages.
    fn record_message_activity(&mut self, conversation: &ConversationId, id: &MessageId) -> bool {
        let Some(entry) = self.convs.get(conversation) else { return false };
        let Some(m) = entry.messages.iter().find(|m| &m.id == id) else { return false };
        if m.from_me || matches!(m.body, MessageBody::Redacted | MessageBody::Event { .. }) {
            return false;
        }
        let replied_to_me = [&m.reply_to, &m.thread_root]
            .into_iter()
            .flatten()
            .any(|target| entry.messages.iter().any(|x| &x.id == target && x.from_me));
        let kind = if m.mentions_me {
            ActivityKind::Mention
        } else if replied_to_me {
            ActivityKind::Reply
        } else {
            return false;
        };
        let item = ActivityItem {
            id: m.id.0.clone(),
            kind,
            conversation: conversation.key(),
            conversation_name: entry.conv.as_ref().map(|c| c.name.clone()).unwrap_or_default(),
            message: m.id.0.clone(),
            sender_name: m.sender_name.clone(),
            sender_avatar: m.sender_avatar.clone(),
            preview: m.body.plain_text(),
            reaction: None,
            at: m.sent_at,
        };
        self.push_activity(item)
    }

    fn push_activity(&mut self, item: ActivityItem) -> bool {
        if self.activity.iter().any(|a| a.id == item.id) {
            return false;
        }
        let i = self.activity.partition_point(|a| a.at > item.at);
        self.activity.insert(i, item);
        self.activity.truncate(ACTIVITY_LIMIT);
        true
    }

    /// Our own reaction with this emoji on `target`, so the UI can toggle it off.
    pub fn own_reaction(&self, conversation: &ConversationId, target: &MessageId, key: &str) -> Option<MessageId> {
        let list = self.convs.get(conversation)?.reactions.get(target)?;
        list.iter().find(|r| r.from_me && r.key == key).map(|r| r.id.clone())
    }

    /// The conversation shown in the chat pane changed (None = nothing shown).
    pub fn focus(&mut self, conversation: Option<ConversationId>, now: Timestamp) -> Outcome {
        let mut out = Outcome::default();
        if self.focused == conversation {
            return out;
        }
        if let Some(prev) = self.focused.take() {
            self.apply(&prev, UnreadInput::Blurred, &mut out);
        }
        if let Some(id) = conversation {
            self.focused = Some(id.clone());
            self.apply(&id, UnreadInput::Focused { at: now }, &mut out);
            if self.window_focused {
                self.read_all(&id, now, &mut out);
            }
        }
        out
    }

    /// Switching windows does not count as leaving the chat; it only decides
    /// whether new messages in the open chat are seen.
    pub fn set_window_focused(&mut self, focused: bool, now: Timestamp) -> Outcome {
        let mut out = Outcome::default();
        self.window_focused = focused;
        if let (true, Some(id)) = (focused, self.focused.clone()) {
            self.read_all(&id, now, &mut out);
        }
        out
    }

    pub fn mark_unread(&mut self, conversation: &ConversationId, now: Timestamp) -> Outcome {
        let mut out = Outcome::default();
        self.apply(conversation, UnreadInput::MarkUnread { at: now }, &mut out);
        out
    }

    pub fn mark_read(&mut self, conversation: &ConversationId, now: Timestamp) -> Outcome {
        let mut out = Outcome::default();
        self.apply(conversation, UnreadInput::MarkRead { at: now }, &mut out);
        out
    }

    pub fn conversations(&self) -> Vec<ConversationView> {
        self.convs.keys().filter_map(|id| self.view(id)).collect()
    }

    pub fn view(&self, id: &ConversationId) -> Option<ConversationView> {
        let entry = self.convs.get(id)?;
        let conv = entry.conv.as_ref()?;
        let summary = entry.unread.summary();
        // Room events (joins, renames) neither show as preview nor move the chat up.
        let last = entry.messages.iter().rev().find(|m| !matches!(m.body, MessageBody::Event { .. }));
        let preview = match last {
            None => String::new(),
            Some(m) => {
                let text = m.body.plain_text().lines().next().unwrap_or_default().to_owned();
                if matches!(m.body, MessageBody::Redacted) {
                    "Message deleted".to_owned()
                } else if m.from_me {
                    format!("You: {text}")
                } else if conv.kind == ConversationKind::Direct {
                    text
                } else {
                    format!("{}: {text}", m.sender_name)
                }
            }
        };
        let (kind, team) = match &conv.kind {
            ConversationKind::Direct => ("direct", None),
            ConversationKind::Group => ("group", None),
            ConversationKind::Channel { team } => ("channel", team.clone()),
            ConversationKind::Meeting => ("meeting", None),
        };
        Some(ConversationView {
            key: id.key(),
            account: id.account.0.clone(),
            kind,
            team,
            name: conv.name.clone(),
            favourite: conv.favourite,
            muted: conv.muted,
            mentions_only: conv.mentions_only,
            encrypted: conv.encrypted,
            unread: summary.unread,
            mentions: summary.mentions,
            marked: summary.marked,
            preview,
            last_at: last.map(|m| m.sent_at).unwrap_or(0),
            avatar: conv.avatar_url.clone(),
            readers: entry.readers.values().cloned().collect(),
            typing: entry.typing.clone(),
            invited_by: conv.invited_by.clone(),
            dm_user: conv.dm_user.clone(),
            presence: conv.dm_user.as_ref().and_then(|u| self.presence.get(u)).map(|(p, _)| *p),
            status: conv.dm_user.as_ref().and_then(|u| self.presence.get(u)).and_then(|(_, s)| s.clone()),
        })
    }

    pub fn messages(&self, id: &ConversationId) -> Vec<MessageView> {
        self.convs.get(id).map(|e| e.messages.iter().map(|m| e.view(m)).collect()).unwrap_or_default()
    }

    /// Teams-like rules: chats notify, channels only on mention, muted never.
    fn notification_for(&self, m: &Message, now: Timestamp) -> Option<Notification> {
        if m.from_me || matches!(m.body, MessageBody::Redacted | MessageBody::Event { .. }) || now.saturating_sub(m.sent_at) > NOTIFY_MAX_AGE_MS || self.is_visible(&m.conversation) {
            return None;
        }
        let entry = self.convs.get(&m.conversation)?;
        if entry.messages.iter().any(|x| x.id == m.id) {
            return None; // already seen
        }
        let conv = entry.conv.as_ref()?;
        let wanted = !conv.muted
            && (m.mentions_me || (!conv.mentions_only && !matches!(conv.kind, ConversationKind::Channel { .. })));
        if !wanted {
            return None;
        }
        let title = match conv.kind {
            ConversationKind::Direct => m.sender_name.clone(),
            _ => format!("{} in {}", m.sender_name, conv.name),
        };
        let body = match &m.body {
            MessageBody::File { kind: FileKind::Image, .. } => "sent an image".to_owned(),
            MessageBody::File { name, .. } => format!("sent {name}"),
            other => other.plain_text(),
        };
        Some(Notification { conversation: m.conversation.key(), title, body })
    }

    fn is_visible(&self, id: &ConversationId) -> bool {
        self.window_focused && self.focused.as_ref() == Some(id)
    }

    fn read_all(&mut self, id: &ConversationId, now: Timestamp, out: &mut Outcome) {
        let Some(entry) = self.convs.get(id) else { return };
        let mut timelines: Vec<Option<MessageId>> = vec![None];
        timelines.extend(entry.thread_roots().into_iter().map(Some));
        for thread_root in timelines {
            let Some(pos) = self.convs[id].latest_pos(&thread_root) else { continue };
            self.apply(id, UnreadInput::LocalRead { pos, thread_root, at: now }, out);
        }
    }

    fn apply(&mut self, id: &ConversationId, input: UnreadInput, out: &mut Outcome) {
        let fx = self.convs.entry(id.clone()).or_default().unread.apply(input);
        self.push_effects(id, fx, out);
        if !out.changed.contains(id) {
            out.changed.push(id.clone());
        }
    }

    fn push_effects(&self, id: &ConversationId, fx: Vec<UnreadEffect>, out: &mut Outcome) {
        let Some(entry) = self.convs.get(id) else { return };
        for effect in fx {
            match effect {
                UnreadEffect::SyncMarkedUnread(value) => out.effects.push(Effect::SyncMarkedUnread { conversation: id.clone(), value }),
                UnreadEffect::SendReceipt { thread_root, pos } => {
                    if let Some(m) = entry.messages.iter().find(|m| m.pos == pos) {
                        out.effects.push(Effect::SendReceipt { conversation: id.clone(), thread_root, up_to: m.id.clone() });
                    }
                }
            }
        }
    }
}

fn merge_outcome(into: &mut Outcome, out: Outcome) {
    for id in out.changed {
        if !into.changed.contains(&id) {
            into.changed.push(id);
        }
    }
    into.removed.extend(out.removed);
    into.new_messages.extend(out.new_messages);
    into.effects.extend(out.effects);
    into.notifications.extend(out.notifications);
    into.teams_changed |= out.teams_changed;
    into.activity_changed |= out.activity_changed;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn conv_id() -> ConversationId {
        ConversationId { account: AccountId("a".into()), remote: "!room".into() }
    }

    fn upsert() -> AdapterEvent {
        AdapterEvent::ConversationUpserted(Conversation {
            id: conv_id(),
            kind: ConversationKind::Group,
            name: "Room".into(),
            avatar_url: None,
            favourite: false,
            muted: false,
            mentions_only: false,
            dm_user: None,
            invited_by: None,
            team_id: None,
            encrypted: true,
        })
    }

    fn msg(pos: TimelinePos, from_me: bool) -> AdapterEvent {
        AdapterEvent::Message(Message {
            id: MessageId(format!("$e{pos}")),
            conversation: conv_id(),
            pos,
            sender: "@bob:x".into(),
            sender_name: "Bob".into(),
            sent_at: pos * 10,
            body: MessageBody::Text { plain: format!("hello {pos}"), html: None },
            thread_root: None,
            reply_to: None,
            sender_avatar: None,
            mentions_me: false,
            from_me,
        })
    }

    #[test]
    fn messages_before_conversation_are_kept() {
        let mut e = Engine::new();
        e.handle(msg(1, false), 0);
        assert!(e.view(&conv_id()).is_none());
        e.handle(upsert(), 0);
        let v = e.view(&conv_id()).unwrap();
        assert_eq!((v.unread, v.preview.as_str()), (1, "Bob: hello 1"));
    }

    #[test]
    fn focusing_reads_and_sends_receipt() {
        let mut e = Engine::new();
        e.handle(upsert(), 0);
        e.handle(msg(1, false), 0);
        let out = e.focus(Some(conv_id()), 100);
        assert_eq!(out.effects, vec![Effect::SendReceipt { conversation: conv_id(), thread_root: None, up_to: MessageId("$e1".into()) }]);
        assert_eq!(e.view(&conv_id()).unwrap().unread, 0);
    }

    #[test]
    fn messages_in_open_chat_stay_unread_while_window_unfocused() {
        let mut e = Engine::new();
        e.handle(upsert(), 0);
        e.focus(Some(conv_id()), 100);
        e.set_window_focused(false, 110);
        e.handle(msg(1, false), 120);
        assert_eq!(e.view(&conv_id()).unwrap().unread, 1);
        e.set_window_focused(true, 130);
        assert_eq!(e.view(&conv_id()).unwrap().unread, 0);
    }

    #[test]
    fn marked_unread_survives_window_switch_but_not_reopen() {
        let mut e = Engine::new();
        e.handle(upsert(), 0);
        e.handle(msg(1, false), 0);
        e.focus(Some(conv_id()), 100);
        let out = e.mark_unread(&conv_id(), 110);
        assert_eq!(out.effects, vec![Effect::SyncMarkedUnread { conversation: conv_id(), value: true }]);

        e.set_window_focused(false, 120);
        e.set_window_focused(true, 130);
        assert!(e.view(&conv_id()).unwrap().marked);

        e.focus(None, 140);
        e.focus(Some(conv_id()), 150);
        assert!(!e.view(&conv_id()).unwrap().marked);
    }

    #[test]
    fn duplicate_messages_are_ignored() {
        let mut e = Engine::new();
        e.handle(upsert(), 0);
        e.handle(msg(1, false), 0);
        let out = e.handle(msg(1, false), 0);
        assert!(out.new_messages.is_empty());
        assert_eq!(e.view(&conv_id()).unwrap().unread, 1);
    }

    #[test]
    fn history_does_not_count_as_unread() {
        let mut e = Engine::new();
        e.handle(upsert(), 0);
        e.handle(msg(5, false), 0);
        e.add_history(&conv_id(), History { events: vec![msg(1, false)], has_more: true });
        let v = e.view(&conv_id()).unwrap();
        assert_eq!(v.unread, 1);
        assert_eq!(e.messages(&conv_id()).first().unwrap().id, "$e1");
    }

    fn reaction(id: &str, key: &str, sender: &str, from_me: bool) -> AdapterEvent {
        AdapterEvent::Reaction {
            conversation: conv_id(),
            target: MessageId("$e1".into()),
            id: MessageId(id.into()),
            key: key.into(),
            sender: sender.into(),
            sender_name: sender.into(),
            from_me,
            at: 100,
        }
    }

    fn edit(sender: &str, text: &str, at: Timestamp) -> AdapterEvent {
        AdapterEvent::Edited {
            conversation: conv_id(),
            target: MessageId("$e1".into()),
            sender: sender.into(),
            body: MessageBody::Text { plain: text.into(), html: None },
            at,
        }
    }

    #[test]
    fn reactions_group_by_emoji_and_can_be_removed() {
        let mut e = Engine::new();
        e.handle(upsert(), 0);
        e.handle(msg(1, false), 0);
        e.handle(reaction("$r1", "👍", "@ann:x", false), 0);
        e.handle(reaction("$r2", "👍", "@me:x", true), 0);
        e.handle(reaction("$r3", "🎉", "@ann:x", false), 0);
        let r = &e.messages(&conv_id())[0].reactions;
        assert_eq!((r[0].key.as_str(), r[0].count, r[0].mine), ("👍", 2, true));
        assert_eq!(r[1].count, 1);
        assert_eq!(e.own_reaction(&conv_id(), &MessageId("$e1".into()), "👍"), Some(MessageId("$r2".into())));

        e.handle(AdapterEvent::MessageRedacted { conversation: conv_id(), id: MessageId("$r2".into()) }, 0);
        let r = &e.messages(&conv_id())[0].reactions;
        assert_eq!((r[0].count, r[0].mine), (1, false));
    }

    #[test]
    fn edits_only_from_original_sender_even_if_early() {
        let mut e = Engine::new();
        e.handle(upsert(), 0);
        e.handle(edit("@mallory:x", "hacked", 5), 0);
        e.handle(msg(1, false), 0);
        assert_eq!(e.messages(&conv_id())[0].body, "hello 1");

        e.handle(edit("@bob:x", "fixed typo", 6), 0);
        let m = &e.messages(&conv_id())[0];
        assert_eq!((m.body.as_str(), m.edited), ("fixed typo", true));
        // An older edit arriving late does not win.
        e.handle(edit("@bob:x", "stale", 4), 0);
        assert_eq!(e.messages(&conv_id())[0].body, "fixed typo");
    }

    #[test]
    fn deleted_message_keeps_its_place() {
        let mut e = Engine::new();
        e.handle(upsert(), 0);
        e.handle(msg(1, false), 0);
        e.handle(reaction("$r1", "👍", "@ann:x", false), 0);
        e.handle(AdapterEvent::MessageRedacted { conversation: conv_id(), id: MessageId("$e1".into()) }, 0);
        let m = &e.messages(&conv_id())[0];
        assert!(m.deleted && m.body.is_empty() && m.reactions.is_empty());
        assert_eq!(e.view(&conv_id()).unwrap().preview, "Message deleted");
    }

    #[test]
    fn notifies_for_fresh_messages_in_background_chats_only() {
        let mut e = Engine::new();
        e.handle(upsert(), 0);
        // msg(n) is sent at n*10 ms; "now" 30 ms later is fresh.
        assert_eq!(e.handle(msg(1, false), 40).notifications.len(), 1);
        assert!(e.handle(msg(2, true), 50).notifications.is_empty(), "own message");
        assert!(e.handle(msg(3, false), 10_000_000).notifications.is_empty(), "old history");
        e.focus(Some(conv_id()), 100);
        assert!(e.handle(msg(4, false), 60).notifications.is_empty(), "chat is open");
    }

    #[test]
    fn activity_collects_mentions_replies_and_reactions_to_me() {
        let mut e = Engine::new();
        e.handle(upsert(), 0);
        e.handle(msg(1, true), 0); // my message $e1
        let reply = Message {
            id: MessageId("$reply".into()),
            reply_to: Some(MessageId("$e1".into())),
            ..match msg(2, false) { AdapterEvent::Message(m) => m, _ => unreachable!() }
        };
        assert!(e.handle(AdapterEvent::Message(reply), 0).activity_changed);
        assert!(e.handle(reaction("$r1", "👍", "@ann:x", false), 0).activity_changed);
        assert!(!e.handle(reaction("$r2", "👍", "@me:x", true), 0).activity_changed, "own reaction");
        assert!(!e.handle(msg(3, false), 0).activity_changed, "unrelated message");
        let kinds: Vec<_> = e.activity().iter().map(|a| a.kind).collect();
        assert!(kinds.contains(&ActivityKind::Reply) && kinds.contains(&ActivityKind::Reaction));
    }

    #[test]
    fn room_events_are_shown_but_not_unread_or_previewed() {
        let mut e = Engine::new();
        e.handle(upsert(), 0);
        e.handle(msg(1, false), 0);
        e.focus(Some(conv_id()), 15);
        e.focus(None, 16);
        let join = Message {
            id: MessageId("$join".into()),
            body: MessageBody::Event { kind: RoomEventKind::Joined, actor: "Ann".into(), target: None, value: None },
            ..match msg(2, false) { AdapterEvent::Message(m) => m, _ => unreachable!() }
        };
        let out = e.handle(AdapterEvent::Message(join), 30);
        assert!(out.notifications.is_empty());
        let v = e.view(&conv_id()).unwrap();
        assert_eq!((v.unread, v.preview.as_str(), v.last_at), (0, "Bob: hello 1", 10));
        assert!(e.messages(&conv_id())[1].event.is_some());
    }

    #[test]
    fn decrypted_message_replaces_placeholder_without_recounting() {
        let mut e = Engine::new();
        e.handle(upsert(), 0);
        let AdapterEvent::Message(real) = msg(1, false) else { unreachable!() };
        let placeholder = Message { body: MessageBody::Encrypted, ..real.clone() };
        e.handle(AdapterEvent::Message(placeholder), 0);
        assert!(e.messages(&conv_id())[0].encrypted);
        let out = e.handle(AdapterEvent::Message(real), 0);
        assert_eq!(out.new_messages.len(), 1);
        let m = &e.messages(&conv_id())[0];
        assert!(!m.encrypted && m.body == "hello 1");
        assert_eq!(e.view(&conv_id()).unwrap().unread, 1);
    }

    #[test]
    fn search_finds_messages_across_conversations() {
        let mut e = Engine::new();
        e.handle(upsert(), 0);
        e.handle(msg(1, false), 0);
        e.handle(msg(2, false), 0);
        let hits = e.search("HELLO 2", 10);
        assert_eq!(hits.len(), 1);
        assert_eq!((hits[0].message.as_str(), hits[0].snippet.as_str()), ("$e2", "hello 2"));
        assert!(e.search("h", 10).is_empty(), "too short");
    }

    #[test]
    fn conversation_key_round_trips() {
        assert_eq!(ConversationId::from_key(&conv_id().key()), Some(conv_id()));
    }
}
