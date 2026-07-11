#!/bin/sh
# Runs as root so it can fix ownership of bind-mounted volumes, then drops to
# the unprivileged `node` user to actually run the app.
#
# Why this is needed: `docker compose` auto-creates a bind-mounted host
# directory (e.g. `./config:/config`) that doesn't exist yet as root:root,
# which the container's non-root `node` user then can't write into — SQLite
# fails with the same generic "unable to open database file" error whether
# the directory is missing or merely unwritable. Named volumes don't have
# this problem (Docker seeds them from the image, already owned by `node`),
# but bind mounts are common enough to handle here rather than document
# around.
set -e

if [ "$(id -u)" = '0' ]; then
  db_dir=$(dirname "${P2F_DB:-/config/p2f.db}")
  mkdir -p "$db_dir"
  chown node:node "$db_dir"
  exec gosu node "$@"
fi

exec "$@"
