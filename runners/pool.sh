#!/usr/bin/env bash
# Keeps one single-use GitHub Actions runner waiting for a job, in Docker on the network tug, and starts the next one
# when it exits. Runs as root, from tug-pool@<slot>.service. No secret enters a container: the GitHub token stays here,
# and the container gets only its single-use runner config and the key service's address.
set -euo pipefail

slot=${1:?usage: pool.sh <slot>}
# shellcheck source=/dev/null
source /etc/tug/pool.env
: "${TUG_SCOPES:?}" "${TUG_SLOTS:?}" "${TUG_LABELS:?}" "${TUG_SECRETS_USER:?}" "${TUG_INFISICAL_PROJECT:?}" "${TUG_INFISICAL_ENV:?}"
image=${TUG_IMAGE:-ghcr.io/actions/actions-runner:latest}
container="tug-$slot"
# Slots 1..TUG_SLOTS serve the first scope, the next TUG_SLOTS the second, and so on. A scope is owner/repo or an org.
read -ra scopes <<<"$TUG_SCOPES"
scope=${scopes[$(((slot - 1) / TUG_SLOTS))]:?slot $slot is past the last scope}
if [[ $scope == */* ]]; then api="https://api.github.com/repos/$scope/actions/runners"; else api="https://api.github.com/orgs/$scope/actions/runners"; fi
owner=${scope%%/*}
token_name="TUG_RUNNER_GITHUB_TOKEN_$(tr 'a-z-' 'A-Z_' <<<"$owner")"

log() { printf '%s\n' "$*" >&2; }

# Prints one secret's value, or nothing when it is not set. Never log it.
secret() {
  runuser -u "$TUG_SECRETS_USER" -- infisical secrets get "$1" --projectId "$TUG_INFISICAL_PROJECT" --env "$TUG_INFISICAL_ENV" --plain --silent 2>/dev/null || true
}

# Calls the GitHub API with the token in a header file, so it never shows in a process list.
github() {
  local method=$1 url=$2 body=${3:-}
  local token
  token=$(secret "$token_name")
  [[ -n $token ]] || token=$(secret TUG_RUNNER_GITHUB_TOKEN)
  [[ -n $token ]] || { log "Neither $token_name nor TUG_RUNNER_GITHUB_TOKEN is set in Infisical"; return 1; }
  curl -fsS --max-time 30 -X "$method" "$url" \
    -H @<(printf 'Authorization: Bearer %s\nAccept: application/vnd.github+json\nX-GitHub-Api-Version: 2022-11-28\n' "$token") \
    ${body:+-d "$body"}
}

runner_id=""
remove_runner() {
  [[ -n $runner_id ]] || return 0
  # An ephemeral runner removes itself after its job; this removes one that never took a job.
  github DELETE "$api/$runner_id" >/dev/null 2>&1 || true
  runner_id=""
}
stop() {
  docker rm -f "$container" >/dev/null 2>&1 || true
  remove_runner
  exit 0
}
trap stop TERM INT

docker rm -f "$container" >/dev/null 2>&1 || true
# A slot stopped mid-registration, or killed, can leave its runner registered; remove this slot's offline runners.
if listed=$(github GET "$api?per_page=100"); then
  for stale in $(python3 -c 'import json,sys; print(" ".join(str(r["id"]) for r in json.load(sys.stdin)["runners"] if r["name"].startswith(sys.argv[1] + "-") and r["status"] == "offline"))' "$container" <<<"$listed"); do
    github DELETE "$api/$stale" >/dev/null 2>&1 && log "Removed stale runner $stale"
  done
fi
until docker image inspect "$image" >/dev/null 2>&1 || docker pull -q "$image" >/dev/null; do sleep 30; done

while true; do
  name="$container-$(date +%s)"
  body=$(python3 -c 'import json,sys; print(json.dumps({"name": sys.argv[1], "runner_group_id": 1, "labels": sys.argv[2].split(","), "work_folder": "_work"}))' "$name" "$TUG_LABELS")
  if ! response=$(github POST "$api/generate-jitconfig" "$body"); then
    log "Could not register $name; retrying in 60 s"
    sleep 60
    continue
  fi
  runner_id=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["runner"]["id"])' <<<"$response")
  ACTIONS_RUNNER_INPUT_JITCONFIG=$(python3 -c 'import json,sys; print(json.load(sys.stdin)["encoded_jit_config"])' <<<"$response")
  export ACTIONS_RUNNER_INPUT_JITCONFIG
  unset response

  log "Starting $name (runner $runner_id)"
  docker run --rm --name "$container" --init \
    --cpus "${TUG_CPUS:-4}" --memory "${TUG_MEMORY:-6g}" --pids-limit "${TUG_PIDS:-4096}" \
    --security-opt no-new-privileges --cap-drop ALL --network tug \
    -e ACTIONS_RUNNER_INPUT_JITCONFIG -e TUG_KEYS=http://172.30.99.1:8787 "$image" ./run.sh &
  wait $! || log "$name exited with $?"

  unset ACTIONS_RUNNER_INPUT_JITCONFIG
  remove_runner
  sleep 5
done
