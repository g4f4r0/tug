import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { createInterface } from "node:readline"
import { parseArgs } from "node:util"
import { Review } from "./contracts.ts"
import { describeState } from "./core/state.ts"
import { modelSettings } from "./engine.ts"
import { client, pullState, token, type Request } from "./forge/github.ts"
import { deploy, healthy, removeHost, spawn, status, validHost, type Run } from "./host.ts"
import { init } from "./init.ts"
import { keysConfig, keysServer } from "./keys.ts"
import { runMerge } from "./merge.ts"
import { confirmed, removeRepo } from "./remove.ts"
import { runReview } from "./review.ts"
import { EXIT, watch } from "./watch.ts"

const PROMPTS = new URL("../prompts/", import.meta.url)
/** The account whose reviews Tug trusts: the Actions bot, or TUG_REVIEWER when run elsewhere. */
const reviewer = () => process.env.TUG_REVIEWER || "github-actions[bot]"

const USAGE = `Usage:
  tug review <owner/repo#n | PR URL | n>
  tug merge <owner/repo#n | PR URL | n>
  tug keys [--listen <host:port>]
  tug init [--merge] [--runs-on <label,...>]
  tug install --host <ssh-host> --project <infisical-project-id> --env <infisical-env> [--ref <branch|tag|sha>]
  tug update --host <ssh-host> [--ref <branch|tag|sha>]
  tug status --host <ssh-host>
  tug remove --host <ssh-host> [--yes]
  tug remove --repo <owner/repo> [--yes]
  tug pr state <owner/repo#n | PR URL | n> [--require <check>]... [--ignore <check>]...
  tug pr watch <owner/repo#n | PR URL | n> [--interval <s>] [--timeout <s>] [--settle <s>] [--until-merged] [--require <check>]... [--ignore <check>]...

tug review posts one review of the head (code and security) and its risk:* label, and fails on a new high finding.
tug merge merges the head when tug.json allows it, or holds it with needs:human. It reads the review from TUG_REVIEW.
tug init writes .github/workflows/tug.yml (tests, review, and merge with --merge) and tug.json in this directory.
  --runs-on defaults to ubuntu-latest; never use self-hosted runners for public repositories.
tug keys serves model calls for GitHub Actions jobs that prove, by OIDC, that they run Tug's own workflows.
tug install sets up the runners and the key service on a host over SSH, with the TUG_* settings of an Infisical environment.
tug update replaces Tug on the host with a ref (default main), keeps its settings and leaves running jobs alone.
tug status prints the host's services, installed version and running jobs as JSON; it exits 1 unless the runner and key services are active.
tug remove takes Tug off a host, or opens a pull request that deletes Tug's workflow and tug.json from a repository.
  It asks you to type the name; without a terminal it refuses unless --yes is given, which only a person's approval allows.
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

type Io = { out: (text: string) => void; err: (text: string) => void }
/** What the host commands touch outside this process; tests replace them. */
export interface Deps {
  run?: Run
  request?: Request
  tty?: boolean
  readLine?: () => Promise<string>
}

export async function main(argv: string[], io: Io = { out: (text) => process.stdout.write(text), err: (text) => process.stderr.write(text) }, deps: Deps = {}): Promise<number> {
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
        listen: { type: "string" },
        merge: { type: "boolean" },
        host: { type: "string" },
        project: { type: "string" },
        env: { type: "string" },
        ref: { type: "string" },
        repo: { type: "string" },
        yes: { type: "boolean" },
        "runs-on": { type: "string" },
        "until-merged": { type: "boolean" },
        help: { type: "boolean", short: "h" },
      },
    })
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${USAGE}\n`)
    return EXIT.USAGE
  }
  const { values, positionals } = parsed
  if (values.help) {
    io.out(`${USAGE}\n`)
    return 0
  }
  if (positionals[0] === "init" && positionals.length === 1) {
    const result = init(process.cwd(), { merge: values.merge === true, runsOn: (values["runs-on"] ?? "ubuntu-latest").split(",").map((label) => label.trim()).filter(Boolean) })
    const taken = result.files.filter((file) => existsSync(file.path)).map((file) => file.path)
    if (taken.length > 0) {
      io.err(`${taken.join(", ")} already exists; nothing was written\n`)
      return 1
    }
    for (const file of result.files) {
      mkdirSync(dirname(file.path), { recursive: true })
      writeFileSync(file.path, file.content)
      io.out(`Wrote ${file.path}\n`)
    }
    for (const note of result.notes) io.err(`${note}\n`)
    return 0
  }
  if ((positionals[0] === "install" || positionals[0] === "update" || positionals[0] === "status" || positionals[0] === "remove") && positionals.length === 1) return hostCommand(positionals[0], values, io, deps)
  if (positionals[0] === "keys" && positionals.length === 1) return keys(values.listen ?? "127.0.0.1:8787", io)
  if ((positionals[0] === "review" || positionals[0] === "merge") && positionals.length === 2) return job(positionals[0], positionals[1]!, io)
  const [group, command, ref, ...rest] = positionals
  if (group !== "pr" || (command !== "state" && command !== "watch") || !ref || rest.length > 0) {
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

async function job(command: "review" | "merge", ref: string, io: { out: (text: string) => void; err: (text: string) => void }): Promise<number> {
  let target
  try {
    target = parseRef(ref)
  } catch (error) {
    io.err(`${(error as Error).message}\n`)
    return EXIT.USAGE
  }
  try {
    const request = client(await token())
    if (command === "review") {
      const result = await runReview({ request, ...target, settings: modelSettings(), reviewer: reviewer(), promptsDir: PROMPTS })
      io.out(`${JSON.stringify(result.review, null, 2)}\n`)
      // The merge job of the same run reads the review from this output.
      if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `review=${JSON.stringify(result.review)}\n`)
      io.err(`Posted · risk ${result.review.risk} · merge ${result.review.merge ? "yes" : "no"} · ${result.review.findings.length} findings\n`)
      return result.failed ? 1 : 0
    }
    const result = await runMerge({ request, ...target, review: process.env.TUG_REVIEW ? Review.parse(JSON.parse(process.env.TUG_REVIEW)) : null, base: process.env.TUG_BASE || undefined })
    io.out(`${JSON.stringify({ action: result.decision.action, merged: result.merged, reason: result.decision.reason, head: result.state.head }, null, 2)}\n`)
    io.err(`${result.decision.action}${result.merged ? " · merged" : ""} · ${result.decision.reason}\n`)
    return result.decision.action === "merge" && !result.merged ? 1 : 0
  } catch (error) {
    // Fails closed: nothing merges, and the check shows the error.
    io.err(`${(error as Error).message}\n`)
    return 2
  }
}

