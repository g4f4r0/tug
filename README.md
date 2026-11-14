# Tug

Tug reviews pull requests for bugs and security issues with the model you choose, and merges the safe ones. It runs as jobs in your repository's GitHub Actions. Tug is in beta (0.0.1), and workflows run it from `main`.

## How it works

1. A pull request opens or gets a push, and GitHub Actions runs your tests, then Tug's `review` job.
2. The review sends the change to the model twice, once for correctness ([prompts/code.md](prompts/code.md)) and once for security ([prompts/security.md](prompts/security.md)). It posts one review with inline comments and a `risk:low`, `risk:medium` or `risk:high` label, and fails on a new critical or high finding.
3. Both passes also look at the screenshots and videos the pull request shows, and judge them as evidence of the change. An error, a broken layout or a result other than the one claimed is a finding. So is a screenshot that shows a secret or personal data.
4. The `merge` job squash-merges the exact commit the review saw, when `tug.json` allows it, every check passed and no thread is open. Otherwise it labels the pull request `needs:human` and says why in one comment.

Tug never runs the pull request's code. It reads the change through the GitHub API, and it never merges a change to `.github/`.

## Showing what a change does

Since Tug doesn't run the code, whoever opens the pull request shows what it does, in its body or a comment. Tug reads:

1. Images written as `![what it shows](url)` or `<img src="url">`.
2. A video as a link alone on its own line, ending in `.mp4`, `.mov` or `.webm`, or as `<video src="url">`. Tug looks at 6 frames spread over it.
3. Either of these pointing at a file uploaded to GitHub or a file in the repository, on any branch.
4. An image or video file the pull request changes, with no link needed.

Tug doesn't follow a plain link such as `[recording](url)`, or anything over plain http. It names media it can't read in the review, so that media never counts as evidence. Crop or blur secrets and personal data before you post a screenshot, because Tug reports them as a critical finding.

## Install

The CLI needs Node 24 or later. Run it as `npx -y github:g4f4r0/tug#main <command>`; the commands below write `tug` for that.

### On GitHub's runners

1. Add the model's secrets to the repository or organization. That's `TUG_REVIEW_MODEL`, such as `openai/gpt-6.1-sol` or `anthropic/claude-opus-5-5`, and that provider's key, `TUG_OPENAI_API_KEY` or `TUG_ANTHROPIC_API_KEY`.
2. In the repository, run `tug init --merge`, then commit and push the two files it writes. Leave out `--merge` to only review.
3. Open a pull request. Tug reviews it within a few minutes.

### On your own server

Use this for private repositories only. Tug runs as the user you install it as, never as root, with its own rootless Docker. Each job runs in a fresh container that Tug deletes afterwards. The container gets capped CPU and memory, no secrets, and no access to the server, its network or your tailnet. A key service on the server holds the model keys, so repositories need no secrets.

