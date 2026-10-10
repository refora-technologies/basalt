#!/bin/bash
# Names Refora Technologies as the vendor and packager of an .rpm the Tauri bundler made,
# which has no setting for it. Runs inside a Fedora container:
#
#   set-vendor.sh FILE.rpm
#
# The package is rebuilt with only its header changed; its files and scripts
# stay as they were.
set -euo pipefail

rpm_file=$1
work=$(mktemp -d)
dnf install -y -q rpmrebuild >/dev/null 2>&1
rpmrebuild --package --notest-install --directory="$work" \
    --change-spec-preamble="sed -e '/^Name:/a Vendor: Refora Technologies\nPackager: Refora Technologies <reforatech@gmail.com>'" \
    "$rpm_file" >/dev/null
mv "$work"/*/*.rpm "$rpm_file"
rpm -qip "$rpm_file" | grep -E '^(Name|Version|Vendor|Packager)'
