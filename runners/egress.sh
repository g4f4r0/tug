#!/usr/bin/env bash
# Loads Tug's rules into its rootless Docker's network namespace, as the user, and creates the Docker network tug when
# it is missing. Jobs' containers sit on tug (172.30.99.0/24). They may reach the internet, which slirp4netns connects
# them to, and the key service on 172.30.99.1:8787, but not private networks, 100.64.0.0/10 (as Tailscale uses)
# included, nor any address of this host. Safe to run again: it replaces the rules.
set -euo pipefail
run=/run/user/$(id -u)/tug
export DOCKER_HOST=unix://$run/docker.sock
child=$(cat "$run/dockerd-rootless/child_pid")

docker network inspect tug >/dev/null 2>&1 ||
  docker network create --subnet 172.30.99.0/24 --gateway 172.30.99.1 -o com.docker.network.bridge.enable_icc=false tug >/dev/null

# slirp4netns connects from the host itself, so a job could reach the host's own services by its public addresses;
# those in the private ranges below are covered already.
host=$(ip -4 -o addr show scope global | awk '{
  sub(/\/.*/, "", $4); split($4, o, ".")
  private = o[1] == 10 || o[1] == 127 || (o[1] == 100 && o[2] >= 64 && o[2] < 128) || (o[1] == 169 && o[2] == 254) || (o[1] == 172 && o[2] >= 16 && o[2] < 32) || (o[1] == 192 && o[2] == 168)
  if (!private) printf ", %s", $4
}')

nsenter -U --preserve-credentials -n -t "$child" nft -f - <<EOF
table inet tug_egress
delete table inet tug_egress

table inet tug_egress {
  chain input {
    type filter hook input priority filter; policy accept;
    ip saddr 172.30.99.0/24 ip daddr 172.30.99.1 tcp dport 8787 accept
    ip saddr 172.30.99.0/24 reject
  }

  chain forward {
    type filter hook forward priority filter; policy accept;
    # slirp4netns's DNS, which resolves through the host's resolvers.
    ip saddr 172.30.99.0/24 ip daddr 10.0.2.3 meta l4proto { udp, tcp } th dport 53 accept
    ip saddr 172.30.99.0/24 ip daddr { 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.168.0.0/16$host } reject
  }
}
EOF
