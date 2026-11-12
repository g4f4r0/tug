# Self-hosted runner pools

Two pools of single-use GitHub Actions runners for one repository, on a Debian host with Docker:

1. `tug-ai` runs Tug's `review` and `merge` jobs. Its containers get `LLM_BASE_URL`, `LLM_MODEL` and `LLM_API_KEY`.
2. `tug-ci` runs every job that runs the pull request's code. Its containers get no secrets.

Each pool is its own user with rootless Docker, so a job that escapes its container still can't reach the other pool. A
root service per slot (`tug-pool@<pool>-<slot>`) asks GitHub for a single-use runner config, starts one container for
one job, and starts the next when it exits. The GitHub token stays in that service; containers get only the single-use
config, by environment variable. Containers run as a non-root user with no capabilities and `no-new-privileges`, with
CPU, memory and process limits.

`egress.nft` lets the pools reach the internet and the host's DNS resolver, but not the host itself, its tailnet, or
private networks.

```sh
sudo runners/install.sh <owner/repo> <secrets-user> <infisical-project-id> <infisical-env> [slots]
sudo runners/install.sh --uninstall
```

`<secrets-user>` is the host user whose Infisical login holds `TUG_RUNNER_GITHUB_TOKEN`: a fine-grained token with
Administration: write on the repository only. Jobs target a pool with `runs-on: [self-hosted, tug-ai]` or
`[self-hosted, tug-ci]`. Never use self-hosted runners for public repositories.

Idle, each pool with two runners and its Docker uses about 280 MB of memory and under 0.5% of one core.
