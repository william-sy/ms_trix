#!/bin/sh
# Builds DeepFilterNet's noise suppression (denoise/) into models/deepfilternet3.wasm, which is
# committed: the app's builds use that file and don't need this. Run it after changing denoise/.
# Needs rustup with the wasm32 target (rustup target add wasm32-unknown-unknown); the Homebrew
# Rust alone can't build WebAssembly, Homebrew's rustup can (brew install rustup).
#   sh scripts/build-denoise.sh
set -eu
cd "$(dirname "$0")/.."
RUSTUP="$(command -v rustup || echo "$(brew --prefix rustup 2>/dev/null)/bin/rustup")"
CARGO="$("$RUSTUP" which --toolchain stable cargo)"
export RUSTC="$("$RUSTUP" which --toolchain stable rustc)"
# SIMD: WebKit 16.4+, WebView2 and WebKitGTK 2.40+ have it; about twice as fast.
RUSTFLAGS="-C target-feature=+simd128" "$CARGO" build --manifest-path denoise/Cargo.toml --release --target wasm32-unknown-unknown
cp denoise/target/wasm32-unknown-unknown/release/trix_denoise.wasm models/deepfilternet3.wasm
ls -l models/deepfilternet3.wasm
