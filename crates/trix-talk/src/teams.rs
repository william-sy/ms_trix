//! Nextcloud Teams (the Circles app, formerly Circles): the teams you're in, their members, and
//! what's shared with them (core's teams API, Nextcloud 29+: Talk conversations, files, Deck
//! boards, …). For Contacts.

use serde_json::Value;
use trix_core::{ServerTeam, ServerTeamDetails, TeamMember, TeamResource};

pub const CIRCLES: &str = "/ocs/v2.php/apps/circles/circles";

fn text(v: &Value) -> Option<String> {
    v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(ToOwned::to_owned)
}

/// The teams you're a member of (not ones you were only invited to or could join), by name.
pub fn teams(data: &Value, server: &str) -> Vec<ServerTeam> {
    let mut list: Vec<ServerTeam> = data
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["initiator"].is_null() || c["initiator"]["status"] == "Member")
        .filter_map(|c| {
            let id = text(&c["id"]).filter(|id| id.chars().all(|ch| ch.is_ascii_alphanumeric()))?;
            Some(ServerTeam {
                name: text(&c["displayName"]).or_else(|| text(&c["name"]))?,
                description: text(&c["description"]),
                members: c["population"].as_u64().unwrap_or(0) as u32,
                link: text(&c["url"]).map(|u| if u.starts_with('/') { format!("{server}{u}") } else { u }).filter(|u| u.starts_with("https://") || u.starts_with("http://")),
                id,
            })
        })
        .collect();
    list.sort_by_cached_key(|t| t.name.to_lowercase());
    list
}

/// A team's members (owners first) and what's shared with it.
pub fn details(members: &Value, resources: &Value) -> ServerTeamDetails {
    let mut people: Vec<(u64, TeamMember)> = members
        .as_array()
        .into_iter()
        .flatten()
        .filter(|m| m["status"] != "Blocked")
        .filter_map(|m| {
            let kind = match m["userType"].as_u64().unwrap_or(0) {
                1 => "user",
                2 => "group",
                4 => "email",
                8 => "contact",
                16 => "team",
                _ => "other",
            };
            let level = m["level"].as_u64().unwrap_or(1);
            let role = match level {
                9 => "owner",
                8 => "admin",
                4 => "moderator",
                _ => "member",
            };
            Some((level, TeamMember {
                name: text(&m["displayName"]).or_else(|| text(&m["userId"]))?,
                user: (kind == "user").then(|| text(&m["userId"])).flatten(),
                kind: kind.to_owned(),
                role: role.to_owned(),
                pending: m["status"] == "Invited" || m["status"] == "Requesting",
            }))
        })
        .collect();
    people.sort_by(|(a, x), (b, y)| b.cmp(a).then_with(|| x.name.to_lowercase().cmp(&y.name.to_lowercase())));
    let resources = resources["resources"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|r| {
            Some(TeamResource {
                label: text(&r["label"])?,
                url: text(&r["url"]).filter(|u| u.starts_with("https://") || u.starts_with("http://"))?,
                provider: text(&r["provider"]["id"]).unwrap_or_default(),
                provider_name: text(&r["provider"]["name"]).unwrap_or_default(),
                emoji: text(&r["iconEmoji"]),
            })
        })
        .collect();
    ServerTeamDetails { members: people.into_iter().map(|(_, m)| m).collect(), resources }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn your_teams_by_name() {
        let list = teams(&json!([
            { "id": "b2", "name": "zeta", "displayName": "Zeta", "population": 4, "initiator": { "status": "Member", "level": 1 }, "url": "/apps/contacts/circle/b2" },
            { "id": "a1", "name": "alpha", "displayName": "Alpha team", "description": "Us", "population": 12, "initiator": { "status": "Member", "level": 9 } },
            { "id": "c3", "displayName": "Invited only", "initiator": { "status": "Invited" } }
        ]), "https://cloud.example");
        assert_eq!(list.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(), ["Alpha team", "Zeta"]);
        assert_eq!(list[1].link.as_deref(), Some("https://cloud.example/apps/contacts/circle/b2"));
        assert_eq!(list[0].members, 12);
    }

    #[test]
    fn members_and_what_is_shared() {
        let d = details(
            &json!([
                { "userId": "bo", "userType": 1, "displayName": "Bo", "level": 1, "status": "Member" },
                { "userId": "anna", "userType": 1, "displayName": "Anna", "level": 9, "status": "Member" },
                { "userId": "staff", "userType": 2, "displayName": "Staff", "level": 1, "status": "Member" },
                { "userId": "x@example.org", "userType": 4, "displayName": "x@example.org", "level": 1, "status": "Invited" }
            ]),
            &json!({ "resources": [
                { "id": "abc", "label": "Team chat", "url": "https://cloud.example/call/abc", "provider": { "id": "talk", "name": "Talk" } },
                { "id": "1", "label": "No link" }
            ] }),
        );
        assert_eq!(d.members.iter().map(|m| m.name.as_str()).collect::<Vec<_>>(), ["Anna", "Bo", "Staff", "x@example.org"]);
        assert_eq!(d.members[0].role, "owner");
        assert_eq!(d.members[2].user, None);
        assert!(d.members[3].pending);
        assert_eq!(d.resources.len(), 1);
        assert_eq!(d.resources[0].provider, "talk");
    }
}
