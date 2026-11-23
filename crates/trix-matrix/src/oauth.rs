//! Native OAuth 2.0 sign-in (MSC3861, Matrix Authentication Service): the
//! server's login page opens in the browser and redirects back to a one-off
//! loopback address here (RFC 8252), the way native apps sign in.

use matrix_sdk::authentication::oauth::registration::{ApplicationType, ClientMetadata, Localized, OAuthGrantType};
use matrix_sdk::authentication::oauth::ClientRegistrationData;
use matrix_sdk::ruma::serde::Raw;
use matrix_sdk::Client;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use trix_core::adapter::{AdapterError, Result};
use url::Url;

/// Shown on the server's consent page as the app's home page.
const CLIENT_URI: &str = "https://github.com/william-sy/trixcomm";
/// How long the browser sign-in may take.
const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(600);

fn err(e: impl std::fmt::Display) -> AdapterError {
    AdapterError::Auth(e.to_string())
}

/// Whether the homeserver signs in through OAuth 2.0 (it then usually has no password/SSO login of its own).
pub async fn supported(client: &Client) -> bool {
    client.oauth().server_metadata().await.is_ok()
}

fn metadata(redirect: &Url) -> Result<Raw<ClientMetadata>> {
    let mut metadata = ClientMetadata::new(
        ApplicationType::Native,
        vec![OAuthGrantType::AuthorizationCode { redirect_uris: vec![redirect.clone()] }],
        Localized::new(Url::parse(CLIENT_URI).map_err(err)?, []),
    );
    metadata.client_name = Some(Localized::new("Trixcomm".to_owned(), []));
    Raw::new(&metadata).map_err(err)
}

/// Runs the browser sign-in; returns once the client is logged in.
pub async fn login(client: &Client, open_url: Box<dyn FnOnce(String) -> Result<()> + Send>) -> Result<()> {
    let listener = TcpListener::bind("127.0.0.1:0").await.map_err(err)?;
    let port = listener.local_addr().map_err(err)?.port();
    // Loopback redirects may use any port; servers match them without it (RFC 8252 §7.3).
    let redirect = Url::parse(&format!("http://127.0.0.1:{port}/")).map_err(err)?;
    let oauth = client.oauth();
    let data = oauth
        .login(redirect.clone(), None, Some(ClientRegistrationData::new(metadata(&redirect)?)), None)
        .build()
        .await
        .map_err(err)?;
    open_url(data.url.to_string())?;

    let query = match tokio::time::timeout(TIMEOUT, wait_for_redirect(&listener)).await {
        Ok(result) => result?,
        Err(_) => {
            oauth.abort_login(&data.state).await;
            return Err(err("the sign-in in the browser took too long; try again"));
        }
    };
    let redirected = redirect.join(&format!("?{query}")).map_err(err)?;
    oauth.finish_login(redirected.into()).await.map_err(err)
}

/// Accepts connections until one carries the authorization response, and answers the browser.
async fn wait_for_redirect(listener: &TcpListener) -> Result<String> {
    loop {
        let (mut stream, _) = listener.accept().await.map_err(err)?;
        let mut buf = vec![0u8; 8192];
        let n = stream.read(&mut buf).await.unwrap_or(0);
        let request = String::from_utf8_lossy(&buf[..n]);
        // "GET /?code=...&state=... HTTP/1.1"
        let target = request.lines().next().and_then(|l| l.split_whitespace().nth(1)).unwrap_or_default();
        let Some(query) = target.strip_prefix("/?").filter(|q| q.contains("state=")) else {
            // Favicon and the like.
            let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").await;
            continue;
        };
        let ok = !query.contains("error=");
        let body = format!(
            "<!doctype html><meta charset=utf-8><title>Trixcomm</title><body style=\"font-family:system-ui;text-align:center;padding:4em\"><h2>{}</h2><p>{}</p></body>",
            if ok { "Signed in" } else { "Sign-in cancelled" },
            "You can close this tab and return to Trixcomm."
        );
        let response = format!("HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len());
        let _ = stream.write_all(response.as_bytes()).await;
        let _ = stream.shutdown().await;
        return Ok(query.to_owned());
    }
}
