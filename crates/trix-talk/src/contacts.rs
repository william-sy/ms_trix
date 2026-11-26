//! Nextcloud Contacts (CardDAV): the cards in your address books, for the Contacts view. Only what
//! the view shows is read: names, work, addresses, numbers, a Nextcloud cloud id, a Matrix id.

use trix_core::{Contact, Phone};

pub const PROPFIND_ADDRESSBOOKS: &str = r#"<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:"><d:prop><d:displayname/><d:resourcetype/></d:prop></d:propfind>"#;

/// Every card of an address book, with only the parts of its vCard the view uses (no pictures:
/// the server's own address book can have hundreds of people). A server that sends whole cards
/// anyway works too.
pub const ADDRESSBOOK_QUERY: &str = r#"<?xml version="1.0"?>
<card:addressbook-query xmlns:d="DAV:" xmlns:card="urn:ietf:params:xml:ns:carddav"><d:prop><card:address-data>
<card:prop name="VERSION"/><card:prop name="UID"/><card:prop name="FN"/><card:prop name="N"/><card:prop name="ORG"/><card:prop name="TITLE"/><card:prop name="EMAIL"/><card:prop name="TEL"/><card:prop name="CLOUD"/><card:prop name="IMPP"/><card:prop name="X-MATRIX"/><card:prop name="NOTE"/><card:prop name="KIND"/><card:prop name="X-ADDRESSBOOKSERVER-KIND"/>
</card:address-data></d:prop></card:addressbook-query>"#;

/// A card as a contact (`id`: its address, `book`: its address book's name); None for a group card.
/// A cloud id on `server` gives the Nextcloud account it belongs to.
pub fn parse(vcard: &str, id: &str, book: &str, server: &str) -> Option<Contact> {
    let unfolded = vcard.replace("\r\n", "\n").replace("\n ", "").replace("\n\t", "");
    let mut c = Contact { id: id.to_owned(), book: book.to_owned(), name: String::new(), org: None, title: None, emails: vec![], phones: vec![], user: None, matrix: None, note: None };
    let mut structured = String::new();
    for line in unfolded.lines() {
        let Some((head, value)) = split(line) else { continue };
        let mut params = head.split(';');
        // "item1.EMAIL" (Apple's grouping) is an EMAIL.
        let name = params.next().unwrap_or_default().rsplit('.').next().unwrap_or_default().to_ascii_uppercase();
        let params: Vec<String> = params.map(|p| p.to_ascii_lowercase()).collect();
        let value = value.trim();
        match name.as_str() {
            "KIND" | "X-ADDRESSBOOKSERVER-KIND" if value.eq_ignore_ascii_case("group") => return None,
            "FN" => c.name = unescape(value),
            // Family;Given;…: "Given Family".
            "N" => {
                let mut parts: Vec<String> = value.split(';').take(2).map(unescape).filter(|s| !s.is_empty()).collect();
                parts.reverse();
                structured = parts.join(" ");
            }
            "ORG" => c.org = Some(value.split(';').map(unescape).filter(|s| !s.is_empty()).collect::<Vec<_>>().join(", ")).filter(|s| !s.is_empty()),
            "TITLE" => c.title = Some(unescape(value)).filter(|s| !s.is_empty()),
            "NOTE" => c.note = Some(unescape(value)).filter(|s| !s.is_empty()),
            "EMAIL" if !value.is_empty() => c.emails.push(unescape(value)),
            "TEL" if !value.is_empty() => c.phones.push(Phone { number: unescape(value.trim_start_matches("tel:")), kind: phone_kind(&params) }),
            "CLOUD" | "X-NEXTCLOUD-CLOUD" => c.user = c.user.take().or_else(|| local_user(&unescape(value), server)),
            "IMPP" | "X-MATRIX" => c.matrix = c.matrix.take().or_else(|| matrix_id(&unescape(value))),
            _ => {}
        }
    }
    if c.name.is_empty() {
        c.name = [structured, c.org.clone().unwrap_or_default(), c.emails.first().cloned().unwrap_or_default()].into_iter().find(|s| !s.is_empty())?;
    }
    Some(c)
}

/// "NAME;PARAMS:VALUE" at its first colon outside quotes.
fn split(line: &str) -> Option<(&str, &str)> {
    let mut quoted = false;
    for (i, ch) in line.char_indices() {
        match ch {
            '"' => quoted = !quoted,
            ':' if !quoted => return Some((&line[..i], &line[i + 1..])),
            _ => {}
        }
    }
    None
}