function keys(listen: string, io: { out: (text: string) => void; err: (text: string) => void }): Promise<number> {
  const at = /^(.+):(\d+)$/u.exec(listen)
  if (!at) {
    io.err("--listen takes host:port\n")
    return Promise.resolve(EXIT.USAGE)
  }
  let config
  try {
    config = keysConfig()
  } catch (error) {
    io.err(`${(error as Error).message}\n`)
    return Promise.resolve(1)
  }
  const server = keysServer(config, { log: (line) => io.err(`${line}\n`) })
  return new Promise((resolve) => {
    server.on("error", (error) => {
      io.err(`${error.message}\n`)
      resolve(1)
    })
    server.listen(Number(at[2]), at[1], () => io.err(`Tug keys listening on ${listen}\n`))
  })
}

interface HostFlags {
  host?: string
  project?: string
  env?: string
  ref?: string
  repo?: string
  yes?: boolean
}

const FLAGS: Record<string, (keyof HostFlags)[]> = { install: ["host", "project", "env", "ref"], update: ["host", "ref"], status: ["host"], remove: ["host", "repo", "yes"] }

const readLine = async (): Promise<string> => {
  const lines = createInterface({ input: process.stdin })
  try {
    for await (const line of lines) return line
    return ""
  } finally {
    lines.close()
  }
}

async function hostCommand(command: string, values: HostFlags, io: Io, deps: Deps): Promise<number> {
  const usage = (message: string) => {
    io.err(`${message}\n`)
    return EXIT.USAGE
  }
  const flag = (name: string) => `--${name}`
  const stray = (Object.keys(values) as (keyof HostFlags)[]).filter((name) => ["host", "project", "env", "ref", "repo", "yes"].includes(name) && !FLAGS[command]!.includes(name))
  if (stray.length > 0) return usage(`tug ${command} does not take ${stray.map(flag).join(", ")}`)
  if (command === "remove") {
    if ((values.host === undefined) === (values.repo === undefined)) return usage("tug remove takes --host or --repo, not both or neither")
  } else {
    const missing = (command === "install" ? ["host", "project", "env"] : ["host"]).filter((name) => !values[name as keyof HostFlags])
    if (missing.length > 0) return usage(`tug ${command} needs ${missing.map(flag).join(", ")}`)
  }
  if (values.host !== undefined && !validHost(values.host)) return usage(`Not an SSH host: ${values.host}`)
  if (values.repo !== undefined && (!/^[\w.-]+\/[\w.-]+$/u.test(values.repo) || values.repo.split("/").some((part) => /^\.+$/u.test(part)))) return usage(`Not a repository: ${values.repo}`)

  const run = deps.run ?? spawn
  try {
    if (command === "remove") {
      const name = (values.host ?? values.repo)!
      if (!(await confirmed(name, { yes: values.yes === true, tty: deps.tty ?? process.stdin.isTTY === true, readLine: deps.readLine ?? readLine, err: io.err }))) return 1
      if (values.host !== undefined) {
        removeHost(run, values.host)
        io.out(`${JSON.stringify({ host: values.host, removed: true }, null, 2)}\n`)
        io.err(`Removed Tug from ${values.host}\n`)
        return 0
      }
      const result = await removeRepo(deps.request ?? client(await token()), values.repo!)
      io.out(`${JSON.stringify(result, null, 2)}\n`)
      io.err(`Opened ${result.pr} to remove Tug from ${result.repo}\n`)
      return 0
    }
    if (command === "status") {
      const result = status(run, values.host!)
      io.out(`${JSON.stringify(result, null, 2)}\n`)
      io.err(`${values.host} · ${Object.entries(result.services).map(([name, state]) => `${name} ${state}`).join(" · ")} · ${result.running} running\n`)
      return healthy(result) ? 0 : 1
    }
    const ref = values.ref ?? "main"
    const request = deps.request ?? client(await token())
    const result = await deploy({ host: values.host!, ref, request, run, settings: command === "install" ? { project: values.project!, env: values.env! } : undefined })
    io.out(`${JSON.stringify(result, null, 2)}\n`)
    io.err(`Installed ${result.version.slice(0, 7)} on ${result.host}\n`)
    return 0
  } catch (error) {
    io.err(`${(error as Error).message}\n`)
    return 1
  }
}
