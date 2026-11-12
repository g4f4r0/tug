#!/usr/bin/env bash
# Installs a pool of single-use GitHub Actions runners for one repository on a Debian host with Docker. The pool is
# the user `tug-runner` with its own rootless Docker, and one systemd unit per slot.
#
#   sudo runners/install.sh <owner/repo> <secrets-user> <infisical-project-id> <infisical-env> [slots]
#   sudo runners/install.sh --uninstall
#
# <secrets-user> is the host user whose Infisical login holds TUG_RUNNER_GITHUB_TOKEN: a fine-grained token with
# Administration: write on the repository only.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run as root." >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
user=tug-runner

as_user() {
  local uid
  uid=$(id -u "$user")
  (cd / && runuser -u "$user" -- env HOME="/var/lib/$user" XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" "$@")
}

if [[ ${1:-} == --uninstall ]]; then
  for unit in $(systemctl list-units --all --plain --no-legend 'tug-pool@*' | awk '{print $1}'); do systemctl disable --now "$unit"; done
  systemctl disable --now tug-egress.service 2>/dev/null || true
  if id "$user" >/dev/null 2>&1; then
    as_user dockerd-rootless-setuptool.sh uninstall -f >/dev/null 2>&1 || true
    loginctl disable-linger "$user"
    pkill -u "$user" 2>/dev/null || true
    sleep 2
    userdel -r "$user" 2>/dev/null || true
  fi
  rm -rf /usr/local/lib/tug /etc/tug /etc/systemd/system/tug-pool@.service /etc/systemd/system/tug-egress.service
  systemctl daemon-reload
  echo "Uninstalled. Remove any runners still listed in the repository's Actions settings."
  exit 0
fi

repo=${1:?owner/repo}
secrets_user=${2:?secrets user}
project=${3:?infisical project id}
environment=${4:?infisical env}
slots=${5:-4}

apt-get install -y -qq uidmap slirp4netns >/dev/null

if ! id "$user" >/dev/null 2>&1; then
  useradd --create-home --home-dir "/var/lib/$user" --shell /usr/sbin/nologin --comment "Tug runner pool" "$user"
fi
grep -q "^$user:" /etc/subuid || { echo "$user has no /etc/subuid range." >&2; exit 1; }
loginctl enable-linger "$user"
uid=$(id -u "$user")
for _ in $(seq 30); do [[ -S /run/user/$uid/bus ]] && break; sleep 1; done
as_user dockerd-rootless-setuptool.sh install >/dev/null
as_user systemctl --user enable --now docker.service >/dev/null
for _ in $(seq 30); do [[ -S /run/user/$uid/docker.sock ]] && break; sleep 1; done

install -d -m 0755 /usr/local/lib/tug /etc/tug
install -m 0755 "$here/pool.sh" /usr/local/lib/tug/pool.sh
install -m 0644 "$here/egress.nft" /usr/local/lib/tug/egress.nft
install -m 0644 "$here/tug-pool@.service" "$here/tug-egress.service" /etc/systemd/system/
cat >/etc/tug/pool.env <<EOF
TUG_REPO=$repo
TUG_POOL_USER=$user
TUG_LABELS=self-hosted,linux,x64,tug
TUG_SECRETS_USER=$secrets_user
TUG_INFISICAL_PROJECT=$project
TUG_INFISICAL_ENV=$environment
EOF
chmod 0600 /etc/tug/pool.env

systemctl daemon-reload
systemctl enable --now tug-egress.service
for slot in $(seq "$slots"); do systemctl enable --now "tug-pool@$slot.service"; done
echo "Installed: $slots runners labelled tug for $repo."
