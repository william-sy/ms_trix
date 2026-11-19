//! Link previews, fetched by the app itself rather than through the homeserver (which would
//! learn every link shared in an encrypted chat). Public web addresses only (nothing on your own
//! network, checked again after every redirect), no cookies, and limits on size and time.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine as _;
use reqwest::{Response, StatusCode, Url};
use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkPreview {
    /// Where the link ended up after redirects.
    pub final_url: String,
    pub site_name: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    /// The page's picture, as a data: URL.
    pub image: Option<String>,
}

const PAGE_MAX: usize = 512 * 1024;
const IMAGE_MAX: usize = 1536 * 1024;
const REDIRECTS: usize = 5;
const CACHE_MAX: usize = 300;
/// A link without a preview is tried again after this (the network may have been down).
const RETRY_AFTER: Duration = Duration::from_secs(600);

static CACHE: Mutex<Option<HashMap<String, (Instant, Option<LinkPreview>)>>> = Mutex::new(None);

pub async fn preview(url: &str) -> Option<LinkPreview> {
    if let Some((at, hit)) = CACHE.lock().unwrap().as_ref().and_then(|c| c.get(url).cloned()) {
        if hit.is_some() || at.elapsed() < RETRY_AFTER {
            return hit;
        }
    }
    let result = fetch_preview(url).await;
    let mut cache = CACHE.lock().unwrap();
    let cache = cache.get_or_insert_with(HashMap::new);
    if cache.len() >= CACHE_MAX {
        cache.clear();
    }
    cache.insert(url.to_owned(), (Instant::now(), result.clone()));
    result
}

fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            // Redirects are followed by hand, so every hop is checked (see `get`).
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(8))
            .user_agent("Mozilla/5.0 (compatible; ms_trix link preview)")
            .build()
            .expect("http client")
    })
}

async fn fetch_preview(url: &str) -> Option<LinkPreview> {
    let (final_url, response) = get(Url::parse(url).ok()?, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.5").await?;
    let html_page = content_type(&response).is_some_and(|t| t.starts_with("text/html") || t.starts_with("application/xhtml"));
    if !html_page {
        return None;
    }
    let body = read_limited(response, PAGE_MAX, true).await?;
    let meta = page_meta(&String::from_utf8_lossy(&body));
    if meta.title.is_none() && meta.description.is_none() {
        return None;
    }
    let image = match meta.image.as_deref().and_then(|i| final_url.join(i).ok()) {
        Some(image_url) => fetch_image(image_url).await,
        None => None,
    };
    let site = meta.site.or_else(|| final_url.host_str().map(|h| h.trim_start_matches("www.").to_owned()));
    Some(LinkPreview { final_url: final_url.to_string(), site_name: site, title: meta.title, description: meta.description, image })
}

async fn fetch_image(url: Url) -> Option<String> {
    let (_, response) = get(url, "image/*").await?;
    let kind = content_type(&response)?;
    // An SVG can carry scripts; pictures only.
    if !kind.starts_with("image/") || kind.starts_with("image/svg") {
        return None;
    }
    let data = read_limited(response, IMAGE_MAX, false).await?;
    Some(format!("data:{kind};base64,{}", base64::engine::general_purpose::STANDARD.encode(data)))
}

/// GETs `url`, following redirects (each to a public address): where it ended, and the response.
async fn get(mut url: Url, accept: &str) -> Option<(Url, Response)> {
    for _ in 0..=REDIRECTS {
        if !public(&url).await {
            return None;
        }
        let response = client().get(url.clone()).header("Accept", accept).send().await.ok()?;
        if response.status().is_redirection() {
            let location = response.headers().get("location")?.to_str().ok()?;
            url = url.join(location).ok()?;
            continue;
        }
        return (response.status() == StatusCode::OK).then_some((url, response));
    }
    None
}

fn content_type(response: &Response) -> Option<String> {
    let value = response.headers().get("content-type")?.to_str().ok()?;
    Some(value.split(';').next()?.trim().to_ascii_lowercase())
}

/// The body, up to `max` bytes: cut off there (`truncate`, for a page whose head is enough) or
/// given up on (a picture that's too big).
async fn read_limited(mut response: Response, max: usize, truncate: bool) -> Option<Vec<u8>> {
    let mut out = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        out.extend_from_slice(&chunk);
        if out.len() > max {
            if !truncate {
                return None;
            }
            out.truncate(max);
            break;
        }
    }
    Some(out)
}

