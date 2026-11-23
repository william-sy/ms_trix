//! Nextcloud's WebDAV side: Files (browse, share) and Calendar (CalDAV).
//! Only what the attach picker and the calendar view need; replies are parsed
//! loosely (by local element names) because servers differ in namespace prefixes.

use std::collections::HashMap;

use quick_xml::events::Event;
use quick_xml::Reader;
use trix_core::{Attendee, CalendarEvent, NewEvent};

/// One `<d:response>` of a multistatus reply.
#[derive(Debug, Default)]
pub struct DavResponse {
    pub href: String,
    /// Text properties by local name ("displayname", "getcontentlength", ...).
    pub props: HashMap<String, String>,
    /// Child elements of `<resourcetype>` ("collection", "calendar", ...).
    pub types: Vec<String>,
    /// Calendar components this collection holds ("VEVENT", "VTODO").
    pub components: Vec<String>,
    /// Privileges the user has ("read", "write", ...).
    pub privileges: Vec<String>,
}

fn entity(name: &str) -> Option<char> {
    Some(match name {
        "amp" => '&',
        "lt" => '<',
        "gt" => '>',
        "quot" => '"',
        "apos" => '\'',
        _ => return None,
    })
}

pub fn multistatus(xml: &str) -> Vec<DavResponse> {
    let mut reader = Reader::from_str(xml);
    let mut out = vec![];
    let mut current: Option<DavResponse> = None;
    let mut stack: Vec<String> = vec![];
    let mut text = String::new();
    loop {
        let event = match reader.read_event() {
            Ok(Event::Eof) | Err(_) => break,
            Ok(e) => e,
        };
        match event {
            Event::Start(e) => {
                let name = e.local_name().as_ref().to_owned();
                if name == "response" {
                    current = Some(DavResponse::default());
                }
                child(&mut current, &stack, &name, &e);
                stack.push(name);
                text.clear();
            }
            Event::Empty(e) => {
                let name = e.local_name().as_ref().to_owned();
                child(&mut current, &stack, &name, &e);
            }
            Event::Text(t) => text.push_str(&t.xml10_content()),
            Event::CData(t) => text.push_str(&t.into_inner()),
            Event::GeneralRef(r) => {
                let resolved = r.resolve_char_ref().ok().flatten().or_else(|| entity(&r.xml10_content()));
                text.extend(resolved);
            }
            Event::End(_) => {
                let Some(name) = stack.pop() else { continue };
                if let Some(resp) = current.as_mut() {
                    if name == "href" && stack.last().map(String::as_str) == Some("response") {
                        resp.href = text.trim().to_owned();
                    } else if stack.iter().any(|s| s == "prop") && !text.trim().is_empty() {
                        resp.props.entry(name.clone()).or_insert_with(|| text.clone());
                    }
                }
                if name == "response" {
                    out.extend(current.take());
                }
                text.clear();
            }
            _ => {}
        }
    }
    out
}

/// Records markers that are elements rather than text (resource types, components, privileges).
fn child(current: &mut Option<DavResponse>, stack: &[String], name: &str, e: &quick_xml::events::BytesStart) {
    let Some(resp) = current.as_mut() else { return };
    match stack.last().map(String::as_str) {
        Some("resourcetype") => resp.types.push(name.to_owned()),
        Some("supported-calendar-component-set") if name == "comp" => {
            if let Some(Ok(attr)) = e.attributes().find(|a| a.as_ref().is_ok_and(|a| a.key.local_name().as_ref() == "name")) {
                resp.components.push(attr.value.into_owned());
            }
        }
        Some("privilege") => resp.privileges.push(name.to_owned()),
        _ => {}
    }
}

pub fn decode(s: &str) -> String {
    percent_encoding::percent_decode_str(s).decode_utf8_lossy().into_owned()
}

/// Percent-encodes each segment of a "/a/b c" path; refuses ".." segments.
pub fn encode_path(path: &str) -> Option<String> {
    let mut out = String::new();
    for segment in path.split('/').filter(|s| !s.is_empty()) {
        if segment == ".." || segment == "." {
            return None;
        }
        out.push('/');
        out.push_str(&percent_encoding::utf8_percent_encode(segment, percent_encoding::NON_ALPHANUMERIC).to_string());
    }
    Some(out)
}

pub const PROPFIND_FILES: &str = r#"<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:nc="http://nextcloud.org/ns">
  <d:prop><d:displayname/><d:getcontentlength/><d:getcontenttype/><d:getlastmodified/><d:resourcetype/><oc:fileid/><oc:size/></d:prop>
</d:propfind>"#;

pub const PROPFIND_CALENDARS: &str = r#"<?xml version="1.0"?>
<d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:x="http://apple.com/ns/ical/">
  <d:prop><d:displayname/><d:resourcetype/><d:current-user-privilege-set/><c:supported-calendar-component-set/><x:calendar-color/></d:prop>
