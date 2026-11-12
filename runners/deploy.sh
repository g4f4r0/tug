#!/usr/bin/env bash
# Installs or updates Tug's runners on another host over SSH, from this checkout, with the TUG_* settings of an
# Infisical environment. Running it again is the update; running jobs are left alone.
#
#   runners/deploy.sh <ssh-host> <infisical-project-id> <infisical-env>
#   runners/deploy.sh <ssh-host> --uninstall
#
# The host needs Debian with Docker, Node 24, nftables and rsync, and passwordless sudo for the SSH user, who runs
# both services. Its settings live in /etc/tug/tug.env, readable only by root.
set -euo pipefail
host=${1:?usage: deploy.sh <ssh-host> <infisical-project-id> <infisical-env> | --uninstall}
here=$(cd "$(dirname "$0")/.." && pwd)

if [[ ${2:-} == --uninstall ]]; then
  ssh "$host" 'sudo tug/runners/install.sh --uninstall && sudo rm -f /etc/tug/tug.env && rm -rf tug'
  exit 0
fi

project=${2:?infisical project id}
env=${3:?infisical env}
rsync -a --delete --exclude .git --exclude node_modules "$here/" "$host:tug/"
# Only Tug's own settings leave this host, straight into the file; they are never printed.
infisical export --projectId "$project" --env "$env" --format dotenv --silent | grep '^TUG_' |
  ssh "$host" 'sudo install -d -m 0755 /etc/tug && sudo install -m 0600 /dev/stdin /etc/tug/tug.env'
ssh "$host" 'sudo tug/runners/install.sh "$USER"'
