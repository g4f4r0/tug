import { describe, expect, it, vi } from "vitest"
import { main, type Deps } from "../src/cli.ts"
import type { Request } from "../src/forge/github.ts"
import { GitHubError } from "../src/forge/github.ts"
import type { Run } from "../src/host.ts"

const SHA = "0123456789abcdef0123456789abcdef01234567"

/**
 * A runner that records every call and answers `ssh` by the command: sudo's password check (passwordless unless `sudo`
 * is false), the status, the root checks, and the output a terminal's root step left.
 */
function fakeRun(answers: { status?: string; checks?: string; sudo?: boolean; output?: string } = {}) {
  const calls: { cmd: string; args: string[]; input?: string | Buffer }[] = []
  const run: Run = (cmd, args, input) => {
    calls.push({ cmd, args, input })
    const command = args.at(-1)!
    const answer = (stdout = "", status = 0) => ({ status, stdout, stderr: "" })
    if (command === "sudo -n true") return answer("", answers.sudo === false ? 1 : 0)
    if (command.startsWith('echo "services')) return answer(answers.status)
    if (command.startsWith("sudo sh -c") && command.includes("docker ps")) return answer(answers.checks)
    if (command.startsWith("cat ~/.tug-output")) return answer(answers.output)
    return answer()
  }
  return { run, calls }
}

/** The ssh command line that runs `script` as root, as the host commands build it. */
const root = (script: string) => `sudo sh -c '${script.replaceAll("'", `'\\''`)}' tug "$USER" "$HOME"`

const commits = (sha: string): Request => (async (_method: string, path: string) => {
  expect(path).toBe("/repos/g4f4r0/tug/commits/main")
  return { sha }
}) as Request

const TARBALL = Buffer.from("tarball")
const downloads: string[] = []
const download = async (url: string) => {
  downloads.push(url)
  return TARBALL
}

function cli(argv: string[], deps: Deps) {
  const out: string[] = []
  const err: string[] = []
  const done = main(argv, { out: (text) => out.push(text), err: (text) => err.push(text) }, { download, env: {}, ...deps })
  return done.then((code) => ({ code, out: out.join(""), err: err.join("") }))
}

const ssh = (command: string, input?: string | Buffer) => ({ cmd: "ssh", args: ["-o", "BatchMode=yes", "-o", "ConnectTimeout=30", "box", command], input })
const FETCH = `rm -rf ~/tug && mkdir ~/tug && tar -xz --strip-components=1 -C ~/tug && echo ${SHA} > ~/tug/VERSION`
const SUDO = "sudo -n true"
const INSTALL = root('"$2/tug/runners/install.sh" "$1"')
const SETTINGS_INSTALL = root('install -d -m 0755 /etc/tug && install -m 0600 /dev/stdin /etc/tug/tug.env && "$2/tug/runners/install.sh" "$1"')

const ENV = { TUG_GITHUB_TOKEN: "ghp_token", TUG_ACCOUNTS: "me,my-org", TUG_REVIEW_MODEL: "openai/gpt-6.1-sol", TUG_OPENAI_API_KEY: 'k=$x"`\\', TUG_REVIEWER: "someone", OTHER: "secret", PATH: "/bin" }

