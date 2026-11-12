#!/usr/bin/env bash
# Keeps one single-use GitHub Actions runner waiting for a job, in the pool user's rootless Docker, and starts the next
# one when it exits. Runs as root, from tug-pool@<pool>-<slot>.service; the GitHub token never enters a container.
set -euo pipefail

instance=${1:?usage: pool.sh <pool>-<slot>}
pool=${instance%-*}
slot=${instance##*-}
# shellcheck source=/dev/null
source "/etc/tug/pools/$pool.env"
: "${TUG_REPO:?}" "${TUG_POOL_USER:?}" "${TUG_LABELS:?}" "${TUG_SECRETS_USER:?}" "${TUG_INFISICAL_PROJECT:?}" "${TUG_INFISICAL_ENV:?}"
image=${TUG_IMAGE:-ghcr.io/actions/actions-runner:latest}
container="tug-$pool-$slot"
api="https://api.github.com/repos/$TUG_REPO/actions/runners"
uid=$(id -u "$TUG_POOL_USER")
export DOCKER_HOST="unix:///run/user/$uid/docker.sock"

log() { printf '%s\n' "$*" >&2; }

# Prints one secret's value, or nothing when it is not set. Never log it.
secret() {
  runuser -u "$TUG_SECRETS_USER" -- infisical secrets get "$1" --projectId "$TUG_INFISICAL_PROJECT" --env "$TUG_INFISICAL_ENV" --plain --silent 2>/dev/null || true
}

# Calls the GitHub API with the token in a header file, so it never shows in a process list.
github() {
  local method=$1 url=$2 body=${3:-}
  local token
  token=$(secret TUG_RUNNER_GITHUB_TOKEN)
  [[ -n $token ]] || { log "TUG_RUNNER_GITHUB_TOKEN is not set in Infisical"; return 1; }
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

  # Values pass by name from this process's environment, never on a command line.
  envs=(-e ACTIONS_RUNNER_INPUT_JITCONFIG)
  for key in ${TUG_SECRETS:-}; do
    value=$(secret "$key")
    if [[ -n $value ]]; then
      export "$key=$value"
      envs+=(-e "$key")
    fi
  done
  unset value

  log "Starting $name (runner $runner_id)"
  docker run --rm --name "$container" --init \
    --cpus "${TUG_CPUS:-4}" --memory "${TUG_MEMORY:-6g}" --pids-limit "${TUG_PIDS:-4096}" \
    --security-opt no-new-privileges --cap-drop ALL \
    "${envs[@]}" "$image" ./run.sh &
  wait $! || log "$name exited with $?"

  unset ACTIONS_RUNNER_INPUT_JITCONFIG
  for key in ${TUG_SECRETS:-}; do unset "$key"; done
  remove_runner
  sleep 5
done
