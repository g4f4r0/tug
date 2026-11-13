import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { createInterface } from "node:readline"
import { parseArgs } from "node:util"
import { Review } from "./contracts.ts"
import { describeState } from "./core/state.ts"
import { modelSettings } from "./engine.ts"
import { client, pullState, token, type Request } from "./forge/github.ts"
import { checkHost, configure, deploy, download, healthy, HOST_SETTINGS, interactive, logs, removeHost, settingNames, settingsFile, spawn, status, validHost, type Download, type Interactive, type Run, type Ssh } from "./host.ts"
import { init } from "./init.ts"
import { checkModels, keysConfig, keysServer } from "./keys.ts"
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
  tug keys [--listen <host:port>] [--check]
  tug init [--merge] [--runs-on <label,...>]
  tug install --host <ssh-host> [--ref <branch|tag|sha>] [--check]
  tug update --host <ssh-host> [--ref <branch|tag|sha>]
  tug status --host <ssh-host>
  tug config set --host <ssh-host> <NAME=value | NAME>...
  tug config unset --host <ssh-host> <NAME>...
  tug config list --host <ssh-host>
  tug logs --host <ssh-host> [--lines <n>]
  tug remove --host <ssh-host> [--yes]
  tug remove --repo <owner/repo> [--yes]
  tug pr state <owner/repo#n | PR URL | n> [--require <check>]... [--ignore <check>]...
  tug pr watch <owner/repo#n | PR URL | n> [--interval <s>] [--timeout <s>] [--settle <s>] [--until-merged] [--require <check>]... [--ignore <check>]...

tug review posts one review of the head (code and security) and its risk:* label, and fails on a new high finding.
  It prints "skipped: <reason>" and exits 0 when tug.json's review settings leave the pull request out.
tug merge merges the head when tug.json allows it, or holds it with needs:human. It reads the review from TUG_REVIEW.
tug init writes .github/workflows/tug.yml (tests and review) in this directory; --merge adds the merge job and tug.json.
  --runs-on defaults to ubuntu-latest; never use self-hosted runners for public repositories.
tug keys serves model calls for GitHub Actions jobs that prove, by OIDC, that they run Tug's own workflows.
  --check instead asks each model one test question with the key service's settings, and prints ok or what failed.
tug install sets up Tug on a Debian or Ubuntu host over SSH, as the SSH user and never as root: its own rootless Docker,
  the runners and the key service, with the TUG_* settings of its own environment, and checks that jobs reach the key
  service. It first checks what the host lacks; only what root alone can install, such as Docker or uidmap, asks for
  sudo, once. --check prints that check and installs nothing.
tug update replaces Tug on the host with a ref (default main), keeps its settings and leaves running jobs alone.
tug status prints the host's services, installed version, running jobs, whether jobs reach the key service (keys) and
  whether each model answers a test question (model) as JSON; it exits 1 unless every one is well.
tug config set changes host settings and keeps the rest; a bare NAME takes its value from the environment, or asks for
  it without showing it. tug config unset removes settings. Both restart the services, then print tug status.
  tug config list prints the names set, never a value.
tug logs prints the last log lines of Tug's Docker, key service and runner service (default 50).
Where sudo asks for a password, an install or update that needs it, and removing a Tug that ran as root, need a terminal.
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
  download?: Download
  env?: NodeJS.ProcessEnv
  tty?: boolean
  readLine?: () => Promise<string>
  /** Reads a value typed at a prompt without showing it. */
  readSecret?: (prompt: string) => Promise<string>
  interactive?: Interactive
  checkModels?: typeof checkModels
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
        ref: { type: "string" },
        repo: { type: "string" },
        yes: { type: "boolean" },
        lines: { type: "string" },
        check: { type: "boolean" },
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
  if (["install", "update", "status", "remove", "logs"].includes(positionals[0]!) && positionals.length === 1) return hostCommand(positionals[0]!, [], values, io, deps)
  if (positionals[0] === "config" && ["set", "unset", "list"].includes(positionals[1]!)) return hostCommand(`config ${positionals[1]}`, positionals.slice(2), values, io, deps)
  if (positionals[0] === "keys" && positionals.length === 1) return values.check ? checkKeys(io, deps.checkModels ?? checkModels) : keys(values.listen ?? "127.0.0.1:8787", io)
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

