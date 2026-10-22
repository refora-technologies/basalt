#!/bin/bash
# Builds the Basalt app for Linux (.deb, .rpm, AppImage).
#
#   packaging/build-client-linux.sh OUT_DIR
#
# The same as build-desktop-linux.sh, which builds Basalt Host. The app plays
# films with the system's libmpv, which the packages depend on (see
# apps/client/src-tauri/src/linux_player.rs); the AppImage needs it installed.
#
# Built in an Ubuntu 22.04 container rather than on the build machine: a
# program linked against a newer C library does not start on an older one,
# and a build on a new system would leave out Ubuntu 22.04, Debian 12, Linux
# Mint 21 and everything of their age. 22.04 is the oldest with the WebKit
# the window needs, and what Tauri itself recommends building on.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
out=$(mkdir -p "${1:?usage: build-desktop-linux.sh OUT_DIR}" && cd "$1" && pwd)

# node_modules is a volume of its own: npm ci in the shared checkout would
# replace the Windows packages beside it with Linux ones.
docker run --rm \
    -v "$repo":/src \
    -v basalt-desktop-cargo:/root/.cargo/registry \
    -v basalt-client-release:/target \
    -v basalt-desktop-node:/node \
    -v basalt-client-node-modules:/src/apps/client/node_modules \
    -e CARGO_TARGET_DIR=/target \
    -e APPIMAGE_EXTRACT_AND_RUN=1 \
    -e DEBIAN_FRONTEND=noninteractive \
    ubuntu:22.04 bash -euc '
        apt-get update -qq >/dev/null
        apt-get install -y -qq build-essential curl wget file xz-utils patchelf xdg-utils \
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
        cd /src/apps/client
        npm ci --silent >/dev/null
        # Only the packages of this build: the cache keeps older ones too.
        rm -rf /target/release/bundle
        npx tauri build

        # The AppImage without the Wayland libraries the bundler copied in
        # from this Ubuntu 22.04: newer systems graphics drivers do not work
        # with them, and on Ubuntu 26.04 the page could not start at all
        # ("Could not create default EGL display"). Every Linux desktop has
        # its own, as GTK needs them. Repacked with the appimagetool the
        # bundler fetched for itself.
        image=$(ls /target/release/bundle/appimage/*.AppImage)
        rm -rf /tmp/repack && mkdir -p /tmp/repack/tool && cd /tmp/repack
        "$image" --appimage-extract >/dev/null
        rm -f squashfs-root/usr/lib/libwayland-*
        (cd tool && /root/.cache/tauri/linuxdeploy-plugin-appimage.AppImage --appimage-extract >/dev/null)
        ARCH=x86_64 tool/squashfs-root/usr/bin/appimagetool --no-appstream squashfs-root "$image" >/dev/null 2>&1
        ls squashfs-root/usr/lib | grep -q "^libwayland-" && { echo "Wayland libraries still in the AppImage"; exit 1; }
        cd /src/apps/client
    '

bundle=/var/lib/docker/volumes/basalt-client-release/_data/release/bundle
cp "$bundle"/appimage/*.AppImage "$out/Basalt-Client-Linux-x86_64.AppImage"
cp "$bundle"/deb/*.deb "$out/Basalt-Client-Linux-amd64.deb"
cp "$bundle"/rpm/*.rpm "$out/Basalt-Client-Linux-x86_64.rpm"
# The bundler writes the publisher's name alone as the .deb's maintainer;
# packages name a way to reach them too.
deb_dir=$(mktemp -d)
dpkg-deb -R "$out/Basalt-Client-Linux-amd64.deb" "$deb_dir/pkg"
sed -i 's/^Maintainer: .*/Maintainer: Refora Technologies <reforatech@gmail.com>/' "$deb_dir/pkg/DEBIAN/control"
dpkg-deb -Zxz --root-owner-group -b "$deb_dir/pkg" "$out/Basalt-Client-Linux-amd64.deb" >/dev/null
rm -rf "$deb_dir"
# The bundler cannot name a vendor in an .rpm; this adds it.
docker run --rm -v "$out":/out -v "$repo/packaging/linux/rpm":/rpm:ro fedora:latest bash /rpm/set-vendor.sh /out/Basalt-Client-Linux-x86_64.rpm
cd "$out"
for file in Basalt-Client-Linux-*; do
    case $file in *.sha256) continue ;; esac
    sha256sum "$file" | sed 's/  / */' > "$file.sha256"
done
ls -la Basalt-Client-Linux-*
