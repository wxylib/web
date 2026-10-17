#!/bin/sh
# Build the wasm module into www/pkg. Needs the wasm32-unknown-unknown
# target, clang (zstd is C), and wasm-bindgen-cli at the version in
# Cargo.lock:
#   rustup target add wasm32-unknown-unknown
#   cargo install wasm-bindgen-cli --version <Cargo.lock's wasm-bindgen>
set -e
cd "$(dirname "$0")/.."
cargo build --release --target wasm32-unknown-unknown
wasm-bindgen --target web --no-typescript --out-dir www/pkg \
  target/wasm32-unknown-unknown/release/wxy_web.wasm
if command -v wasm-opt >/dev/null; then
  wasm-opt -O3 www/pkg/wxy_web_bg.wasm -o www/pkg/wxy_web_bg.wasm
fi
ls -l www/pkg
