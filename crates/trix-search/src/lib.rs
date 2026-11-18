//! Encrypted local full-text search for ms_trix.
//!
//! Server-side search can't read encrypted rooms, so messages are indexed on
//! this device. The index holds decrypted text, so nothing readable is stored:
//!
//! - message text and metadata are encrypted with the Matrix SDK's store cipher
//!   (XChaCha20-Poly1305), whose key the host keeps in the OS keychain;
//! - words are stored only as keyed hashes of their prefixes (3 to 8 letters,
//!   short words whole), so a lookup finds candidates without the plaintext.
//!   Candidates are decrypted and checked, so hash collisions never show up.
//!
//! What an attacker with the file but without the key learns: how many messages
//! there are, per conversation (hashed), with their timestamps, and how often
//! each (hashed) word prefix occurs.

use std::collections::HashSet;
use std::path::Path;
use std::sync::Mutex;

use matrix_sdk_store_encryption::StoreCipher;
use rusqlite::{params, params_from_iter, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("search index: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("search index encryption: {0}")]
    Crypto(#[from] matrix_sdk_store_encryption::Error),
    /// The key doesn't open this index (e.g. the keychain entry was reset).
    #[error("search index key doesn't match")]
    WrongKey,
}

pub type Result<T> = std::result::Result<T, Error>;

/// One searchable message.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Doc {
    /// Conversation key ("account|room").
    pub conversation: String,
    pub event_id: String,
    pub sender_name: String,
    pub from_me: bool,
    pub body: String,
    pub ts: u64,
    /// The file or picture this message carries, for the Shared tab.
    #[serde(default)]
    pub media: Option<DocMedia>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct DocMedia {
    pub id: String,
    /// "image", "video", "audio", "file" or "sticker".
    pub kind: String,
    pub name: String,
    pub mime: Option<String>,
}

/// What the Shared tab lists; stored as hidden terms next to the words.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// Images, videos and stickers.
    Media,
    /// Other files, including audio.
    Files,
    Links,
}

impl Kind {
    fn term(self) -> &'static str {
        match self {
            Kind::Media => "k:media",
            Kind::Files => "k:files",
            Kind::Links => "k:links",
        }
    }

    fn of(doc: &Doc) -> Vec<Kind> {
        let mut out = vec![];
        match doc.media.as_ref().map(|m| m.kind.as_str()) {
            Some("image" | "video" | "sticker") => out.push(Kind::Media),
            Some(_) => out.push(Kind::Files),
            None => {}
        }
        if !links(&doc.body).is_empty() {
            out.push(Kind::Links);
        }
        out
    }
}

/// Web links in a message body (also inside markdown links).
pub fn links(text: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for token in text.split_whitespace() {
        let Some(at) = token.find("https://").or_else(|| token.find("http://")) else { continue };
        let url = token[at..].trim_end_matches(|c: char| matches!(c, ')' | ']' | '>' | '.' | ',' | ';' | ':' | '!' | '?' | '"' | '\''));
        if url.len() > "https://".len() && !out.iter().any(|u| u == url) {
            out.push(url.to_owned());
        }
    }
    out
}

/// How far the history crawler got in one conversation.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
pub struct CrawlState {
    /// Where to continue paging backwards; None = start from the newest message.
    pub token: Option<String>,
    /// Reached the start of the conversation.
    pub done: bool,
    /// Crawls from an older version (that stored less) are redone.
    #[serde(default)]
    pub version: u32,
    /// Messages that couldn't be decrypted yet, retried later (capped).
    #[serde(default)]
    pub undecrypted: Vec<String>,
}

/// Bump when docs gain information that old crawls didn't store.
pub const CRAWL_VERSION: u32 = 2;

const MAX_PREFIX: usize = 8;

pub struct SearchIndex {
    db: Mutex<Connection>,
    cipher: StoreCipher,
}

