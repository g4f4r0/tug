import { VERSION, type PullState, type PullStateName } from "../contracts.ts"

/** What a forge reports about a pull request and its head, before any rule reads it. */
export interface PullFacts {
  repo: string
  number: number
  state: "open" | "closed"
  merged: boolean
  draft: boolean
  /** Null while the forge has not computed it yet. */
  mergeable: boolean | null
  /** GitHub's `mergeable_state`, such as `clean` or `dirty`. */
  mergeableState: string
  head: string
  base: string
  title: string
  author: string
  labels: string[]
  /** Check runs on the head. Absent when the pull request is merged or closed and nothing more was read. */
  checks?: { name: string; status: string; conclusion: string | null }[]
  /** Commit status contexts on the head, latest per context. */
  statuses?: { context: string; state: string }[]
  /** Unresolved review threads. */
  threads?: number
}

/** A person adds it to stop the merge for one pull request. */
export const HOLD_LABEL = "merge:hold"
/** Tug adds it when it holds a pull request for a person. */
export const HUMAN_LABEL = "needs:human"
const HELD_LABELS = [HOLD_LABEL, HUMAN_LABEL]

const OK_CONCLUSIONS = ["success", "neutral", "skipped"]

export interface StateOptions {
  /** Checks that are not checks of the head, such as the merge job's own run. */
  ignore?: readonly string[]
  /** Checks that count as pending until the head has them, such as the review. */
  require?: readonly string[]
}

/** Names the state of a pull request: the first of merged, closed, held, conflicts, failed checks, threads and pending work, else READY. */
export function state(facts: PullFacts, options: StateOptions = {}): PullState {
  const ignore = new Set(options.ignore ?? [])
  const labels = facts.labels
  const make = (name: PullStateName, rest: Pick<PullState, "failed" | "pending" | "threads" | "reasons">): PullState => ({
    version: VERSION,
    repo: facts.repo,
    number: facts.number,
    state: name,
    head: facts.head,
    base: facts.base,
    title: facts.title,
    author: facts.author,
    labels,
    ...rest,
  })
  const done = (name: PullStateName) => make(name, { failed: [], pending: [], threads: 0, reasons: [] })
  if (facts.merged) return done("MERGED")
  if (facts.state === "closed") return done("CLOSED")
  if (facts.checks === undefined || facts.statuses === undefined || facts.threads === undefined) throw new Error(`${facts.repo}#${facts.number} is open, but its checks, statuses or threads were not read`)

  const failed: string[] = []
  const pending: string[] = []
  for (const run of facts.checks) {
    if (ignore.has(run.name)) continue
    if (run.status !== "completed") pending.push(run.name)
    else if (!OK_CONCLUSIONS.includes(run.conclusion ?? "")) failed.push(run.name)
  }
  for (const status of facts.statuses) {
    if (ignore.has(status.context) || status.state === "success") continue
    if (status.state === "pending") pending.push(status.context)
    else failed.push(status.context)
  }
  const posted = new Set([...facts.checks.map((run) => run.name), ...facts.statuses.map((status) => status.context)])
  for (const name of options.require ?? []) if (!ignore.has(name) && !posted.has(name)) pending.push(`${name} (not posted)`)

  const reasons: string[] = []
  const held = labels.map((label) => label.toLowerCase()).filter((label) => HELD_LABELS.includes(label))
  const conflicts = facts.mergeable === false || facts.mergeableState === "dirty"
  const unknown = facts.mergeable === null
  for (const label of held) reasons.push(`label ${label}`)
  if (conflicts) reasons.push("merge conflicts")
  if (facts.draft) reasons.push("draft")
  if (unknown && !conflicts) reasons.push("mergeability not computed yet")

  const name: PullStateName =
    held.length > 0 ? "HELD" : conflicts ? "CONFLICTS" : failed.length > 0 ? "CHECKS" : facts.threads > 0 ? "THREADS" : facts.draft || unknown || pending.length > 0 ? "PENDING" : "READY"
  return make(name, { failed, pending, threads: facts.threads, reasons })
}

/** A short plain summary of a state and what holds it. */
export function describeState(pull: PullState): string {
  return [
    pull.state,
    ...pull.reasons,
    pull.failed.length > 0 ? `failed: ${pull.failed.join(", ")}` : "",
    pull.pending.length > 0 ? `pending: ${pull.pending.join(", ")}` : "",
    pull.threads > 0 ? `${pull.threads} unresolved thread${pull.threads === 1 ? "" : "s"}` : "",
  ]
    .filter(Boolean)
    .join(" · ")
}
