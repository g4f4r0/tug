#!/usr/bin/env bash
# Checks what Tug needs to run as one user, with its jobs in rootless Docker, and fixes what is missing. Supports Debian
# and distributions built on it, such as Ubuntu.
#
#   runners/preflight.sh                              checks, as the user who will run Tug; changes nothing
#   sudo runners/preflight.sh --fix <user> <item>...  fixes those items, as root
#
# The check prints one line per item:
#   ok    <item> <detail>   in place
#   root  <item> <why>      missing, and only root can fix it
#   user  <item> <why>      missing, and Tug fixes it as the user when it installs
#   warn  <item> <why>      missing, and Tug works without it
# When an item needs root, the last line is the one command that fixes them all. The check exits 0 when nothing needs
# root, 1 when something does, and 2 on a system Tug can't run on.
set -uo pipefail

has() { command -v "$1" >/dev/null 2>&1; }
installed() { dpkg-query -W -f='${Status}' "$1" 2>/dev/null | grep -q 'ok installed'; }
# Docker's own packages (docker-ce) bring rootlesskit and the rootless launcher in docker-ce-rootless-extras, which
# conflicts with the distribution's rootlesskit; Debian's and Ubuntu's docker.io pair with their rootlesskit package.
rootless_extras() { installed docker-ce; }
launcher() { has dockerd-rootless.sh || [[ -x /usr/share/docker.io/contrib/dockerd-rootless.sh ]]; }
# Whether a user has at least 65536 subordinate IDs in a file such as /etc/subuid, listed by name or by number.
subids() { awk -F: -v name="$1" -v id="$(id -u "$1")" '$1 == name || $1 == id { n += $3 } END { exit !(n >= 65536) }' "$2" 2>/dev/null; }
restricted() { [[ $(sysctl -n kernel.apparmor_restrict_unprivileged_userns 2>/dev/null) == 1 ]]; }
swap_mb() { awk 'NR > 1 { kb += $3 } END { print int(kb / 1024) }' /proc/swaps; }
# Whether an AppArmor profile lets this rootlesskit create user namespaces.
profiled() {
  local path file
  path=$(realpath -m "$(command -v rootlesskit || echo /usr/bin/rootlesskit)")
  # A loop, not grep over the directory: a user can't read some profiles, and that failure must not hide a match.
  for file in /etc/apparmor.d/*; do
    [[ -f $file && -r $file ]] || continue
    grep -qF -- "$path" "$file" && grep -q '^[[:space:]]*userns,' "$file" && return 0
  done
  return 1
}

if [[ ${1:-} == --fix ]]; then
  [[ $EUID -eq 0 ]] || { echo "Run --fix as root." >&2; exit 1; }
  user=${2:?usage: preflight.sh --fix <user> <item>...}
  id "$user" >/dev/null
  shift 2
  packages=()
  for item in "$@"; do
    case $item in
      docker) if rootless_extras; then packages+=(docker-ce-rootless-extras); else packages+=(docker.io); fi ;;
      rootlesskit) if rootless_extras; then packages+=(docker-ce-rootless-extras); else packages+=(rootlesskit); fi ;;
      uidmap | slirp4netns | nftables) packages+=("$item") ;;
      subuid | apparmor | userns | linger | legacy | swap) ;;
      *) echo "Not an item: $item" >&2; exit 1 ;;
    esac
  done
  if ((${#packages[@]})); then
    apt-get update -q >&2
    DEBIAN_FRONTEND=noninteractive apt-get install -y -q $(printf '%s\n' "${packages[@]}" | sort -u) >&2
  fi
  for item in "$@"; do
    case $item in
      subuid)
        # The next free range after every range already given out, in both files.
        start=$(cat /etc/subuid /etc/subgid 2>/dev/null | awk -F: 'BEGIN { m = 100000 } { if ($2 + $3 > m) m = $2 + $3 } END { print m }')
        range="$start-$((start + 65535))"
        subids "$user" /etc/subuid || usermod --add-subuids "$range" "$user"
        subids "$user" /etc/subgid || usermod --add-subgids "$range" "$user"
        ;;
      apparmor)
        if restricted && ! profiled; then
          path=$(realpath -m "$(command -v rootlesskit || echo /usr/bin/rootlesskit)")
          cat >/etc/apparmor.d/tug-rootlesskit <<EOF
# Lets rootlesskit create the user namespace rootless Docker runs in, as Ubuntu restricts that since 24.04.
abi <abi/4.0>,
include <tunables/global>

profile tug-rootlesskit $path flags=(unconfined) {
  userns,

  include if exists <local/tug-rootlesskit>
}
EOF
          apparmor_parser -r /etc/apparmor.d/tug-rootlesskit
        fi
        ;;
      userns)
        printf '%s\n' "user.max_user_namespaces = 28633" >/etc/sysctl.d/90-tug-userns.conf
        [[ ! -e /proc/sys/kernel/unprivileged_userns_clone ]] || echo "kernel.unprivileged_userns_clone = 1" >>/etc/sysctl.d/90-tug-userns.conf
        sysctl -q -p /etc/sysctl.d/90-tug-userns.conf
        ;;
      linger) loginctl enable-linger "$user" ;;
      swap)
        # A 4 GB swap file, kept across reboots, used only under pressure. An existing /swapfile is never reformatted.
        if (($(swap_mb) == 0)); then
          created=no
          # A failed step stops the fix and removes a file it made, so the next run starts clean.
          if [[ ! -e /swapfile ]]; then
            fallocate -l 4G /swapfile && chmod 600 /swapfile && created=yes && mkswap /swapfile >/dev/null
          fi && swapon /swapfile || {
            [[ $created == no ]] || rm -f /swapfile
            echo "Could not turn on swap at /swapfile." >&2
            exit 1
          }
          grep -q '^/swapfile ' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
          echo 'vm.swappiness=10' >/etc/sysctl.d/90-tug-swap.conf
          sysctl -q -p /etc/sysctl.d/90-tug-swap.conf
        fi
        ;;
      legacy)
        # A Tug from before it ran as a user: its settings move to the user, then the rest goes. Docker itself stays.
        home=$(getent passwd "$user" | cut -d: -f6)
        group=$(id -gn "$user")
        if [[ -e /etc/tug/tug.env && ! -e $home/.config/tug/tug.env ]]; then
          [[ -d $home/.config ]] || install -d -m 0755 -o "$user" -g "$group" "$home/.config"
          install -d -m 0700 -o "$user" -g "$group" "$home/.config/tug"
          install -m 0600 -o "$user" -g "$group" /etc/tug/tug.env "$home/.config/tug/tug.env"
        fi
        systemctl disable --now tug-runners.service tug-keys.service tug-cleanup.timer 2>/dev/null || true
        docker rm -f tug-keys >/dev/null 2>&1 || true
        docker ps -q --filter label=tug.scope 2>/dev/null | xargs -r docker rm -f >/dev/null 2>&1 || true
        docker network rm tug >/dev/null 2>&1 || true
        nft delete table inet tug_egress 2>/dev/null || true
        ! has ufw || ufw delete allow from 172.30.99.0/24 to 172.30.99.1 port 8787 proto tcp >/dev/null 2>&1 || true
        rm -rf /usr/local/lib/tug /etc/tug /etc/systemd/system/tug-{runners,keys,cleanup}.service /etc/systemd/system/tug-cleanup.timer
        systemctl daemon-reload
        ;;
    esac
  done
  echo "Fixed: $*"
  exit 0
fi

[[ $EUID -ne 0 ]] || { echo "Check as the user who will run Tug, not root." >&2; exit 2; }
user=$(id -un)
roots=()
report() { printf '%-5s %-12s %s\n' "$1" "$2" "$3"; }
need_root() {
  report root "$1" "$2"
  roots+=("$1")
}

family=$(. /etc/os-release 2>/dev/null && echo " ${ID:-} ${ID_LIKE:-} ")
os=$(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-unknown}")
if [[ $family != *" debian "* ]]; then
  report fail os "$os: Tug runs on Debian or a distribution built on it, such as Ubuntu"
  exit 2
fi
report ok os "$os"
if [[ ! -d /run/systemd/system ]]; then
  report fail systemd "Tug runs its services with systemd"
  exit 2
fi
report ok systemd "$(systemctl --version | head -n 1)"

if has dockerd && has containerd && has runc && launcher; then
  report ok docker "$(dockerd --version)"
elif has dockerd; then
  need_root docker "Docker is there, but not its rootless launcher, dockerd-rootless.sh"
else
  need_root docker "no Docker"
fi
if has newuidmap && has newgidmap; then report ok uidmap "newuidmap, newgidmap"; else need_root uidmap "no newuidmap: rootless Docker can't map its users"; fi
if has rootlesskit; then report ok rootlesskit "$(rootlesskit --version 2>/dev/null | head -n 1)"; else need_root rootlesskit "no rootlesskit, which rootless Docker runs in"; fi
if has slirp4netns; then report ok slirp4netns "$(slirp4netns --version 2>/dev/null | head -n 1)"; else need_root slirp4netns "no slirp4netns, which gives Tug's rootless containers their network"; fi
if has nft; then report ok nftables "nft"; else need_root nftables "no nft, for the rules that keep jobs off private networks"; fi
if subids "$user" /etc/subuid && subids "$user" /etc/subgid; then
  report ok subuid "$user has 65536 subordinate IDs"
else
  need_root subuid "$user has fewer than 65536 subordinate IDs in /etc/subuid or /etc/subgid"
fi
if [[ $(cat /proc/sys/user/max_user_namespaces 2>/dev/null || echo 0) -gt 0 && $(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1) == 1 ]]; then
  report ok userns "user namespaces on"
else
  need_root userns "the kernel turns user namespaces off for users"
fi
if ! restricted; then
  report ok apparmor "user namespaces not restricted"
elif profiled; then
  report ok apparmor "a profile lets rootlesskit create user namespaces"
else
  need_root apparmor "AppArmor restricts user namespaces, and no profile lets rootlesskit create them"
fi

if [[ $(loginctl show-user "$user" -p Linger --value 2>/dev/null) == yes ]]; then
  report ok linger "Tug's services keep running while $user is logged out"
elif pkaction --action-id org.freedesktop.login1.set-self-linger --verbose 2>/dev/null | grep -Eq 'implicit (any|active): +yes'; then
  report user linger "Tug enables it, as $user, so its services keep running while $user is logged out"
else
  need_root linger "$user may not keep services running while logged out"
fi
# Each job gets an even share of memory. With swap, a job that needs more borrows as much again and slows down; without
# it, the job is killed.
free_gb=$(df --output=avail -BG / | tail -n 1 | tr -dc 0-9)
if (($(swap_mb) > 0)); then
  report ok swap "$(swap_mb) MB: a job that needs more than its share of memory slows down instead of failing"
elif [[ $(findmnt -no FSTYPE /) != @(ext4|xfs) ]] || ((free_gb < 8)); then
  report warn swap "none, and the fix makes a swap file only on ext4 or xfs with 8 GB free: a job that needs more than its share of memory fails"
else
  need_root swap "none: a job that needs more than its share of memory fails instead of slowing down"
fi
controllers=$(cat "/sys/fs/cgroup/user.slice/user-$(id -u).slice/user@$(id -u).service/cgroup.controllers" 2>/dev/null)
missing=()
for controller in cpu memory pids; do [[ " $controllers " == *" $controller "* ]] || missing+=("$controller"); done
if ((${#missing[@]} == 0)); then
  report ok cgroups "cpu, memory and pids are delegated: each job's limits hold"
else
  report warn cgroups "${missing[*]} not delegated to $user: jobs run without those limits"
fi

if [[ -e /etc/systemd/system/tug-runners.service ]]; then
  need_root legacy "an older Tug runs as root here; the fix moves its settings to $user, then removes it"
fi

if ((${#roots[@]})); then
  echo "fix: sudo $(realpath "$0") --fix $user ${roots[*]}"
  exit 1
fi
exit 0