impl SearchIndex {
    /// Opens (or creates) the index at `path`. `key` must be 32 random bytes.
    pub fn open(path: &Path, key: &[u8]) -> Result<Self> {
        let db = Connection::open(path)?;
        db.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v BLOB NOT NULL);
             CREATE TABLE IF NOT EXISTS docs (
                 id INTEGER PRIMARY KEY,
                 uid INTEGER NOT NULL UNIQUE,
                 conv INTEGER NOT NULL,
                 account INTEGER NOT NULL,
                 ts INTEGER NOT NULL,
                 data BLOB NOT NULL
             );
             CREATE INDEX IF NOT EXISTS docs_conv ON docs (conv, ts);
             CREATE INDEX IF NOT EXISTS docs_account ON docs (account);
             CREATE TABLE IF NOT EXISTS terms (term INTEGER NOT NULL, doc INTEGER NOT NULL, PRIMARY KEY (term, doc)) WITHOUT ROWID;
             CREATE TABLE IF NOT EXISTS crawl (conv INTEGER PRIMARY KEY, data BLOB NOT NULL);",
        )?;
        let stored: Option<Vec<u8>> = db.query_row("SELECT v FROM meta WHERE k = 'cipher'", [], |r| r.get(0)).optional()?;
        let cipher = match stored {
            Some(blob) => StoreCipher::import_with_key(key, &blob).map_err(|_| Error::WrongKey)?,
            None => {
                let cipher = StoreCipher::new()?;
                db.execute("INSERT INTO meta (k, v) VALUES ('cipher', ?1)", params![cipher.export_with_key(key)?])?;
                cipher
            }
        };
        Ok(Self { db: Mutex::new(db), cipher })
    }

    fn hash(&self, table: &str, value: &str) -> i64 {
        let h = self.cipher.hash_key(table, value.as_bytes());
        i64::from_le_bytes(h[..8].try_into().expect("8 bytes"))
    }

    fn term_hashes(&self, doc: &Doc) -> HashSet<i64> {
        let mut terms = index_terms(&doc.body);
        terms.extend(Kind::of(doc).into_iter().map(|k| k.term().to_owned()));
        terms.iter().map(|t| self.hash("term", t)).collect()
    }

    /// Adds messages, or updates them when they're already indexed (edits).
    pub fn add(&self, docs: &[Doc]) -> Result<()> {
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        for doc in docs {
            let uid = self.hash("uid", &format!("{}|{}", doc.conversation, doc.event_id));
            let existing: Option<(i64, Vec<u8>)> = tx.query_row("SELECT id, data FROM docs WHERE uid = ?1", params![uid], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
            let data = self.cipher.encrypt_value(doc)?;
            let id = match existing {
                Some((id, old)) => {
                    if let Ok(old) = self.cipher.decrypt_value::<Doc>(&old) {
                        if old == *doc {
                            continue;
                        }
                        for term in self.term_hashes(&old) {
                            tx.execute("DELETE FROM terms WHERE term = ?1 AND doc = ?2", params![term, id])?;
                        }
                    }
                    tx.execute("UPDATE docs SET ts = ?1, data = ?2 WHERE id = ?3", params![doc.ts as i64, data, id])?;
                    id
                }
                None => {
                    let conv = self.hash("conv", &doc.conversation);
                    let account = self.hash("account", account_of(&doc.conversation));
                    tx.execute("INSERT INTO docs (uid, conv, account, ts, data) VALUES (?1, ?2, ?3, ?4, ?5)", params![uid, conv, account, doc.ts as i64, data])?;
                    tx.last_insert_rowid()
                }
            };
            let mut insert = tx.prepare_cached("INSERT OR IGNORE INTO terms (term, doc) VALUES (?1, ?2)")?;
            for term in self.term_hashes(&doc) {
                insert.execute(params![term, id])?;
            }
        }
        tx.commit()?;
        Ok(())
    }

    /// Changes the text of an indexed message (an edit seen without the full message).
    pub fn edit(&self, conversation: &str, event_id: &str, body: &str) -> Result<()> {
        let uid = self.hash("uid", &format!("{conversation}|{event_id}"));
        let old: Option<Vec<u8>> = self.db.lock().unwrap().query_row("SELECT data FROM docs WHERE uid = ?1", params![uid], |r| r.get(0)).optional()?;
        let Some(old) = old else { return Ok(()) };
        let mut doc: Doc = self.cipher.decrypt_value(&old)?;
        doc.body = body.to_owned();
        self.add(&[doc])
    }

    pub fn remove(&self, conversation: &str, event_id: &str) -> Result<()> {
        let uid = self.hash("uid", &format!("{conversation}|{event_id}"));
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        let row: Option<(i64, Vec<u8>)> = tx.query_row("SELECT id, data FROM docs WHERE uid = ?1", params![uid], |r| Ok((r.get(0)?, r.get(1)?))).optional()?;
        if let Some((id, data)) = row {
            if let Ok(doc) = self.cipher.decrypt_value::<Doc>(&data) {
                for term in self.term_hashes(&doc) {
                    tx.execute("DELETE FROM terms WHERE term = ?1 AND doc = ?2", params![term, id])?;
                }
            }
            tx.execute("DELETE FROM docs WHERE id = ?1", params![id])?;
        }
        tx.commit()?;
        Ok(())
    }

    /// Drops everything of a signed-out account.
    pub fn remove_account(&self, account: &str) -> Result<()> {
        let account = self.hash("account", account);
        let mut db = self.db.lock().unwrap();
        let tx = db.transaction()?;
        tx.execute("DELETE FROM terms WHERE doc IN (SELECT id FROM docs WHERE account = ?1)", params![account])?;
        tx.execute("DELETE FROM docs WHERE account = ?1", params![account])?;
        tx.commit()?;
        Ok(())
    }

    /// Newest first. Every word of `query` must start a word in the message
    /// (words of one or two letters must match whole).
    pub fn search(&self, query: &str, conversation: Option<&str>, limit: usize) -> Result<Vec<Doc>> {
        let terms: Vec<String> = words(query).collect::<HashSet<_>>().into_iter().collect();
        if terms.is_empty() || limit == 0 {
            return Ok(vec![]);
        }
        let mut values: Vec<i64> = terms.iter().map(|t| self.hash("term", &query_term(t))).collect();
        let mut sql = format!(
            "SELECT data FROM docs WHERE id IN ({})",
            (1..=values.len()).map(|i| format!("SELECT doc FROM terms WHERE term = ?{i}")).collect::<Vec<_>>().join(" INTERSECT ")
        );
        if let Some(conversation) = conversation {
            values.push(self.hash("conv", conversation));
            sql.push_str(&format!(" AND conv = ?{}", values.len()));
        }
        // Over-fetch a little: candidates that only share a long prefix are dropped below.
        sql.push_str(&format!(" ORDER BY ts DESC LIMIT {}", limit * 3));
        let db = self.db.lock().unwrap();
        let mut stmt = db.prepare(&sql)?;
        let rows = stmt.query_map(params_from_iter(values), |r| r.get::<_, Vec<u8>>(0))?;
        let mut out = vec![];
        for row in rows {
            let Ok(doc) = self.cipher.decrypt_value::<Doc>(&row?) else { continue };
            let body_words: Vec<String> = words(&doc.body).collect();
            if terms.iter().all(|t| body_words.iter().any(|w| term_matches(w, t))) {
                out.push(doc);
                if out.len() == limit {
                    break;
                }
            }
        }
        Ok(out)
    }

    /// Messages with media, files or links in one conversation, newest first,
    /// older than `before` (a timestamp) when paging.
    pub fn list(&self, conversation: &str, kind: Kind, before: Option<u64>, limit: usize) -> Result<Vec<Doc>> {
        let term = self.hash("term", kind.term());
        let conv = self.hash("conv", conversation);
        let db = self.db.lock().unwrap();
        let mut stmt = db.prepare(
            "SELECT data FROM docs WHERE conv = ?1 AND ts < ?2 AND id IN (SELECT doc FROM terms WHERE term = ?3) ORDER BY ts DESC LIMIT ?4",
        )?;
        let before = before.map(|b| b as i64).unwrap_or(i64::MAX);
        let rows = stmt.query_map(params![conv, before, term, limit as i64], |r| r.get::<_, Vec<u8>>(0))?;
        Ok(rows.filter_map(|r| r.ok()).filter_map(|d| self.cipher.decrypt_value::<Doc>(&d).ok()).collect())
    }

    pub fn crawl_state(&self, conversation: &str) -> Result<CrawlState> {
        let conv = self.hash("conv", conversation);
        let data: Option<Vec<u8>> = self.db.lock().unwrap().query_row("SELECT data FROM crawl WHERE conv = ?1", params![conv], |r| r.get(0)).optional()?;
        Ok(match data {
            Some(d) => self.cipher.decrypt_value(&d)?,
            None => CrawlState::default(),
        })
    }

    pub fn set_crawl_state(&self, conversation: &str, state: &CrawlState) -> Result<()> {
        let conv = self.hash("conv", conversation);
        let data = self.cipher.encrypt_value(state)?;
        self.db.lock().unwrap().execute("INSERT OR REPLACE INTO crawl (conv, data) VALUES (?1, ?2)", params![conv, data])?;
        Ok(())
    }

    /// Encrypts anything with the index's key (e.g. the chat list cache), so it's
    /// as safe on disk as the index itself.
    pub fn seal<T: Serialize>(&self, value: &T) -> Result<Vec<u8>> {
        Ok(self.cipher.encrypt_value(value)?)
    }

    pub fn unseal<T: serde::de::DeserializeOwned>(&self, data: &[u8]) -> Result<T> {
        Ok(self.cipher.decrypt_value(data)?)
    }

    /// Number of indexed messages.
    pub fn len(&self) -> Result<u64> {
        Ok(self.db.lock().unwrap().query_row("SELECT COUNT(*) FROM docs", [], |r| r.get::<_, i64>(0))? as u64)
    }

    pub fn is_empty(&self) -> Result<bool> {
        Ok(self.len()? == 0)
    }
}

