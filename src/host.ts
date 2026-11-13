import { spawnSync } from "node:child_process"
import type { Request } from "./forge/github.ts"
import { keysConfig } from "./keys.ts"

/** Runs one program; tests replace it so no SSH is needed. */
export type Run = (cmd: string, args: string[], input?: string | Buffer) => { status: number; stdout: string; stderr: string }
/** Runs one program on this terminal, so its prompts reach the person, and returns its exit status; tests replace it. */
export type Interactive = (cmd: string, args: string[]) => number
/** Fetches a URL's body; tests replace it so no network is needed. */
export type Download = (url: string) => Promise<Buffer>

/** How the host commands reach a host: `run` for every command, and `interactive` on a terminal, where sudo may ask for a password. */
export interface Ssh {
  run: Run
  interactive?: Interactive
}

class HostError extends Error {}

export const spawn: Run = (cmd, args, input) => {
  const result = spawnSync(cmd, args, { input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.error ? result.error.message : (result.stderr ?? "") }
}

export const interactive: Interactive = (cmd, args) => spawnSync(cmd, args, { stdio: "inherit" }).status ?? 1

export const download: Download = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new HostError(`${url} answered ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/** An SSH host or alias, never something `ssh` would read as an option. */
export const validHost = (host: string): boolean => /^[\w][\w.@-]*$/u.test(host)

const SOURCE = "g4f4r0/tug"
const SHA = /^[0-9a-f]{40}$/u
/** Where Tug lives on the host, in the home of the user it runs as. */
const LIB = "~/.local/share/tug"
const SETTINGS_FILE = "~/.config/tug/tug.env"
const SERVICES = ["tug-runners", "tug-keys", "tug-docker", "tug-cleanup.timer"]
/**
 * One call, as the user: the running jobs, whether a job's container reaches the key service, one call to each model,
 * then the services and the installed version. The services come last: the reach check waits for a key service that
 * is starting, so a runner service that fails just after a restart shows as failing, not active.
 */
const STATUS = [
  "export DOCKER_HOST=unix:///run/user/$(id -u)/tug/docker.sock",
  `echo "running $(docker ps -q --filter label=tug.scope 2>/dev/null | wc -l)"`,
  `echo "keys $(${LIB}/reach.sh 2>&1 | tail -n 1)"`,
  `echo "model $(docker exec tug-keys node /tug/src/bin.ts keys --check 2>&1 | tail -n 1)"`,
  `echo "services $(systemctl --user is-active ${SERVICES.join(" ")} | tr '\\n' ' ')"`,
  `echo "version $(cat ${LIB}/VERSION 2>/dev/null)"`,
].join("; ")
const PREFLIGHT = "~/tug/runners/preflight.sh"
/** A Tug from before it ran as a user, which only root can remove. */
const LEGACY = "test -e /etc/systemd/system/tug-runners.service"

/** The settings the host's services read; nothing else in the environment leaves this machine. */
export const HOST_SETTINGS = [
  "TUG_GITHUB_TOKEN", "TUG_ACCOUNTS", "TUG_MAX_RUNNERS",
  "TUG_OPENAI_API_KEY", "TUG_OPENAI_BASE_URL", "TUG_ANTHROPIC_API_KEY", "TUG_ANTHROPIC_BASE_URL",
  "TUG_REVIEW_MODEL", "TUG_REVIEW_REASONING_EFFORT", "TUG_SECURITY_MODEL", "TUG_SECURITY_REASONING_EFFORT",
]
/** The settings no host runs without, which `tug config unset` keeps. */
const REQUIRED = ["TUG_GITHUB_TOKEN", "TUG_ACCOUNTS", "TUG_REVIEW_MODEL"]

/** Refuses a value the services would misread: a line break, which would add a setting, or a malformed number or model. */
function checkValue(name: string, value: string): void {
  if (/[\r\n]/u.test(value)) throw new HostError(`${name} has a line break`)
  if (name === "TUG_MAX_RUNNERS" && !(Number(value.trim()) >= 1 && Number.isInteger(Number(value.trim())))) throw new HostError("TUG_MAX_RUNNERS must be a positive number")
  if ((name === "TUG_REVIEW_MODEL" || name === "TUG_SECURITY_MODEL") && !/^(openai|anthropic)\/./u.test(value)) throw new HostError(`${name} must be openai/<model> or anthropic/<model>, not ${value}`)
}

/** One line of `tug.env`, double-quoted as systemd's `EnvironmentFile` reads it. */
const settingLine = (name: string, value: string) => `${name}="${value.replace(/["\\`$]/gu, "\\$&")}"\n`

/**
 * The host's `/etc/tug/tug.env`: the host settings set in `env`, checked as the services read them, one line each
 * as systemd's `EnvironmentFile` reads it.
 */
export function settingsFile(env: NodeJS.ProcessEnv): string {
  const settings: Record<string, string> = {}
  for (const name of HOST_SETTINGS) if (env[name]) settings[name] = env[name]
  try {
    keysConfig(settings)
  } catch (error) {
    throw new HostError((error as Error).message)
  }
  if (!settings.TUG_GITHUB_TOKEN?.trim()) throw new HostError("Set TUG_GITHUB_TOKEN")
  for (const [name, value] of Object.entries(settings)) checkValue(name, value)
  return Object.entries(settings)
    .map(([name, value]) => settingLine(name, value))
    .join("")
}

/** Changes to a host's settings: values to set, and names to remove. */
export interface SettingChanges {
  set: Record<string, string>
  unset: string[]
}

/** Refuses changes the host would misread or not run with, before anything reaches it. */
export function checkChanges(changes: SettingChanges): void {
  const names = [...Object.keys(changes.set), ...changes.unset]
  if (names.length === 0) throw new HostError("Name at least one setting")
  for (const name of names) if (!HOST_SETTINGS.includes(name)) throw new HostError(`Not a Tug setting: ${name}`)
  for (const name of changes.unset) {
    if (REQUIRED.includes(name)) throw new HostError(`${name} is required; set it to a new value instead`)
    if (Object.hasOwn(changes.set, name)) throw new HostError(`${name} is both set and unset`)
  }
  for (const [name, value] of Object.entries(changes.set)) {
    if (!value.trim()) throw new HostError(`${name} is empty; tug config unset removes a setting`)
    checkValue(name, value)
  }
}

/** Runs a command on the host and returns its output, or throws with what it said. */
function remote(run: Run, host: string, command: string, input?: string | Buffer): string {
  const result = run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=30", host, command], input)
  if (result.status !== 0) throw new HostError(`${host}: ${result.stderr.trim() || result.stdout.trim() || `ssh exited ${result.status}`}`)
  return result.stdout
}

/** A value as one word of a POSIX shell. */
const quote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`

/**
 * Runs `script` as root on the host, with `$1` the SSH user and `$2` its home and `input` as its stdin, and returns its
 * output. With passwordless sudo it runs at once. Otherwise, on a terminal, `ssh -t` lets sudo ask for the password,
 * and the input and output wait in files only the user can read, each removed once read.
 */
function asRoot(ssh: Ssh, host: string, script: string, input?: string): string {
  const sudo = `sudo sh -c ${quote(script)} tug "$USER" "$HOME"`
  const check = ssh.run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=30", host, "sudo -n true"])
  if (check.status === 0) return remote(ssh.run, host, sudo, input)
  if (check.status === 255) throw new HostError(`${host}: ${check.stderr.trim() || "ssh failed"}`)
  if (!ssh.interactive) throw new HostError(`${host}: sudo asks for a password there; run this in a terminal to type it, or allow passwordless sudo`)
  if (input !== undefined) remote(ssh.run, host, "umask 077 && cat > ~/.tug-input", input)
  // The umask only makes the files private: sudo keeps the caller's umask, and the root step must not run under 077.
  // `code`, not `status`, which zsh, a login shell the host may have, keeps read-only.
  const command = `(umask 077 && : > ~/.tug-output) && ${sudo}${input === undefined ? "" : " < ~/.tug-input"} >> ~/.tug-output; code=$?; rm -f ~/.tug-input; exit $code`
  const status = ssh.interactive("ssh", ["-t", "-o", "ConnectTimeout=30", host, command])
  const output = remote(ssh.run, host, "cat ~/.tug-output 2>/dev/null; rm -f ~/.tug-output")
  if (status !== 0) throw new HostError(`${host}: ${output.trim() || `the step as root exited ${status}; what it said is above`}`)
  return output
}

/** What `runners/preflight.sh` found: 0 ready, 1 something needs root, 2 a system Tug can't run on. */
export interface Preflight {
  code: number
  report: string
  /** The items only root can fix, which `preflight.sh --fix` takes. */
  root: string[]
}

/** Runs the preflight check on the host, as the user; it changes nothing. */
function preflight(run: Run, host: string): Preflight {
  const result = run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=30", host, PREFLIGHT])
  if (![0, 1, 2].includes(result.status) || !result.stdout.trim()) throw new HostError(`${host}: ${result.stderr.trim() || result.stdout.trim() || `the check exited ${result.status}`}`)
  const report = result.stdout.trim()
  // An item is a lowercase word, so it is safe in the root command line.
  const root = report.split("\n").flatMap((line) => /^root +([a-z0-9]+) /u.exec(line)?.[1] ?? [])
  return { code: result.status, report, root }
}

/** Downloads the commit `ref` names and unpacks it into `~/tug` on the host, which `install.sh` installs from. */
async function fetchTug(input: { host: string; ref: string; request: Request; run: Run; download: Download }): Promise<string> {
  const commit = await input.request<{ sha?: string }>("GET", `/repos/${SOURCE}/commits/${input.ref.split("/").map(encodeURIComponent).join("/")}`)
  const sha = commit.sha ?? ""
  if (!SHA.test(sha)) throw new HostError(`GitHub gave no commit SHA for ${input.ref}`)
  const tarball = await input.download(`https://codeload.github.com/${SOURCE}/tar.gz/${sha}`)
  remote(input.run, input.host, `rm -rf ~/tug && mkdir ~/tug && tar -xz --strip-components=1 -C ~/tug && echo ${sha} > ~/tug/VERSION`, tarball)
  return sha
}

/** `tug install --check`: what the host has and lacks, from the commit `ref` names; it installs nothing. */
export async function checkHost(input: { host: string; ref: string; request: Request; run: Run; download: Download }): Promise<Preflight> {
  await fetchTug(input)
  return preflight(input.run, input.host)
}

/**
 * Installs or updates Tug on a host at the commit `ref` names, as the SSH user. What only root can provide is fixed
 * first, once, when the check finds it missing; then nothing runs as root. Settings, from `settingsFile`, are sent
 * only when given.
 */
export async function deploy(input: { host: string; ref: string; request: Request; ssh: Ssh; download: Download; settings?: string; log?: (line: string) => void }): Promise<{ host: string; version: string; ref: string }> {
  const { host, ref, ssh } = input
  const sha = await fetchTug({ ...input, run: ssh.run })
  let found = preflight(ssh.run, host)
  if (found.code === 2) throw new HostError(`${host} can't run Tug:\n${found.report}`)
  if (found.root.length > 0) {
    input.log?.(`${found.report}\n${host} needs this once, as root: ${found.root.join(", ")}\n`)
    asRoot(ssh, host, `"$2/tug/runners/preflight.sh" --fix "$1" ${found.root.join(" ")}`)
    found = preflight(ssh.run, host)
    if (found.code !== 0) throw new HostError(`${host} still lacks what Tug needs:\n${found.report}`)
  }
  // The settings go straight into a file only the user can read; they are never printed.
  if (input.settings !== undefined) remote(ssh.run, host, `umask 077 && mkdir -p ~/.config/tug && cat > ${SETTINGS_FILE}`, input.settings)
  remote(ssh.run, host, "~/tug/runners/install.sh")
  return { host, version: sha, ref }
}

interface HostStatus {
  host: string
  version: string | null
  services: Record<string, string>
  /** Jobs running now. */
  running: number | null
  /** ok when a job's container reaches the key service, else why not. */
  keys: string
  /** ok when each pass's model answers a test call with the host's settings, else why not. */
  model: string
}

/** Reads, as the user, the running jobs, the key service's reach, the models, the services and the installed version. */
export function status(run: Run, host: string): HostStatus {
  const lines = remote(run, host, STATUS).split("\n")
  const field = (name: string) => lines.find((line) => line.startsWith(`${name} `))?.slice(name.length + 1).trim()
  const states = (field("services") ?? "").split(/\s+/u).filter(Boolean)
  if (states.length !== SERVICES.length) throw new HostError(`${host}: could not read the status of Tug`)
  const running = Number(field("running"))
  return {
    host,
    version: field("version") || null,
    services: Object.fromEntries(SERVICES.map((name, index) => [name, states[index]!])),
    running: Number.isInteger(running) ? running : null,
    keys: field("keys") || "no answer",
    model: field("model") || "no answer",
  }
}

export const healthy = (host: HostStatus): boolean => ["tug-runners", "tug-keys", "tug-docker"].every((name) => host.services[name] === "active") && host.keys === "ok" && host.model === "ok"

/** Sets and removes host settings, keeping every other one, then restarts both services. Values are never printed. */
export function configure(run: Run, host: string, changes: SettingChanges): void {
  checkChanges(changes)
  const lines = [...Object.entries(changes.set).map(([name, value]) => settingLine(name, value)), ...changes.unset.map((name) => `-${name}\n`)]
  remote(run, host, `${LIB}/config.sh`, lines.join(""))
}

/** The names of the settings the host has, never their values. */
export const settingNames = (run: Run, host: string): string[] => remote(run, host, `${LIB}/config.sh --list`).split("\n").filter(Boolean)

/** The last lines Tug's Docker, key service and runner service logged. */
export function logs(run: Run, host: string, lines: number): string {
  if (!Number.isSafeInteger(lines) || lines < 1) throw new HostError("--lines takes a positive number")
  return remote(run, host, `journalctl --user -u tug-docker -u tug-keys -u tug-runners -n ${lines} --no-pager -q -o short-iso`)
}

/** Takes Tug off a host, settings included. Only a Tug from before it ran as a user needs root to go. */
export function removeHost(ssh: Ssh, host: string): void {
  if (ssh.run("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=30", host, LEGACY]).status === 0) asRoot(ssh, host, `"$2/tug/runners/preflight.sh" --fix "$1" legacy`)
  remote(ssh.run, host, `~/tug/runners/install.sh --uninstall && rm -f ${SETTINGS_FILE} && rm -rf ~/tug`)
}
