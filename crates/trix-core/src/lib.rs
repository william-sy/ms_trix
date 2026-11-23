//! Protocol-agnostic core of Trixcomm.
//!
//! The UI only ever talks to the types in this crate. Every chat network
//! (Matrix today, XMPP/IRC later) plugs in by implementing [`ProtocolAdapter`].

pub mod adapter;
pub mod engine;
pub mod model;
pub mod query;
pub mod texts;
pub mod unread;

pub use adapter::{AdapterEvent, AdapterRegistry, Capabilities, ProtocolAdapter};
pub use engine::{ConversationView, Effect, Engine, MessageView, Outcome};
pub use model::*;
pub use query::Query;
pub use texts::Texts;
pub use unread::{UnreadInput, UnreadState, UnreadSummary};
