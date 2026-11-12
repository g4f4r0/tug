# tug: design and handoff

Status: design agreed with the user on 2026-11-12. Nothing is built yet. Next thread, first step: create the public repo `hellogafaro/tug` and commit this file there as `docs/design.md`.

## Product

Tug is an open-source PR review, security review and merge, running in CI on your own infrastructure with any model. It needs no server, no app and no webhooks.

Installing it takes three things:
1. a small entry in the repo's CI, which `tug init` writes;
2. `TUG_MODEL_URL`, `TUG_MODEL_KEY` and `TUG_REVIEW_MODEL` in the environment (any OpenAI-compatible API), and optionally `TUG_SECURITY_MODEL`;
3. optionally, `tug.json` at the repo root.

Done means:
1. On `g4f4r0/opencode-plugins`, without OpenCode, a docs PR is reviewed and merged on its exact head.
2. A risky PR is held with `needs:human`.
3. Changing the model settings switches provider with no other change.
4. An agent in any harness follows up its own PR with `tug pr watch`.

## Architecture

```
entry points:   GitHub Actions (review.yml, merge.yml) · CLI (tug review, tug merge, tug pr state, tug pr watch, tug init)
                                 │
policy source:  tug.json ──► core (pure, no I/O) ◄── engines: api (OpenAI-compatible); later claude-code, codex, opencode
                                 │
forge adapter:  GitHub; later GitLab, Forgejo
```

1. **Core.** Pure functions: `state(pr)` gives MERGED, CLOSED, HELD, CONFLICTS, CHECKS, THREADS, PENDING or READY. `decide(state, review, policy)` gives merge, hold or wait. Every rule that matters lives here and is tested with fixtures.
2. **Contracts.** Versioned JSON shapes that every part uses:
   - `PullState`
   - `Review` (findings, risk, merge, reason)
   - `Policy`
3. **Engines.** One interface: diff, files and rules in, `Review` out. v1 is `api`: a chat-completions call with structured JSON. Later engines run agent CLIs on subscriptions; check each provider's terms for CI use.
4. **Forge adapter.** Reads the PR, its checks and threads. Writes the review, inline comments, labels and the merge. v1 is GitHub only.
5. **Review kinds.** `code` and `security`, each a prompt file (`prompts/code.md`, `prompts/security.md`) plus a name. A new kind is a new prompt file.
6. **Entry points.** Actions and the CLI run the same code. A webhook server could be added later as another entry.

## Solid by construction

1. It fails closed: any error, timeout or unclear answer holds, never merges.
2. There's no database. State lives on the forge: checks, labels, and the review marker for each head.
3. Results are tied to one head SHA. A new push starts over, and the merge uses `--match-head-commit`.
4. Tug's own CI runs evals: fixture PRs that should merge and others that should hold, against the real engine.
5. Releases are pinned: `@v1`.

## Config: `tug.json` at the repo root (optional)

```json
{
  "$schema": "https://raw.githubusercontent.com/hellogafaro/tug/v1/schema.json",
  "merge": {
    "risk": "low",
    "filters": {
      "authors": ["g4f4r0"],
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
2. If the file is missing, or has no `merge`, Tug only reviews and never merges. That's the setting for client repos.
3. Code enforces `merge`:
   - `risk` is the highest risk that merges by itself.
   - `filters` work like GitHub Actions' branch and path filters: globs, `!` to exclude, last match wins, and a list of only `!` entries means "everything except".
   - `authors` lists who may be auto-merged.
   - `branches` is the PR's base branch.
   - `paths` must pass for every changed file, not just one.
4. The AI reads `rules`, on top of Tug's defaults. Port the defaults from the `development` skill's `pr-review.md` and `merge-decision.md`, without the OpenCode and Executor steps. The skill is Notion page `3fffc798-2e43-8172-aecd-fd0dc74f66ae`, synced to `~/.agents/skills/development/references/`.
5. Model settings are never in the file.

## How a PR flows (GitHub)

The repo's CI workflow gets two Tug jobs next to its own:

```yaml
jobs:
  test: { ... }                      # the repo's own CI, unchanged
  review:
    uses: hellogafaro/tug/.github/workflows/review.yml@v1
    secrets:                         # only Tug's own, never `inherit`
      TUG_MODEL_URL: ${{ secrets.TUG_MODEL_URL }}
      TUG_MODEL_KEY: ${{ secrets.TUG_MODEL_KEY }}
      TUG_REVIEW_MODEL: ${{ secrets.TUG_REVIEW_MODEL }}
  merge:
    needs: [test, review]
    uses: hellogafaro/tug/.github/workflows/merge.yml@v1
    with:
      review: ${{ needs.review.outputs.review }}