/** What systemd's EnvironmentFile reads from a double-quoted line. */
const unquote = (line: string) => /^(\w+)="(.*)"$/u.exec(line)!.slice(1, 3).map((part) => part.replace(/\\(["\\`$])/gu, "$1")) as [string, string]

describe("tug install and update", () => {
  it("downloads the commit, sends it, then installs as root with only the host settings as stdin", async () => {
    downloads.length = 0
    const { run, calls } = fakeRun()
    const result = await cli(["install", "--host", "box"], { run, request: commits(SHA), env: ENV })
    expect(result.code).toBe(0)
    expect(downloads).toEqual([`https://codeload.github.com/g4f4r0/tug/tar.gz/${SHA}`])
    expect(calls.map((call) => call.args.at(-1))).toEqual([FETCH, SUDO, SETTINGS_INSTALL])
    expect(calls[0]).toEqual(ssh(FETCH, TARBALL))
    const lines = String(calls[2]!.input).split("\n")
    expect(lines.pop()).toBe("")
    expect(Object.fromEntries(lines.map(unquote))).toEqual({ ...ENV, TUG_REVIEWER: undefined, OTHER: undefined, PATH: undefined })
    expect(JSON.parse(result.out)).toEqual({ host: "box", version: SHA, ref: "main" })
    expect(result.err).toBe("Installed 0123456 on box\n")
    expect(result.out + result.err).not.toContain("secret")
  })

  it("lets sudo ask for the password on a terminal, the settings waiting in a file only the user reads", async () => {
    const { run, calls } = fakeRun({ sudo: false })
    const typed: string[][] = []
    const interactive = (cmd: string, args: string[]) => {
      typed.push([cmd, ...args])
      return 0
    }
    const result = await cli(["install", "--host", "box"], { run, request: commits(SHA), env: ENV, tty: true, interactive })
    expect(result.code).toBe(0)
    expect(calls.map((call) => call.args.at(-1))).toEqual([FETCH, SUDO, "umask 077 && cat > ~/.tug-input", "cat ~/.tug-output 2>/dev/null; rm -f ~/.tug-output"])
    expect(String(calls[2]!.input)).toContain('TUG_ACCOUNTS="me,my-org"\n')
    expect(typed).toEqual([["ssh", "-t", "-o", "ConnectTimeout=30", "box", `(umask 077 && : > ~/.tug-output) && ${SETTINGS_INSTALL} < ~/.tug-input >> ~/.tug-output; code=$?; rm -f ~/.tug-input; exit $code`]])
  })

  it("refuses off a terminal when sudo asks for a password, and says how to go on", async () => {
    const { run, calls } = fakeRun({ sudo: false })
    const result = await cli(["update", "--host", "box"], { run, request: commits(SHA), tty: false })
    expect(result).toEqual({ code: 1, out: "", err: "box: sudo asks for a password there; run this in a terminal to type it, or allow passwordless sudo\n" })
    expect(calls.map((call) => call.args.at(-1))).toEqual([FETCH, SUDO])
  })

  it("fails when the root step on a terminal fails, with what it left", async () => {
    const { run } = fakeRun({ sudo: false, output: "Installed, but jobs can't reach the key service: timed out\n" })
    const result = await cli(["update", "--host", "box"], { run, request: commits(SHA), tty: true, interactive: () => 1 })
    expect(result).toEqual({ code: 1, out: "", err: "box: Installed, but jobs can't reach the key service: timed out\n" })
  })

  it.each([
    [{ TUG_ACCOUNTS: undefined }, "Set TUG_ACCOUNTS"],
    [{ TUG_REVIEW_MODEL: undefined }, "Set TUG_REVIEW_MODEL"],
    [{ TUG_OPENAI_API_KEY: undefined }, "Set TUG_OPENAI_API_KEY for openai/gpt-6.1-sol"],
    [{ TUG_GITHUB_TOKEN: undefined }, "Set TUG_GITHUB_TOKEN"],
    [{ TUG_GITHUB_TOKEN: " " }, "Set TUG_GITHUB_TOKEN"],
    [{ TUG_GITHUB_TOKEN: "ghp_token\nTUG_ACCOUNTS=evil" }, "TUG_GITHUB_TOKEN has a line break"],
    [{ TUG_MAX_RUNNERS: "0" }, "TUG_MAX_RUNNERS must be a positive number"],
    [{ TUG_REVIEW_REASONING_EFFORT: "high\nTUG_ACCOUNTS=evil" }, "TUG_REVIEW_REASONING_EFFORT has a line break"],
  ])("refuses %j in one line, before GitHub or the host", async (change, message) => {
    downloads.length = 0
    const { run, calls } = fakeRun()
    const request = (async () => {
      throw new Error("GitHub was called")
    }) as Request
    const result = await cli(["install", "--host", "box"], { run, request, env: { ...ENV, ...change } })
    expect(result).toEqual({ code: 1, out: "", err: `${message}\n` })
    expect(calls).toEqual([])
    expect(downloads).toEqual([])
  })

  it("updates without touching settings, at the ref given", async () => {
    const { run, calls } = fakeRun()
    const request = (async (_method: string, path: string) => {
      expect(path).toBe("/repos/g4f4r0/tug/commits/feat/own-host")
      return { sha: SHA }
    }) as Request
    const result = await cli(["update", "--host", "box", "--ref", "feat/own-host"], { run, request, env: ENV })
    expect(result.code).toBe(0)
    expect(calls).toEqual([ssh(FETCH, TARBALL), ssh(SUDO), ssh(INSTALL)])
    expect(JSON.parse(result.out)).toEqual({ host: "box", version: SHA, ref: "feat/own-host" })
  })

  it("rejects a SHA that is not 40 hex characters, before any remote command", async () => {
    const { run, calls } = fakeRun()
    const result = await cli(["update", "--host", "box"], { run, request: commits("abc; rm -rf /") })
    expect(result.code).toBe(1)
    expect(calls).toEqual([])
  })

  it("prints a failed remote step's stderr and exits 1", async () => {
    const run: Run = () => ({ status: 255, stdout: "", stderr: "Permission denied\n" })
    const result = await cli(["update", "--host", "box"], { run, request: commits(SHA) })
    expect(result.code).toBe(1)
    expect(result.err).toBe("box: Permission denied\n")
  })
})

describe("tug status", () => {
  const output = (services: string) => `services ${services}\nversion ${SHA}\n`
  const CHECKS = "running 2\nkeys ok\nmodel ok\n"

  it("reads the checks as root, then the services, and exits 0 when all are well", async () => {
    const { run, calls } = fakeRun({ status: output("active active active"), checks: CHECKS })
    const result = await cli(["status", "--host", "box"], { run, tty: false })
    expect(result.code).toBe(0)
    const commands = calls.map((call) => call.args.at(-1)!)
    expect(commands).toHaveLength(3)
    expect(commands[0]).toBe(SUDO)
    expect(commands[1]).toMatch(/^sudo sh -c '.*docker ps.*reach\.sh.*docker exec tug-keys node \/tug\/src\/bin\.ts keys --check/u)
    expect(commands[2]).toContain("systemctl is-active tug-runners tug-keys tug-cleanup.timer")
    expect(JSON.parse(result.out)).toEqual({ host: "box", version: SHA, services: { "tug-runners": "active", "tug-keys": "active", "tug-cleanup.timer": "active" }, running: 2, keys: "ok", model: "ok" })
    expect(result.err).toBe("box · tug-runners active · tug-keys active · tug-cleanup.timer active · 2 running · keys ok · model ok\n")
  })

  it("exits 1 when a service is down", async () => {
    const result = await cli(["status", "--host", "box"], { run: fakeRun({ status: output("active failed inactive"), checks: CHECKS }).run, tty: false })
    expect(result.code).toBe(1)
    expect(JSON.parse(result.out).services["tug-keys"]).toBe("failed")
  })

  it.each([
    ["keys", "running 0\nkeys the connection to 172.30.99.1:8787 timed out\nmodel ok\n"],
    ["model", "running 0\nkeys ok\nmodel code and security (openai/gpt): OpenAI answered 404: no such model\n"],
  ])("exits 1 and says why when the %s check fails", async (name, checks) => {
    const result = await cli(["status", "--host", "box"], { run: fakeRun({ status: output("active active active"), checks }).run, tty: false })
    expect(result.code).toBe(1)
    expect(JSON.parse(result.out)[name]).toBe(checks.split("\n")[name === "keys" ? 1 : 2]!.slice(name.length + 1))
  })

  it("reports the root checks as not checked when sudo asks for a password off a terminal", async () => {
    const result = await cli(["status", "--host", "box"], { run: fakeRun({ status: output("active active active"), sudo: false }).run, tty: false })
    expect(result.code).toBe(1)
    const why = "not checked: box: sudo asks for a password there; run this in a terminal to type it, or allow passwordless sudo"
    expect(JSON.parse(result.out)).toMatchObject({ running: null, keys: why, model: why })
  })

  it("reads an empty version as null", async () => {
    const result = await cli(["status", "--host", "box"], { run: fakeRun({ status: "services active active active\nversion \n", checks: CHECKS }).run, tty: false })
    expect(JSON.parse(result.out).version).toBeNull()
  })
})

describe("tug config", () => {
  const CONFIG = root("/usr/local/lib/tug/config.sh")
  const healthy = { status: "services active active active\nversion x\n", checks: "running 0\nkeys ok\nmodel ok\n" }

  it("sets values given, from the environment and typed at a prompt, as root, then prints the status", async () => {
    const { run, calls } = fakeRun(healthy)
    const prompts: string[] = []
    const readSecret = async (prompt: string) => {
      prompts.push(prompt)
      return 'typed"$secret'
    }
    const result = await cli(["config", "set", "--host", "box", "TUG_ACCOUNTS=me,org", "TUG_MAX_RUNNERS", "TUG_GITHUB_TOKEN"], { run, tty: true, readSecret, env: { TUG_MAX_RUNNERS: "2" } })
    expect(result.code).toBe(0)
    expect(prompts).toEqual(["TUG_GITHUB_TOKEN: "])
    const change = calls.find((call) => call.args.at(-1) === CONFIG)!
    expect(String(change.input)).toBe('TUG_ACCOUNTS="me,org"\nTUG_MAX_RUNNERS="2"\nTUG_GITHUB_TOKEN="typed\\"\\$secret"\n')
    expect(result.err).toContain("Set TUG_ACCOUNTS, TUG_MAX_RUNNERS, TUG_GITHUB_TOKEN on box, and restarted Tug's services\n")
    expect(JSON.parse(result.out)).toMatchObject({ keys: "ok", model: "ok" })
    expect(result.out + result.err).not.toContain("secret")
  })

  it("removes settings with one -NAME line each", async () => {
    const { run, calls } = fakeRun(healthy)
    const result = await cli(["config", "unset", "--host", "box", "TUG_SECURITY_MODEL", "TUG_SECURITY_REASONING_EFFORT"], { run, tty: false })
    expect(result.code).toBe(0)
    expect(String(calls.find((call) => call.args.at(-1) === CONFIG)!.input)).toBe("-TUG_SECURITY_MODEL\n-TUG_SECURITY_REASONING_EFFORT\n")
  })

  it("lists the names the host has", async () => {
    const run: Run = (_cmd, args) => ({ status: 0, stdout: args.at(-1) === root("/usr/local/lib/tug/config.sh --list") ? "TUG_ACCOUNTS\nTUG_GITHUB_TOKEN\n" : "", stderr: "" })
    expect(await cli(["config", "list", "--host", "box"], { run, tty: false })).toEqual({ code: 0, out: "TUG_ACCOUNTS\nTUG_GITHUB_TOKEN\n", err: "" })
  })

  it.each([
    [["config", "set", "--host", "box", "TUG_GITHUB_TOKEN"], "Give TUG_GITHUB_TOKEN=<value>, set TUG_GITHUB_TOKEN in the environment, or run this in a terminal to type it"],
    [["config", "set", "--host", "box", "TUG_NOPE=1"], "Not a Tug setting: TUG_NOPE"],
    [["config", "set", "--host", "box", "PATH=/tmp"], "Not a Tug setting: PATH"],
    [["config", "set", "--host", "box"], "Name at least one setting"],
    [["config", "set", "--host", "box", "TUG_MAX_RUNNERS=0"], "TUG_MAX_RUNNERS must be a positive number"],
    [["config", "set", "--host", "box", "TUG_REVIEW_MODEL=gpt"], "TUG_REVIEW_MODEL must be openai/<model> or anthropic/<model>, not gpt"],
    [["config", "set", "--host", "box", "TUG_ACCOUNTS="], "TUG_ACCOUNTS is empty; tug config unset removes a setting"],
    [["config", "set", "--host", "box", "TUG_ACCOUNTS=a\nTUG_GITHUB_TOKEN=evil"], "TUG_ACCOUNTS has a line break"],
    [["config", "unset", "--host", "box", "TUG_GITHUB_TOKEN"], "TUG_GITHUB_TOKEN is required; set it to a new value instead"],
    [["config", "unset", "--host", "box", "TUG_MAX_RUNNERS=2"], "tug config unset takes names, not TUG_MAX_RUNNERS=…"],
    [["config", "list", "--host", "box", "TUG_ACCOUNTS"], "tug config list takes no names"],
    [["config", "set", "TUG_ACCOUNTS=a"], "tug config set needs --host"],
    [["config", "set", "--host", "box", "--ref", "x", "TUG_ACCOUNTS=a"], "tug config set does not take --ref"],
  ])("refuses %j before changing anything", async (argv, message) => {
    const { run, calls } = fakeRun(healthy)
    const result = await cli(argv, { run, tty: false })
    expect(result.code).toBe(1)
    expect(result.err).toBe(`${message}\n`)
    expect(calls).toEqual([])
  })
})

describe("tug logs", () => {
  it("prints both services' last lines, read as root", async () => {
    const run: Run = (_cmd, args) => ({ status: 0, stdout: args.at(-1)!.includes("journalctl") ? "line 1\nline 2\n" : "", stderr: "" })
    expect(await cli(["logs", "--host", "box"], { run, tty: false })).toEqual({ code: 0, out: "line 1\nline 2\n", err: "" })
    const { run: recording, calls } = fakeRun()
    await cli(["logs", "--host", "box", "--lines", "5"], { run: recording, tty: false })
    expect(calls.at(-1)!.args.at(-1)).toBe(root("journalctl -u tug-keys -u tug-runners -n 5 --no-pager -q -o short-iso"))
  })

  it("refuses a --lines that is not a positive number", async () => {
    const { run, calls } = fakeRun()
    const result = await cli(["logs", "--host", "box", "--lines", "5; reboot"], { run, tty: false })
    expect(result).toEqual({ code: 1, out: "", err: "--lines takes a positive number\n" })
    expect(calls).toEqual([])
  })
})

describe("tug keys --check", () => {
  const settings = { TUG_ACCOUNTS: "me", TUG_REVIEW_MODEL: "openai/gpt", TUG_OPENAI_API_KEY: "k" }

  it("prints ok, or what failed on one line, for tug status to read", async () => {
    for (const [name, value] of Object.entries(settings)) vi.stubEnv(name, value)
    try {
      expect(await cli(["keys", "--check"], { checkModels: async () => [] })).toEqual({ code: 0, out: "ok\n", err: "" })
      expect(await cli(["keys", "--check"], { checkModels: async () => ["code (openai/gpt): 401", "security (openai/x): 404"] })).toEqual({ code: 1, out: "code (openai/gpt): 401; security (openai/x): 404\n", err: "" })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe("tug remove --host", () => {
  const UNINSTALL = root('"$2/tug/runners/install.sh" --uninstall && rm -f /etc/tug/tug.env')

  it("refuses without --yes when stdin is not a terminal", async () => {
    const { run, calls } = fakeRun()
    const result = await cli(["remove", "--host", "box"], { run, tty: false })
    expect(result.code).toBe(1)
    expect(result.err).toBe("Refusing to remove box without --yes\n")
    expect(calls).toEqual([])
  })

  it("removes with --yes", async () => {
    const { run, calls } = fakeRun()
    const result = await cli(["remove", "--host", "box", "--yes"], { run, tty: false })
    expect(result.code).toBe(0)
    expect(calls).toEqual([ssh(SUDO), ssh(UNINSTALL), ssh("rm -rf ~/tug")])
    expect(JSON.parse(result.out)).toEqual({ host: "box", removed: true })
  })

  it("removes when the typed name matches on a terminal", async () => {
    const { run, calls } = fakeRun()
    const result = await cli(["remove", "--host", "box"], { run, tty: true, readLine: async () => "box" })
    expect(result.code).toBe(0)
    expect(result.err).toContain("Type box to remove Tug from it: ")
    expect(calls.map((call) => call.args.at(-1))).toEqual([SUDO, UNINSTALL, "rm -rf ~/tug"])
  })

  it("does not remove when the typed name is wrong", async () => {
    const { run, calls } = fakeRun()
    const result = await cli(["remove", "--host", "box"], { run, tty: true, readLine: async () => "bo" })
    expect(result.code).toBe(1)
    expect(result.err).toContain("Not removed\n")
    expect(calls).toEqual([])
  })
})

describe("tug remove --repo", () => {
  function github(existing: string[]) {
    const calls: { method: string; path: string; body?: unknown }[] = []
    const request = (async (method: string, path: string, options?: { body?: unknown }) => {
      calls.push({ method, path, body: options?.body })
      if (path === "/repos/o/r") return { default_branch: "main" }
      if (path === "/repos/o/r/commits/main") return { sha: "head1", commit: { tree: { sha: "tree1" } } }
      if (method === "GET" && path.startsWith("/repos/o/r/contents/")) {
        if (existing.some((file) => path.includes(`/contents/${file}?`))) return { content: Buffer.from("x").toString("base64") }
        throw new GitHubError("Not Found", 404)
      }
      if (path === "/repos/o/r/git/trees") return { sha: "tree2" }
      if (path === "/repos/o/r/git/commits") return { sha: "commit2" }
      if (path === "/repos/o/r/git/refs") return {}
      if (path === "/repos/o/r/pulls") return { html_url: "https://github.com/o/r/pull/9" }
      throw new Error(`unexpected ${method} ${path}`)
    }) as Request
    return { request, calls }
  }

  it("deletes both files in one commit on tug/remove and opens a pull request", async () => {
    const { request, calls } = github([".github/workflows/tug.yml", "tug.json"])
    const result = await cli(["remove", "--repo", "o/r", "--yes"], { request })
    expect(result.code).toBe(0)
    const writes = calls.filter((call) => call.method === "POST")
    expect(writes.map((call) => call.path)).toEqual(["/repos/o/r/git/trees", "/repos/o/r/git/commits", "/repos/o/r/git/refs", "/repos/o/r/pulls"])
    expect(writes[0]!.body).toEqual({
      base_tree: "tree1",
      tree: [
        { path: ".github/workflows/tug.yml", mode: "100644", type: "blob", sha: null },
        { path: "tug.json", mode: "100644", type: "blob", sha: null },
      ],
    })
    expect(writes[1]!.body).toEqual({ message: "ci: Remove Tug", tree: "tree2", parents: ["head1"] })
    expect(writes[2]!.body).toEqual({ ref: "refs/heads/tug/remove", sha: "commit2" })
    expect(writes[3]!.body).toMatchObject({ title: "ci: Remove Tug", head: "tug/remove", base: "main" })
    expect(String((writes[3]!.body as { body: string }).body)).toContain("## Summary")
    expect(String((writes[3]!.body as { body: string }).body)).toContain("## Risk")
    expect(JSON.parse(result.out)).toEqual({ repo: "o/r", pr: "https://github.com/o/r/pull/9", files: [".github/workflows/tug.yml", "tug.json"] })
  })

  it("skips files the repository lacks", async () => {
    const { request, calls } = github(["tug.json"])
    const result = await cli(["remove", "--repo", "o/r", "--yes"], { request })
    expect(result.code).toBe(0)
    expect(JSON.parse(result.out).files).toEqual(["tug.json"])
    expect(calls.find((call) => call.path.endsWith("/git/trees"))!.body).toMatchObject({ tree: [{ path: "tug.json" }] })
  })

  it("exits 1 when the repository has no Tug files", async () => {
    const { request, calls } = github([])
    const result = await cli(["remove", "--repo", "o/r", "--yes"], { request })
    expect(result.code).toBe(1)
    expect(result.err).toBe("o/r has no Tug files\n")
    expect(calls.some((call) => call.method === "POST")).toBe(false)
  })

  it("asks for the repository's name, and refuses without --yes off a terminal", async () => {
    const { request, calls } = github([".github/workflows/tug.yml"])
    const result = await cli(["remove", "--repo", "o/r"], { request, tty: false })
    expect(result.code).toBe(1)
    expect(result.err).toBe("Refusing to remove o/r without --yes\n")
    expect(calls).toEqual([])
  })
})

describe("usage errors", () => {
  const usage = async (argv: string[]) => {
    const { run, calls } = fakeRun()
    const result = await cli(argv, { run, request: commits(SHA), tty: false })
    expect(calls).toEqual([])
    return result
  }

  it.each([
    [["install"], "tug install needs --host"],
    [["update"], "tug update needs --host"],
    [["status"], "tug status needs --host"],
    [["remove"], "tug remove takes --host or --repo, not both or neither"],
    [["remove", "--host", "box", "--repo", "o/r"], "tug remove takes --host or --repo, not both or neither"],
    [["update", "--host", "box", "--yes"], "tug update does not take --yes"],
    [["status", "--host", "box", "--ref", "x"], "tug status does not take --ref"],
    [["update", "--host=-oProxyCommand=x"], "Not an SSH host: -oProxyCommand=x"],
    [["remove", "--repo", "not-a-repo"], "Not a repository: not-a-repo"],
  ])("%j", async (argv, message) => {
    const result = await usage(argv)
    expect(result.code).toBe(1)
    expect(result.err).toBe(`${message}\n`)
  })
})

describe("unknown flags", () => {
  it("tug install refuses one before any remote command", async () => {
    const { run, calls } = fakeRun()
    const result = await cli(["install", "--host", "box", "--env", "x"], { run, request: commits(SHA), env: ENV })
    expect(result.code).toBe(1)
    expect(result.err).toContain("Unknown option '--env'")
    expect(calls).toEqual([])
  })
})

describe("tug keys", () => {
  it("names a missing setting in one line instead of a stack trace", async () => {
    vi.stubEnv("TUG_ACCOUNTS", "")
    try {
      const result = await cli(["keys"], { run: fakeRun().run, request: commits(SHA) })
      expect(result).toEqual({ code: 1, out: "", err: "Set TUG_ACCOUNTS\n" })
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
