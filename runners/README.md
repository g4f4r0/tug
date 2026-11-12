# Self-hosted runners

Single-use GitHub Actions runners, and the Tug key service, on a Debian host with Docker. Every job, Tug's and the
repository's own CI, targets them with `runs-on: tug`.

One service (`tug-runners`) serves every account that has your GitHub App installed and is listed in `TUG_OWNERS`.
It registers a runner scale set named `tug` in each organization, and in each private repository of a personal
account, then waits for jobs. Each queued job gets a fresh container that runs that one job and is deleted, never
more than `TUG_MAX_RUNNERS` at once across all accounts. Nothing runs while no job waits. Restarting the service leaves
running jobs alone.

No secret enters a container: the app's key stays in the service, and the container gets only its single-use config.
Containers run as a non-root user with no capabilities and `no-new-privileges`, with CPU, memory and process limits,
on the Docker network `tug`. `egress.nft` lets that network reach the internet and the key service, but not the rest of
the host, its tailnet, or private networks. Neither service starts without these rules.

The key service (`tug-keys`, `tug keys` on `172.30.99.1:8787`) holds the model settings. It forwards a model call only
when the request carries GitHub's OIDC token for Tug's own `review.yml` on a repository of `TUG_OWNERS`, and sets the
real key, model and reasoning effort itself.

```sh
sudo runners/install.sh <user> [<infisical-project-id> <infisical-env>]
sudo runners/install.sh --uninstall
```

`<user>` runs both services. Settings come from Infisical when a project is given, else from `/etc/tug/tug.env`; after
changing one, run `sudo systemctl restart tug-runners tug-keys`.

| Setting | |
| --- | --- |
| `TUG_APP_ID`, `TUG_APP_PRIVATE_KEY` | The GitHub App the runners sign in as. A key pasted without its line breaks works too. |
| `TUG_OWNERS` | Accounts to serve, such as `my-user,my-org`. An installation anywhere else is ignored. |
| `TUG_MAX_RUNNERS` | Jobs at once, across all accounts. Default 4. |
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_REASONING_EFFORT` | The model, for the key service. The effort is optional. |
| `TUG_CPUS`, `TUG_MEMORY`, `TUG_PIDS`, `TUG_IMAGE` | Optional per-container limits (4, `6g`, 4096) and runner image. |

Create the app from
`https://github.com/settings/apps/new?name=<name>&url=https://github.com/hellogafaro/tug&public=true&webhook_active=false&administration=write&organization_self_hosted_runners=write`,
generate a private key, and install it on each account. It must be public to install on other accounts; only those in
`TUG_OWNERS` are served. On a personal account, the repositories you select at install are the ones served.

Never serve public repositories: anyone can open a pull request there, and its code would run on your host. The
service skips public repositories, and organizations whose Default runner group allows them.
