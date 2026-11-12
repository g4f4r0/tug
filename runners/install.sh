#!/usr/bin/env bash
# Installs single-use GitHub Actions runners for one repository, and the Tug key service, on a Debian host with Docker.
#
#   sudo runners/install.sh <owner/repo> <secrets-user> <infisical-project-id> <infisical-env> [slots]
#   sudo runners/install.sh --uninstall
#
# <secrets-user> is the host user whose Infisical login holds TUG_RUNNER_GITHUB_TOKEN (a fine-grained token with
# Administration: write on the repository only) and the key service's LLM_BASE_URL, LLM_MODEL, LLM_API_KEY and
# optional LLM_REASONING_EFFORT.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run as root." >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)

if [[ ${1:-} == --uninstall ]]; then
  for unit in $(systemctl list-units --all --plain --no-legend 'tug-pool@*' 'tug-keys*' | awk '{print $1}'); do systemctl disable --now "$unit"; done
  docker network rm tug >/dev/null 2>&1 || true
  nft delete table inet tug_egress 2>/dev/null || true
  rm -rf /usr/local/lib/tug /etc/tug /etc/systemd/system/tug-pool@.service /etc/systemd/system/tug-keys.service
  systemctl daemon-reload
  echo "Uninstalled. Remove any runners still listed in the repository's Actions settings."
  exit 0
fi

repo=${1:?owner/repo}
secrets_user=${2:?secrets user}
project=${3:?infisical project id}
environment=${4:?infisical env}
slots=${5:-4}

docker network inspect tug >/dev/null 2>&1 ||
  docker network create --subnet 172.30.99.0/24 --gateway 172.30.99.1 -o com.docker.network.bridge.enable_icc=false tug >/dev/null

# Tug itself, for the key service: built from this checkout.
install -d -m 0755 /usr/local/lib/tug /etc/tug
build=$(mktemp -d)
chown "$secrets_user" "$build"
package=$(cd "$here/.." && runuser -u "$secrets_user" -- npm pack --silent --pack-destination "$build" | tail -1)
rm -rf /usr/local/lib/tug/node
npm install --global --silent --prefix /usr/local/lib/tug/node "$build/$package" >/dev/null
rm -rf "$build"

install -m 0755 "$here/pool.sh" /usr/local/lib/tug/pool.sh
install -m 0644 "$here/egress.nft" /usr/local/lib/tug/egress.nft
install -m 0644 "$here/tug-pool@.service" /etc/systemd/system/
sed -e "s|@SECRETS_USER@|$secrets_user|" -e "s|@PROJECT@|$project|" -e "s|@ENV@|$environment|" -e "s|@OWNERS@|${repo%%/*}|" "$here/tug-keys.service" >/etc/systemd/system/tug-keys.service
cat >/etc/tug/pool.env <<EOF
TUG_REPO=$repo
TUG_LABELS=self-hosted,linux,x64,tug
TUG_SECRETS_USER=$secrets_user
TUG_INFISICAL_PROJECT=$project
TUG_INFISICAL_ENV=$environment
EOF
chmod 0600 /etc/tug/pool.env

systemctl daemon-reload
# Restart, not just start, so a re-run loads the new rules and code before any job runs.
nft -f /usr/local/lib/tug/egress.nft
systemctl enable tug-keys.service
systemctl restart tug-keys.service
for slot in $(seq "$slots"); do
  systemctl enable "tug-pool@$slot.service"
  systemctl restart "tug-pool@$slot.service"
done
echo "Installed: $slots runners labelled tug for $repo, and the key service on 172.30.99.1:8787."
