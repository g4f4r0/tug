import { spawnSync } from "node:child_process"
import type { Request } from "./forge/github.ts"

/** Runs one program; tests replace it so no SSH is needed. */
export type Run = (cmd: string, args: string[], input?: string) => { status: number; stdout: string; stderr: string }

export class HostError extends Error {}

export const spawn: Run = (cmd, args, input) => {
  const result = spawnSync(cmd, args, { input, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.error ? result.error.message : (result.stderr ?? "") }
}

/** An SSH host or alias, never something `ssh` would read as an option. */
export const validHost = (host: string): boolean => /^[\w][\w.@-]*$/u.test(host)

const SOURCE = "hellogafaro/tug"
const SHA = /^[0-9a-f]{40}$/u
const SERVICES = ["tug-runners", "tug-keys", "tug-prune.timer"]
const STATUS = `echo "services $(systemctl is-active ${SERVICES.join(" ")} | tr '\\n' ' ')"; echo "version $(cat /usr/local/lib/tug/VERSION 2>/dev/null)"; echo "running $(docker ps -q --filter label=tug.scope | wc -l)"`

/** Runs a command on the host and returns its output, or throws with what it said. */
function remote(run: Run, host: string, command: string, input?: string): string {
  const result = run("ssh", ["-o", "BatchMode=yes", host, command], input)
  if (result.status !== 0) throw new HostError(`${host}: ${result.stderr.trim() || result.stdout.trim() || `ssh exited ${result.status}`}`)
  return result.stdout
}

/** Installs or updates Tug on a host at the commit `ref` names. Settings are sent only when `settings` is given. */
export async function deploy(input: { host: string; ref: string; request: Request; run: Run; settings?: { project: string; env: string } }): Promise<{ host: string; version: string; ref: string }> {
  const { host, ref, run } = input
  const commit = await input.request<{ sha?: string }>("GET", `/repos/${SOURCE}/commits/${ref.split("/").map(encodeURIComponent).join("/")}`)
  const sha = commit.sha ?? ""
  if (!SHA.test(sha)) throw new HostError(`GitHub gave no commit SHA for ${ref}`)

  // Only Tug's own settings leave this machine, straight into the file; they are never printed.
  let settings: string | undefined
  if (input.settings) {
    const exported = run("infisical", ["export", "--projectId", input.settings.project, "--env", input.settings.env, "--format", "dotenv", "--silent"])
    if (exported.status !== 0) throw new HostError(`infisical: ${exported.stderr.trim() || `exited ${exported.status}`}`)
    const lines = exported.stdout.split("\n").filter((line) => line.startsWith("TUG_"))
    if (lines.length === 0) throw new HostError(`${input.settings.project} ${input.settings.env} has no TUG_ settings`)
    settings = `${lines.join("\n")}\n`
  }

  remote(run, host, `rm -rf ~/tug && mkdir ~/tug && curl -fsSL https://codeload.github.com/${SOURCE}/tar.gz/${sha} | tar -xz --strip-components=1 -C ~/tug && echo ${sha} > ~/tug/VERSION`)
  if (settings !== undefined) remote(run, host, "sudo install -d -m 0755 /etc/tug && sudo install -m 0600 /dev/stdin /etc/tug/tug.env", settings)
  remote(run, host, 'sudo ~/tug/runners/install.sh "$USER"')
  return { host, version: sha, ref }
}

export interface HostStatus {
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
