import { spawnSync } from "node:child_process"
import { createPrivateKey } from "node:crypto"
import type { Request } from "./forge/github.ts"
import { keysConfig } from "./keys.ts"

/** Runs one program; tests replace it so no SSH is needed. */
export type Run = (cmd: string, args: string[], input?: string | Buffer) => { status: number; stdout: string; stderr: string }
/** Fetches a URL's body; tests replace it so no network is needed. */
export type Download = (url: string) => Promise<Buffer>

class HostError extends Error {}

export const spawn: Run = (cmd, args, input) => {
  const result = spawnSync(cmd, args, { input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.error ? result.error.message : (result.stderr ?? "") }
}

export const download: Download = async (url) => {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) })
  if (!response.ok) throw new HostError(`${url} answered ${response.status}`)
  return Buffer.from(await response.arrayBuffer())
}

/** An SSH host or alias, never something `ssh` would read as an option. */
export const validHost = (host: string): boolean => /^[\w][\w.@-]*$/u.test(host)

const SOURCE = "hellogafaro/tug"
const SHA = /^[0-9a-f]{40}$/u
const SERVICES = ["tug-runners", "tug-keys", "tug-prune.timer"]
const STATUS = `echo "services $(systemctl is-active ${SERVICES.join(" ")} | tr '\\n' ' ')"; echo "version $(cat /usr/local/lib/tug/VERSION 2>/dev/null)"; echo "running $(docker ps -q --filter label=tug.scope | wc -l)"`

/** The GitHub App's key on one line, its line breaks as spaces, which the runner service puts back. */
function oneLineKey(value: string): string {
  // Line breaks may come real, as spaces, or escaped as `\n`, as dotenv files and CI secrets often hold them.
  const pem = /-----BEGIN ([A-Z ]+)-----([\s\S]*?)-----END \1-----/u.exec(value.replaceAll("\\n", "\n"))
  const lines = pem ? [`-----BEGIN ${pem[1]}-----`, ...(pem[2]!.replace(/\s+/gu, "").match(/.{1,64}/gu) ?? []), `-----END ${pem[1]}-----`] : []
  let type
  try {
    type = createPrivateKey(lines.join("\n")).asymmetricKeyType
  } catch {
    throw new HostError("TUG_APP_PRIVATE_KEY is not a PEM key")
  }
  if (type !== "rsa") throw new HostError("TUG_APP_PRIVATE_KEY is not an RSA key")
  return lines.join(" ")
}

/** The settings the host's services read; nothing else in the environment leaves this machine. */
const HOST_SETTINGS = [
  "TUG_APP_ID", "TUG_APP_PRIVATE_KEY", "TUG_ACCOUNTS", "TUG_MAX_RUNNERS",
  "TUG_OPENAI_API_KEY", "TUG_OPENAI_BASE_URL", "TUG_ANTHROPIC_API_KEY", "TUG_ANTHROPIC_BASE_URL",
  "TUG_REVIEW_MODEL", "TUG_REVIEW_REASONING_EFFORT", "TUG_SECURITY_MODEL", "TUG_SECURITY_REASONING_EFFORT",
]

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
  for (const name of ["TUG_APP_ID", "TUG_APP_PRIVATE_KEY"]) if (!settings[name]?.trim()) throw new HostError(`Set ${name}`)
  const max = settings.TUG_MAX_RUNNERS?.trim()
  if (max && !(Number(max) >= 1 && Number.isInteger(Number(max)))) throw new HostError("TUG_MAX_RUNNERS must be a positive number")
  settings.TUG_APP_PRIVATE_KEY = oneLineKey(settings.TUG_APP_PRIVATE_KEY!)
  return Object.entries(settings)
    .map(([name, value]) => {
      if (/[\r\n]/u.test(value)) throw new HostError(`${name} has a line break`)
      return `${name}="${value.replace(/["\\`$]/gu, "\\$&")}"\n`
    })
    .join("")
}

/** Runs a command on the host and returns its output, or throws with what it said. */
function remote(run: Run, host: string, command: string, input?: string | Buffer): string {
  const result = run("ssh", ["-o", "BatchMode=yes", host, command], input)
  if (result.status !== 0) throw new HostError(`${host}: ${result.stderr.trim() || result.stdout.trim() || `ssh exited ${result.status}`}`)
  return result.stdout
}

/** Installs or updates Tug on a host at the commit `ref` names. Settings, from `settingsFile`, are sent only when given. */
export async function deploy(input: { host: string; ref: string; request: Request; run: Run; download: Download; settings?: string }): Promise<{ host: string; version: string; ref: string }> {
  const { host, ref, run } = input
  const commit = await input.request<{ sha?: string }>("GET", `/repos/${SOURCE}/commits/${ref.split("/").map(encodeURIComponent).join("/")}`)
  const sha = commit.sha ?? ""
  if (!SHA.test(sha)) throw new HostError(`GitHub gave no commit SHA for ${ref}`)
  const tarball = await input.download(`https://codeload.github.com/${SOURCE}/tar.gz/${sha}`)

  remote(run, host, `rm -rf ~/tug && mkdir ~/tug && tar -xz --strip-components=1 -C ~/tug && echo ${sha} > ~/tug/VERSION`, tarball)
  // The settings go straight into the root-only file; they are never printed.
  if (input.settings !== undefined) remote(run, host, "sudo install -d -m 0755 /etc/tug && sudo install -m 0600 /dev/stdin /etc/tug/tug.env", input.settings)
  remote(run, host, 'sudo ~/tug/runners/install.sh "$USER"')
  return { host, version: sha, ref }
}

interface HostStatus {
  host: string
  version: string | null
  services: Record<string, string>
  running: number
}

/** Reads the services, the installed version and the number of running jobs in one SSH call. */
export function status(run: Run, host: string): HostStatus {
  const lines = remote(run, host, STATUS).split("\n")
  const field = (name: string) => lines.find((line) => line.startsWith(`${name} `))?.slice(name.length + 1).trim()
  const states = (field("services") ?? "").split(/\s+/u).filter(Boolean)
  const running = Number(field("running"))
  if (states.length !== SERVICES.length || !Number.isInteger(running)) throw new HostError(`${host}: could not read the status of Tug`)
  return { host, version: field("version") || null, services: Object.fromEntries(SERVICES.map((name, index) => [name, states[index]!])), running }
}

export const healthy = (host: HostStatus): boolean => host.services["tug-runners"] === "active" && host.services["tug-keys"] === "active"

export function removeHost(run: Run, host: string): void {
  remote(run, host, "sudo ~/tug/runners/install.sh --uninstall && sudo rm -f /etc/tug/tug.env && rm -rf ~/tug")
}
