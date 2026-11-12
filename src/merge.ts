import { parsePolicy, type PullState, type Review } from "./contracts.ts"
import { decide, type Decision } from "./core/decide.ts"
import { HUMAN_LABEL, state } from "./core/state.ts"
import { fileAt, pullFiles, readPull, setLabel, touchedPaths, type Request } from "./forge/github.ts"

/** The merge job's own check run, which is still running while it decides. A finished one named the same still counts. */
const OWN_CHECK = /(^|\/ )merge$/u

export interface MergeResult {
  decision: Decision
  state: PullState
  merged: boolean
}

/**
 * Decides the pull request's head with `decide`, from the review of the same workflow run, then merges it by squash on that exact commit, or holds it with
 * `needs:human` and one comment. A head that isn't ready yet is left alone.
 * The review comes from the run, not from the pull request's reviews, because any workflow's token posts as the same bot.
 * `base` is the base branch the review saw; a pull request retargeted since then waits.
 */
export async function runMerge(input: { request: Request; repo: string; number: number; review: Review | null; base?: string; wait?: (ms: number) => Promise<void> }): Promise<MergeResult> {
  const { request, repo, number } = input
  const facts = await readPull({ request, repo, number, wait: input.wait })
  const checks = facts.checks?.filter((run) => !(OWN_CHECK.test(run.name) && run.status !== "completed"))
  const pull = state({ ...facts, checks })
  const info = await request<{ base?: { sha?: string }; changed_files?: number; head?: { ref?: string; repo?: { full_name?: string } | null } }>("GET", `/repos/${repo}/pulls/${number}`)
  const baseSha = info.base?.sha ?? pull.base
  const policy = parsePolicy(await fileAt(request, repo, "tug.json", baseSha))
  if (input.base && input.base !== pull.base) return { decision: { action: "wait", reason: `The base changed from ${input.base} to ${pull.base} after the review` }, state: pull, merged: false }
  // Read by the head commit that merges, so the gates check exactly what lands.
  const files = pull.state === "READY" ? touchedPaths(await pullFiles(request, repo, baseSha, pull.head, info.changed_files ?? 0)) : []
  const decision = decide({ state: pull, review: input.review, policy, files })

  if (decision.action === "merge") {
    await request("PUT", `/repos/${repo}/pulls/${number}/merge`, { body: { sha: pull.head, merge_method: "squash", commit_title: `${pull.title} (#${number})` } })
    const after = await readPull({ request, repo, number, wait: input.wait })
    if (after.merged && info.head?.ref && info.head.repo?.full_name === repo) await deleteBranch(request, repo, info.head.ref, pull.head)
    return { decision, state: pull, merged: after.merged }
  }
  if (decision.action === "hold" && !pull.labels.includes(HUMAN_LABEL)) {
    await setLabel(request, repo, number, HUMAN_LABEL, pull.labels, "5319E7")
    await request("POST", `/repos/${repo}/issues/${number}/comments`, { body: { body: `Tug held ${pull.head.slice(0, 7)} for a person: ${decision.reason}` } })
  }
  return { decision, state: pull, merged: false }
}

/**
 * Deletes a merged branch, as `gh pr merge --delete-branch` does. It stays when an open pull request targets it, since
 * deleting a base branch closes its pull requests, when someone pushed to it since, or when any read fails.
 */
async function deleteBranch(request: Request, repo: string, branch: string, merged: string): Promise<void> {
  const ref = `/repos/${repo}/git/refs/heads/${branch.split("/").map(encodeURIComponent).join("/")}`
  try {
    const targeting = await request<unknown[]>("GET", `/repos/${repo}/pulls?state=open&base=${encodeURIComponent(branch)}&per_page=1`)
    const current = await request<{ object?: { sha?: string } }>("GET", ref)
    if (targeting.length === 0 && current.object?.sha === merged) await request("DELETE", ref)
  } catch {
    // The merge already happened; a branch left behind is harmless.
  }
}
