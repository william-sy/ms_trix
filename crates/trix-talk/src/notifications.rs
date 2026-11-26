//! Nextcloud's own notifications (the notifications app's OCS API, v2): what the server tells you
//! besides the chats, such as a file shared with you or a calendar invitation. And the apps it
//! offers in its web pages (its app menu), for More in the rail.

use serde_json::Value;
use trix_core::{RichPart, ServerAction, ServerApp, ServerNotification};

/// The server's app menu (core/navigation/apps with absolute addresses), in its order.
pub fn apps(data: &Value) -> Vec<ServerApp> {
    let mut list: Vec<(i64, ServerApp)> = data.as_array().into_iter().flatten().filter_map(|a| {
        let href = text(&a["href"]).filter(|h| h.starts_with("https://") || h.starts_with("http://"))?;
        Some((a["order"].as_i64().unwrap_or(i64::MAX), ServerApp { id: text(&a["id"])?, name: text(&a["name"])?, href, icon: text(&a["icon"]) }))
    }).collect();
    list.sort_by_key(|(order, _)| *order);
    list.into_iter().map(|(_, app)| app).collect()
}

pub const PATH: &str = "/ocs/v2.php/apps/notifications/api/v2/notifications";

/// The list as the server (at `server`) sends it, newest first.
pub fn parse(data: &Value, server: &str) -> Vec<ServerNotification> {
    let mut list: Vec<ServerNotification> = data.as_array().into_iter().flatten().filter_map(one).collect();
    // A file named by its id alone: its /f/ link, which the app can find in your files (Show in Files).
    for part in list.iter_mut().flat_map(|n| n.subject.iter_mut().chain(n.message.iter_mut())) {
        if part.kind.as_deref() == Some("file") && part.link.is_none() && part.path.is_none() {
            part.link = part.id.as_deref().filter(|id| id.chars().all(|c| c.is_ascii_digit())).map(|id| format!("{server}/f/{id}"));
        }
    }
    list
}

fn text(v: &Value) -> Option<String> {
    v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(ToOwned::to_owned)
}

fn one(n: &Value) -> Option<ServerNotification> {
    // Rich (with names of things) where the server gives it, else the plain text.
    let rich = |kind: &str| {
        let pieces = parts(n[format!("{kind}Rich")].as_str().unwrap_or_default(), &n[format!("{kind}RichParameters")]);
        if pieces.is_empty() { text(&n[kind]).map(plain).into_iter().collect() } else { pieces }
    };
    Some(ServerNotification {
        id: n["notification_id"].as_i64()?,
        app: text(&n["app"]).unwrap_or_default(),
        object_type: text(&n["object_type"]).unwrap_or_default(),
        at: n["datetime"].as_str().and_then(iso_millis).unwrap_or(0),
        subject: rich("subject"),
        message: rich("message"),
        link: text(&n["link"]),
        icon: text(&n["icon"]),
        actions: n["actions"].as_array().into_iter().flatten().filter_map(|a| {
            Some(ServerAction { label: text(&a["label"])?, link: text(&a["link"])?, method: text(&a["type"])?.to_uppercase(), primary: a["primary"].as_bool().unwrap_or(false) })
        }).collect(),
        alert: n["shouldNotify"].as_bool().unwrap_or(true),
    })
}

fn plain(text: String) -> RichPart {
    RichPart { text, kind: None, id: None, link: None, path: None }
}

/// "{user} shared {file} with you" and its parameters, in pieces; an unknown {placeholder} stays text.
fn parts(rich: &str, params: &Value) -> Vec<RichPart> {
    let mut out: Vec<RichPart> = Vec::new();
    let push = |out: &mut Vec<RichPart>, s: &str| {
        if s.is_empty() {
            return;
        }
        match out.last_mut() {
            Some(last) if last.kind.is_none() => last.text.push_str(s),
            _ => out.push(plain(s.to_owned())),
        }
    };
    let mut rest = rich;
    while let Some(open) = rest.find('{') {
        let Some(close) = rest[open..].find('}').map(|c| open + c) else { break };
        let param = &params[&rest[open + 1..close]];
        match text(&param["name"]) {
            Some(name) => {
                push(&mut out, &rest[..open]);
                let id = text(&param["id"]).or_else(|| param["id"].as_i64().map(|n| n.to_string()));
                out.push(RichPart { text: name, kind: text(&param["type"]), id, link: text(&param["link"]), path: text(&param["path"]) });
            }
            None => push(&mut out, &rest[..=close]),
        }
        rest = &rest[close + 1..];
    }
    push(&mut out, rest);
    out
}

