import type { PullState, PullStateName } from "./contracts.ts"

/** How `tug pr watch` exits, by what stopped it. */
export const EXIT = {
  READY: 0,
  MERGED: 0,
  USAGE: 1,
  CONFLICTS: 2,
  THREADS: 3,
  CHECKS: 4,
  TIMEOUT: 5,
  HELD: 6,
  CLOSED: 6,
  QUERY: 7,
} as const

const exitCode = (name: Exclude<PullStateName, "PENDING">): number => EXIT[name]

interface WatchResult {
  /** The last state read; PENDING when the watch timed out. */
  state: PullState
  exit: number
  timedOut: boolean
}

/** Consecutive failed reads before the watch gives up with exit 7. */
const MAX_FAILURES = 3

/**
 * Reads the pull request every `intervalMs` while it is PENDING, and returns the first other state. A `timeoutMs` of
 * 0 never times out. A failed read is retried with backoff, up to `MAX_FAILURES` in a row, then thrown.
 *
 * A head with no checks at all counts as PENDING for its first `settleMs`, timed from when the watch first saw that
 * head: right after a push, the forge may not have registered the head's checks yet, and it would read READY too early.
 */
export async function watch(input: {
  read: () => Promise<PullState>
  intervalMs: number
  timeoutMs: number
  settleMs?: number
  /** READY stays quiet too, so the watch ends on MERGED, CLOSED, HELD or a new blocker. */
  untilMerged?: boolean
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}): Promise<WatchResult> {
  const now = input.now ?? Date.now
  const sleep = input.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const deadline = input.timeoutMs > 0 ? now() + input.timeoutMs : Number.POSITIVE_INFINITY
  let head = ""
  let seen = now()
  const settled = (pull: PullState) => {
    if (pull.head !== head) {
      head = pull.head
      seen = now()
    }
    return pull.state !== "READY" || pull.passed.length > 0 || now() - seen >= (input.settleMs ?? 0)
  }
  let failures = 0
  let last: PullState | undefined
  for (;;) {
    try {
      last = await input.read()
      failures = 0
      const name = last.state
      const quiet = name === "PENDING" || (input.untilMerged === true && name === "READY")
      if (settled(last) && !quiet) return { state: last, exit: exitCode(name), timedOut: false }
    } catch (error) {
      failures++
      if (failures >= MAX_FAILURES) throw error
    }
    const delay = failures > 0 ? Math.min(input.intervalMs * 2 ** failures, 300_000) : input.intervalMs
    const left = deadline - now()
    if (left <= 0) {
      if (last) return { state: last, exit: EXIT.TIMEOUT, timedOut: true }
      throw new Error("The watch timed out before any read succeeded")
    }
    await sleep(Math.min(delay, left))
  }
}
