#!/bin/bash
# Builds Basalt Host with no screen for Linux: .deb, .rpm and .tar.gz, for
# amd64 and arm64 (Raspberry Pi and most ARM home servers).
#
#   packaging/build-server.sh OUT_DIR
#
# Run on Linux with Docker. The binaries are built in a Debian 11 container,
# against an older C library than most build machines have, so they run on
# Debian 11+, Ubuntu 20.04+, Raspberry Pi OS 11+, Fedora and the rest. The
# packages are made with dpkg-deb and rpmbuild on the machine running this.
set -euo pipefail

repo=$(cd "$(dirname "$0")/.." && pwd)
out=$(mkdir -p "${1:?usage: build-server.sh OUT_DIR}" && cd "$1" && pwd)
version=$(grep -m1 '^version' "$repo/Cargo.toml" | cut -d'"' -f2)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

echo "Basalt Host (no screen) $version"

# --- Binaries ---------------------------------------------------------------
docker run --rm \
    -v "$repo":/src:ro \
    -v "$work":/out \
    -v basalt-server-cargo:/usr/local/cargo/registry \
    -v basalt-server-target:/target \
    -e CARGO_TARGET_DIR=/target \
    -e CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc \
    -e CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc \
    -w /src \
    rust:1-bullseye bash -euc '
        apt-get update -qq >/dev/null
        apt-get install -y -qq gcc-aarch64-linux-gnu libc6-dev-arm64-cross >/dev/null
        rustup target add aarch64-unknown-linux-gnu >/dev/null 2>&1
        for target in x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu; do
            cargo build --release --locked -p basalt-host --bin basalt-host --target "$target"
        done
        cp /target/x86_64-unknown-linux-gnu/release/basalt-host /out/basalt-host-amd64
        cp /target/aarch64-unknown-linux-gnu/release/basalt-host /out/basalt-host-arm64
        chmod 0755 /out/basalt-host-*
    '

linux="$repo/packaging/linux"
firewall="$repo/apps/host/src-tauri/linux"

for arch in amd64 arm64; do
    case $arch in
        amd64) rpmarch=x86_64 ;;
        arm64) rpmarch=aarch64 ;;
    esac
    binary="$work/basalt-host-$arch"

    # --- .deb ---------------------------------------------------------------
    root="$work/deb-$arch"
    install -D -m 0755 "$binary" "$root/usr/bin/basalt-host"
    install -D -m 0644 "$linux/basalt-host.service" "$root/usr/lib/systemd/system/basalt-host.service"
    install -D -m 0644 "$firewall/basalt-host.ufw" "$root/etc/ufw/applications.d/basalt-host"
    install -D -m 0644 "$linux/README.md" "$root/usr/share/doc/basalt-host-server/README.md"
    install -d "$root/DEBIAN"
    for script in postinst prerm postrm; do
        install -m 0755 "$linux/deb/$script" "$root/DEBIAN/$script"
    done
    echo "/etc/ufw/applications.d/basalt-host" > "$root/DEBIAN/conffiles"
    cat > "$root/DEBIAN/control" <<EOF
Package: basalt-host-server
Version: $version
Architecture: $arch
Maintainer: Refora Technologies
Installed-Size: $(du -sk "$root" | cut -f1)
Depends: libc6 (>= 2.31), passwd
Recommends: ffmpeg, libmpv2 | libmpv1
Conflicts: basalt-host
Section: net
Priority: optional
Homepage: https://github.com/refora-technologies/basalt
Description: Basalt Host with no screen: shares a drive with your devices
 Basalt Host for a computer with no screen: a home server, a Raspberry Pi,
 a NAS. It shares one drive or folder with your phones and computers on this
 network, and is set up and managed from the Basalt app.
EOF
    # xz, not the zstd newer dpkg defaults to: Debian 11 and Raspberry Pi OS 11
    # cannot open zstd packages at all.
    dpkg-deb -Zxz --root-owner-group --build "$root" "$out/Basalt-Host-Server-Linux-$arch.deb" >/dev/null

    # --- .rpm ---------------------------------------------------------------
    sources="$work/rpm-sources-$arch"
    mkdir -p "$sources"
    cp "$binary" "$sources/basalt-host"
    cp "$linux/basalt-host.service" "$linux/README.md" "$sources/"
    cp "$firewall/basalt-host.firewalld.xml" "$sources/"
    sed -e "s/@VERSION@/$version/" -e "s/@RPMARCH@/$rpmarch/" \
        "$linux/rpm/basalt-host-server.spec" > "$work/basalt-host-server-$arch.spec"
    rpmbuild --quiet -bb --target "$rpmarch" \
        --define "_topdir $work/rpmbuild-$arch" \
        --define "_sourcedir $sources" \
        "$work/basalt-host-server-$arch.spec"
    cp "$work/rpmbuild-$arch/RPMS/$rpmarch/"*.rpm "$out/Basalt-Host-Server-Linux-$rpmarch.rpm"

    # --- .tar.gz ------------------------------------------------------------
    bundle="$work/basalt-host-server-$version-linux-$rpmarch"
    mkdir -p "$bundle"
    install -m 0755 "$binary" "$bundle/basalt-host"
    cp "$linux/basalt-host.service" "$linux/README.md" "$bundle/"
    cp "$firewall/basalt-host.ufw" "$firewall/basalt-host.firewalld.xml" "$bundle/"
    tar -C "$work" -czf "$out/Basalt-Host-Server-Linux-$rpmarch.tar.gz" "$(basename "$bundle")"
done

cd "$out"
for file in Basalt-Host-Server-Linux-*; do
    case $file in *.sha256) continue ;; esac
    sha256sum "$file" | sed 's/  / */' > "$file.sha256"
done
ls -la Basalt-Host-Server-Linux-*