/// A web address on the public internet: not this computer, the local network or the like.
async fn public(url: &Url) -> bool {
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = url.host_str() else { return false };
    let port = url.port_or_known_default().unwrap_or(443);
    let Ok(addresses) = tokio::net::lookup_host((host.trim_matches(['[', ']']), port)).await else { return false };
    let addresses: Vec<_> = addresses.collect();
    !addresses.is_empty() && addresses.iter().all(|a| is_public(a.ip()))
}

fn is_public(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let [a, b, ..] = v4.octets();
            !(v4.is_private() || v4.is_loopback() || v4.is_link_local() || v4.is_broadcast() || v4.is_documentation() || v4.is_unspecified() || v4.is_multicast()
                || a == 0
                || (a == 100 && (b & 0xc0) == 64)) // carrier-grade NAT, 100.64.0.0/10
        }
        IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            !(v6.is_loopback() || v6.is_unspecified() || v6.is_multicast()
                || (first & 0xfe00) == 0xfc00 // unique local
                || (first & 0xffc0) == 0xfe80) // link local
                && v6.to_ipv4_mapped().is_none_or(|v4| is_public(IpAddr::V4(v4)))
        }
    }
}

#[derive(Debug, Default, PartialEq)]
struct Meta {
    title: Option<String>,
    description: Option<String>,
    site: Option<String>,
    image: Option<String>,
}

/// Title, description, site name and picture from a page's head (Open Graph, Twitter cards, or
/// the plain title and description).
fn page_meta(html: &str) -> Meta {
    // ASCII lowercasing keeps byte positions, so positions found in `lower` work in `html`.
    let lower = html.to_ascii_lowercase();
    let head_end = lower.find("</head>").unwrap_or(lower.len());
    let mut tags: HashMap<String, String> = HashMap::new();
    let mut at = 0;
    while at < head_end {
        let Some(found) = lower[at..head_end].find("<meta") else { break };
        let start = at + found + "<meta".len();
        let end = lower[start..].find('>').map_or(lower.len(), |e| start + e);
        let attributes = attributes(&html[start..end]);
        let key = attributes.iter().find(|(n, _)| n == "property" || n == "name").map(|(_, v)| v.to_ascii_lowercase());
        let content = attributes.iter().find(|(n, _)| n == "content").map(|(_, v)| v.clone());
        if let (Some(key), Some(content)) = (key, content) {
            tags.entry(key).or_insert(content);
        }
        at = end;
    }
    let title_tag = lower.find("<title").and_then(|s| {
        let open = s + lower[s..].find('>')? + 1;
        let close = open + lower[open..].find("</title>")?;
        Some(decode_entities(&html[open..close]))
    });
    let pick = |keys: &[&str]| keys.iter().find_map(|k| tags.get(*k)).map(|v| tidy(v, 300)).filter(|v| !v.is_empty());
    Meta {
        title: pick(&["og:title", "twitter:title"]).or_else(|| title_tag.map(|t| tidy(&t, 300)).filter(|t| !t.is_empty())).map(|t| shorten(t, 200)),
        description: pick(&["og:description", "twitter:description", "description"]),
        site: pick(&["og:site_name"]).map(|s| shorten(s, 80)),
        image: ["og:image", "og:image:url", "og:image:secure_url", "twitter:image", "twitter:image:src"].iter().find_map(|k| tags.get(*k)).map(|v| v.trim().to_owned()),
    }
}

