import { parseArgs } from "node:util"
import { describeState } from "./core/state.ts"
import { client, pullState, token } from "./forge/github.ts"
import { EXIT, watch } from "./watch.ts"

const USAGE = `Usage:
  tug pr state <owner/repo#n | PR URL | n> [--require <check>]... [--ignore <check>]...
  tug pr watch <owner/repo#n | PR URL | n> [--interval <s>] [--timeout <s>] [--settle <s>] [--until-merged] [--require <check>]... [--ignore <check>]...

tug pr state prints the pull request's state as JSON: MERGED, CLOSED, HELD, CONFLICTS, CHECKS, THREADS, PENDING or READY.
tug pr watch stays quiet while it is PENDING, then prints the state once and exits:
  0 ready or merged, 2 conflicts, 3 threads, 4 checks, 5 timeout, 6 held or closed, 7 query failure.

--require <check>   counts as pending until the head has this check or status
--ignore <check>    is not a check of the head
--interval <s>      seconds between reads (default 30)
--timeout <s>       seconds before exit 5 (default 3600; 0 never times out)
--until-merged      stays quiet while READY too, and exits on MERGED, CLOSED, held or a new blocker
--settle <s>        seconds a head with no checks yet stays pending, for checks to register after a push (default 60)

The token comes from GITHUB_TOKEN or GH_TOKEN, else from \`gh auth token\`. A bare number uses GITHUB_REPOSITORY.`

/** Parses `owner/repo#12`, a pull request URL, or `12` with `GITHUB_REPOSITORY`. */
export function parseRef(ref: string, env: NodeJS.ProcessEnv = process.env): { repo: string; number: number } {
  const url = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:[/?#].*)?$/u.exec(ref)
  const short = /^([\w.-]+\/[\w.-]+)#(\d+)$/u.exec(ref)
  const bare = /^#?(\d+)$/u.exec(ref)
  const repo = url?.[1] ?? short?.[1] ?? (bare ? env.GITHUB_REPOSITORY : undefined)
  const number = Number(url?.[2] ?? short?.[2] ?? bare?.[1])
  if (!repo || !/^[\w.-]+\/[\w.-]+$/u.test(repo) || repo.split("/").some((part) => /^\.+$/u.test(part)) || !Number.isSafeInteger(number) || number <= 0) throw new UsageError(`Not a pull request: ${ref}`)
  return { repo, number }
}

class UsageError extends Error {}

const seconds = (value: string | undefined, fallback: number, name: string): number => {
  if (value === undefined) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) throw new UsageError(`--${name} takes a number of seconds`)
  return parsed
}

export async function main(argv: string[], io: { out: (text: string) => void; err: (text: string) => void } = { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) }): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      options: {
        require: { type: "string", multiple: true },
        ignore: { type: "string", multiple: true },
        interval: { type: "string" },
        timeout: { type: "string" },
        settle: { type: "string" },
        "until-merged": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    })
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${USAGE}\n`)
    return EXIT.USAGE
  }
  const { values, positionals } = parsed
  const [group, command, ref, ...rest] = positionals
  if (values.help || group !== "pr" || (command !== "state" && command !== "watch") || !ref || rest.length > 0) {
    if (values.help) {
      io.out(`${USAGE}\n`)
      return 0
    }
    io.err(`${USAGE}\n`)
    return EXIT.USAGE
  }

  let target, intervalMs: number, timeoutMs: number, settleMs: number
  try {
    target = parseRef(ref)
    intervalMs = seconds(values.interval, 30, "interval") * 1000
    timeoutMs = seconds(values.timeout, 3600, "timeout") * 1000
    settleMs = seconds(values.settle, 60, "settle") * 1000
    if (intervalMs < 1000) throw new UsageError("--interval is at least 1 second")
  } catch (error) {
    io.err(`${(error as Error).message}\n`)
    return EXIT.USAGE
  }

  const options = { require: values.require ?? [], ignore: values.ignore ?? [] }
  try {
    const request = client(await token())
    const read = () => pullState({ request, ...target, ...options })
    if (command === "state") {
      io.out(`${JSON.stringify(await read(), null, 2)}\n`)
      return 0
    }
    const result = await watch({ read, intervalMs, timeoutMs, settleMs, untilMerged: values["until-merged"] === true })
    io.out(`${JSON.stringify(result.state, null, 2)}\n`)
    io.err(`${result.timedOut ? "TIMEOUT · " : ""}${describeState(result.state)}\n`)
    return result.exit
  } catch (error) {
    io.err(`${(error as Error).message}\n`)
    return EXIT.QUERY
  }
}
