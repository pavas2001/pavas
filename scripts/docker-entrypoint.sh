#!/bin/sh
# Hosting volumes are often mounted owned by root. Fix ownership of /data, then run the app as the
# unprivileged "node" user.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$(dirname "$PIXBERRY_DB")" "$PIXBERRY_BACKUP_DIR"
  chown -R node:node "$(dirname "$PIXBERRY_DB")" "$PIXBERRY_BACKUP_DIR"
  exec setpriv --reuid=node --regid=node --init-groups "$@"
fi
exec "$@"
