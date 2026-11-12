# tug

Open-source PR review, security review and merge, running in CI on your own infrastructure with any model. No server, no app, no webhooks.

Work in progress. See [docs/design.md](docs/design.md).

## Follow up a pull request

```sh
tug pr state owner/repo#12      # prints the state as JSON
tug pr watch owner/repo#12      # quiet while PENDING, then prints the state once and exits
```

`tug pr watch` exits 0 when ready or merged (with `--until-merged`, only when merged), 2 on conflicts, 3 on unresolved threads, 4 on failed checks, 5 on timeout, 6 when held (`merge:hold` or `needs:human`) or closed, and 7 when GitHub can't be read. The token comes from `GITHUB_TOKEN` or `GH_TOKEN`, else from `gh auth token`.
