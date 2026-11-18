//! A spelling correction for the word being typed, so the composer can offer it and Tab takes
//! it (macOS: the system spell checker, the one that underlines the word too). The web view's
//! own suggestions can't be accepted with Tab, hence this.

/// The correction for the last word of `text` (what's before the cursor), if it's misspelled.
/// A plain command, so it runs on the main thread, where AppKit wants it.
#[tauri::command]
pub fn spell_suggestion(text: String) -> Option<String> {
    #[cfg(target_os = "macos")]
    return mac::suggestion(&text);
    #[cfg(not(target_os = "macos"))]
    {
        let _ = text;
        None
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use objc2_app_kit::NSSpellChecker;
    use objc2_foundation::{NSRange, NSString, NSTextCheckingType};

    pub fn suggestion(text: &str) -> Option<String> {
        // The word just typed: letters (and apostrophes) at the very end.
        let word_start = text.char_indices().rev().take_while(|(_, c)| c.is_alphabetic() || *c == '\'').last().map(|(i, _)| i)?;
        let word = &text[word_start..];
        if word.chars().count() < 3 {
            return None;
        }
        let string = NSString::from_str(text);
        let range = NSRange::new(text[..word_start].encode_utf16().count(), word.encode_utf16().count());
        let checker = NSSpellChecker::sharedSpellChecker();
        // The check text fields do themselves: is the word misspelled, and in which language is
        // the text (from your spelling languages)?
        let mut orthography = None;
        let whole = NSRange::new(0, string.length());
        let results = unsafe {
            checker.checkString_range_types_options_inSpellDocumentWithTag_orthography_wordCount(&string, whole, NSTextCheckingType::Spelling.0, None, 0, Some(&mut orthography), std::ptr::null_mut())
        };
        let misspelled = results.iter().any(|r| r.range().location == range.location && r.range().length == range.length);
        if !misspelled {
            return None;
        }
        // The text's language if it's clear; otherwise (a few words) each of your spelling
        // languages, taking the guess closest to what was typed ("fuotje" → Dutch "foutje").
        let detected = orthography.map(|o| o.dominantLanguage()).filter(|l| l.to_string() != "und");
        let languages: Vec<_> = match detected {
            Some(language) => vec![language],
            None => checker.userPreferredLanguages().iter().take(4).collect(),
        };
        let typed = word.to_lowercase();
        languages
            .iter()
            .filter_map(|language| checker.guessesForWordRange_inString_language_inSpellDocumentWithTag(range, &string, Some(language), 0)?.firstObject())
            .map(|guess| guess.to_string())
            .filter(|guess| guess != word)
            .min_by_key(|guess| distance(&typed, &guess.to_lowercase()))
    }

    /// Edits between two words, counting a swap of neighbouring letters as one (typos).
    fn distance(a: &str, b: &str) -> usize {
        let (a, b): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
        let mut d = vec![vec![0usize; b.len() + 1]; a.len() + 1];
        for (i, row) in d.iter_mut().enumerate() {
            row[0] = i;
        }
        for j in 0..=b.len() {
            d[0][j] = j;
        }
        for i in 1..=a.len() {
            for j in 1..=b.len() {
                let cost = usize::from(a[i - 1] != b[j - 1]);
                d[i][j] = (d[i - 1][j] + 1).min(d[i][j - 1] + 1).min(d[i - 1][j - 1] + cost);
                if i > 1 && j > 1 && a[i - 1] == b[j - 2] && a[i - 2] == b[j - 1] {
                    d[i][j] = d[i][j].min(d[i - 2][j - 2] + 1);
                }
            }
        }
        d[a.len()][b.len()]
    }

    #[cfg(test)]
    #[test]
    fn swapped_letters_count_once() {
        assert_eq!(distance("fuotje", "foutje"), 1);
        assert_eq!(distance("fuotje", "footage"), 3);
    }
}
