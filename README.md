# tug

Open-source PR review, security review and merge, running in CI on your own infrastructure with any model. No server, no app, no webhooks.

## How it works

A repository's CI workflow gets two jobs next to its tests:

1. `review` sends the pull request's title, body, comments, patches and `tug.json` rules to the model twice, once for correctness ([prompts/code.md](prompts/code.md)) and once for security ([prompts/security.md](prompts/security.md)), each with a strict JSON schema. It posts one review with inline comments, sets `risk:low`, `risk:medium` or `risk:high`, and fails on a new critical or high finding. A re-review skips findings already raised and never lowers the risk.
2. `merge` runs after the tests and the review. When `tug.json` has `merge`, it squash-merges the exact head the review saw, if the head is ready (every check green, no open thread, no conflict, no `merge:hold` or `needs:human`), the review says merge, and the risk is within the policy. Otherwise it holds the pull request with `needs:human` and one comment. It never merges a pull request that changes `.github/`.

Tug runs no code from the pull request: it reads the change through the GitHub API.

## Set up a repository

```sh
npx -y github:hellogafaro/tug#main init --merge
```

This writes `.github/workflows/tug.yml`, with a test job from `package.json` (`typecheck`, `lint`, `test`, using its lockfile's package manager), the review and the merge, and `tug.json`. Leave out `--merge` to only review. A repository with CI of its own gets only the review, because the merge job has to run in the same workflow as the tests; add the jobs to that workflow by hand.

To take Tug off a repository, run `npx -y github:hellogafaro/tug#main remove --repo <owner/repo>`. It opens a pull request that deletes `.github/workflows/tug.yml` and `tug.json`, after you type the repository's name.

Model settings are repository or organization secrets: `TUG_MODEL_URL` (any OpenAI-compatible API), `TUG_MODEL_KEY`, and `TUG_REVIEW_MODEL`, such as `gpt-6.1-sol:high` (a model, optionally with its reasoning effort). The security pass uses `TUG_SECURITY_MODEL` when set, else the review model. With your own runners and the key service (below), the repository needs none of them.

## tug.json

```json
{
  "merge": {
    "risk": "low",
    "filters": { "authors": ["octocat"], "branches": ["main"], "paths": ["docs/**", "!docs/legal/**"] }
  },
  "rules": ["Prices live in config/prices.json; any change to it needs a person."]
}
```

1. `merge.risk` is the highest risk that merges by itself. Without `merge`, Tug only reviews.
2. `filters` work like GitHub Actions' branch and path filters, and every changed file must pass `paths`.
3. `rules` are read by the review on top of its defaults.
4. Tug reads `tug.json` from the base branch, so a pull request can't loosen its own review.

## Your own runners

[runners/](runners/README.md) installs single-use self-hosted runners on a Debian host with Docker: one container per job, discarded after it, with no secrets and no access to the host or private networks. Its key service holds the model settings and answers only GitHub-signed tokens for Tug's own review job, so no runner ever holds the key. Never use self-hosted runners for public repositories.

## Follow up a pull request

```sh
tug pr state owner/repo#12      # prints the state as JSON
tug pr watch owner/repo#12      # quiet while PENDING, then prints the state once and exits
```

`tug pr watch` exits 0 when ready or merged (with `--until-merged`, only when merged), 2 on conflicts, 3 on unresolved threads, 4 on failed checks, 5 on timeout, 6 when held (`merge:hold` or `needs:human`) or closed, and 7 when GitHub can't be read. The token comes from `GITHUB_TOKEN` or `GH_TOKEN`, else from `gh auth token`.

Resolving a thread starts no workflow. After resolving threads without a push, re-run the run's merge job: `gh run rerun <run-id> --job <job-id>`.

## Limits

1. Checks from other workflows look pending to the merge job, so it doesn't merge beside them.
2. A merge made with the workflow's token starts no other workflows.
3. Pull requests from forks are skipped: they get no secrets, OIDC token or write token.
4. Reviews and comments show as `github-actions[bot]`.

See [docs/design.md](docs/design.md) for the design.