async function job(command: "review" | "merge", ref: string, io: Io): Promise<number> {
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
      const result = await runReview({ request, ...target, settings: () => modelSettings(), reviewer: reviewer(), promptsDir: PROMPTS })
      // No review output: the merge job then has no review of the head, and never merges it.
      if ("skipped" in result) {
        io.out(`skipped: ${result.skipped}\n`)
        return 0
      }
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

function keys(listen: string, io: Io): Promise<number> {
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

/** `tug keys --check`: one line, ok or what failed, as `tug status` reads it on the host. */
async function checkKeys(io: Io, check: typeof checkModels): Promise<number> {
  try {
    const problems = await check(keysConfig())
    if (problems.length === 0) {
      io.out("ok\n")
      return 0
    }
    io.out(`${problems.join("; ")}\n`)
  } catch (error) {
    io.out(`${(error as Error).message}\n`)
  }
  return 1
}

interface HostFlags {
  host?: string
  ref?: string
  repo?: string
  yes?: boolean
  lines?: string
  check?: boolean
}

const FLAGS: Record<string, (keyof HostFlags)[]> = {
  install: ["host", "ref", "check"],
  update: ["host", "ref"],
  status: ["host"],
  remove: ["host", "repo", "yes"],
  logs: ["host", "lines"],
  "config set": ["host"],
  "config unset": ["host"],
  "config list": ["host"],
}

/** Reads one line from the terminal without showing it, for a secret typed or pasted at a prompt. */
const readSecret = (prompt: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const input = process.stdin
    let value = ""
    const finish = (error?: Error) => {
      input.off("data", onData)
      input.setRawMode(false)
      input.pause()
      process.stderr.write("\n")
      if (error) reject(error)
      else resolve(value)
    }
    const onData = (chunk: Buffer) => {
      for (const char of chunk.toString("utf8")) {
        if (char === "\r" || char === "\n" || char === "\u0004") return finish()
        if (char === "\u0003") return finish(new Error("Cancelled"))
        value = char === "\u007f" || char === "\b" ? value.slice(0, -1) : value + char
      }
    }
    process.stderr.write(prompt)
    input.setRawMode(true)
    input.on("data", onData)
    input.resume()
  })

const summary = (result: ReturnType<typeof status>) =>
  `${result.host} · ${Object.entries(result.services).map(([name, state]) => `${name} ${state}`).join(" · ")} · ${result.running ?? "?"} running · keys ${result.keys} · model ${result.model}\n`

const readLine = async (): Promise<string> => {
  const lines = createInterface({ input: process.stdin })
  try {
    for await (const line of lines) return line
    return ""
  } finally {
    lines.close()
  }
}

async function hostCommand(command: string, args: string[], values: HostFlags, io: Io, deps: Deps): Promise<number> {
  const usage = (message: string) => {
    io.err(`${message}\n`)
    return EXIT.USAGE
  }
  const flag = (name: string) => `--${name}`
  const stray = (Object.keys(values) as (keyof HostFlags)[]).filter((name) => ["host", "ref", "repo", "yes", "lines", "check"].includes(name) && !FLAGS[command]!.includes(name))
  if (stray.length > 0) return usage(`tug ${command} does not take ${stray.map(flag).join(", ")}`)
  if (command === "remove") {
    if ((values.host === undefined) === (values.repo === undefined)) return usage("tug remove takes --host or --repo, not both or neither")
  } else if (!values.host) return usage(`tug ${command} needs --host`)
  if (values.host !== undefined && !validHost(values.host)) return usage(`Not an SSH host: ${values.host}`)
  if (values.repo !== undefined && (!/^[\w.-]+\/[\w.-]+$/u.test(values.repo) || values.repo.split("/").some((part) => /^\.+$/u.test(part)))) return usage(`Not a repository: ${values.repo}`)
  if (command === "config list" && args.length > 0) return usage("tug config list takes no names")
  for (const arg of command === "config unset" ? args : []) if (arg.includes("=")) return usage(`tug config unset takes names, not ${arg.slice(0, arg.indexOf("="))}=…`)

  const tty = deps.tty ?? process.stdin.isTTY === true
  // Only a terminal can type sudo's password; without one, a host whose sudo asks for it is refused with that reason.
  const ssh: Ssh = { run: deps.run ?? spawn, interactive: tty ? (deps.interactive ?? interactive) : undefined }
  const host = values.host!
  try {
    if (command === "remove") {
      const name = (values.host ?? values.repo)!
      if (!(await confirmed(name, { yes: values.yes === true, tty, readLine: deps.readLine ?? readLine, err: io.err }))) return 1
      if (values.host !== undefined) {
        removeHost(ssh, host)
        io.out(`${JSON.stringify({ host, removed: true }, null, 2)}\n`)
        io.err(`Removed Tug from ${host}\n`)
        return 0
      }
      const result = await removeRepo(deps.request ?? client(await token()), values.repo!)
      io.out(`${JSON.stringify(result, null, 2)}\n`)
      io.err(`Opened ${result.pr} to remove Tug from ${result.repo}\n`)
      return 0
    }
    if (command === "status") {
      const result = status(ssh.run, host)
      io.out(`${JSON.stringify(result, null, 2)}\n`)
      io.err(summary(result))
      return healthy(result) ? 0 : 1
    }
    if (command === "logs") {
      const lines = logs(ssh.run, host, Number(values.lines ?? 50))
      if (lines.trim()) io.out(lines.endsWith("\n") ? lines : `${lines}\n`)
      else io.err(`${host} has no log lines from Tug's services\n`)
      return 0
    }
    if (command === "config list") {
      for (const name of settingNames(ssh.run, host)) io.out(`${name}\n`)
      return 0
    }
    if (command === "config set" || command === "config unset") {
      const changes = { set: {} as Record<string, string>, unset: [] as string[] }
      if (command === "config unset") changes.unset = args
      const env = deps.env ?? process.env
      for (const arg of command === "config set" ? args : []) {
        const at = arg.indexOf("=")
        const name = at < 0 ? arg : arg.slice(0, at)
        if (!HOST_SETTINGS.includes(name)) return usage(`Not a Tug setting: ${name}`)
        if (at >= 0) changes.set[name] = arg.slice(at + 1)
        else if (env[name]) changes.set[name] = env[name]
        else if (tty) changes.set[name] = await (deps.readSecret ?? readSecret)(`${name}: `)
        else return usage(`Give ${name}=<value>, set ${name} in the environment, or run this in a terminal to type it`)
      }
      configure(ssh.run, host, changes)
      io.err(`${command === "config set" ? "Set" : "Removed"} ${[...Object.keys(changes.set), ...changes.unset].join(", ")} on ${host}, and restarted Tug's services\n`)
      const result = status(ssh.run, host)
      io.out(`${JSON.stringify(result, null, 2)}\n`)
      io.err(summary(result))
      return healthy(result) ? 0 : 1
    }
    if (values.check) {
      const found = await checkHost({ host, ref: values.ref ?? "main", request: deps.request ?? client(await token()), run: ssh.run, download: deps.download ?? download })
      io.out(`${found.report}\n`)
      if (found.root.length > 0) io.err(`${host} needs this once, as root: ${found.root.join(", ")}; tug install asks for sudo for it\n`)
      return found.code
    }
    const settings = command === "install" ? settingsFile(deps.env ?? process.env) : undefined
    const request = deps.request ?? client(await token())
    const result = await deploy({ host, ref: values.ref ?? "main", request, ssh, download: deps.download ?? download, settings, log: io.err })
    io.out(`${JSON.stringify(result, null, 2)}\n`)
    io.err(`Installed ${result.version.slice(0, 7)} on ${result.host}\n`)
    return 0
  } catch (error) {
    io.err(`${(error as Error).message}\n`)
    return 1
  }
}
