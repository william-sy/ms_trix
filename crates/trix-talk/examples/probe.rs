//! Starts Login Flow v2 against a server and stops at the browser step:
//!   cargo run -p trix-talk --example probe -- cloud.example.org

#[tokio::main]
async fn main() {
    let server = std::env::args().nth(1).expect("server");
    let result = trix_talk::login(&server, Box::new(|url| {
        println!("login page: {url}");
        Err(trix_core::adapter::AdapterError::Other("stopped at browser step (probe)".into()))
    }))
    .await;
    if let Err(e) = result {
        println!("{e}");
    }
}