1. Create a classic token with the `repo` and `admin:org` scopes from [this link](https://github.com/settings/tokens/new?description=Tug&scopes=repo,admin:org). With the GitHub CLI, you can run `gh auth refresh -s admin:org` and use `gh auth token` instead. It must be classic, because one classic token serves all your accounts. The token acts as you. It manages runners only in organizations and repositories you own, but it can reach every repository you can, so keep the server private.
2. Get a Debian or Ubuntu server with SSH. `tug install` first checks what the server lacks. Only what root alone can set up, such as Docker, `uidmap`, `rootlesskit` or a swap file, needs `sudo`, once, and `sudo` asks for your password when you run the command in a terminal. Everything else runs as you. `tug install --host <ssh-host> --check` prints that check and installs nothing.
3. Install, with the settings in your environment:
   ```sh
   export TUG_GITHUB_TOKEN="$(gh auth token)" TUG_ACCOUNTS=my-user,my-org \
     TUG_REVIEW_MODEL=openai/gpt-6.1-sol TUG_OPENAI_API_KEY=sk-...
   tug install --host <ssh-host>
   ```
   Any secrets tool's `run` wrapper works in place of `export`. The install ends by checking that a job's container reaches the key service, and stops with the reason when it can't.
4. Run `tug status --host <ssh-host>`. Every service should be `active` (`tug-docker`, `tug-keys`, `tug-runners`). `keys` is `ok` when jobs reach the key service, and `model` is `ok` when each model answers a test question with your settings.
5. In each repository, run `tug init --merge --runs-on tug`, then commit and push. Its workflow passes no secrets, since the key service holds the model keys. A model key that reaches a job on your server anyway is never used, and the job warns you with its name.

### Sizing the server

Tug runs 4 jobs at once by default (`TUG_MAX_RUNNERS`), and the rest wait their turn. Each job gets an even share of the server's memory, and of its CPUs, at least one. A review needs little of either, because it spends most of its time waiting for the model. Test jobs need more. The heaviest we measured peaked at 2.8 GB, though most of that was file cache it could give back.

Swap lets a job that needs more than its share borrow as much again, so it slows down instead of being killed. `tug install` and `tug update` add a 4 GB swap file to a server that has none, on ext4 or xfs with 8 GB free. On a 2-CPU, 8 GB server, going from 2 jobs at once to 4 cut the median wait for a slot from 7.6 to 2.5 minutes in a replay of a day's jobs. The heaviest test job still passed within its 2 GB share, without touching swap.

## Common tasks

1. Update the server to the latest Tug with `tug update --host <h>`. Its settings and running jobs stay. A server that ran an older Tug as root moves over, with one fix as root that moves its settings to your user and removes the old Tug.
2. Change server settings with `tug config set --host <h> TUG_ACCOUNTS=my-user,my-org`. It keeps the other settings, restarts Tug and prints `tug status`. Give a secret by its name alone, such as `tug config set --host <h> TUG_GITHUB_TOKEN`. Tug takes it from your environment, or asks for it without showing it, so it stays out of your shell's history. `tug config unset --host <h> TUG_SECURITY_MODEL` removes a setting, and `tug config list --host <h>` prints the names set, never a value.
3. Read the server's logs with `tug logs --host <h>`. `--lines 200` shows more.
4. For a pull request labelled `needs:human`, read Tug's comment, then fix and push, or merge it yourself.
5. After you resolve review threads without a push, rerun the merge job with `gh run rerun <run-id> --job <job-id>`.
6. Stop Tug from merging one pull request with the `merge:hold` label.
7. Follow a pull request with `tug pr watch owner/repo#12`. It waits quietly, then prints the state as JSON and exits with 0 for ready or merged, 2 for conflicts, 3 for open threads, 4 for failed checks, 5 for a timeout, 6 for held or closed, 7 when GitHub is unreachable, and 1 for a usage error. `tug pr state` prints the state at once.
8. To move to another server, run `tug remove --host <old>` first, because only one server can serve an account at a time. Then run `tug install --host <new>`.
9. Remove Tug from a repository with `tug remove --repo <owner/repo>`. It opens a pull request that deletes the two files.

`remove` asks you to type the name. Without a terminal it needs `--yes`.

### When reviews fail on your own server

Run `tug status --host <h>`. Its `keys` and `model` say what is wrong.

1. If `keys` says nothing listens, or the connection timed out, the key service or Tug's Docker is down. `tug logs --host <h>` says why. Jobs reach the key service inside Tug's own Docker, so the server's firewall never stands between them.
2. If a service isn't `active`, `tug logs --host <h>` says why, and `tug install --host <h> --check` shows what the server lacks.
3. If `model` shows the provider's answer, such as a wrong model name, key or base URL, fix it with `tug config set`.

## tug.json

`tug.json` at the repository's root sets what Tug reviews and merges. Tug reads it from the base branch, so a pull request can't loosen its own rules.

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

1. Every field is optional. Without `review`, Tug runs both passes on every pull request that isn't a draft. Without `merge`, Tug only reviews.
2. `review.code` and `review.security` turn each pass on or off. With both off, Tug doesn't review, and `merge` is an error.
3. `review.drafts` reviews drafts too. `review.max` is the most reviews on one pull request; past it, Tug adds `needs:human`.
4. `merge.risk` is the highest risk Tug merges by itself.
5. `filters` match the pull request's `authors`, base `branches`, `labels` and changed `paths` with globs, like GitHub Actions' filters. `!` excludes, and the last match wins. A label change counts from the next push.
6. `review.filters.paths` picks the files the model sees, and Tug never merges a file the review didn't see. In `merge.filters`, every changed file must match `paths`.
7. A pull request the review leaves out gets `skipped: <reason>` in the job's log and no review, and the merge holds it for a person.
8. `rules` add to the review's defaults.

## Settings

| Setting | Where | Meaning |
|---|---|---|
| `TUG_REVIEW_MODEL` | both | Required. `openai/<model>` or `anthropic/<model>`. |
| `TUG_OPENAI_API_KEY`, `TUG_ANTHROPIC_API_KEY` | both | The key of each provider a pass uses. |
| `TUG_OPENAI_BASE_URL`, `TUG_ANTHROPIC_BASE_URL` | both | Optional. Each defaults to the provider's API; any compatible proxy works. |
| `TUG_REVIEW_REASONING_EFFORT` | both | Optional, such as `high`. Unset, the provider's default applies. |
| `TUG_SECURITY_MODEL`, `TUG_SECURITY_REASONING_EFFORT` | both | Optional. The security pass; each falls back to the review's. |
| `TUG_GITHUB_TOKEN` | server | A classic token with `repo` and `admin:org`, or `gh auth token`. |
| `TUG_ACCOUNTS` | server | Your user and the organizations to serve, such as `my-user,my-org`. Your user serves its own private repositories. |
| `TUG_MAX_RUNNERS` | server | Optional. Jobs at once, across all accounts. Default 4. |

"Both" means repository or organization secrets on GitHub's runners, or the server's settings on your own.

## Limits

1. The merge job sees checks from other workflows as pending, so it doesn't merge beside them.
2. A merge made with the workflow's token starts no other workflows.
3. Tug skips pull requests from forks, because they get no secrets or write token.
4. Your own server skips public repositories, and organizations whose Default runner group allows them.
5. Reviews and comments come from `github-actions[bot]`.
6. A review reads at most 10 pieces of media, up to 50 MB each, and shows the model at most 16 images, a video's frames included. It reads the media into a temporary folder and deletes it once the review is posted.
7. The repository's token goes to GitHub only, never to another host or along a redirect.
8. Where a runner has no ffmpeg on PATH, as neither Tug's own runners nor GitHub's `ubuntu-latest` do, Tug downloads a pinned static build. It checks the build against its SHA-256 and runs it with no environment.

Tug is MIT-licensed.
