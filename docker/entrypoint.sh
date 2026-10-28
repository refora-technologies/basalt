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
    # Each folder mounted under /media, tried as the user the host runs as.
    # One owned by root (made with sudo, most often) can be browsed and
    # played but takes no uploads, and nothing else says so until one fails.
    for folder in /media/*/; do
        [ -d "$folder" ] || continue
        folder=${folder%/}
        if ! setpriv --reuid="$PUID" --regid="$PGID" "$groups" -- test -w "$folder"; then
            echo "Basalt Host runs as user $PUID, group $PGID, and can't add files to $folder."
            echo "  Browsing and playing work; uploads, new folders, renames and deletes won't."
            echo "  To fix it, on this computer give that user the folder you mounted there:"
            echo "    sudo chown $PUID:$PGID /the/folder/you/mounted"
            echo "  or set PUID and PGID to its owner (ls -ln shows the numbers)."
        fi
    done
    exec setpriv --reuid="$PUID" --regid="$PGID" "$groups" -- basalt-host "$@"
fi

exec basalt-host "$@"
