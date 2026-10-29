#!/bin/sh
# Runs Basalt Host as the user that owns the folders you mounted under /media,
# so it can add files to them with nothing else to set; or as PUID:PGID when
# those are set. Gives that user /config.
set -e

if [ "$(id -u)" = "0" ]; then
    # Who owns what you shared: the first folder under /media. Set PUID and
    # PGID to choose another user.
    owner=""
    first=""
    for folder in /media/*/; do
        [ -d "$folder" ] || continue
        first=${folder%/}
        owner=$(stat -c '%u %g' "$first")
        break
    done
    if [ -n "${PUID:-}" ] && [ -n "${PGID:-}" ]; then
        echo "Basalt Host runs as user $PUID, group $PGID, as PUID and PGID say."
    elif [ -n "$owner" ]; then
        PUID=${PUID:-${owner% *}}
        PGID=${PGID:-${owner#* }}
        if [ "$PUID" = "0" ]; then
            echo "Basalt Host runs as root, the owner of $first, so it can add files there."
            echo "  To run it as another user, give that user the folder, or set PUID and PGID."
        else
            echo "Basalt Host runs as user $PUID, group $PGID: the owner of $first."
        fi
    else
        # Nothing shared yet: the usual first user of a NAS or a Linux box.
        PUID=${PUID:-1000}
        PGID=${PGID:-1000}
        echo "Basalt Host runs as user $PUID, group $PGID. No folder is mounted under /media yet."
    fi
    export PUID PGID

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
    # One it cannot change (a second folder owned by someone else, say) can be
    # browsed and played but takes no uploads, and nothing else says so until
    # one fails.
    for folder in /media/*/; do
        [ -d "$folder" ] || continue
        folder=${folder%/}
        if ! setpriv --reuid="$PUID" --regid="$PGID" "$groups" -- test -w "$folder"; then
            echo "Basalt Host runs as user $PUID, group $PGID, and can't add files to $folder."
            echo "  Browsing and playing work; uploads, new folders, renames and deletes won't."
            echo "  To fix it, on this computer give that user the folder you mounted there:"
            echo "    sudo chown $PUID:$PGID /the/folder/you/mounted"
            if [ -n "$owner" ] && [ "$PUID:$PGID" != "${owner% *}:${owner#* }" ] && [ "$folder" = "$first" ]; then
                echo "  or take PUID and PGID out: Basalt Host then runs as the folder's owner by itself."
            else
                echo "  or mount folders that one user owns."
            fi
        fi
    done
    exec setpriv --reuid="$PUID" --regid="$PGID" "$groups" -- basalt-host "$@"
fi

exec basalt-host "$@"