</d:propfind>"#;

/// Event occurrences in a time range; the server expands recurrences (and gives UTC times).
pub fn events_query(from: &str, to: &str) -> String {
    format!(
        r#"<?xml version="1.0"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data><c:expand start="{from}" end="{to}"/></c:calendar-data></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="{from}" end="{to}"/></c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>"#
    )
}

fn unfold(ics: &str) -> Vec<String> {
    let mut unfolded: Vec<String> = vec![];
    for line in ics.split('\n') {
        let line = line.strip_suffix('\r').unwrap_or(line);
        if let Some(rest) = line.strip_prefix([' ', '\t']) {
            if let Some(last) = unfolded.last_mut() {
                last.push_str(rest);
                continue;
            }
        }
        if !line.is_empty() {
            unfolded.push(line.to_owned());
        }
    }
    unfolded
}

/// Splits a content line into (name, params, value).
fn split_line(line: &str) -> Option<(String, Vec<(String, String)>, String)> {
    // The value starts at the first ':' outside a quoted parameter.
    let mut quoted = false;
    let split = line.char_indices().find(|(_, c)| {
        if *c == '"' {
            quoted = !quoted;
        }
        *c == ':' && !quoted
    })?;
    let (head, value) = (&line[..split.0], &line[split.0 + 1..]);
    let mut parts = head.split(';');
    let name = parts.next()?.to_ascii_uppercase();
    let params = parts.filter_map(|p| p.split_once('=')).map(|(k, v)| (k.to_ascii_uppercase(), v.trim_matches('"').to_owned())).collect();
    Some((name, params, value.to_owned()))
}

/// iCalendar lines with folding undone: (name, params, value).
fn ics_lines(ics: &str) -> Vec<(String, Vec<(String, String)>, String)> {
    unfold(ics).iter().filter_map(|l| split_line(l)).collect()
}

/// Lines over 75 bytes are folded, as the spec asks.
fn fold(line: &str) -> String {
    let mut out = String::new();
    let mut width = 0;
    for c in line.chars() {
        if width + c.len_utf8() > 74 {
            out.push_str("\r\n ");
            width = 1;
        }
        out.push(c);
        width += c.len_utf8();
    }
    out
}

fn mailto(value: &str) -> String {
    let v = value.trim();
    v.strip_prefix("mailto:").or_else(|| v.strip_prefix("MAILTO:")).unwrap_or(v).to_owned()
}

/// A parameter value without characters that would break the line.
fn param(value: &str) -> String {
    format!("\"{}\"", value.replace(['"', '\r', '\n'], ""))
}

fn unescape(value: &str) -> String {
    let mut out = String::new();
    let mut chars = value.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            match chars.next() {
                Some('n' | 'N') => out.push('\n'),
                Some(other) => out.push(other),
                None => {}
            }
        } else {
            out.push(c);
        }
    }
    out
}

pub fn escape(value: &str) -> String {
    value.replace('\\', "\\\\").replace(';', "\\;").replace(',', "\\,").replace('\r', "").replace('\n', "\\n")
}

/// The VEVENTs of one calendar object (every occurrence, when expanded).
/// `me` are the user's own addresses, to tell which events they organise.
pub fn parse_events(calendar: &str, href: &str, etag: Option<&str>, me: &[String], ics: &str) -> Vec<CalendarEvent> {
    let mut out = vec![];
    let mut event: Option<CalendarEvent> = None;
    let mut depth = 0; // nested components inside a VEVENT (VALARM)
    for (name, params, value) in ics_lines(ics) {
        match (name.as_str(), value.as_str()) {
            ("BEGIN", "VEVENT") => {
                event = Some(CalendarEvent {
                    calendar: calendar.to_owned(),
                    uid: String::new(),
                    summary: String::new(),
                    start: String::new(),
                    end: None,
                    location: None,
                    description: None,
                    organizer: None,
                    href: href.to_owned(),
                    etag: etag.map(ToOwned::to_owned),
                    recurring: false,
                    recurrence_id: None,
                    attendees: vec![],
                    mine: true,
                    my_status: None,
                });
                depth = 0;
            }
            ("END", "VEVENT") => out.extend(event.take().filter(|e| !e.start.is_empty())),
            ("BEGIN", _) if event.is_some() => depth += 1,
            ("END", _) if event.is_some() => depth -= 1,
            _ => {
                let Some(e) = event.as_mut().filter(|_| depth == 0) else { continue };
                let text = || Some(unescape(&value)).filter(|v| !v.trim().is_empty());
                match name.as_str() {
                    "UID" => e.uid = value.clone(),
                    "SUMMARY" => e.summary = unescape(&value),
                    "DTSTART" => e.start = value.trim().to_owned(),
                    "DTEND" => e.end = Some(value.trim().to_owned()),
                    "LOCATION" => e.location = text(),
                    "DESCRIPTION" => e.description = text(),
                    "ORGANIZER" => {
                        let email = mailto(&value);
                        e.mine = me.iter().any(|m| m.eq_ignore_ascii_case(&email));
                        let cn = params.iter().find(|(k, _)| k == "CN").map(|(_, v)| v.clone());
                        e.organizer = cn.or(Some(email));
                    }
                    "ATTENDEE" => {
                        let get = |key: &str| params.iter().find(|(k, _)| k == key).map(|(_, v)| v.clone());
                        // Rooms and resources aren't people to list.
                        let email = mailto(&value);
                        if me.iter().any(|m| m.eq_ignore_ascii_case(&email)) {
                            e.my_status = Some(get("PARTSTAT").unwrap_or_else(|| "NEEDS-ACTION".into()));
                        }
                        if get("CUTYPE").is_none_or(|t| t.eq_ignore_ascii_case("INDIVIDUAL")) {
                            e.attendees.push(Attendee { name: get("CN"), email, status: get("PARTSTAT"), user: None });
                        }
                    }
                    "RECURRENCE-ID" => {
                        e.recurring = true;
                        e.recurrence_id = Some(value.trim().to_owned());
                    }
                    "RRULE" | "RDATE" => e.recurring = true,
                    _ => {}
                }
            }
        }
    }
    out
}

