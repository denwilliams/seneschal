#!/bin/sh
# The Compose sandbox override may mount Docker's socket with a group that is
# only knowable inside this container (Docker Desktop commonly remaps it).
# Start as root only long enough to add that supplementary group, then exec the
# harness as the image's unprivileged `node` user. No agent-controlled file is
# consulted before privileges are dropped.
set -eu

if [ -S /var/run/docker.sock ]; then
  docker_gid="$(stat -c '%g' /var/run/docker.sock)"
  exec setpriv --reuid=node --regid=node --groups="$docker_gid" env HOME=/home/node USER=node LOGNAME=node "$@"
fi

exec setpriv --reuid=node --regid=node --clear-groups env HOME=/home/node USER=node LOGNAME=node "$@"
