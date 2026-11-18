//! Texts the core and adapters produce for people: chat previews, system
//! notifications, command results. English is built in; the UI sends the
//! translations for its language (its "rust.*" locale keys) with [`Texts::set`].
//! Templates use `{name}` placeholders, like the UI's.

use std::collections::HashMap;

/// Built-in English, also the fallback for keys a translation lacks.
const ENGLISH: &[(&str, &str)] = &[
    ("preview.deleted", "Message deleted"),
    ("preview.you", "You: {text}"),
    ("notify.inRoom", "{sender} in {room}"),
    ("notify.image", "sent an image"),
    ("notify.file", "sent {name}"),
    ("notify.invited", "{by} invited you"),
    ("notify.call", "📞 Call started"),
    ("notify.verifyTitle", "Verification request"),
    ("notify.verifyBody", "{user} wants to verify by emoji"),
    ("cmd.joined", "Joined {room}"),
    ("cmd.left", "You left the room"),
    ("cmd.invited", "Invited {user}"),
    ("cmd.topic", "Topic: {topic}"),
    ("cmd.noTopic", "This room has no topic"),
    ("cmd.topicSet", "Topic updated"),
    ("cmd.roomNameSet", "Room name updated"),
    ("cmd.nickSet", "Your display name is now {name}"),
    ("cmd.chatWith", "Chat with {user}"),
    ("cmd.banned", "Banned {user}"),
    ("cmd.unbanned", "Unbanned {user}"),
    ("cmd.removed", "Removed {user}"),
    ("cmd.powerLevel", "{user} now has power level {level}"),
    ("cmd.ignored", "Ignoring {user}"),
    ("cmd.unignored", "No longer ignoring {user}"),
    ("cmd.roomNickReset", "Your name in this room is reset"),
    ("cmd.roomNickSet", "Your name in this room is now {name}"),
    ("cmd.convertedToDm", "This is now a direct chat"),
    ("cmd.convertedToRoom", "This is now a room instead of a direct chat"),
    ("cmd.upgraded", "Upgraded to room version {version}; continue in the new room"),
    ("cmd.discarded", "The next message starts a new encryption session"),
    ("cmd.verified", "Verified {user}'s session {device}"),
];

#[derive(Debug, Clone, Default)]
pub struct Texts {
    translated: HashMap<String, String>,
}

impl Texts {
    /// Replaces the translations (keys without the "rust." prefix).
    pub fn set(&mut self, translated: HashMap<String, String>) {
        self.translated = translated;
    }

    pub fn get(&self, key: &str, vars: &[(&str, &str)]) -> String {
        let template = self.translated.get(key).map(String::as_str).unwrap_or_else(|| english(key));
        fill(template, vars)
    }
}

/// English text for `key` (the key itself when unknown, so mistakes are visible).
pub fn english(key: &str) -> &str {
    ENGLISH.iter().find(|(k, _)| *k == key).map(|(_, v)| *v).unwrap_or(key)
}

pub fn fill(template: &str, vars: &[(&str, &str)]) -> String {
    let mut out = template.to_owned();
    for (name, value) in vars {
        out = out.replace(&format!("{{{name}}}"), value);
    }
    out
}

/// Every built-in key, so a test can check the UI locales cover them.
pub fn keys() -> impl Iterator<Item = &'static str> {
    ENGLISH.iter().map(|(k, _)| *k)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn falls_back_to_english_and_fills() {
        let mut t = Texts::default();
        assert_eq!(t.get("preview.you", &[("text", "hi")]), "You: hi");
        t.set(HashMap::from([("preview.you".to_owned(), "Jij: {text}".to_owned())]));
        assert_eq!(t.get("preview.you", &[("text", "hoi")]), "Jij: hoi");
        assert_eq!(t.get("preview.deleted", &[]), "Message deleted");
    }

    /// The UI's English locale must have a "rust.<key>" entry with the same text for every key.
    #[test]
    fn ui_locale_matches() {
        let en: HashMap<String, String> = serde_json::from_str(include_str!("../../../apps/desktop/src/locales/en.json")).unwrap();
        for (key, text) in ENGLISH {
            assert_eq!(en.get(&format!("rust.{key}")).map(String::as_str), Some(*text), "rust.{key} in en.json");
        }
    }
}