/// The properties Trixcomm writes for an event (a new one, or replacing these in an edited one).
fn event_props(stamp: &str, event: &NewEvent, organizer: Option<&Attendee>) -> Vec<String> {
    let zone = event.tzid.as_deref().filter(|z| valid_tzid(z));
    let date = |v: &str| match (v.len(), zone) {
        (8, _) => format!(";VALUE=DATE:{v}"),
        // A local time in the meeting's own time zone.
        (15, Some(zone)) => format!(";TZID={zone}:{v}"),
        _ => format!(":{v}"),
    };
    let mut lines = vec![
        format!("DTSTAMP:{stamp}"),
        format!("LAST-MODIFIED:{stamp}"),
        format!("DTSTART{}", date(&event.start)),
        format!("DTEND{}", date(&event.end)),
        format!("SUMMARY:{}", escape(&event.summary)),
    ];
    if let Some(location) = event.location.as_deref().filter(|l| !l.trim().is_empty()) {
        lines.push(format!("LOCATION:{}", escape(location)));
    }
    if let Some(description) = event.description.as_deref().filter(|d| !d.trim().is_empty()) {
        lines.push(format!("DESCRIPTION:{}", escape(description)));
    }
    // With attendees Nextcloud emails the invitations, sent as the organizer.
    let attendees: Vec<&Attendee> = event.attendees.iter().filter(|a| a.email.contains('@')).collect();
    if let (Some(me), false) = (organizer, attendees.is_empty()) {
        let cn = me.name.as_deref().map(|n| format!(";CN={}", param(n))).unwrap_or_default();
        lines.push(format!("ORGANIZER{cn}:mailto:{}", me.email.trim()));
        for a in attendees {
            let cn = a.name.as_deref().filter(|n| !n.is_empty()).map(|n| format!(";CN={}", param(n))).unwrap_or_default();
            let status = a.status.as_deref().filter(|s| s.chars().all(|c| c.is_ascii_alphabetic() || c == '-')).unwrap_or("NEEDS-ACTION");
            lines.push(format!("ATTENDEE{cn};CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT={status};RSVP=TRUE:mailto:{}", a.email.trim()));
        }
    }
    lines
}

pub fn event_ics(uid: &str, stamp: &str, event: &NewEvent, organizer: Option<&Attendee>) -> String {
    let mut lines = vec!["BEGIN:VCALENDAR".to_owned(), "VERSION:2.0".to_owned(), "PRODID:-//Trixcomm//EN".to_owned()];
    if let Some(zone) = event.vtimezone.as_deref().filter(|_| event.tzid.as_deref().is_some_and(valid_tzid)).filter(|z| valid_vtimezone(z)) {
        lines.extend(zone.lines().map(|l| l.trim_end().to_owned()));
    }
    lines.extend(["BEGIN:VEVENT".to_owned(), format!("UID:{uid}")]);
    lines.extend(event_props(stamp, event, organizer));
    if let Some(rule) = event.rrule.as_deref().filter(|r| valid_rrule(r)) {
        lines.push(format!("RRULE:{rule}"));
    }
    lines.extend(["END:VEVENT".to_owned(), "END:VCALENDAR".to_owned()]);
    lines.iter().map(|l| fold(l)).collect::<Vec<_>>().join("\r\n") + "\r\n"
}

