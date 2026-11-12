#!/usr/bin/env bash
# Installs Tug's two runner pools on a Debian host with Docker: `ai` runs Tug's review and merge jobs with the model
# settings, `ci` runs the repository's own CI with no secrets. Each pool is a user with its own rootless Docker.
#
#   sudo runners/install.sh <owner/repo> <secrets-user> <infisical-project-id> <infisical-env> [slots]
#   sudo runners/install.sh --uninstall
#
# <secrets-user> is the host user whose Infisical login holds TUG_RUNNER_GITHUB_TOKEN (Administration: write on the
# repository) and, for the ai pool, LLM_BASE_URL, LLM_MODEL and LLM_API_KEY.
set -euo pipefail
[[ $EUID -eq 0 ]] || { echo "Run as root." >&2; exit 1; }
here=$(cd "$(dirname "$0")" && pwd)
users=(tug-ai tug-ci)

as_user() {
  local user=$1 uid
  shift
  uid=$(id -u "$user")
  (cd / && runuser -u "$user" -- env HOME="/var/lib/$user" XDG_RUNTIME_DIR="/run/user/$uid" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$uid/bus" "$@")
}

if [[ ${1:-} == --uninstall ]]; then
  for unit in $(systemctl list-units --all --plain --no-legend 'tug-pool@*' | awk '{print $1}'); do systemctl disable --now "$unit"; done
  systemctl disable --now tug-egress.service 2>/dev/null || true
  for user in "${users[@]}"; do
    id "$user" >/dev/null 2>&1 || continue
    as_user "$user" dockerd-rootless-setuptool.sh uninstall -f >/dev/null 2>&1 || true
    loginctl disable-linger "$user"
    userdel -r "$user" 2>/dev/null || true
  done
  rm -rf /usr/local/lib/tug /etc/tug /etc/systemd/system/tug-pool@.service /etc/systemd/system/tug-egress.service
  systemctl daemon-reload
  echo "Uninstalled. Remove any runners still listed in the repository's Actions settings."
  exit 0
fi

repo=${1:?owner/repo}
secrets_user=${2:?secrets user}
project=${3:?infisical project id}
environment=${4:?infisical env}
slots=${5:-2}

apt-get install -y -qq uidmap slirp4netns >/dev/null

for user in "${users[@]}"; do
  if ! id "$user" >/dev/null 2>&1; then
    useradd --create-home --home-dir "/var/lib/$user" --shell /usr/sbin/nologin --comment "Tug runner pool" "$user"
  fi
  grep -q "^$user:" /etc/subuid || { echo "$user has no /etc/subuid range." >&2; exit 1; }
  loginctl enable-linger "$user"
  uid=$(id -u "$user")
  for _ in $(seq 30); do [[ -S /run/user/$uid/bus ]] && break; sleep 1; done
  as_user "$user" dockerd-rootless-setuptool.sh install >/dev/null
  as_user "$user" systemctl --user enable --now docker.service >/dev/null
  for _ in $(seq 30); do [[ -S /run/user/$uid/docker.sock ]] && break; sleep 1; done
done

install -d -m 0755 /usr/local/lib/tug /etc/tug/pools
install -m 0755 "$here/pool.sh" /usr/local/lib/tug/pool.sh
install -m 0644 "$here/egress.nft" /usr/local/lib/tug/egress.nft
install -m 0644 "$here/tug-pool@.service" "$here/tug-egress.service" /etc/systemd/system/

pool_env() {
  cat <<EOF
TUG_REPO=$repo
TUG_POOL_USER=tug-$1
TUG_LABELS=self-hosted,linux,x64,tug-$1
TUG_SECRETS_USER=$secrets_user
TUG_INFISICAL_PROJECT=$project
TUG_INFISICAL_ENV=$environment
TUG_SECRETS="$2"
EOF
}
pool_env ai "LLM_BASE_URL LLM_MODEL LLM_API_KEY" >/etc/tug/pools/ai.env
pool_env ci "" >/etc/tug/pools/ci.env
chmod 0600 /etc/tug/pools/*.env

systemctl daemon-reload
systemctl enable --now tug-egress.service
for pool in ai ci; do
  for slot in $(seq "$slots"); do systemctl enable --now "tug-pool@$pool-$slot.service"; done
done
echo "Installed: $slots runners each in tug-ai and tug-ci for $repo."
