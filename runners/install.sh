#!/usr/bin/env bash
# Installs Tug's runner service and key service on a Debian host, with Docker and nftables from Debian's own packages
# when they are missing. Every setting is an environment variable in /etc/tug/tug.env (runners/README.md lists them).
#
#   sudo runners/install.sh <user>
#   sudo runners/install.sh --uninstall
#
# <user> runs both services.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run as root." >&2; exit 1; }
grep -Eqx 'ID="?debian"?' /etc/os-release 2>/dev/null || { echo "Tug's runners need Debian." >&2; exit 1; }
[[ -d /run/systemd/system ]] || { echo "Tug's runners need systemd." >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)

if [[ ${1:-} == --uninstall ]]; then
  systemctl disable --now tug-runners.service tug-keys.service tug-cleanup.timer 2>/dev/null || true
  docker rm -f tug-keys >/dev/null 2>&1 || true
  docker ps -q --filter label=tug.scope | xargs -r docker rm -f >/dev/null
  docker network rm tug >/dev/null 2>&1 || true
  nft delete table inet tug_egress 2>/dev/null || true
  rm -rf /usr/local/lib/tug /etc/systemd/system/tug-{runners,keys,cleanup}.service /etc/systemd/system/tug-cleanup.timer
  systemctl daemon-reload
  echo "Uninstalled. /etc/tug/tug.env is kept."
  exit 0
fi

user=${1:?usage: install.sh <user> | install.sh --uninstall}
id "$user" >/dev/null

# Docker's own docker-ce counts too: only a missing command is installed.
packages=()
command -v docker >/dev/null || packages+=(docker.io)
command -v nft >/dev/null || packages+=(nftables)
if ((${#packages[@]})); then
  apt-get update -q >&2
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q "${packages[@]}" >&2
fi
systemctl enable --now docker.service

docker network inspect tug >/dev/null 2>&1 ||
  docker network create --subnet 172.30.99.0/24 --gateway 172.30.99.1 -o com.docker.network.bridge.enable_icc=false tug >/dev/null

install -d -m 0755 /usr/local/lib/tug /etc/tug
[[ ! -e "$here/../VERSION" ]] || install -m 0644 "$here/../VERSION" /usr/local/lib/tug/VERSION
build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT
# The key service: Tug's source, which Node runs as is, with its runtime dependency installed in Node's own image, so
# the host needs no Node.
mkdir "$build/app"
cp -r "$here/../src" "$here/../prompts" "$here/../package.json" "$here/../package-lock.json" "$build/app/"
docker run --rm -v "$build/app:/app" -w /app node:24 \
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund --no-update-notifier --silent >&2
rm -rf /usr/local/lib/tug/node /usr/local/lib/tug/app
cp -r "$build/app" /usr/local/lib/tug/app
# The runner service: built in Go's own image, so the host needs no Go.
docker run --rm -v "$here/tug-runners:/src:ro" -v "$build:/out" -w /src -e CGO_ENABLED=0 golang:1.27 \
  go build -trimpath -ldflags=-s -o /out/tug-runners . >&2
install -m 0755 "$build/tug-runners" /usr/local/lib/tug/tug-runners

install -m 0644 "$here/egress.nft" /usr/local/lib/tug/egress.nft
for unit in tug-runners tug-keys; do
  sed -e "s|@USER@|$user|" "$here/$unit.service" >"/etc/systemd/system/$unit.service"
done
install -m 0644 "$here/tug-cleanup.service" "$here/tug-cleanup.timer" /etc/systemd/system/
[[ -e /etc/tug/tug.env ]] || install -m 0600 /dev/null /etc/tug/tug.env

systemctl daemon-reload
nft -f /usr/local/lib/tug/egress.nft
# Restart, not just start, so a re-run loads the new rules and code. Running jobs are left alone: their containers
# belong to Docker, and the runner service adopts them when it starts.
for unit in tug-keys tug-runners; do
  systemctl enable "$unit.service"
  systemctl restart "$unit.service"
done
systemctl enable --now tug-cleanup.timer
echo "Installed: the runner service and the key service on 172.30.99.1:8787. Logs: journalctl -u tug-runners"
