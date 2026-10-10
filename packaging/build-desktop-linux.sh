#!/bin/bash
# Builds the desktop Basalt Host for Linux (.deb, .rpm, AppImage).
#
#   packaging/build-desktop-linux.sh OUT_DIR
#
# Built in an Ubuntu 22.04 container rather than on the build machine: a
# program linked against a newer C library does not start on an older one,
# and a build on a new system would leave out Ubuntu 22.04, Debian 12, Linux
# Mint 21 and everything of their age. 22.04 is the oldest with the WebKit
# the window needs, and what Tauri itself recommends building on.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
out=$(mkdir -p "${1:?usage: build-desktop-linux.sh OUT_DIR}" && cd "$1" && pwd)

docker run --rm \
    -v "$repo":/src \
    -v basalt-desktop-cargo:/root/.cargo/registry \
    -v basalt-desktop-target:/target \
    -v basalt-desktop-node:/node \
    -e CARGO_TARGET_DIR=/target \
    -e APPIMAGE_EXTRACT_AND_RUN=1 \
    -e DEBIAN_FRONTEND=noninteractive \
    ubuntu:22.04 bash -euc '
        apt-get update -qq >/dev/null
        apt-get install -y -qq build-essential curl wget file xz-utils patchelf xdg-utils \
            libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev \
            librsvg2-dev >/dev/null
        if [ ! -x /node/bin/node ]; then
            curl -fsSL https://nodejs.org/dist/v22.11.0/node-v22.11.0-linux-x64.tar.xz \
                | tar -xJ -C /node --strip-components=1
        fi
        export PATH=/node/bin:$PATH
        if ! command -v cargo >/dev/null; then
            curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal >/dev/null
        fi
        . /root/.cargo/env
        # The update helper goes into the packages beside the app: see
        # crates/basalt-host/src/bin/basalt-host-update.rs.
        cd /src
        cargo build --release --locked -p basalt-host --bin basalt-host-update
        install -m 0755 /target/release/basalt-host-update apps/host/src-tauri/linux/basalt-host-update
        cd /src/apps/host
        npm ci --silent >/dev/null
        # Only the packages of this build: the cache keeps older ones too.
        rm -rf /target/release/bundle
        npx tauri build
    '

bundle=/var/lib/docker/volumes/basalt-desktop-target/_data/release/bundle
cp "$bundle"/appimage/*.AppImage "$out/Basalt-Host-Linux-x86_64.AppImage"
cp "$bundle"/deb/*.deb "$out/Basalt-Host-Linux-amd64.deb"
cp "$bundle"/rpm/*.rpm "$out/Basalt-Host-Linux-x86_64.rpm"
# The bundler cannot name a vendor in an .rpm; this adds it.
docker run --rm -v "$out":/out -v "$repo/packaging/linux/rpm":/rpm:ro fedora:latest bash /rpm/set-vendor.sh /out/Basalt-Host-Linux-x86_64.rpm
cd "$out"
for file in Basalt-Host-Linux-*; do
    case $file in *.sha256) continue ;; esac
    sha256sum "$file" | sed 's/  / */' > "$file.sha256"
done
ls -la Basalt-Host-Linux-*
