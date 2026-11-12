import { describe, expect, it } from "vitest"
import type { PullState, PullStateName } from "../src/contracts.ts"
import { parseRef } from "../src/cli.ts"
import { EXIT, watch } from "../src/watch.ts"

const pull = (name: PullStateName): PullState => ({ version: 1, repo: "o/r", number: 1, state: name, head: "a", base: "main", title: "t", author: "u", labels: [], passed: [], failed: [], pending: [], threads: 0, reasons: [] })

/** A fake clock: sleeping moves time forward. */
function clock() {
  let time = 0
  const sleeps: number[] = []
  return { now: () => time, sleep: async (ms: number) => void (sleeps.push(ms), (time += ms)), sleeps }
}

describe("watch", () => {
  it("stays quiet while pending and exits once with the next state's code", async () => {
    const expected: [PullStateName, number][] = [["READY", 0], ["MERGED", 0], ["CONFLICTS", 2], ["THREADS", 3], ["CHECKS", 4], ["HELD", 6], ["CLOSED", 6]]
    for (const [name, code] of expected) {
      const states = [pull("PENDING"), pull("PENDING"), pull(name)]
      const c = clock()
      const result = await watch({ read: async () => states.shift()!, intervalMs: 30_000, timeoutMs: 0, ...c })
      expect(result).toMatchObject({ exit: code, timedOut: false, state: { state: name } })
      expect(c.sleeps).toEqual([30_000, 30_000])
    }
  })

  it("keeps a head with no checks yet pending for the settle window, then trusts READY", async () => {
    const c = clock()
    const bare = await watch({ read: async () => pull("READY"), intervalMs: 30_000, timeoutMs: 0, settleMs: 60_000, ...c })
    expect(bare.exit).toBe(0)
    expect(c.sleeps).toEqual([30_000, 30_000])
    const checked = clock()
    const green = await watch({ read: async () => ({ ...pull("READY"), passed: ["test"] }), intervalMs: 30_000, timeoutMs: 0, settleMs: 60_000, ...checked })
    expect(green.exit).toBe(0)
    expect(checked.sleeps).toEqual([])
  })

  it("restarts the settle window when a push changes the head", async () => {
    const c = clock()
    const reads = [pull("PENDING"), pull("PENDING"), pull("PENDING"), { ...pull("READY"), head: "b" }, { ...pull("READY"), head: "b" }, { ...pull("READY"), head: "b" }]
    const result = await watch({ read: async () => reads.shift()!, intervalMs: 30_000, timeoutMs: 0, settleMs: 60_000, ...c })
    expect(result).toMatchObject({ exit: 0, state: { head: "b" } })
    expect(c.sleeps).toHaveLength(5)
  })

  it("times out with exit 5 and the last pending state", async () => {
    const c = clock()
    const result = await watch({ read: async () => pull("PENDING"), intervalMs: 30_000, timeoutMs: 70_000, ...c })
    expect(result).toMatchObject({ exit: EXIT.TIMEOUT, timedOut: true, state: { state: "PENDING" } })
    expect(c.sleeps).toEqual([30_000, 30_000, 10_000])
  })

  it("retries a failed read with backoff, and throws after three in a row", async () => {
    const c = clock()
    let reads = 0
    const flaky = async () => {
      reads++
      if (reads <= 2) throw new Error("502")
      return pull("READY")
    }
    expect((await watch({ read: flaky, intervalMs: 1_000, timeoutMs: 0, ...c })).exit).toBe(0)
    expect(c.sleeps).toEqual([2_000, 4_000])
    await expect(watch({ read: async () => Promise.reject(new Error("401")), intervalMs: 1_000, timeoutMs: 0, ...clock() })).rejects.toThrow("401")
  })
})

describe("parseRef", () => {
  it("reads owner/repo#n, a pull request URL, or a number with GITHUB_REPOSITORY", () => {
    expect(parseRef("g4f4r0/opencode-plugins#31")).toEqual({ repo: "g4f4r0/opencode-plugins", number: 31 })
    expect(parseRef("https://github.com/hellogafaro/tug/pull/2/files")).toEqual({ repo: "hellogafaro/tug", number: 2 })
    expect(parseRef("7", { GITHUB_REPOSITORY: "o/r" })).toEqual({ repo: "o/r", number: 7 })
    expect(() => parseRef("7", {})).toThrow("Not a pull request")
    expect(() => parseRef("o/r#0")).toThrow()
    expect(() => parseRef("../x#1")).toThrow()
  })
})
