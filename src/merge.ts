import { parsePolicy, type PullState } from "./contracts.ts"
import { decide, type Decision } from "./core/decide.ts"
import { HUMAN_LABEL, state } from "./core/state.ts"
import { fileAt, pullFiles, readPull, setLabel, type Request } from "./forge/github.ts"
import { tugReviews } from "./review.ts"

/** The merge job's own check run, which is still running while it decides. */
const OWN_CHECK = /(^|\/ )merge$/u

export interface MergeResult {
  decision: Decision
  state: PullState
  merged: boolean
}

/**
 * Decides the pull request's head with `decide`, then merges it by squash on that exact commit, or holds it with
 * `needs:human` and one comment. A head that isn't ready yet is left alone.
 */
export async function runMerge(input: { request: Request; repo: string; number: number; reviewer: string; wait?: (ms: number) => Promise<void> }): Promise<MergeResult> {
  const { request, repo, number } = input
  const facts = await readPull({ request, repo, number, wait: input.wait })
  const checks = facts.checks?.filter((run) => !OWN_CHECK.test(run.name))
  const pull = state({ ...facts, checks })
  const base = await request<{ base?: { sha?: string } }>("GET", `/repos/${repo}/pulls/${number}`)
  const policy = parsePolicy(await fileAt(request, repo, "tug.json", base.base?.sha ?? pull.base))
  const review = (await tugReviews(request, repo, number, input.reviewer)).find((posted) => posted.head === pull.head) ?? null
  const files = pull.state === "READY" ? (await pullFiles(request, repo, number)).map((file) => file.path) : []
  const decision = decide({ state: pull, review, policy, files })

  if (decision.action === "merge") {
    await request("PUT", `/repos/${repo}/pulls/${number}/merge`, { body: { sha: pull.head, merge_method: "squash", commit_title: `${pull.title} (#${number})` } })
    const after = await readPull({ request, repo, number, wait: input.wait })
    return { decision, state: pull, merged: after.merged }
  }
  if (decision.action === "hold" && !pull.labels.includes(HUMAN_LABEL)) {
    await setLabel(request, repo, number, HUMAN_LABEL, pull.labels, "5319E7")
    await request("POST", `/repos/${repo}/issues/${number}/comments`, { body: { body: `Tug held ${pull.head.slice(0, 7)} for a person: ${decision.reason}` } })
  }
  return { decision, state: pull, merged: false }
}
