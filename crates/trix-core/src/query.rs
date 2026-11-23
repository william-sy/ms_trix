//! A search box query, the same for the search index and the messages in memory: plain words
//! (each must start a word in the message; one or two letters must be the whole word), "exact
//! phrases", wildcards within a word (*part*, part*, *ing) and #hashtags; optionally matching
//! case. Everything in the query has to match.

use crate::model::hashtags;

#[derive(Debug, Clone, Default, PartialEq)]
pub struct Query {
    pub words: Vec<String>,
    pub phrases: Vec<String>,
    /// Patterns with `*`, each matched against one word.
    pub globs: Vec<String>,
    pub tags: Vec<String>,
    pub match_case: bool,
}

/// The words of a text: runs of letters and digits.
fn split_words(text: &str) -> impl Iterator<Item = (usize, &str)> {
    let mut start = None;
    let mut out = vec![];
    for (i, c) in text.char_indices() {
        match (c.is_alphanumeric(), start) {
            (true, None) => start = Some(i),
            (false, Some(s)) => {
                out.push((s, &text[s..i]));
                start = None;
            }
            _ => {}
        }
    }
    if let Some(s) = start {
        out.push((s, &text[s..]));
    }
    out.into_iter()
}

/// `*` matches any run of characters (within the word); everything else must be there as is.
fn glob_match(word: &str, pattern: &str) -> bool {
    let parts: Vec<&str> = pattern.split('*').collect();
    let (first, last) = (parts[0], parts[parts.len() - 1]);
    if parts.len() == 1 {
        return word == pattern;
    }
    if !word.starts_with(first) || word.len() < first.len() + last.len() || !word.ends_with(last) {
        return false;
    }
    let mut rest = &word[first.len()..word.len() - last.len()];
    for part in &parts[1..parts.len() - 1] {
        match rest.find(part) {
            Some(at) => rest = &rest[at + part.len()..],
            None => return false,
        }
    }
    true
}

impl Query {
    pub fn parse(input: &str, match_case: bool) -> Self {
        let case = |s: &str| if match_case { s.to_owned() } else { s.to_lowercase() };
        let mut q = Query { tags: hashtags(input), match_case, ..Default::default() };
        // "Quoted" parts are phrases (curly quotes too); the rest is words and wildcards.
        let normalized = input.replace(['“', '”', '„'], "\"");
        for (i, part) in normalized.split('"').enumerate() {
            if i % 2 == 1 {
                let phrase = part.split_whitespace().collect::<Vec<_>>().join(" ");
                if !phrase.is_empty() {
                    q.phrases.push(case(&phrase));
                }
                continue;
            }
            for token in part.split_whitespace() {
                if token.contains('*') {
                    let pattern: String = token.chars().filter(|c| c.is_alphanumeric() || *c == '*').collect();
                    if pattern.chars().any(char::is_alphanumeric) {
                        q.globs.push(case(&pattern));
                    }
                } else {
                    q.words.extend(split_words(token).map(|(_, w)| case(w)));
                }
            }
        }
        q
    }

    /// Too little to search for.
    pub fn is_empty(&self) -> bool {
        let size = self.words.iter().chain(&self.phrases).chain(&self.globs).map(|s| s.chars().filter(|c| *c != '*').count()).sum::<usize>();
        size < 2 && self.tags.is_empty()
    }

    fn norm(&self, text: &str) -> String {
        if self.match_case { text.to_owned() } else { text.to_lowercase() }
    }

    fn word_hit(&self, word: &str) -> bool {
        self.words.iter().any(|w| if w.chars().count() <= 2 { word == w } else { word.starts_with(w.as_str()) })
    }

    pub fn matches(&self, text: &str) -> bool {
        let norm = self.norm(text);
        let words: Vec<&str> = split_words(&norm).map(|(_, w)| w).collect();
        self.phrases.iter().all(|p| norm.contains(p.as_str()))
            && self.globs.iter().all(|g| words.iter().any(|w| glob_match(w, g)))
            && self.words.iter().all(|t| words.iter().any(|w| if t.chars().count() <= 2 { w == t } else { w.starts_with(t.as_str()) }))
            && (self.tags.is_empty() || {
                let found = hashtags(text);
                self.tags.iter().all(|t| found.contains(t))
            })
    }

    /// Where the first match is in `text` (byte offset and length), for a snippet around it.
    pub fn first_match(&self, text: &str) -> Option<(usize, usize)> {
        let norm = self.norm(text);
        // Offsets in the normalized text are only valid in `text` when lowercasing kept the length.
        let same = norm.len() == text.len();
        let phrase = self.phrases.iter().filter_map(|p| norm.find(p.as_str()).map(|at| (at, p.len()))).filter(|_| same).min();
        let word = split_words(text).find(|(_, w)| {
            let w = self.norm(w);
            self.word_hit(&w) || self.globs.iter().any(|g| glob_match(&w, g)) || self.tags.contains(&w.to_lowercase())
        });
        match (phrase, word.map(|(at, w)| (at, w.len()))) {
            (Some(p), Some(w)) => Some(p.min(w)),
            (p, w) => p.or(w),
        }
    }

    /// Words the search index can look up (each must start a word in a hit); none means a search
    /// that can only be done by reading the messages (wildcards at the start of a word).
    pub fn index_words(&self) -> Vec<String> {
        let mut out: Vec<String> = self.words.iter().map(|w| w.to_lowercase()).collect();
        for phrase in &self.phrases {
            out.extend(split_words(phrase).map(|(_, w)| w.to_lowercase()));
        }
        for glob in &self.globs {
            let literal = glob.split('*').next().unwrap_or_default();
            if literal.chars().count() >= 3 {
                out.push(literal.to_lowercase());
            }
        }
        out.extend(self.tags.iter().cloned());
        out.sort();
        out.dedup();
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_phrases_wildcards_and_case() {
        let text = "Deploying the ACME cluster tomorrow, see #planning";
        let q = |s: &str, case: bool| Query::parse(s, case);
        assert!(q("deploy acme", false).matches(text), "words start words");
        assert!(!q("ploy", false).matches(text), "not inside words without a wildcard");
        assert!(q("*ploy*", false).matches(text) && q("*ing", false).matches(text) && q("clus*", false).matches(text));
        assert!(q("\"acme cluster\"", false).matches(text) && !q("\"cluster acme\"", false).matches(text), "phrases keep their order");
        assert!(q("ACME", true).matches(text) && !q("Acme", true).matches(text), "match case");
        assert!(q("#planning", false).matches(text) && !q("#plan", false).matches(text));
        assert!(q("x", false).is_empty() && !q("*ab", false).is_empty());
        assert_eq!(q("*ploy* \"the acme\"", false).index_words(), vec!["acme", "the"], "a leading wildcard can't use the index");
        assert_eq!(q("cluster", false).first_match(text), Some((19, 7)));
    }

    #[test]
    fn globs() {
        assert!(glob_match("likethis", "*like*") && glob_match("unlikely", "*like*") && glob_match("report", "rep*t"));
        assert!(!glob_match("rapport", "rep*") && !glob_match("ab", "a*b*c"));
    }
}