fn valid_rrule(rule: &str) -> bool {
    rule.starts_with("FREQ=") && rule.chars().all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || matches!(c, '=' | ';' | ',' | '-'))
}

/// An IANA time zone name ("Europe/Amsterdam", "America/Argentina/Buenos_Aires", "Etc/GMT+1").
fn valid_tzid(zone: &str) -> bool {
    !zone.is_empty() && zone.len() < 64 && zone.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '+'))
}

/// A VTIMEZONE block as the meeting dialog makes it: nothing but time zone lines.
fn valid_vtimezone(block: &str) -> bool {
    let lines: Vec<&str> = block.lines().map(str::trim_end).collect();
    lines.first() == Some(&"BEGIN:VTIMEZONE")
        && lines.last() == Some(&"END:VTIMEZONE")
        && lines.iter().all(|l| {
            let (name, value) = l.split_once(':').unwrap_or((l, ""));
            match name {
                "BEGIN" | "END" => matches!(value, "VTIMEZONE" | "STANDARD" | "DAYLIGHT"),
                "TZID" => valid_tzid(value),
                "TZOFFSETFROM" | "TZOFFSETTO" | "DTSTART" | "RRULE" | "TZNAME" => !value.is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '=' | ';' | ',')),
                _ => false,
            }
        })
}

/// An edited event: the original object with Trixcomm's properties replaced, and the rest
/// (reminders, other apps' fields) kept. Rewrites the first VEVENT: for single events.
pub fn rewrite_event(original: &str, stamp: &str, event: &NewEvent, organizer: Option<&Attendee>) -> Option<String> {
    let mut out = vec![];
    let (mut in_event, mut depth, mut done) = (false, 0, false);
    for line in unfold(original) {
        let (name, _, value) = split_line(&line)?;
        match (name.as_str(), value.as_str()) {
            ("BEGIN", "VEVENT") if !done => in_event = true,
            ("BEGIN", _) if in_event => depth += 1,
            ("END", "VEVENT") if in_event => {
                out.extend(event_props(stamp, event, organizer));
                in_event = false;
                done = true;
            }
            ("END", _) if in_event => depth -= 1,
            (prop, _) if in_event && depth == 0 && REPLACED.contains(&prop) => continue,
            ("SEQUENCE", v) if in_event && depth == 0 => {
                out.push(format!("SEQUENCE:{}", v.trim().parse::<u32>().unwrap_or(0) + 1));
                continue;
            }
            _ => {}
        }
        out.push(line);
    }
    done.then(|| out.iter().map(|l| fold(l)).collect::<Vec<_>>().join("\r\n") + "\r\n")
}

/// Days since 1970-01-01 to (year, month, day).
pub fn civil(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (yoe + era * 400 + i64::from(m <= 2), m, d)
}

fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y.rem_euclid(400);
    let mp = (i64::from(m) + 9) % 12;
    let doy = (153 * mp + 2) / 5 + i64::from(d) - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

/// An iCalendar date or date-time as seconds (local times are taken as they are written).
fn ical_secs(v: &str) -> Option<i64> {
    let v = v.trim();
    let num = |r: std::ops::Range<usize>| v.get(r)?.parse::<i64>().ok();
    let days = days_from_civil(num(0..4)?, num(4..6)? as u32, num(6..8)? as u32);
    let time = if v.len() >= 15 { num(9..11)? * 3600 + num(11..13)? * 60 + num(13..15)? } else { 0 };
    Some(days * 86_400 + time)
}

/// Seconds back to the form of `like`: a date, a UTC time ("…Z") or a local time.
fn ical_format(secs: i64, like: &str) -> String {
    let (y, m, d) = civil(secs.div_euclid(86_400));
    if like.trim().len() == 8 {
        return format!("{y:04}{m:02}{d:02}");
    }
    let rest = secs.rem_euclid(86_400);
    let z = if like.trim().ends_with('Z') { "Z" } else { "" };
    format!("{y:04}{m:02}{d:02}T{:02}{:02}{:02}{z}", rest / 3600, rest % 3600 / 60, rest % 60)
}

/// The VEVENT blocks of an object: (first line, last line, recurrence id) by index into `lines`.
fn vevents(lines: &[String]) -> Vec<(usize, usize, Option<String>)> {
    let mut out = vec![];
    let (mut start, mut depth, mut rid) = (None, 0, None);
    for (i, line) in lines.iter().enumerate() {
        let Some((name, _, value)) = split_line(line) else { continue };
        match (name.as_str(), value.trim()) {
            ("BEGIN", "VEVENT") if start.is_none() => (start, depth, rid) = (Some(i), 0, None),
            ("BEGIN", _) if start.is_some() => depth += 1,
            ("END", "VEVENT") if depth == 0 => out.extend(start.take().map(|s| (s, i, rid.take()))),
            ("END", _) if start.is_some() => depth -= 1,
            ("RECURRENCE-ID", v) if start.is_some() && depth == 0 => rid = Some(v.to_owned()),
            _ => {}
        }
    }
    out
}

