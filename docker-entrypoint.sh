#!/bin/sh
# Run the app as PUID:PGID (default 1000:1000) instead of root, so files in the
# mounted /config belong to the host user. Started with --user, it runs as given.
set -e
if [ "$(id -u)" = 0 ]; then
    PUID=${PUID:-1000}
    PGID=${PGID:-1000}
    # Only touch files with the wrong owner, so a large image cache isn't re-chowned on every start.
    find /config \( ! -user "$PUID" -o ! -group "$PGID" \) -exec chown "$PUID:$PGID" {} +
    exec setpriv --reuid="$PUID" --regid="$PGID" --clear-groups "$@"
fi
exec "$@"
