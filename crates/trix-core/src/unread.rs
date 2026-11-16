//! Client-owned unread state.
//!
//! Element's unread state is unreliable because it mixes server-computed
//! notification counts, threaded receipts and a marked-unread flag that
//! different code paths set and clear. Here a single state machine owns the
//! truth per conversation. Server data is an *input*, never the answer, and
//! the manual flag follows explicit rules:
//!
//! * Marking unread while the conversation is on screen does not get undone
//!   by that same view: the flag only clears after you leave and come back.
//! * A read receipt from another device clears the flag only if it happened
//!   *after* you marked the conversation unread.
//! * A stale synced flag cannot overwrite a local change that the server has
//!   not echoed back yet.

use std::collections::HashMap;

use serde::Serialize;

use crate::model::{MessageId, TimelinePos, Timestamp};

/// Read position and unread messages for one timeline (main or a thread).
#[derive(Debug, Clone, Default)]
struct ReadTracker {
    last_read: Option<TimelinePos>,
    /// Incoming messages after `last_read`, sorted by position: (pos, mentions_me).
    unread: Vec<(TimelinePos, bool)>,
}

impl ReadTracker {
    fn incoming(&mut self, pos: TimelinePos, mentions_me: bool) {
        if self.last_read.is_some_and(|r| pos <= r) {
            return;
        }
        if let Err(i) = self.unread.binary_search_by_key(&pos, |(p, _)| *p) {
            self.unread.insert(i, (pos, mentions_me));
        }
    }

    /// Returns true when the read position moved forward.
    fn read_up_to(&mut self, pos: TimelinePos) -> bool {
        if self.last_read.is_some_and(|r| pos <= r) {
            return false;
        }
        self.last_read = Some(pos);
        self.unread.retain(|(p, _)| *p > pos);
        true
    }

    fn latest_unread(&self) -> Option<TimelinePos> {
        self.unread.last().map(|(p, _)| *p)
    }

    fn counts(&self) -> (usize, usize) {
        (self.unread.len(), self.unread.iter().filter(|(_, m)| *m).count())
    }
}

#[derive(Debug, Clone)]
pub enum UnreadInput {
    /// A message was added to the timeline.
    Incoming { pos: TimelinePos, thread_root: Option<MessageId>, mentions_me: bool, from_me: bool, at: Timestamp },
    /// The user saw messages up to `pos` on this device.
    LocalRead { pos: TimelinePos, thread_root: Option<MessageId>, at: Timestamp },
    /// Our own read receipt, sent by another device.
    RemoteRead { pos: TimelinePos, thread_root: Option<MessageId>, at: Timestamp },
    /// An unthreaded receipt from another device: main timeline and all threads.
    RemoteReadAll { pos: TimelinePos, at: Timestamp },
    /// The conversation became the visible one.
    Focused { at: Timestamp },
    /// The conversation is no longer visible.
    Blurred,
    MarkUnread { at: Timestamp },
    MarkRead { at: Timestamp },
    /// The synced marked-unread flag arrived from the server.
    RemoteMarkedUnread { value: bool },
}

/// Side effects the caller must forward to the protocol adapter.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum UnreadEffect {
    SendReceipt { thread_root: Option<MessageId>, pos: TimelinePos },
    SyncMarkedUnread(bool),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct UnreadSummary {
    pub unread: usize,
    pub mentions: usize,
    pub marked: bool,
}

impl UnreadSummary {
    pub fn is_unread(&self) -> bool {
        self.marked || self.unread > 0
    }
}

#[derive(Debug, Clone)]
pub struct UnreadState {
    main: ReadTracker,
    threads: HashMap<MessageId, ReadTracker>,
    marked: bool,
    marked_at: Timestamp,
    /// False while the view that set the flag is still on screen.
    armed: bool,
    focused: bool,
    /// A flag value we wrote to the server that has not been echoed yet.
    pending_sync: Option<bool>,
}

impl Default for UnreadState {
    fn default() -> Self {
        Self { main: ReadTracker::default(), threads: HashMap::new(), marked: false, marked_at: 0, armed: true, focused: false, pending_sync: None }
    }
}

impl UnreadState {
    pub fn summary(&self) -> UnreadSummary {
        let (mut unread, mut mentions) = self.main.counts();
        for t in self.threads.values() {
            let (u, m) = t.counts();
            unread += u;
            mentions += m;
        }
        UnreadSummary { unread, mentions, marked: self.marked }
    }