fn account_of(conversation: &str) -> &str {
    conversation.split('|').next().unwrap_or(conversation)
}

fn words(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !c.is_alphanumeric()).filter(|w| !w.is_empty()).map(str::to_lowercase)
}

/// The terms a message is findable by: prefixes of 3..=8 letters, short words whole.
fn index_terms(text: &str) -> HashSet<String> {
    let mut out = HashSet::new();
    for w in words(text) {
        let chars: Vec<char> = w.chars().collect();
        if chars.len() <= 2 {
            out.insert(format!("w:{w}"));
        } else {
            for k in 3..=chars.len().min(MAX_PREFIX) {
                out.insert(format!("p:{}", chars[..k].iter().collect::<String>()));
            }
        }
    }
    out
}

fn query_term(term: &str) -> String {
    let chars: Vec<char> = term.chars().collect();
    if chars.len() <= 2 {
        format!("w:{term}")
    } else {
        format!("p:{}", chars[..chars.len().min(MAX_PREFIX)].iter().collect::<String>())
    }
}

fn term_matches(word: &str, term: &str) -> bool {
    if term.chars().count() <= 2 { word == term } else { word.starts_with(term) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc(conv: &str, id: &str, body: &str, ts: u64) -> Doc {
        Doc { conversation: conv.into(), event_id: id.into(), sender_name: "Ann".into(), from_me: false, body: body.into(), ts, media: None }
    }

    #[test]
    fn lists_media_files_and_links() {
        let dir = tempfile::tempdir().unwrap();
        let index = open(&dir);
        let media = |kind: &str| Some(DocMedia { id: "mxc://x/1".into(), kind: kind.into(), name: "a.png".into(), mime: None });
        index.add(&[
            Doc { media: media("image"), ..doc("a|!r", "$1", "a.png", 1) },
            Doc { media: media("file"), ..doc("a|!r", "$2", "report.pdf", 2) },
            doc("a|!r", "$3", "see [docs](https://example.org/x).", 3),
            doc("a|!r", "$4", "plain text", 4),
        ])
        .unwrap();
        let ids = |kind| index.list("a|!r", kind, None, 10).unwrap().into_iter().map(|d| d.event_id).collect::<Vec<_>>();
        assert_eq!(ids(Kind::Media), ["$1"]);
        assert_eq!(ids(Kind::Files), ["$2"]);
        assert_eq!(ids(Kind::Links), ["$3"]);
        assert_eq!(links("see [docs](https://example.org/x)."), ["https://example.org/x"]);
        assert!(index.list("a|!r", Kind::Media, Some(1), 10).unwrap().is_empty(), "paging with before");
    }

    fn open(dir: &tempfile::TempDir) -> SearchIndex {
        SearchIndex::open(&dir.path().join("search.sqlite"), &[7u8; 32]).unwrap()
    }

    #[test]
    fn finds_by_word_prefix_newest_first() {
        let dir = tempfile::tempdir().unwrap();
        let index = open(&dir);
        index.add(&[doc("a|!r", "$1", "Sturen die wel logs naar OpenSearch?", 1), doc("a|!r", "$2", "opensearch cluster is down", 2), doc("a|!x", "$3", "lunch?", 3)]).unwrap();
        let hits = index.search("opens", None, 10).unwrap();
        assert_eq!(hits.iter().map(|d| d.event_id.as_str()).collect::<Vec<_>>(), ["$2", "$1"]);
        assert_eq!(index.search("logs opensearch", None, 10).unwrap().len(), 1, "all words must match");
        assert!(index.search("pensearch", None, 10).unwrap().is_empty(), "prefixes only, not infixes");
        assert_eq!(index.search("opensearchcluster", None, 10).unwrap().len(), 0, "long prefix shared, word differs");
        assert_eq!(index.search("lunch", Some("a|!r"), 10).unwrap().len(), 0, "conversation filter");
    }

    #[test]
    fn short_words_match_whole() {
        let dir = tempfile::tempdir().unwrap();
        let index = open(&dir);
        index.add(&[doc("a|!r", "$1", "ok top", 1), doc("a|!r", "$2", "okay", 2)]).unwrap();
        assert_eq!(index.search("ok", None, 10).unwrap().len(), 1);
    }

    #[test]
    fn edits_removals_and_accounts() {
        let dir = tempfile::tempdir().unwrap();
        let index = open(&dir);
        index.add(&[doc("a|!r", "$1", "hello world", 1), doc("b|!r", "$2", "hello there", 2)]).unwrap();
        index.edit("a|!r", "$1", "goodbye world").unwrap();
        assert_eq!(index.search("hello", None, 10).unwrap().len(), 1);
        assert_eq!(index.search("goodbye", None, 10).unwrap()[0].event_id, "$1");
        index.remove("a|!r", "$1").unwrap();
        assert!(index.search("world", None, 10).unwrap().is_empty());
        index.remove_account("b").unwrap();
        assert!(index.is_empty().unwrap());
    }

    #[test]
    fn crawl_state_and_reopen() {
        let dir = tempfile::tempdir().unwrap();
        {
            let index = open(&dir);
            index.add(&[doc("a|!r", "$1", "persisted", 1)]).unwrap();
            index.set_crawl_state("a|!r", &CrawlState { token: Some("t1".into()), done: false, version: CRAWL_VERSION, undecrypted: vec![] }).unwrap();
        }
        let index = open(&dir);
        assert_eq!(index.search("persist", None, 10).unwrap().len(), 1);
        assert_eq!(index.crawl_state("a|!r").unwrap().token.as_deref(), Some("t1"));
        assert!(matches!(SearchIndex::open(&dir.path().join("search.sqlite"), &[8u8; 32]), Err(Error::WrongKey)));
    }

    #[test]
    fn nothing_readable_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let index = open(&dir);
        index.add(&[doc("a|!secretroom", "$1", "supersecretword", 1)]).unwrap();
        drop(index);
        let mut raw = std::fs::read(dir.path().join("search.sqlite")).unwrap();
        raw.extend(std::fs::read(dir.path().join("search.sqlite-wal")).unwrap_or_default());
        let text = String::from_utf8_lossy(&raw);
        assert!(!text.contains("supersecret") && !text.contains("secretroom") && !text.contains("Ann"));
    }
}