```

1. Triggers: `pull_request` with `opened`, `synchronize`, `reopened` and `ready_for_review`. Label changes start nothing: a person who removes `merge:hold` or `needs:human` merges by hand. Use `concurrency` per PR with `cancel-in-progress`. Skip drafts.
2. `review` runs alongside the tests. It runs the code and security kinds in parallel and posts one COMMENT review with inline comments. It sets `risk:low|medium|high` and fails on a new high finding; a critical or high security finding counts as high. On a re-review it skips findings already raised and never lowers the risk.
3. `merge` runs only after `test` and `review` pass. It reads `tug.json`, requires `tug pr state` to be READY and the filters to pass, and requires the review of the same run, passed as `review.yml`'s output, to have said merge. It never reads the review from the PR, because any workflow's token posts as the same bot. It never merges a PR that changes `.github/`: that PR's own workflows run with a token that posts as the same bot, so they could forge the review. Then it runs `gh pr merge --squash --match-head-commit <sha>` and reads the PR back. Otherwise it adds `needs:human` and a comment.
4. CI belongs to the forge. Tug doesn't run CI commands itself. `tug init` writes a plain CI workflow when a repo has none: `npm ci`, `typecheck`, `lint`, `test` from `package.json`, or `shopify theme check`. It also adds the Tug jobs, and opens all of this as a PR.
5. Labels: `risk:*`, `needs:human`, and `merge:hold` (set by a person). There are no `review:*` or `security:*` labels; the checks show the result. Gates read checks, never labels.
6. Known limits:
   - The merge job only waits for jobs in its own workflow. Checks from other workflows read as PENDING, so it doesn't merge.
   - A merge done with `GITHUB_TOKEN` starts no other workflows.
   - Actions has no event for a resolved thread; verify this.
   - Pull requests from forks are skipped: they get no secrets, OIDC token or write token.
   - The free plan has no branch protection, so nothing stops a person from merging a red PR.
   - Comments show as `github-actions[bot]`.
7. Permissions: `contents: write`, `pull-requests: write`, `issues: write`.

## Follow-up

The agent that opened the PR runs `tug pr watch <repo>#<n>`, as pstack does with `watch-pr`. It stays quiet while the PR is PENDING, then exits once. Exit codes: 0 ready, 2 conflicts, 3 threads, 4 checks, 5 timeout, 7 query failure. It also stops on MERGED, CLOSED, `needs:human` or `merge:hold`. There's no catch-all watcher.

## Our infrastructure (Hello Gafaro)

1. Self-hosted runners on g4f4r0-server, ephemeral: a single-use runner config, one job per container, in the host's Docker on its own network `tug`, as a non-root user with no capabilities. They get no access to `~/.agents`, Infisical, `~/projects` or agent credentials, and an egress firewall keeps them off the host, the tailnet and private networks. The server has 16 cores, 31 GB of RAM and Docker.
2. One pool, `tug`, for every job, and no secret in any container. (Changed on 2026-11-12 from two pools, `tug-ai` with injected model settings and `tug-ci` without: labels don't restrict which workflow uses a runner, so a PR's own workflow could target `tug-ai` and print the key.) A key service on the host holds the model settings from Infisical and forwards model calls only for requests that carry GitHub's OIDC token for Tug's own `review.yml` or `merge.yml`, at a pinned ref, on an allowed repository. Tug's jobs never run the PR's code, so that token stays out of the PR's reach.
3. Organizations (`hellogafaro`, `Minicoton`, `VenezuelaTeAyuda`) register their runners at the org level. Each personal `g4f4r0` repo needs its own registration. Runners make outgoing connections only. Never use them for public repos.

## Decisions

1. The name is `tug`, and it's open source. MIT is suggested; confirm with the user.
2. Never use fast model variants.
3. Once Tug is live on a repo, switch off that repo's OpenCode automations, with the user's OK. They are "Review GitHub pull requests" (`auto_mw6oqs9nbd5083983280`) and "Merge decision" (`aut_1cc76e544001CVZX5s4Yk27ehJ`). Retire the `g4f4r0-opencode` app and the OpenTunnel route only when the user says so (see `opencode-plugins/AGENTS.md`).

## Phases

1. Create the public `hellogafaro/tug` repo, with the core, contracts and GitHub adapter, plus `tug pr state` and `tug pr watch`. Port them from `opencode-plugins` main `f9314e2`: `opencode-github/src/state.ts` and its tests in `test/trigger.test.ts`. Use `gh` or `GITHUB_TOKEN` instead of app tokens. Switch the `development` skill's `pr-follow-up` playbook to `tug pr watch` once the user approves the exact Notion diff.
2. Set up the runner pool for `g4f4r0/opencode-plugins`.
3. Build `review.yml` with the `api` engine, plus a CI workflow for `opencode-plugins`. Trial them on test PRs. The user decides how to avoid duplicate `risk:*` labels while the OpenCode review still runs.
4. Build `merge.yml`, and prove one PR merges and one is held. Then switch off the OpenCode automations.
5. Run `tug init` across our repos. Client theme repos get no `merge`.
6. Later: evals in Tug's CI, subscription engines, then the README and the public launch.

## Boundaries

1. Never edit `~/projects/opencode-plugins` directly: the server hot-reloads it. Use worktrees.
2. Notion skill changes need the user's approval of the exact diff. Upload with Executor's `notion.skills.upload` on the account labelled "Hello Gafaro", then sync and diff.
3. Security and permission changes need the user's approval.
4. Leave no test PRs, branches, automations or runners behind.

## Sources

Research is in `/tmp/opencode/tug/research/`: pstack, Pocock, steipete, factory.
