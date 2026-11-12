# Self-hosted runner pool

A pool of single-use GitHub Actions runners for one repository, on a Debian host with Docker. Every job, Tug's and the
repository's own CI, targets it with `runs-on: [self-hosted, tug]`.

The pool is the user `tug-runner` with its own rootless Docker. A root service per slot (`tug-pool@<slot>`) asks
GitHub for a single-use runner config, starts one container for one job, and starts the next when it exits. No secret
enters a container: the GitHub token stays in that service, and the container gets only its single-use config, by
environment variable. Containers run as a non-root user with no capabilities and `no-new-privileges`, with CPU,
memory and process limits.

`egress.nft` lets the pool reach the internet and the host's DNS resolver, but not the host itself, its tailnet, or
private networks. A runner doesn't start without these rules, and stops before they are removed.

```sh
sudo runners/install.sh <owner/repo> <secrets-user> <infisical-project-id> <infisical-env> [slots]
sudo runners/install.sh --uninstall
```

`<secrets-user>` is the host user whose Infisical login holds `TUG_RUNNER_GITHUB_TOKEN`: a fine-grained token with
Administration: write on the repository only. Never use self-hosted runners for public repositories.

Idle, four runners and their Docker use about 320 MB of memory and 0.2% of one core.
