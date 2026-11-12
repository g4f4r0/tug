# Self-hosted runners

Single-use GitHub Actions runners, and the Tug key service, on a Debian host. Every job, Tug's and the
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
the host or private networks. Neither service starts without these rules.

The key service (`tug-keys`, `tug keys` on `172.30.99.1:8787`, in a container of Node's own image) holds the model
settings, and only those: the GitHub App's key never enters its container. A review job asks it for one pass, `code`
or `security`, with its prompts and schema. It answers only when the request carries GitHub's OIDC token
for Tug's own `review.yml` on a repository of `TUG_ACCOUNTS`, and it calls that pass's provider with its own key, model
and reasoning effort. The job never learns which provider answered.

```sh
sudo runners/install.sh <user>
sudo runners/install.sh --uninstall
```

`<user>` runs both services. `install.sh` installs Docker and nftables from Debian's packages when they are missing,
installs Tug's one runtime dependency in Node's own image, and builds the runner service in Go's, so the host needs
neither Node nor Go. Settings come from
`/etc/tug/tug.env`; after changing one, run `sudo systemctl restart tug-runners tug-keys`. Running `install.sh` again
is the update.

To set up a host, use `tug` from anywhere with SSH access to it. `install` takes the `TUG_*` settings from its own
environment, checks them, and copies them into the host's root-only `/etc/tug/tug.env`, never printed:

```sh
export TUG_APP_ID=123456 TUG_APP_PRIVATE_KEY="$(cat app.pem)" TUG_ACCOUNTS=my-user,my-org
export TUG_REVIEW_MODEL=openai/gpt-6.1-sol TUG_OPENAI_API_KEY=sk-...
tug install --host <ssh-host> [--ref <branch|tag|sha>]
tug update --host <ssh-host> [--ref <branch|tag|sha>]
tug status --host <ssh-host>
tug remove --host <ssh-host> [--yes]
```

Any secrets tool's `run` wrapper works too: it runs `tug install` with the settings in its environment.

1. `install` and `update` fetch Tug from GitHub (default `main`, or `--ref`) on this machine and send it over SSH.
2. `update` keeps the settings, and `install` again refreshes them. Running jobs are left alone.
3. `status` prints the services, the installed commit and the running jobs as JSON, and exits 1 unless the runner and key services are active.
4. `remove` asks you to type the host's name. Without a terminal it needs `--yes`.

That host needs only Debian with SSH, and passwordless `sudo` for the SSH user. A base URL must be an address the host
can reach; the key service runs on the host's network, so a proxy on a private network works.

| Setting | |
| --- | --- |
| `TUG_APP_ID`, `TUG_APP_PRIVATE_KEY` | The GitHub App the runners sign in as. A key pasted without its line breaks works too. |
| `TUG_ACCOUNTS` | GitHub accounts to serve, users or organizations, such as `my-user,my-org`. An installation anywhere else is ignored. |
| `TUG_REVIEW_MODEL` | The code review's provider and model, `openai/<model>` or `anthropic/<model>`, such as `openai/gpt-6.1-sol`. |
| `TUG_REVIEW_REASONING_EFFORT` | Optional: its reasoning effort, such as `high`. Default: the provider's. |
| `TUG_SECURITY_MODEL`, `TUG_SECURITY_REASONING_EFFORT` | Optional: the security pass's model and effort. Each defaults to the review's. |
| `TUG_OPENAI_API_KEY`, `TUG_ANTHROPIC_API_KEY` | The key of each provider a pass uses. |
| `TUG_OPENAI_BASE_URL`, `TUG_ANTHROPIC_BASE_URL` | Optional: each provider's API, such as an OpenAI- or Anthropic-compatible proxy. Default: `https://api.openai.com/v1` and `https://api.anthropic.com`. |
| `TUG_MAX_RUNNERS` | Optional: jobs at once, across all accounts. Default 4. |

Create the app from
`https://github.com/settings/apps/new?name=<name>&url=https://github.com/hellogafaro/tug&public=true&webhook_active=false&administration=write&organization_self_hosted_runners=write`,
generate a private key, and install it on each account. It must be public to install on other accounts; only those in
`TUG_ACCOUNTS` are served. On a personal account, the repositories you select at install are the ones served.

Never serve public repositories: anyone can open a pull request there, and its code would run on your host. The
service skips public repositories, and organizations whose Default runner group allows them.
