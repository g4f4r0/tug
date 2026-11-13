#!/usr/bin/env bash
# Checks that a container on the Docker network tug, as every job is, reaches the key service on 172.30.99.1:8787, in
# Tug's rootless Docker. It prints ok, or why not, and exits 1 then. It retries for 30 seconds, as the key service may be
# starting. Run as the user Tug runs as.
set -uo pipefail
export DOCKER_HOST=unix:///run/user/$(id -u)/tug/docker.sock
probe='
const until = Date.now() + 30_000
for (;;) {
  try {
    await fetch("http://172.30.99.1:8787/", { signal: AbortSignal.timeout(5_000) })
    console.log("ok")
    process.exit(0)
  } catch (error) {
    const code = error.cause?.code ?? error.name
    if (Date.now() > until) {
      console.log(
        code === "ECONNREFUSED" ? "nothing listens on 172.30.99.1:8787; see the key service in tug logs"
        : code === "TimeoutError" || code === "UND_ERR_CONNECT_TIMEOUT" ? "the connection to 172.30.99.1:8787 timed out; see Tug'"'"'s rules and the key service in tug logs"
        : `${code} from 172.30.99.1:8787`,
      )
      process.exit(1)
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
}'
# As locked down as a job's container, on its network.
docker run --rm --network tug --cap-drop ALL --security-opt no-new-privileges node:24 \
  node --input-type=module -e "$probe" </dev/null 2>&1 | tail -n 1
exit "${PIPESTATUS[0]}"
