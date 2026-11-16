//! Prints which login methods a server offers:
//!   cargo run -p trix-matrix --example methods -- matrix.org surf.nl

#[tokio::main]
async fn main() {
    for server in std::env::args().skip(1) {
        match trix_matrix::login_methods(&server).await {
            Ok(m) => println!("{server}: {m:?}"),
            Err(e) => println!("{server}: error: {e}"),
        }
    }
}
