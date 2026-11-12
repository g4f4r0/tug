#!/usr/bin/env bash
# Keeps one single-use GitHub Actions runner waiting for a job, in Docker on the network tug, and starts the next one
# when it exits. Runs as root, from tug-pool@<slot>.service. It signs in as the Tug runners GitHub App. No secret enters
# a container: the app's key and tokens stay here, and the container gets only its single-use runner config and the key
# service's address.
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
if [[ $scope == */* ]]; then where="repos/$scope"; else where="orgs/$scope"; fi
api="https://api.github.com/$where/actions/runners"

log() { printf '%s\n' "$*" >&2; }

# Prints one secret's value, or nothing when it is not set. Never log it.
secret() {
  runuser -u "$TUG_SECRETS_USER" -- infisical secrets get "$1" --projectId "$TUG_INFISICAL_PROJECT" --env "$TUG_INFISICAL_ENV" --plain --silent 2>/dev/null || true
}

# Calls the GitHub API with a bearer credential in a header file, so it never shows in a process list.
call() {
  local method=$1 url=$2 bearer=$3 body=${4:-}
  curl -fsS --max-time 30 -X "$method" "$url" \
    -H @<(printf 'Authorization: Bearer %s\nAccept: application/vnd.github+json\nX-GitHub-Api-Version: 2022-11-28\n' "$bearer") \
    ${body:+-d "$body"}
}

# Rebuilds a PEM key whose line breaks were lost when it was pasted into a one-line field.
pem() {
  python3 -c 'import re,sys,textwrap; m=re.search(r"-----BEGIN ([A-Z ]+)-----(.*?)-----END \1-----", sys.stdin.read(), re.S); body=re.sub(r"\s", "", m.group(2)); print(f"-----BEGIN {m.group(1)}-----\n" + "\n".join(textwrap.wrap(body, 64)) + f"\n-----END {m.group(1)}-----")'
}
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }

# The app installation's token for this scope, valid for an hour. Never log it.
app_token() {
  local id key now jwt installation
  id=$(secret TUG_APP_ID)
  key=$(secret TUG_APP_PRIVATE_KEY)
  [[ -n $id && -n $key ]] || { log "TUG_APP_ID or TUG_APP_PRIVATE_KEY is not set in Infisical"; return 1; }
  now=$(date +%s)
  jwt="$(printf '{"alg":"RS256","typ":"JWT"}' | b64url).$(printf '{"iat":%d,"exp":%d,"iss":"%s"}' $((now - 60)) $((now + 540)) "$id" | b64url)"
  jwt="$jwt.$(printf '%s' "$jwt" | openssl dgst -sha256 -sign <(pem <<<"$key") | b64url)"
  installation=$(call GET "https://api.github.com/$where/installation" "$jwt" | python3 -c 'import json,sys; print(json.load(sys.stdin)["id"])') ||
    { log "The Tug runners app is not installed on $scope"; return 1; }
  call POST "https://api.github.com/app/installations/$installation/access_tokens" "$jwt" | python3 -c 'import json,sys; print(json.load(sys.stdin)["token"])'
}

github() {
  local token
  token=$(app_token) || return 1
  call "$1" "$2" "$token" "${3:-}"
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
