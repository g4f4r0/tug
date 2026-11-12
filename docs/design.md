# tug: design

## Product

Tug is an open-source PR review, security review and merge, running in CI on your own infrastructure with any model. It needs no server, no app and no webhooks.

Installing it takes three things:
1. a small entry in the repo's CI, which `tug init` writes;
2. `TUG_REVIEW_MODEL` (`openai/<model>` or `anthropic/<model>`) and that provider's `TUG_OPENAI_API_KEY` or `TUG_ANTHROPIC_API_KEY` in the environment, and optionally a reasoning effort, a base URL (an OpenAI- or Anthropic-compatible proxy works too) and the security pass's own model and effort;
3. optionally, `tug.json` at the repo root.

## Architecture

```
entry points:   GitHub Actions (review.yml, merge.yml) · CLI (tug review, tug merge, tug pr state, tug pr watch, tug init)
                                 │
policy source:  tug.json ──► core (pure, no I/O) ◄── engines: api (OpenAI, Anthropic); later agent CLIs
                                 │
forge adapter:  GitHub; later GitLab, Forgejo
```

1. **Core.** Pure functions: `state(pr)` gives MERGED, CLOSED, HELD, CONFLICTS, CHECKS, THREADS, PENDING or READY. `decide(state, review, policy, files)` gives merge, hold or wait. Every rule that matters lives here and is tested with fixtures.
2. **Contracts.** Versioned JSON shapes that every part uses:
   - `PullState`
   - `Review` (findings, risk, merge, reason)
   - `Policy`
3. **Engines.** One interface: diff, files and rules in, `Review` out. v1 is `api`: one call with structured JSON, to OpenAI's chat completions or Anthropic's Messages API. Later engines run agent CLIs on subscriptions; check each provider's terms for CI use.
4. **Forge adapter.** Reads the PR, its checks and threads. Writes the review, inline comments, labels and the merge. v1 is GitHub only.
5. **Review kinds.** `code` and `security`, each a prompt file (`prompts/code.md`, `prompts/security.md`) plus a name. A new kind is a new prompt file.
6. **Entry points.** Actions and the CLI run the same code. A webhook server could be added later as another entry.

## Solid by construction

1. It fails closed: any error, timeout or unclear answer holds, never merges.
2. There's no database. State lives on the forge: checks, labels, and the review marker for each head.
3. Results are tied to one head SHA. A new push starts over, and the merge names that SHA, so GitHub refuses it if the head moved.
4. Jobs run Tug from the source of its `main` branch, and the key service accepts only `review.yml` at `main`.

## Config: `tug.json` at the repo root (optional)

```json
{
  "$schema": "https://raw.githubusercontent.com/hellogafaro/tug/v1/schema.json",
  "merge": {
    "risk": "low",
    "filters": {
      "authors": ["octocat"],
      "branches": ["!master"],
      "paths": ["!config/settings_data.json", "!locales/**"]
    }
  },
  "rules": [
    "Dated, price, discount or legal content always goes to a human.",
    "The diff must do what the title says."
  ]
}
```

1. The file lives at the root, not in `.github/`, so it isn't tied to one forge.
2. If the file is missing, or has no `merge`, Tug only reviews and never merges.
3. Code enforces `merge`:
   - `risk` is the highest risk that merges by itself.
   - `filters` work like GitHub Actions' branch and path filters: globs, `!` to exclude, last match wins, and a list of only `!` entries means "everything except".
   - `authors` lists who may be auto-merged.
   - `branches` is the PR's base branch.
   - `paths` must pass for every changed file, not just one.
4. The AI reads `rules` on top of Tug's defaults, the prompts in `prompts/`.
5. Model settings are never in the file.
6. Tug reads the file from the base branch, so a PR can't loosen its own review or merge.

## How a PR flows (GitHub)

The repo's CI workflow gets two Tug jobs next to its own:

```yaml
jobs:
  test: { ... }                      # the repo's own CI, unchanged
  review:
    uses: hellogafaro/tug/.github/workflows/review.yml@main
    secrets:                         # only Tug's own, never `inherit`
      TUG_REVIEW_MODEL: ${{ secrets.TUG_REVIEW_MODEL }}
      TUG_OPENAI_API_KEY: ${{ secrets.TUG_OPENAI_API_KEY }}
  merge:
    needs: [test, review]
    uses: hellogafaro/tug/.github/workflows/merge.yml@main
    with:
      review: ${{ needs.review.outputs.review }}
```

