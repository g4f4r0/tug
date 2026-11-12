# Self-hosted runners

Single-use GitHub Actions runners for repositories and organizations, and the Tug key service, on a Debian host with Docker. Every
job, Tug's and the repository's own CI, targets them with `runs-on: [self-hosted, tug]`.

A root service per slot (`tug-pool@<slot>`) asks GitHub for a single-use runner config, starts one container for one
job, and starts the next when it exits. No secret enters a container: the GitHub token stays in that service, and the
container gets only its single-use config. Containers run as a non-root user with no capabilities and
`no-new-privileges`, with CPU, memory and process limits, on the Docker network `tug`.

`egress.nft` lets that network reach the internet and the key service, but not the rest of the host, its tailnet, or
private networks. No runner or key service starts without these rules.

The key service (`tug-keys`, `tug keys` on `172.30.99.1:8787`) holds the model settings from Infisical. It forwards a
model call only when the request carries GitHub's OIDC token for Tug's own `review.yml` on an allowed owner's
repository, and sets the real key, model and reasoning effort itself.

```sh
sudo runners/install.sh <secrets-user> <infisical-project-id> <infisical-env> <slots> <scope>...
sudo runners/install.sh --uninstall
```

Each scope, `owner/repo` or an organization, gets `<slots>` runners. Organization runners join its Default runner
group, which serves private repositories only.

The runners sign in as a GitHub App, so one key covers a personal account and every organization. Create it from
`https://github.com/settings/apps/new?name=<name>&url=https://github.com/hellogafaro/tug&public=true&webhook_active=false&administration=write&organization_self_hosted_runners=write`,
generate a private key, and install it on each scope's owner. It must be public to install on other accounts; only
the scopes you list here use it.

`<secrets-user>` is the host user whose Infisical login holds the app's `TUG_APP_ID` and `TUG_APP_PRIVATE_KEY` (a key
pasted into a one-line field, without its line breaks, works too), and `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY` and
optional `LLM_REASONING_EFFORT` for the key service. Never use self-hosted runners for public repositories.