/// The attributes of a tag (what follows its name, up to `>`), values decoded.
fn attributes(tag: &str) -> Vec<(String, String)> {
    let b = tag.as_bytes();
    let mut out = vec![];
    let mut i = 0;
    while i < b.len() {
        while i < b.len() && (b[i].is_ascii_whitespace() || b[i] == b'/') {
            i += 1;
        }
        let start = i;
        while i < b.len() && !b[i].is_ascii_whitespace() && !matches!(b[i], b'=' | b'/') {
            i += 1;
        }
        let name = tag[start..i].to_ascii_lowercase();
        while i < b.len() && b[i].is_ascii_whitespace() {
            i += 1;
        }
        if i < b.len() && b[i] == b'=' {
            i += 1;
            while i < b.len() && b[i].is_ascii_whitespace() {
                i += 1;
            }
            let value = if i < b.len() && matches!(b[i], b'"' | b'\'') {
                let quote = b[i];
                let from = i + 1;
                i = from;
                while i < b.len() && b[i] != quote {
                    i += 1;
                }
                let value = &tag[from..i];
                i += 1;
                value
            } else {
                let from = i;
                while i < b.len() && !b[i].is_ascii_whitespace() {
                    i += 1;
                }
                &tag[from..i]
            };
            if !name.is_empty() {
                out.push((name, decode_entities(value)));
            }
        } else if name.is_empty() {
            i += 1;
        }
    }
    out
}

fn decode_entities(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(amp) = rest.find('&') {
        out.push_str(&rest[..amp]);
        rest = &rest[amp..];
        let Some(semi) = rest[..rest.len().min(12)].find(';') else {
            out.push('&');
            rest = &rest[1..];
            continue;
        };
        let entity = &rest[1..semi];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|h| u32::from_str_radix(h, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|d| d.parse().ok()))
                .and_then(char::from_u32),
        };
        match decoded {
            Some(c) => {
                out.push(c);
                rest = &rest[semi + 1..];
            }
            None => {
                out.push('&');
                rest = &rest[1..];
            }
        }
    }
    out.push_str(rest);
    out
}

/// Whitespace collapsed, at most `max` characters.
fn tidy(text: &str, max: usize) -> String {
    shorten(text.split_whitespace().collect::<Vec<_>>().join(" "), max)
}

fn shorten(text: String, max: usize) -> String {
    if text.chars().count() <= max {
        return text;
    }
    let mut cut: String = text.chars().take(max - 1).collect();
    cut.push('…');
    cut
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_open_graph_and_falls_back_to_the_title() {
        let html = r#"<html><head><title>Plain &amp; simple</title>
            <meta property="og:title" content="Rich &quot;title&quot;">
            <meta name=description content='A page about &#x27;things&#39;'>
            <META PROPERTY="og:image" CONTENT="/pic.png" /></head><body><meta property="og:title" content="not this"></body>"#;
        let meta = page_meta(html);
        assert_eq!(meta.title.as_deref(), Some("Rich \"title\""));
        assert_eq!(meta.description.as_deref(), Some("A page about 'things'"));
        assert_eq!(meta.image.as_deref(), Some("/pic.png"));
        assert_eq!(page_meta("<title>\n  Only   a title </title>").title.as_deref(), Some("Only a title"));
    }

    #[test]
    #[ignore = "needs the internet"]
    fn previews_a_real_page() {
        let preview = tauri::async_runtime::block_on(preview("https://www.surf.nl/")).expect("a preview");
        println!("{} | {:?} | {:?} | image: {}", preview.final_url, preview.site_name, preview.title, preview.image.as_ref().map_or(0, |i| i.len()));
        assert!(preview.title.is_some());
        assert!(tauri::async_runtime::block_on(preview_local()).is_none());
    }

    async fn preview_local() -> Option<LinkPreview> {
        fetch_preview("http://127.0.0.1:1420/").await
    }

    #[test]
    fn local_addresses_are_not_public() {
        for ip in ["127.0.0.1", "10.1.2.3", "192.168.11.29", "172.16.0.1", "169.254.1.1", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:192.168.1.1"] {
            assert!(!is_public(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["145.100.1.1", "2001:610::1"] {
            assert!(is_public(ip.parse().unwrap()), "{ip}");
        }
    }
}