fn same_time(a: &str, b: &str) -> bool {
    ical_secs(a).is_some() && ical_secs(a) == ical_secs(b)
}

fn join(lines: &[String]) -> String {
    lines.iter().map(|l| fold(l)).collect::<Vec<_>>().join("\r\n") + "\r\n"
}

/// The part of a content line before its value ("DTSTART;TZID=Europe/Amsterdam").
fn head(line: &str, value: &str) -> String {
    line[..line.len() - value.len() - 1].to_owned()
}

const REPLACED: &[&str] = &["DTSTAMP", "LAST-MODIFIED", "DTSTART", "DTEND", "DURATION", "SUMMARY", "LOCATION", "DESCRIPTION", "ORGANIZER", "ATTENDEE"];

/// A repeating meeting changed as a whole: the series moves by as much as the occurrence
/// `occurrence` was moved (keeping its time zone, so it stays at the same local time), and
/// gets the new title, place, text and people. Changed single occurrences stay as they are.
pub fn rewrite_series(original: &str, stamp: &str, event: &NewEvent, organizer: Option<&Attendee>, occurrence: &str) -> Option<String> {
    let lines = unfold(original);
    let (first, last, _) = vevents(&lines).into_iter().find(|(_, _, rid)| rid.is_none())?;
    let shift = ical_secs(&event.start)? - ical_secs(occurrence)?;
    let length = ical_secs(&event.end)? - ical_secs(&event.start)?;
    let mut out: Vec<String> = lines[..first + 1].to_vec();
    let mut depth = 0;
    let mut start_line = None;
    for line in &lines[first + 1..last] {
        let (name, _, value) = split_line(line)?;
        match (name.as_str(), value.trim()) {
            ("BEGIN", _) => depth += 1,
            ("END", _) => depth -= 1,
            ("DTSTART", v) if depth == 0 => {
                start_line = Some((head(line, &value), v.to_owned()));
                continue;
            }
            (prop, _) if depth == 0 && REPLACED.contains(&prop) => continue,
            ("SEQUENCE", v) if depth == 0 => {
                out.push(format!("SEQUENCE:{}", v.parse::<u32>().unwrap_or(0) + 1));
                continue;
            }
            _ => {}
        }
        out.push(line.clone());
    }
    let (start_head, start) = start_line?;
    let new_start = ical_secs(&start)? + shift;
    out.push(format!("{start_head}:{}", ical_format(new_start, &start)));
    out.push(format!("{}:{}", start_head.replacen("DTSTART", "DTEND", 1), ical_format(new_start + length, &start)));
    out.extend(event_props(stamp, event, organizer).into_iter().filter(|l| !l.starts_with("DTSTART") && !l.starts_with("DTEND")));
    out.extend(lines[last..].iter().cloned());
    Some(join(&out))
}

/// One occurrence of a repeating meeting changed: its own VEVENT (RECURRENCE-ID) is
/// rewritten, or made from the series' one.
pub fn override_occurrence(original: &str, stamp: &str, event: &NewEvent, organizer: Option<&Attendee>, occurrence: &str) -> Option<String> {
    let lines = unfold(original);
    let blocks = vevents(&lines);
    if let Some((first, last, _)) = blocks.iter().find(|(_, _, rid)| rid.as_deref().is_some_and(|r| same_time(r, occurrence))) {
        let block = join(&lines[*first..=*last]);
        let rewritten = rewrite_event(&format!("BEGIN:VCALENDAR\r\n{block}END:VCALENDAR\r\n"), stamp, event, organizer)?;
        let inner = unfold(&rewritten);
        let mut out = lines[..*first].to_vec();
        out.extend(inner[1..inner.len() - 1].iter().cloned());
        out.extend(lines[last + 1..].iter().cloned());
        return Some(join(&out));
    }
    let (first, last, _) = *blocks.iter().find(|(_, _, rid)| rid.is_none())?;
    let rid = if occurrence.trim().len() == 8 { format!("RECURRENCE-ID;VALUE=DATE:{}", occurrence.trim()) } else { format!("RECURRENCE-ID:{}", occurrence.trim()) };
    let mut copy = vec!["BEGIN:VEVENT".to_owned()];
    let mut depth = 0;
    for line in &lines[first + 1..last] {
        let (name, _, _) = split_line(line)?;
        match name.as_str() {
            "BEGIN" => depth += 1,
            "END" => depth -= 1,
            prop if depth == 0 && (REPLACED.contains(&prop) || matches!(prop, "RRULE" | "RDATE" | "EXDATE" | "EXRULE")) => continue,
            _ => {}
        }
        copy.push(line.clone());
    }
    copy.push(rid);
    copy.extend(event_props(stamp, event, organizer));
    copy.push("END:VEVENT".to_owned());
    let mut out = lines[..=last].to_vec();
    out.extend(copy);
    out.extend(lines[last + 1..].iter().cloned());
    Some(join(&out))
}

