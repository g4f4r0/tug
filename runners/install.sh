#!/usr/bin/env bash
# Installs Tug as the user who runs it, never as root: its own rootless Docker, the key service and the runner service,
# as systemd user services that keep running while the user is logged out. runners/preflight.sh must pass first; when
# it doesn't, it names the one command, as root, that installs what is missing. Every setting is an environment
# variable in ~/.config/tug/tug.env (the README lists them). It ends by checking that a job's container reaches the key
# service.
#
#   runners/install.sh
#   runners/install.sh --uninstall
set -euo pipefail
[[ $EUID -ne 0 ]] || { echo "Run as the user Tug runs as, not as root." >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
lib=$HOME/.local/share/tug
units=$HOME/.config/systemd/user
export XDG_RUNTIME_DIR=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
export DOCKER_HOST=unix://$XDG_RUNTIME_DIR/tug/docker.sock

if [[ ${1:-} == --uninstall ]]; then
  systemctl --user disable --now tug-runners.service tug-keys.service tug-cleanup.timer tug-docker.service 2>/dev/null || true
  # Rootless Docker's files belong to the user's subordinate IDs, which only a user namespace like its own can remove.
  [[ ! -d $lib ]] || rootlesskit rm -rf "$lib"
  rm -f "$units"/tug-{docker,keys,runners,cleanup}.service "$units/tug-cleanup.timer"
  systemctl --user daemon-reload
  echo "Uninstalled. ~/.config/tug/tug.env is kept."
  exit 0
fi

if ! report=$("$here/preflight.sh"); then
  printf '%s\n' "$report" >&2
  exit 1
fi
[[ -e $HOME/.config/tug/tug.env ]] || { echo "No settings: write ~/.config/tug/tug.env first." >&2; exit 1; }
# So the services run while the user is logged out; preflight.sh found the user may turn it on.
loginctl enable-linger "$(id -un)"

mkdir -p "$lib" "$units"
install -m 0755 "$here/egress.sh" "$here/reach.sh" "$here/config.sh" "$lib/"
[[ ! -e "$here/../VERSION" ]] || install -m 0644 "$here/../VERSION" "$lib/VERSION"
# Debian's and Ubuntu's docker.io keep the rootless launcher out of PATH; Docker's own packages put it in /usr/bin.
launcher=$(command -v dockerd-rootless.sh || echo /usr/share/docker.io/contrib/dockerd-rootless.sh)
docker_unit=$(mktemp)
trap 'rm -f "$docker_unit"' EXIT
sed -e "s|@LAUNCHER@|$launcher|" -e "s|@PATH@|$(dirname "$launcher"):/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin|" "$here/tug-docker.service" >"$docker_unit"
# Restarting Docker would stop running jobs, so it restarts only when its own unit changes.
restart_docker=no
cmp -s "$docker_unit" "$units/tug-docker.service" || restart_docker=yes
install -m 0644 "$docker_unit" "$units/tug-docker.service"
install -m 0644 "$here/tug-keys.service" "$here/tug-runners.service" "$here/tug-cleanup.service" "$here/tug-cleanup.timer" "$units/"
systemctl --user daemon-reload
systemctl --user enable tug-docker.service tug-keys.service tug-runners.service tug-cleanup.timer
if [[ $restart_docker == yes ]]; then systemctl --user restart tug-docker.service; else systemctl --user start tug-docker.service; fi
# The rules of this version, even when Docker kept running.
"$lib/egress.sh"

build=$(mktemp -d)
trap 'rm -f "$docker_unit"; rm -rf "$build"' EXIT
# The key service: Tug's source, which Node runs as is, with its runtime dependency installed in Node's own image, so
# the host needs no Node.
mkdir "$build/app"
cp -r "$here/../src" "$here/../prompts" "$here/../package.json" "$here/../package-lock.json" "$build/app/"
docker run --rm -v "$build/app:/app" -w /app node:24 \
  npm ci --omit=dev --ignore-scripts --no-audit --no-fund --no-update-notifier --silent >&2
rm -rf "$lib/app"
cp -r "$build/app" "$lib/app"
# Its container runs as node, one of the user's subordinate IDs, which must read it.
chmod -R a+rX "$lib/app"
# The runner service: built in Go's own image, so the host needs no Go.
docker run --rm -v "$here/tug-runners:/src:ro" -v "$build:/out" -w /src -e CGO_ENABLED=0 golang:1.27 \
  go build -trimpath -ldflags=-s -o /out/tug-runners . >&2
install -m 0755 "$build/tug-runners" "$lib/tug-runners"

# Restart, not just start, so a re-run loads the new code. Running jobs are left alone: their containers belong to
# Docker, and the runner service adopts them when it starts.
systemctl --user restart tug-keys.service tug-runners.service
systemctl --user start tug-cleanup.timer
# Every job reaches the key service from the network tug; if that fails, every review would, so say so now.
if ! reached=$("$lib/reach.sh"); then
  echo "Installed, but jobs can't reach the key service: $reached" >&2
  exit 1
fi
echo "Installed as $(id -un), without root: Tug's rootless Docker, the key service on 172.30.99.1:8787, which jobs reach, and the runner service. Logs: tug logs"