1. Triggers: `pull_request` with `opened`, `synchronize`, `reopened` and `ready_for_review`. Label changes start nothing: a person who removes `merge:hold` or `needs:human` merges by hand. Use `concurrency` per PR with `cancel-in-progress`. Skip drafts.
2. `review` runs alongside the tests. It runs the code and security kinds in parallel and posts one COMMENT review with inline comments. It sets `risk:low|medium|high` and fails on a new high finding; a critical or high security finding counts as high. On a re-review it skips findings already raised and never lowers the risk.
3. `merge` runs only after `test` and `review` pass. It reads `tug.json`, requires `tug pr state` to be READY and the filters to pass, and requires the review of the same run, passed as `review.yml`'s output, to have said merge. It never reads the review from the PR, because any workflow's token posts as the same bot. It never merges a PR that changes `.github/`: that PR's own workflows run with a token that posts as the same bot, so they could forge the review. Then it squash-merges through the API on that exact SHA, reads the PR back and deletes the merged branch. Otherwise it adds `needs:human` and a comment.
4. CI belongs to the forge. Tug doesn't run CI commands itself. When a repo has no workflow of its own, `tug init` writes a test job from `package.json` (`typecheck`, `lint`, `test`, with the lockfile's package manager) next to the Tug jobs, into `.github/workflows/tug.yml` in the working directory.
5. Labels: `risk:*`, `needs:human`, and `merge:hold` (set by a person). There are no `review:*` or `security:*` labels; the checks show the result. Gates read checks, never labels.
6. Known limits:
   - The merge job only waits for jobs in its own workflow. Checks from other workflows read as PENDING, so it doesn't merge.
   - A merge done with `GITHUB_TOKEN` starts no other workflows.
   - Actions has no event for a resolved thread: after resolving threads without a push, re-run the merge job.
   - Pull requests from forks are skipped: they get no secrets, OIDC token or write token.
   - Without branch protection, nothing stops a person from merging a red PR.
   - Comments show as `github-actions[bot]`.
7. Permissions: `review` needs `contents: read`, `pull-requests: write`, `issues: write` and `id-token: write`; `merge` needs `actions: read`, `checks: read`, `statuses: read`, `contents: write`, `pull-requests: write` and `issues: write`.

## Follow-up

The agent that opened the PR runs `tug pr watch <repo>#<n>`. It stays quiet while the PR is PENDING, then exits once. Exit codes: 0 ready or merged, 2 conflicts, 3 threads, 4 checks, 5 timeout, 6 held (`needs:human` or `merge:hold`) or closed, 7 query failure. There's no catch-all watcher.

## Self-hosted runners

1. Runners are ephemeral: a single-use runner config, one job per container, in the host's Docker on its own network `tug`, as a non-root user with no capabilities. An egress firewall keeps them off the host and private networks. Give the runners a host of their own.
2. One pool, `tug`, for every job, and no secret in any container. (Changed on 2026-11-12 from two pools, `tug-ai` with injected model settings and `tug-ci` without: labels don't restrict which workflow uses a runner, so a PR's own workflow could target `tug-ai` and print the key.) A key service on the host holds the model settings and makes a pass's model call only for requests that carry GitHub's OIDC token for Tug's own `review.yml` at `main`, from a repository of an account in `TUG_ACCOUNTS`. Tug's jobs never run the PR's code, so that token stays out of the PR's reach.
3. `tug install --host <ssh-host>` sets up a host that has only Debian with SSH and passwordless `sudo`. It installs Docker and nftables from Debian's packages, and runs the key service in Node's own image, so the host needs no Node. Its settings come from the environment of `tug install`, set with a plain `export` or any secrets tool's `run` wrapper, and go to the host's root-only `/etc/tug/tug.env`. (Changed on 2026-11-12 from reading them from Infisical: Tug depends on no secrets tool.)
4. Organizations get one runner scale set each, in their Default runner group, which must not allow public repositories. A personal account gets one per private repository the GitHub App's installation includes. Runners make outgoing connections only. Never use them for public repos.
