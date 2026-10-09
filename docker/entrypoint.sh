#!/bin/sh
# Runs Basalt Host as PUID:PGID (1000:1000 unless set), the user that owns
# the shared folders on most NAS systems, and gives it /config.
set -e

if [ "$(id -u)" = "0" ]; then
    mkdir -p /config
    # The host's settings are its user's alone: they hold its identity.
    chown -R "$PUID:$PGID" /config
    chmod 0700 /config
    export HOME=/config
    # With the graphics device passed in, the group that may use it, so
    # ffmpeg can convert on it.
    groups=--clear-groups
    if [ -e /dev/dri/renderD128 ]; then
        groups="--groups=$(stat -c %g /dev/dri/renderD128)"
    fi
    exec setpriv --reuid="$PUID" --regid="$PGID" "$groups" -- basalt-host "$@"
fi

exec basalt-host "$@"
