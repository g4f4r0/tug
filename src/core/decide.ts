import { riskRank, type Policy, type PullState, type Review } from "../contracts.ts"
import { passes } from "./filters.ts"
import { describeState } from "./state.ts"

/**
 * `merge` the head now; `hold` it for a person with `needs:human`; or `wait`, changing nothing, because the head is not
 * ready yet, someone already holds it, or merging is off.
 */
export interface Decision {
  action: "merge" | "hold" | "wait"
  reason: string
}

const BLOCKING = ["critical", "high"]

/**
 * Decides one head. It fails closed: anything missing, stale or unclear holds, and only a ready head that every
 * filter passes, with a review of that same head that says merge within the policy's risk, merges.
 */
export function decide(input: { state: PullState; review: Review | null; policy: Policy; files: readonly string[] }): Decision {
  const { state, review, policy, files } = input
  const merge = policy.merge
  if (!merge) return { action: "wait", reason: "tug.json has no merge, so Tug only reviews" }
  if (state.state !== "READY") return { action: "wait", reason: describeState(state) }

  const filters = merge.filters ?? {}
  if (!passes(filters.authors, state.author, { caseless: true })) return { action: "hold", reason: `The author ${state.author} is not in merge.filters.authors.` }
  if (!passes(filters.branches, state.base)) return { action: "hold", reason: `The base branch ${state.base} is not in merge.filters.branches.` }
  if (files.length === 0) return { action: "hold", reason: "No changed files were read." }
  const outside = files.filter((file) => !passes(filters.paths, file))
  if (outside.length > 0) return { action: "hold", reason: `${outside.slice(0, 3).join(", ")}${outside.length > 3 ? ` and ${outside.length - 3} more` : ""} not in merge.filters.paths.` }

  if (!review) return { action: "hold", reason: `No review of ${state.head.slice(0, 7)} was found.` }
  if (review.head !== state.head) return { action: "hold", reason: `The review is of ${review.head.slice(0, 7)}, not the head ${state.head.slice(0, 7)}.` }
  if (riskRank(review.risk) > riskRank(merge.risk)) return { action: "hold", reason: `Risk is ${review.risk}; tug.json merges up to ${merge.risk}.` }
  const blocking = review.findings.filter((finding) => BLOCKING.includes(finding.severity))
  if (blocking.length > 0) return { action: "hold", reason: `${blocking.length} ${blocking.length === 1 ? "finding is" : "findings are"} critical or high.` }
  if (!review.merge) return { action: "hold", reason: review.reason }
  return { action: "merge", reason: review.reason }
}
