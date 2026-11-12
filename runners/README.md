# Self-hosted runners

Single-use GitHub Actions runners, and the Tug key service, on a Debian host with Docker. Every job, Tug's and the
repository's own CI, targets them with `runs-on: tug`.

One service (`tug-runners`) serves every account that has your GitHub App installed and is listed in `TUG_ACCOUNTS`.
It registers a runner scale set named `tug` in each organization, and in each private repository of a personal
account, then waits for jobs. Each queued job gets a fresh container that runs that one job and is deleted, never
more than `TUG_MAX_RUNNERS` at once across all accounts, which share the host's CPUs and memory evenly. Nothing runs
while no job waits. Restarting the service leaves running jobs alone.

Give the runners a host of their own: a full pool uses all of it, and a daily timer (`tug-prune`) removes every Docker
image unused for a day.

No secret enters a container: the app's key stays in the service, and the container gets only its single-use config.
Containers run as a non-root user with no capabilities and `no-new-privileges`, with CPU, memory and process limits,
on the Docker network `tug`. `egress.nft` lets that network reach the internet and the key service, but not the rest of
the host, its tailnet, or private networks. Neither service starts without these rules.

The key service (`tug-keys`, `tug keys` on `172.30.99.1:8787`) holds the model settings. It forwards a model call only
when the request carries GitHub's OIDC token for Tug's own `review.yml` on a repository of `TUG_ACCOUNTS`, and sets
the real key, model and reasoning effort of each pass itself.

```sh
sudo runners/install.sh <user> [<infisical-project-id> <infisical-env>]
sudo runners/install.sh --uninstall
```

`<user>` runs both services. Settings come from Infisical when a project is given, else from `/etc/tug/tug.env`; after
changing one, run `sudo systemctl restart tug-runners tug-keys`. Running `install.sh` again is the update.

To run them on another host, `deploy.sh` does the same over SSH from this checkout, copying only the `TUG_*` settings
of an Infisical environment into the host's `/etc/tug/tug.env`. Running it again is the update:

```sh
runners/deploy.sh <ssh-host> <infisical-project-id> <infisical-env>
runners/deploy.sh <ssh-host> --uninstall
```

That host needs Debian with Docker, Node 24, nftables and rsync, and passwordless `sudo` for the SSH user. Point
`TUG_MODEL_URL` at an address it can reach, such as the model API's address on your tailnet.

| Setting | |
| --- | --- |
| `TUG_APP_ID`, `TUG_APP_PRIVATE_KEY` | The GitHub App the runners sign in as. A key pasted without its line breaks works too. |
| `TUG_ACCOUNTS` | GitHub accounts to serve, users or organizations, such as `my-user,my-org`. An installation anywhere else is ignored. |
| `TUG_MODEL_URL`, `TUG_MODEL_KEY` | Any OpenAI-compatible API and its key. |
| `TUG_REVIEW_MODEL` | The code review's model, optionally with its reasoning effort, such as `gpt-6.1-sol:high`. |
| `TUG_SECURITY_MODEL` | Optional: the security pass's model, the same way. Default: the review model. |
| `TUG_MAX_RUNNERS` | Optional: jobs at once, across all accounts. Default 4. |

Create the app from
`https://github.com/settings/apps/new?name=<name>&url=https://github.com/hellogafaro/tug&public=true&webhook_active=false&administration=write&organization_self_hosted_runners=write`,
generate a private key, and install it on each account. It must be public to install on other accounts; only those in
`TUG_ACCOUNTS` are served. On a personal account, the repositories you select at install are the ones served.

Never serve public repositories: anyone can open a pull request there, and its code would run on your host. The
service skips public repositories, and organizations whose Default runner group allows them.
