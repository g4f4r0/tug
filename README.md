# Tug

Tug reviews pull requests for bugs and security issues with the model you choose, and merges the safe ones. It runs as jobs in your repository's GitHub Actions, with no server, app or webhook of its own. [Your own runners](#your-own-runners) are optional.

Tug is in beta (0.0.1). Workflows run Tug from `main`.

Run the CLI with Node 24 or later:

```sh
npx -y github:hellogafaro/tug#main <command>
```

The examples below write `tug` for that.

## How it works

1. The `review` job sends the pull request's title, body, comments, patches and rules to the model twice (unless `tug.json` turns a pass off): once for correctness ([prompts/code.md](prompts/code.md)) and once for security ([prompts/security.md](prompts/security.md)). It posts one review with inline comments and a `risk:low`, `risk:medium` or `risk:high` label. It fails on a new critical or high finding.
2. The `merge` job runs after the tests and the review. It squash-merges the exact commit the review saw when `tug.json` allows it, every check passed, no thread is open, and the risk is within the policy. Otherwise it labels the pull request `needs:human` and says why in one comment.

Tug never runs the pull request's code; it reads the change through the GitHub API. It never merges a change to `.github/`. A re-review skips findings it already raised and never lowers the risk.

## Add Tug to a repository

```sh
tug init --merge
```

This writes `.github/workflows/tug.yml` and `tug.json`. The workflow runs the tests from `package.json` (`typecheck`, `lint`, `test`) with the lockfile's package manager, then the review and the merge. Leave out `--merge` to only review.

A repository with CI of its own gets only the review, because the merge must run in the same workflow as the tests. Add the jobs to that workflow by hand.

To remove Tug, run `tug remove --repo <owner/repo>`. It opens a pull request that deletes both files, after you type the repository's name.

## Settings

Set these as repository or organization secrets.

| Secret | |
|---|---|
| `TUG_REVIEW_MODEL` | Required. `openai/<model>` or `anthropic/<model>`, such as `openai/gpt-6.1-sol`. |
| `TUG_OPENAI_API_KEY`, `TUG_ANTHROPIC_API_KEY` | The key of the provider the model uses. |
| `TUG_OPENAI_BASE_URL`, `TUG_ANTHROPIC_BASE_URL` | Optional. Default each provider's API; any compatible proxy works. |
| `TUG_REVIEW_REASONING_EFFORT` | Optional, such as `high`. Unset, the provider's default applies. |
| `TUG_SECURITY_MODEL`, `TUG_SECURITY_REASONING_EFFORT` | Optional. The security pass; each falls back to the review's. |

On your own runners, the key service holds these instead, and the repository needs none.

## tug.json

```json
{
  "review": {
    "code": true,
    "security": true,
    "drafts": false,
    "max": 20,
    "filters": { "authors": ["!dependabot[bot]"], "branches": ["main"], "labels": ["!no-review"], "paths": ["!**/*.lock", "!dist/**"] }
  },
  "merge": {
    "risk": "low",
    "filters": { "authors": ["octocat"], "branches": ["main"], "labels": ["!wip"], "paths": ["docs/**"] }
  },
  "rules": ["Prices live in config/prices.json; any change to it needs a person."]
}
```

1. `review` and each of its fields are optional. Without it, Tug runs both passes on every pull request that isn't a draft.
2. `review.code` and `review.security` turn each pass on or off (default on). With both off, Tug doesn't review, and `merge` is an error.
3. `review.drafts` reviews draft pull requests too (default off).
4. `review.max` is the most reviews Tug posts on one pull request. Once it is reached, Tug adds `needs:human` and says so in one comment.
5. `merge.risk` is the highest risk Tug merges by itself. Without `merge`, Tug only reviews.
6. `filters` take the pull request's `authors`, base `branches`, `labels` and changed `paths`. They work like GitHub Actions' branch and path filters: globs, `!` to exclude, and the last match wins.
7. `labels` pass when no label matches a `!` pattern last, and, if the list has other patterns, one label matches them. Case doesn't matter.
8. In `review.filters`, the model sees only the files that match `paths`. In `merge.filters`, every changed file must match.
9. When `review` leaves a pull request out, the review job prints `skipped: <reason>` and posts nothing, so the merge never merges it.
10. `rules` add to the review's defaults.
11. Tug reads `tug.json` from the base branch, so a pull request can't loosen its own rules.

## Your own runners

Tug can run every job on single-use runners on a Debian server you reach over SSH. They start runners through a GitHub App of your own. Each job gets a fresh Docker container that is deleted after it, with capped CPU and memory, no access to the server or its network, and no secrets. A key service on the server holds the model keys and answers only Tug's own review jobs, proven by GitHub's OIDC token. Use them for private repositories only.

The server needs Debian, SSH and passwordless `sudo`; `tug install` adds Docker and the rest. It reads its settings from its own environment, so any secrets tool's `run` wrapper works in place of `export`:

```sh
export TUG_APP_ID=123456 TUG_APP_PRIVATE_KEY="$(cat app.pem)" TUG_ACCOUNTS=my-user,my-org \
  TUG_REVIEW_MODEL=openai/gpt-6.1-sol TUG_OPENAI_API_KEY=sk-...
tug install --host <ssh-host>
```

| Command | |
|---|---|
| `tug install --host <h>` | Sets up the server, or reinstalls it with new settings. |
| `tug update --host <h>` | Moves the server to the latest Tug, keeping its settings and running jobs. |
| `tug status --host <h>` | Prints the services, the version and the running jobs. Exits 1 when a service is down. |
| `tug remove --host <h>` | Removes everything from the server, after you type its name. |

[runners/README.md](runners/README.md) has the GitHub App's permissions and the other server settings. Workflows use them with `runs-on: tug`.

## Follow a pull request

```sh
tug pr state owner/repo#12   # prints the state as JSON
tug pr watch owner/repo#12   # waits quietly, then prints the state once and exits
```

`tug pr watch` exits 0 when ready or merged, 2 on conflicts, 3 on open threads, 4 on failed checks, 5 on timeout, 6 when held or closed, 7 when GitHub can't be read, and 1 on a usage error. With `--until-merged` it exits 0 only once merged. It uses `GITHUB_TOKEN`, `GH_TOKEN` or `gh auth token`.

Resolving a thread starts no workflow. After resolving threads without a push, rerun the merge job with `gh run rerun <run-id> --job <job-id>`.

## Limits

1. The merge job sees checks from other workflows as pending, so it doesn't merge beside them.
2. A merge made with the workflow's token starts no other workflows.
3. Pull requests from forks are skipped, because they get no secrets or write token.
4. Reviews and comments come from `github-actions[bot]`.

[docs/design.md](docs/design.md) explains the design. Tug is MIT-licensed.