    pub fn apply(&mut self, input: UnreadInput) -> Vec<UnreadEffect> {
        let mut fx = Vec::new();
        match input {
            UnreadInput::Incoming { pos, thread_root, mentions_me, from_me, at } => {
                if from_me {
                    // Writing a message means you've read everything before it.
                    self.tracker(&thread_root).read_up_to(pos);
                    if at > self.marked_at {
                        self.set_marked(false, &mut fx);
                    }
                } else {
                    self.tracker(&thread_root).incoming(pos, mentions_me);
                }
            }
            UnreadInput::LocalRead { pos, thread_root, at } => {
                if self.tracker(&thread_root).read_up_to(pos) {
                    fx.push(UnreadEffect::SendReceipt { thread_root, pos });
                }
                if self.armed && at > self.marked_at {
                    self.set_marked(false, &mut fx);
                }
            }
            UnreadInput::RemoteRead { pos, thread_root, at } => {
                // A receipt that doesn't move us forward is usually the echo of one
                // we sent ourselves, so it says nothing about the flag.
                if self.tracker(&thread_root).read_up_to(pos) && at > self.marked_at {
                    self.set_marked(false, &mut fx);
                }
            }
            UnreadInput::RemoteReadAll { pos, at } => {
                let mut advanced = self.main.read_up_to(pos);
                for t in self.threads.values_mut() {
                    advanced |= t.read_up_to(pos);
                }
                if advanced && at > self.marked_at {
                    self.set_marked(false, &mut fx);
                }
            }
            UnreadInput::Focused { at } => {
                self.focused = true;
                if self.armed && at > self.marked_at {
                    self.set_marked(false, &mut fx);
                }
            }
            UnreadInput::Blurred => {
                self.focused = false;
                self.armed = true;
            }
            UnreadInput::MarkUnread { at } => {
                self.marked_at = at;
                self.armed = !self.focused;
                self.set_marked(true, &mut fx);
            }
            UnreadInput::MarkRead { at } => {
                self.marked_at = self.marked_at.max(at);
                self.set_marked(false, &mut fx);
                if let Some(pos) = self.main.latest_unread() {
                    self.main.read_up_to(pos);
                    fx.push(UnreadEffect::SendReceipt { thread_root: None, pos });
                }
                for (root, t) in &mut self.threads {
                    if let Some(pos) = t.latest_unread() {
                        t.read_up_to(pos);
                        fx.push(UnreadEffect::SendReceipt { thread_root: Some(root.clone()), pos });
                    }
                }
            }
            UnreadInput::RemoteMarkedUnread { value } => match self.pending_sync {
                Some(expected) if expected == value => self.pending_sync = None,
                Some(_) => {} // stale value from before our own write
                None => self.marked = value,
            },
        }
        fx
    }

    fn tracker(&mut self, thread_root: &Option<MessageId>) -> &mut ReadTracker {
        match thread_root {
            None => &mut self.main,
            Some(root) => self.threads.entry(root.clone()).or_default(),
        }
    }

