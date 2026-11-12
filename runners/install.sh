#!/usr/bin/env bash
# Installs Tug's runner service and key service on a Debian host with Docker. Every setting is an environment variable
# (runners/README.md lists them), read from Infisical when a project is given, else from /etc/tug/tug.env.
#
#   sudo runners/install.sh <user> [<infisical-project-id> <infisical-env>]
#   sudo runners/install.sh --uninstall
#
# <user> runs both services; with Infisical, its login reads the project.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run as root." >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)

stop_old() {
  for unit in $(systemctl list-units --all --plain --no-legend 'tug-pool@*' | awk '{print $1}'); do systemctl disable --now "$unit"; done
  rm -f /etc/systemd/system/tug-pool@.service /usr/local/lib/tug/pool.sh /etc/tug/pool.env
}

if [[ ${1:-} == --uninstall ]]; then
  stop_old
  systemctl disable --now tug-runners.service tug-keys.service 2>/dev/null || true
  docker ps -q --filter label=tug.scope | xargs -r docker rm -f >/dev/null
  docker network rm tug >/dev/null 2>&1 || true
  nft delete table inet tug_egress 2>/dev/null || true
  rm -rf /usr/local/lib/tug /etc/systemd/system/tug-runners.service /etc/systemd/system/tug-keys.service
  systemctl daemon-reload
  echo "Uninstalled. /etc/tug/tug.env is kept."
  exit 0
fi

user=${1:?usage: install.sh <user> [<infisical-project-id> <infisical-env>]}
run=""
if (($# >= 3)); then run="/usr/bin/infisical run --projectId $2 --env $3 --silent -- "; fi

docker network inspect tug >/dev/null 2>&1 ||
  docker network create --subnet 172.30.99.0/24 --gateway 172.30.99.1 -o com.docker.network.bridge.enable_icc=false tug >/dev/null

install -d -m 0755 /usr/local/lib/tug /etc/tug
build=$(mktemp -d)
chown "$user" "$build"
# The key service: Tug itself, from this checkout.
package=$(cd "$here/.." && runuser -u "$user" -- npm pack --silent --pack-destination "$build" | tail -1)
rm -rf /usr/local/lib/tug/node
npm install --global --silent --prefix /usr/local/lib/tug/node "$build/$package" >/dev/null
# The runner service: built in Go's own image, so the host needs no Go.
docker run --rm -v "$here/tug-runners:/src:ro" -v "$build:/out" -w /src -e CGO_ENABLED=0 golang:1.27 \
  go build -trimpath -ldflags=-s -o /out/tug-runners . >&2
install -m 0755 "$build/tug-runners" /usr/local/lib/tug/tug-runners
rm -rf "$build"

install -m 0644 "$here/egress.nft" /usr/local/lib/tug/egress.nft
for unit in tug-runners tug-keys; do
  sed -e "s|@USER@|$user|" -e "s|@RUN@|$run|" "$here/$unit.service" >"/etc/systemd/system/$unit.service"
done
[[ -e /etc/tug/tug.env ]] || install -m 0600 /dev/null /etc/tug/tug.env

stop_old
systemctl daemon-reload
nft -f /usr/local/lib/tug/egress.nft
# Restart, not just start, so a re-run loads the new rules and code. Running jobs are left alone: their containers
# belong to Docker, and the runner service adopts them when it starts.
for unit in tug-keys tug-runners; do
  systemctl enable "$unit.service"
  systemctl restart "$unit.service"
done
echo "Installed: the runner service and the key service on 172.30.99.1:8787. Logs: journalctl -u tug-runners"