/// One occurrence of a repeating meeting cancelled: an EXDATE in the series (and its own
/// changed copy, if any, removed).
pub fn exclude_occurrence(original: &str, occurrence: &str) -> Option<String> {
    let lines = unfold(original);
    let blocks = vevents(&lines);
    let (_, master_end, _) = *blocks.iter().find(|(_, _, rid)| rid.is_none())?;
    let skip: Vec<(usize, usize)> = blocks.iter().filter(|(_, _, rid)| rid.as_deref().is_some_and(|r| same_time(r, occurrence))).map(|(a, b, _)| (*a, *b)).collect();
    let exdate = if occurrence.trim().len() == 8 { format!("EXDATE;VALUE=DATE:{}", occurrence.trim()) } else { format!("EXDATE:{}", occurrence.trim()) };
    let mut out = vec![];
    for (i, line) in lines.iter().enumerate() {
        if skip.iter().any(|(a, b)| (*a..=*b).contains(&i)) {
            continue;
        }
        if i == master_end {
            out.push(exdate.clone());
        }
        out.push(line.clone());
    }
    Some(join(&out))
}

/// Your reply to an invitation: your ATTENDEE lines (in every VEVENT of the object) get
/// the new PARTSTAT; None if you aren't invited in it.
pub fn set_my_status(original: &str, stamp: &str, me: &str, status: &str) -> Option<String> {
    let mut found = false;
    let mut out = vec![];
    for line in unfold(original) {
        let (name, params, value) = split_line(&line)?;
        if name == "ATTENDEE" && mailto(&value).eq_ignore_ascii_case(me) {
            found = true;
            let kept: String = params
                .iter()
                .filter(|(k, _)| k != "PARTSTAT" && k != "RSVP")
                .map(|(k, v)| if v.contains([';', ':', ',']) || k == "CN" { format!(";{k}={}", param(v)) } else { format!(";{k}={v}") })
                .collect();
            out.push(format!("ATTENDEE{kept};PARTSTAT={status}:{value}"));
            continue;
        }
        if name == "DTSTAMP" {
            out.push(format!("DTSTAMP:{stamp}"));
            continue;
        }
        out.push(line);
    }
    found.then(|| out.iter().map(|l| fold(l)).collect::<Vec<_>>().join("\r\n") + "\r\n")
}

/// Nextcloud users (and their addresses) whose name or address matches `term`.
pub fn people_query(term: &str) -> String {
    let term = term.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;");
    format!(
        r#"<?xml version="1.0"?>
<d:principal-property-search xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" test="anyof">
  <d:property-search><d:prop><d:displayname/></d:prop><d:match>{term}</d:match></d:property-search>
  <d:property-search><d:prop><s:email-address/></d:prop><d:match>{term}</d:match></d:property-search>
  <d:prop><d:displayname/><s:email-address/></d:prop>
</d:principal-property-search>"#
    )
}

/// iCalendar values are plain ASCII digits/letters; anything else is a bad request.
pub fn valid_time(v: &str) -> bool {
    matches!(v.len(), 8 | 16) && v.chars().all(|c| c.is_ascii_digit() || c == 'T' || c == 'Z')
}