fn unescape(v: &str) -> String {
    let mut out = String::with_capacity(v.len());
    let mut chars = v.chars();
    while let Some(ch) = chars.next() {
        if ch != '\\' {
            out.push(ch);
            continue;
        }
        match chars.next() {
            Some('n' | 'N') => out.push('\n'),
            Some(other) => out.push(other),
            None => {}
        }
    }
    out.trim().to_owned()
}

/// Mobile, work, home or fax, from "TYPE=CELL,VOICE", "TYPE=work" or a bare "CELL" (vCard 2.1).
fn phone_kind(params: &[String]) -> Option<String> {
    let types = params.iter().flat_map(|p| p.strip_prefix("type=").unwrap_or(p).split(',').map(|t| t.trim_matches('"').to_owned()).collect::<Vec<_>>());
    let types: Vec<String> = types.collect();
    ["cell", "work", "home", "fax"].into_iter().find(|k| types.iter().any(|t| t == k)).map(|k| if k == "cell" { "mobile".to_owned() } else { k.to_owned() })
}

/// "anna@cloud.example" on the server at "https://cloud.example": "anna".
fn local_user(cloud: &str, server: &str) -> Option<String> {
    let here = server.trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/');
    let (user, host) = cloud.rsplit_once('@')?;
    let host = host.trim_start_matches("https://").trim_start_matches("http://").trim_end_matches('/');
    (!user.is_empty() && host.eq_ignore_ascii_case(here)).then(|| user.to_owned())
}

/// "matrix:u/anna:example.org", "https://matrix.to/#/@anna:example.org" or "@anna:example.org".
fn matrix_id(v: &str) -> Option<String> {
    let v = v.trim();
    let id = if let Some(rest) = v.strip_prefix("matrix:u/") {
        format!("@{}", rest.split(['?', '/']).next().unwrap_or_default())
    } else if let Some(rest) = v.strip_prefix("https://matrix.to/#/") {
        rest.split('?').next().unwrap_or_default().to_owned()
    } else {
        v.strip_prefix("matrix:").unwrap_or(v).to_owned()
    };
    (id.starts_with('@') && id.len() > 3 && id[1..].contains(':') && !id.contains(char::is_whitespace)).then_some(id)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_card_from_nextcloud() {
        let card = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:1\r\nFN:Anna de Vries\r\nN:de Vries;Anna;;;\r\nORG:Example\\, Inc.;Research\r\nTITLE:Engineer\r\nitem1.EMAIL;TYPE=INTERNET:anna@example.org\r\nTEL;TYPE=CELL,VOICE:+31 6 1234\r\n 5678\r\nTEL;TYPE=work:tel:+31201234567\r\nCLOUD:anna@cloud.example\r\nIMPP;X-SERVICE-TYPE=Matrix:matrix:u/anna:example.org\r\nNOTE:Met at the\\nconference\r\nEND:VCARD\r\n";
        let c = parse(card, "/remote.php/dav/addressbooks/users/me/contacts/1.vcf", "Contacts", "https://cloud.example").unwrap();
        assert_eq!(c.name, "Anna de Vries");
        assert_eq!(c.org.as_deref(), Some("Example, Inc., Research"));
        assert_eq!(c.emails, ["anna@example.org"]);
        assert_eq!(c.phones[0], Phone { number: "+31 6 12345678".into(), kind: Some("mobile".into()) });
        assert_eq!(c.phones[1], Phone { number: "+31201234567".into(), kind: Some("work".into()) });
        assert_eq!(c.user.as_deref(), Some("anna"));
        assert_eq!(c.matrix.as_deref(), Some("@anna:example.org"));
        assert_eq!(c.note.as_deref(), Some("Met at the\nconference"));
    }

    #[test]
    fn names_groups_and_other_servers() {
        let c = parse("BEGIN:VCARD\nN:Jansen;Piet;;;\nCLOUD:piet@other.example\nEND:VCARD\n", "x", "B", "https://cloud.example").unwrap();
        assert_eq!(c.name, "Piet Jansen");
        assert_eq!(c.user, None);
        assert!(parse("BEGIN:VCARD\nFN:Team\nX-ADDRESSBOOKSERVER-KIND:group\nEND:VCARD\n", "x", "B", "").is_none());
        assert!(parse("BEGIN:VCARD\nVERSION:3.0\nEND:VCARD\n", "x", "B", "").is_none());
        assert_eq!(matrix_id("https://matrix.to/#/@bo:matrix.org"), Some("@bo:matrix.org".into()));
        assert_eq!(matrix_id("xmpp:bo@example.org"), None);
    }
}