    fn set_marked(&mut self, value: bool, fx: &mut Vec<UnreadEffect>) {
        if self.marked != value {
            self.marked = value;
            self.pending_sync = Some(value);
            fx.push(UnreadEffect::SyncMarkedUnread(value));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn incoming(pos: TimelinePos, at: Timestamp) -> UnreadInput {
        UnreadInput::Incoming { pos, thread_root: None, mentions_me: false, from_me: false, at }
    }

    fn local_read(pos: TimelinePos, at: Timestamp) -> UnreadInput {
        UnreadInput::LocalRead { pos, thread_root: None, at }
    }

    #[test]
    fn counts_incoming_and_clears_on_read() {
        let mut s = UnreadState::default();
        s.apply(incoming(1, 10));
        s.apply(UnreadInput::Incoming { pos: 2, thread_root: None, mentions_me: true, from_me: false, at: 11 });
        assert_eq!(s.summary(), UnreadSummary { unread: 2, mentions: 1, marked: false });

        let fx = s.apply(local_read(1, 12));
        assert_eq!(fx, vec![UnreadEffect::SendReceipt { thread_root: None, pos: 1 }]);
        assert_eq!(s.summary().unread, 1);

        s.apply(local_read(2, 13));
        assert!(!s.summary().is_unread());
    }

    #[test]
    fn mark_unread_from_list_clears_when_opened() {
        let mut s = UnreadState::default();
        let fx = s.apply(UnreadInput::MarkUnread { at: 100 });
        assert_eq!(fx, vec![UnreadEffect::SyncMarkedUnread(true)]);
        assert!(s.summary().is_unread());

        let fx = s.apply(UnreadInput::Focused { at: 200 });
        assert_eq!(fx, vec![UnreadEffect::SyncMarkedUnread(false)]);
        assert!(!s.summary().is_unread());
    }

    #[test]
    fn mark_unread_while_viewing_survives_until_reopened() {
        let mut s = UnreadState::default();
        s.apply(UnreadInput::Focused { at: 100 });
        s.apply(UnreadInput::MarkUnread { at: 110 });

        // The open view keeps reading new messages; the flag must stay.
        s.apply(incoming(1, 120));
        s.apply(local_read(1, 121));
        assert!(s.summary().marked);

        s.apply(UnreadInput::Blurred);
        assert!(s.summary().marked);

        s.apply(UnreadInput::Focused { at: 300 });
        assert!(!s.summary().marked);
    }

    #[test]
    fn remote_receipt_older_than_mark_does_not_clear() {
        let mut s = UnreadState::default();
        s.apply(incoming(1, 10));
        s.apply(UnreadInput::MarkUnread { at: 100 });

        s.apply(UnreadInput::RemoteRead { pos: 1, thread_root: None, at: 50 });
        assert!(s.summary().marked);

        s.apply(incoming(2, 140));
        s.apply(UnreadInput::RemoteRead { pos: 2, thread_root: None, at: 150 });
        assert!(!s.summary().marked);
    }

    #[test]
    fn echo_of_own_receipt_does_not_clear_flag() {
        let mut s = UnreadState::default();
        s.apply(UnreadInput::Focused { at: 100 });
        s.apply(UnreadInput::MarkUnread { at: 110 });
        s.apply(incoming(1, 120));
        s.apply(local_read(1, 121));

        // The server echoes the receipt we just sent, with a newer timestamp.
        s.apply(UnreadInput::RemoteRead { pos: 1, thread_root: None, at: 130 });
        assert!(s.summary().marked);
    }

    #[test]
    fn unthreaded_receipt_covers_threads() {
        let mut s = UnreadState::default();
        let root = MessageId("$root".into());
        s.apply(incoming(1, 10));
        s.apply(UnreadInput::Incoming { pos: 2, thread_root: Some(root.clone()), mentions_me: false, from_me: false, at: 11 });
        s.apply(incoming(3, 12));

        // A main-timeline receipt leaves the thread unread...
        s.apply(UnreadInput::RemoteRead { pos: 3, thread_root: None, at: 20 });
        assert_eq!(s.summary().unread, 1);
        // ...an unthreaded one doesn't.
        s.apply(UnreadInput::RemoteReadAll { pos: 3, at: 21 });
        assert!(!s.summary().is_unread());
    }

    #[test]
    fn stale_synced_flag_does_not_overwrite_pending_write() {
        let mut s = UnreadState::default();
        s.apply(UnreadInput::MarkUnread { at: 100 });

        // Sync delivers an old `false` before the server echoes our `true`.
        s.apply(UnreadInput::RemoteMarkedUnread { value: false });
        assert!(s.summary().marked);

        s.apply(UnreadInput::RemoteMarkedUnread { value: true });
        assert!(s.summary().marked);

        // Once echoed, other devices may change it again.
        s.apply(UnreadInput::RemoteMarkedUnread { value: false });
        assert!(!s.summary().marked);
    }

    #[test]
    fn threads_are_tracked_separately() {
        let mut s = UnreadState::default();
        let root = MessageId("$root".into());
        s.apply(incoming(1, 10));
        s.apply(UnreadInput::Incoming { pos: 2, thread_root: Some(root.clone()), mentions_me: true, from_me: false, at: 11 });

        s.apply(local_read(1, 12));
        assert_eq!(s.summary(), UnreadSummary { unread: 1, mentions: 1, marked: false });

        s.apply(UnreadInput::LocalRead { pos: 2, thread_root: Some(root), at: 13 });
        assert!(!s.summary().is_unread());
    }

    #[test]
    fn own_message_reads_everything_before_it() {
        let mut s = UnreadState::default();
        s.apply(incoming(1, 10));
        s.apply(UnreadInput::MarkUnread { at: 20 });
        s.apply(UnreadInput::Incoming { pos: 2, thread_root: None, mentions_me: false, from_me: true, at: 30 });
        assert!(!s.summary().is_unread());
    }

    #[test]
    fn mark_read_sends_receipts_for_main_and_threads() {
        let mut s = UnreadState::default();
        let root = MessageId("$root".into());
        s.apply(incoming(1, 10));
        s.apply(UnreadInput::Incoming { pos: 2, thread_root: Some(root.clone()), mentions_me: false, from_me: false, at: 11 });

        let fx = s.apply(UnreadInput::MarkRead { at: 20 });
        assert!(fx.contains(&UnreadEffect::SendReceipt { thread_root: None, pos: 1 }));
        assert!(fx.contains(&UnreadEffect::SendReceipt { thread_root: Some(root), pos: 2 }));
        assert!(!s.summary().is_unread());
    }
}