/// An event's start and end: dates, UTC times, or local times in a time zone it names.
pub fn valid_times(event: &NewEvent) -> bool {
    let local = |v: &str| v.len() == 15 && v.as_bytes()[8] == b'T' && v.chars().enumerate().all(|(i, c)| i == 8 || c.is_ascii_digit());
    let zoned = event.tzid.as_deref().is_some_and(valid_tzid);
    [&event.start, &event.end].iter().all(|v| valid_time(v) || (zoned && local(v)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_multistatus() {
        let xml = r#"<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns" xmlns:cal="urn:ietf:params:xml:ns:caldav">
 <d:response><d:href>/remote.php/dav/files/me/Docs%20x/</d:href>
  <d:propstat><d:prop><d:displayname>Docs x</d:displayname><d:resourcetype><d:collection/></d:resourcetype><oc:fileid>12</oc:fileid></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
 </d:response>
 <d:response><d:href>/remote.php/dav/calendars/me/work/</d:href>
  <d:propstat><d:prop><d:displayname>Work &amp; more</d:displayname><d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>
  <cal:supported-calendar-component-set><cal:comp name="VEVENT"/></cal:supported-calendar-component-set>
  <d:current-user-privilege-set><d:privilege><d:read/></d:privilege><d:privilege><d:write/></d:privilege></d:current-user-privilege-set></d:prop></d:propstat>
 </d:response>
</d:multistatus>"#;
        let r = multistatus(xml);
        assert_eq!(r.len(), 2);
        assert_eq!(decode(&r[0].href), "/remote.php/dav/files/me/Docs x/");
        assert_eq!(r[0].props["fileid"], "12");
        assert_eq!(r[0].types, ["collection"]);
        assert_eq!(r[1].props["displayname"], "Work & more");
        assert_eq!(r[1].components, ["VEVENT"]);
        assert!(r[1].privileges.contains(&"write".to_owned()));
    }

    #[test]
    fn parses_events() {
        let ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:a1\r\nSUMMARY:Stand-up\\, daily\r\nDTSTART:20261117T080000Z\r\nDTEND:20261117T081500Z\r\nLOCATION:https://cloud.example/call/ab\r\n cd12\r\nORGANIZER;CN=\"Ann: Lead\":mailto:ann@example.org\r\nBEGIN:VALARM\r\nDESCRIPTION:alarm\r\nEND:VALARM\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:a2\r\nSUMMARY:Holiday\r\nDTSTART;VALUE=DATE:20261118\r\nDTEND;VALUE=DATE:20261119\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let events = parse_events("work", "/x.ics", None, &["ann@example.org".to_owned()], ics);
        assert_eq!(events.len(), 2);
        assert_eq!(events[0].summary, "Stand-up, daily");
        assert_eq!(events[0].location.as_deref(), Some("https://cloud.example/call/abcd12"));
        assert_eq!(events[0].organizer.as_deref(), Some("Ann: Lead"));
        assert_eq!(events[0].description, None);
        assert_eq!(events[1].start, "20261118");
        assert!(events[0].mine && !events[0].recurring);
    }

    #[test]
    fn new_repeating_meeting_keeps_its_local_time() {
        let zone = "BEGIN:VTIMEZONE\r\nTZID:Europe/Amsterdam\r\nBEGIN:STANDARD\r\nTZOFFSETFROM:+0200\r\nTZOFFSETTO:+0100\r\nDTSTART:19701025T030000\r\nRRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU\r\nEND:STANDARD\r\nEND:VTIMEZONE";
        let event = NewEvent {
            calendar: "c".into(), summary: "Stand-up".into(), start: "20261117T090000".into(), end: "20261117T091500".into(),
            location: None, description: None, attendees: vec![], occurrence: None, series: false,
            rrule: Some("FREQ=WEEKLY;BYDAY=MO,TU".into()), tzid: Some("Europe/Amsterdam".into()), vtimezone: Some(zone.into()),
        };
        assert!(valid_times(&event));
        assert!(!valid_times(&NewEvent { tzid: None, ..event.clone() }), "a local time needs its zone");
        let ics = event_ics("u1", "20261119T100000Z", &event, None);
        assert!(ics.contains("PRODID:-//Trixcomm//EN\r\nBEGIN:VTIMEZONE\r\nTZID:Europe/Amsterdam"), "{ics}");
        assert!(ics.contains("DTSTART;TZID=Europe/Amsterdam:20261117T090000\r\nDTEND;TZID=Europe/Amsterdam:20261117T091500"), "{ics}");
        assert!(ics.contains("RRULE:FREQ=WEEKLY;BYDAY=MO,TU\r\nEND:VEVENT"), "{ics}");
        // Anything else in the rule or the zone is refused.
        let sneaky = NewEvent { rrule: Some("FREQ=DAILY\r\nATTENDEE:mailto:x@y".into()), vtimezone: Some(format!("{zone}\r\nBEGIN:VEVENT")), ..event };
        let ics = event_ics("u2", "20261119T100000Z", &sneaky, None);
        assert!(!ics.contains("RRULE") && !ics.contains("VTIMEZONE"), "{ics}");
    }

    const WEEKLY: &str = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:w1\r\nSEQUENCE:1\r\nSUMMARY:Standup\r\nDTSTART;TZID=Europe/Amsterdam:20261116T090000\r\nDTEND;TZID=Europe/Amsterdam:20261116T093000\r\nRRULE:FREQ=WEEKLY\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";

    fn moved(start: &str, end: &str) -> NewEvent {
        NewEvent { calendar: String::new(), summary: "Standup 2".into(), start: start.into(), end: end.into(), location: None, description: None, attendees: vec![], occurrence: None, series: false, rrule: None, tzid: None, vtimezone: None }
    }

    #[test]
    fn repeating_series_moves_in_its_own_time_zone() {
        // The occurrence of 23 Nov (08:00 UTC) moved an hour later and made 45 minutes long.
        let out = rewrite_series(WEEKLY, "20261117T000000Z", &moved("20261123T090000Z", "20261123T094500Z"), None, "20261123T080000Z").unwrap();
        assert!(out.contains("DTSTART;TZID=Europe/Amsterdam:20261116T100000"), "{out}");
        assert!(out.contains("DTEND;TZID=Europe/Amsterdam:20261116T104500"), "{out}");
        assert!(out.contains("RRULE:FREQ=WEEKLY") && out.contains("SUMMARY:Standup 2") && out.contains("SEQUENCE:2"));
    }

    #[test]
    fn repeating_occurrence_gets_its_own_copy_and_can_be_cancelled() {
        let out = override_occurrence(WEEKLY, "20261117T000000Z", &moved("20261123T100000Z", "20261123T103000Z"), None, "20261123T080000Z").unwrap();
        let events = parse_events("c", "/h", None, &[], &out);
        assert_eq!(events.len(), 2);
        assert_eq!(events[1].recurrence_id.as_deref(), Some("20261123T080000Z"));
        assert_eq!(events[1].start, "20261123T100000Z");
        assert!(!out.split("BEGIN:VEVENT").nth(2).unwrap().contains("RRULE"));
        // Changing it again rewrites that copy instead of adding another.
        let again = override_occurrence(&out, "20261117T000000Z", &moved("20261123T110000Z", "20261123T113000Z"), None, "20261123T080000Z").unwrap();
        assert_eq!(parse_events("c", "/h", None, &[], &again).len(), 2);
        // Cancelled: an EXDATE in the series, and the copy gone.
        let cancelled = exclude_occurrence(&again, "20261123T080000Z").unwrap();
        assert!(cancelled.contains("EXDATE:20261123T080000Z"));
        assert_eq!(parse_events("c", "/h", None, &[], &cancelled).len(), 1);
    }

    #[test]
    fn rewrites_event_keeping_the_rest() {
        let original = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u1\r\nSEQUENCE:2\r\nSUMMARY:Old\r\nDTSTART;TZID=Europe/Amsterdam:20261117T090000\r\nDTEND;TZID=Europe/Amsterdam:20261117T100000\r\nX-OTHER:keep\r\nBEGIN:VALARM\r\nDESCRIPTION:alarm\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let me = Attendee { name: Some("Me".into()), email: "me@example.org".into(), status: None, user: None };
        let event = NewEvent {
            calendar: String::new(),
            summary: "New".into(),
            start: "20261118T080000Z".into(),
            end: "20261118T090000Z".into(),
            location: None,
            description: None,
            attendees: vec![Attendee { name: Some("Bo \"B\"".into()), email: "bo@example.org".into(), status: None, user: None }],
            occurrence: None,
            series: false,
            rrule: None,
            tzid: None,
            vtimezone: None,
        };
        let out = rewrite_event(original, "20261117T000000Z", &event, Some(&me)).unwrap();
        assert!(out.contains("SUMMARY:New") && !out.contains("Old") && !out.contains("TZID"));
        assert!(out.contains("SEQUENCE:3") && out.contains("X-OTHER:keep") && out.contains("DESCRIPTION:alarm"));
        assert!(out.contains("ORGANIZER;CN=\"Me\":mailto:me@example.org"));
        let parsed = parse_events("c", "/h", None, &["me@example.org".into()], &out);
        assert_eq!(parsed[0].attendees[0].email, "bo@example.org");
        assert_eq!(parsed[0].attendees[0].name.as_deref(), Some("Bo B"));
        assert!(parsed[0].mine);
    }

    #[test]
    fn replies_to_invitation() {
        let ics = "BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:u\r\nDTSTART:20261118T080000Z\r\nDTSTAMP:20260101T000000Z\r\nATTENDEE;CN=\"Me, Myself\";PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:me@x.org\r\nATTENDEE;PARTSTAT=ACCEPTED:mailto:bo@x.org\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n";
        let out = set_my_status(ics, "20261117T000000Z", "ME@x.org", "ACCEPTED").unwrap();
        assert!(out.contains("ATTENDEE;CN=\"Me, Myself\";PARTSTAT=ACCEPTED:mailto:me@x.org"));
        assert!(!out.contains("RSVP") && out.contains("DTSTAMP:20261117T000000Z"));
        let parsed = parse_events("c", "/h", None, &["me@x.org".into()], &out);
        assert_eq!(parsed[0].my_status.as_deref(), Some("ACCEPTED"));
        assert!(set_my_status(ics, "s", "other@x.org", "ACCEPTED").is_none());
    }

    #[test]
    fn paths() {
        assert_eq!(encode_path("/a b/c.txt").as_deref(), Some("/a%20b/c%2Etxt"));
        assert_eq!(encode_path("/a/../b"), None);
        assert!(valid_time("20261117T080000Z") && valid_time("20261117") && !valid_time("2026<x>"));
    }
}