/// "2026-11-26T09:30:00+01:00" (or "…Z") as milliseconds since 1970.
fn iso_millis(v: &str) -> Option<i64> {
    let num = |r: std::ops::Range<usize>| v.get(r)?.parse::<i64>().ok();
    let days = crate::dav::days_from_civil(num(0..4)?, num(5..7)? as u32, num(8..10)? as u32);
    let secs = days * 86_400 + num(11..13)? * 3600 + num(14..16)? * 60 + num(17..19)?;
    // After the seconds (and any fraction): "Z", or "+01:00" / "-0500".
    let zone = v[19..].trim_start_matches(|c: char| c == '.' || c.is_ascii_digit());
    let digits: String = zone.chars().filter(char::is_ascii_digit).collect();
    let offset = digits.get(0..2).and_then(|h| h.parse::<i64>().ok()).unwrap_or(0) * 3600 + digits.get(2..4).and_then(|m| m.parse::<i64>().ok()).unwrap_or(0) * 60;
    let sign = if zone.starts_with('-') { -1 } else { 1 };
    Some((secs - sign * offset) * 1000)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_share_in_pieces() {
        let data = json!([{
            "notification_id": 12, "app": "files_sharing", "object_type": "share", "datetime": "2026-11-26T09:30:00+01:00",
            "subject": "Anna shared report.pdf with you",
            "subjectRich": "{user} shared {file} with you",
            "subjectRichParameters": {
                "user": { "type": "user", "id": "anna", "name": "Anna" },
                "file": { "type": "file", "id": 4711, "name": "report.pdf", "link": "https://cloud.example/f/4711", "path": "Shared/report.pdf" }
            },
            "message": "", "link": "https://cloud.example/f/4711", "icon": "https://cloud.example/apps/files_sharing/img/app-dark.svg",
            "actions": [{ "label": "Accept", "link": "https://cloud.example/ocs/v2.php/apps/files_sharing/api/v1/remote_shares/pending/3", "type": "post", "primary": true }]
        }]);
        let list = parse(&data, "https://cloud.example");
        assert_eq!(list.len(), 1);
        let n = &list[0];
        assert_eq!(n.at, (days(2026, 11, 26) * 86_400 + 8 * 3600 + 30 * 60) * 1000);
        assert_eq!(n.subject.iter().map(|p| p.text.as_str()).collect::<String>(), "Anna shared report.pdf with you");
        assert_eq!(n.subject[0].kind.as_deref(), Some("user"));
        assert_eq!(n.subject[2].id.as_deref(), Some("4711"));
        assert_eq!(n.subject[2].path.as_deref(), Some("Shared/report.pdf"));
        assert_eq!(n.subject[3], plain(" with you".into()));
        assert_eq!(n.actions[0].method, "POST");
        assert!(n.alert && n.message.is_empty());
        // Talk's call recording: the file is named in the message.
        let recording = &parse(&json!([{ "notification_id": 3, "subject": "Call recording now available", "subjectRich": "Call recording now available", "subjectRichParameters": [],
            "messageRich": "The recording for the call in {call} was uploaded to {file}.",
            "messageRichParameters": { "call": { "type": "call", "id": "9", "name": "Team" }, "file": { "type": "file", "id": "78", "name": "Recording.webm" } } }]), "https://cloud.example")[0];
        assert_eq!(recording.subject, vec![plain("Call recording now available".into())]);
        assert_eq!(recording.message[3].link.as_deref(), Some("https://cloud.example/f/78"));
    }

    #[test]
    fn plain_subjects_and_unknown_placeholders() {
        let n = &parse(&json!([{ "notification_id": 1, "subject": "Update available", "datetime": "2026-01-02T03:04:05Z", "shouldNotify": false }]), "https://cloud.example")[0];
        assert_eq!(n.subject, vec![plain("Update available".into())]);
        assert_eq!(n.at, (days(2026, 1, 2) * 86_400 + 3 * 3600 + 4 * 60 + 5) * 1000);
        assert!(!n.alert);
        assert_eq!(parts("{who} said {x}", &json!({ "who": { "name": "Bo" } })).iter().map(|p| p.text.as_str()).collect::<String>(), "Bo said {x}");
        let recording = &parse(&json!([{ "notification_id": 2, "subjectRich": "Recording ready: {file}", "subjectRichParameters": { "file": { "type": "file", "id": "77", "name": "Recording.webm" } } }]), "https://cloud.example")[0];
        assert_eq!(recording.subject[1].link.as_deref(), Some("https://cloud.example/f/77"));
        assert_eq!(iso_millis("2026-01-02T03:04:05-0500"), Some((days(2026, 1, 2) * 86_400 + 8 * 3600 + 4 * 60 + 5) * 1000));
    }

    #[test]
    fn the_app_menu_in_order() {
        let list = apps(&json!([
            { "id": "photos", "order": 3, "href": "https://cloud.example/apps/photos/", "icon": "https://cloud.example/apps/photos/img/app.svg", "name": "Photos", "type": "link" },
            { "id": "files", "order": 1, "href": "https://cloud.example/apps/files/", "icon": "https://cloud.example/apps/files/img/app.svg", "name": "Files", "type": "link" },
            { "id": "odd", "order": 2, "href": "/apps/odd/", "name": "Not absolute" }
        ]));
        assert_eq!(list.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), ["files", "photos"]);
    }

    fn days(y: i64, m: u32, d: u32) -> i64 {
        crate::dav::days_from_civil(y, m, d)
    }
}
