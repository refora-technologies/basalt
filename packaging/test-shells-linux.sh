#!/bin/bash
# Runs the tests of the two app shells (apps/client/src-tauri and
# apps/host/src-tauri) on Linux, in the Ubuntu 22.04 container the Linux
# packages are built in.
#
#   packaging/test-shells-linux.sh
#
# The shells are outside the Cargo workspace, so `cargo test --all` and the
# pre-commit checks never run their tests, and their Linux-only code (the
# film player, for one) is not even compiled on Windows. Run before every
# release, on Linux with Docker.
set -euo pipefail

repo="$(cd "$(dirname "$0")/.." && pwd)"

docker run --rm \
    -v "$repo":/src \
    -v basalt-desktop-cargo:/root/.cargo/registry \
    -v basalt-shells-test:/target \
    -v basalt-desktop-node:/node \
    -v basalt-client-node-modules:/src/apps/client/node_modules \
    -v basalt-host-node-modules:/src/apps/host/node_modules \
    -e CARGO_TARGET_DIR=/target \
    -e DEBIAN_FRONTEND=noninteractive \
    ubuntu:22.04 bash -euc '
        apt-get update -qq >/dev/null
        apt-get install -y -qq build-essential curl xz-utils \
            libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev \
            librsvg2-dev libmpv-dev >/dev/null
        if [ ! -x /node/bin/node ]; then
            curl -fsSL https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz \
                | tar -xJ -C /node --strip-components=1
        fi
        export PATH=/node/bin:$PATH
        if ! command -v cargo >/dev/null; then
            curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal >/dev/null
        fi
        . /root/.cargo/env
        for app in client host; do
            echo "== $app shell"
            cd /src/apps/$app
            # The shell embeds the built page, so it has to exist.
            npm ci --silent >/dev/null
            npx vite build --logLevel error >/dev/null
            cd src-tauri
            cargo test 2>&1 | grep -E "^test |^test result|panicked|^error" || true
            cargo test --quiet >/dev/null 2>&1 || { echo "FAILED: $app shell tests"; exit 1; }
        done
        echo "== both shells passed"
    '
