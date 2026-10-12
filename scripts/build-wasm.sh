#!/bin/sh
# Reproducible build of the contracts.
#
# The release wasm embeds the absolute path of the Cargo registry in the panic
# messages of its dependencies (soroban-sdk), so a native `cargo build` gives a
# different hash on every machine. This script builds inside a pinned image,
# where that path is always /usr/local/cargo, so anyone gets the same bytes.
#
#   scripts/build-wasm.sh           build and print the hashes
#   scripts/build-wasm.sh --check   also compare them with contracts/wasm.sha256
#
# Requires Docker. Runs on Linux, macOS and WSL. The output is written to
# contracts/target/reproducible/wasm32-unknown-unknown/release/.
set -eu

IMAGE="rust:1.93.1-slim-bookworm@sha256:5b9332190bb3b9ece73b810cd1f1e9f06343b294ce184bcb067f0747d7d333ea"
ROOT=$(cd "$(dirname "$0")/.." && pwd)

CHECK=""
if [ "${1:-}" = "--check" ]; then
  CHECK="&& sha256sum -c /src/wasm.sha256"
fi

docker run --rm --platform linux/amd64 \
  --user "$(id -u):$(id -g)" -e HOME=/tmp \
  -e CARGO_TARGET_DIR=/src/target/reproducible \
  -v "$ROOT/contracts:/src" -w /src \
  "$IMAGE" sh -c "
    rustup target add wasm32-unknown-unknown >/dev/null &&
    cargo build --locked --release --target wasm32-unknown-unknown &&
    cd target/reproducible/wasm32-unknown-unknown/release &&
    sha256sum harmony_factory.wasm harmony_organization.wasm $CHECK
  "
