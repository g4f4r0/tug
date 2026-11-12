import { createPrivateKey, generateKeyPairSync } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import { main, type Deps } from "../src/cli.ts"
import type { Request } from "../src/forge/github.ts"
import { GitHubError } from "../src/forge/github.ts"
import type { Run } from "../src/host.ts"

const SHA = "0123456789abcdef0123456789abcdef01234567"

/** A runner that records every call and answers `ssh` from a script. */
function fakeRun(answers: { status?: string } = {}) {
  const calls: { cmd: string; args: string[]; input?: string | Buffer }[] = []
  const run: Run = (cmd, args, input) => {
    calls.push({ cmd, args, input })
    return { status: 0, stdout: args.at(-1)?.startsWith("echo") ? (answers.status ?? "") : "", stderr: "" }
  }
  return { run, calls }
}

const commits = (sha: string): Request => (async (_method: string, path: string) => {
  expect(path).toBe("/repos/hellogafaro/tug/commits/main")
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
const SETTINGS = "sudo install -d -m 0755 /etc/tug && sudo install -m 0600 /dev/stdin /etc/tug/tug.env"
const INSTALL = 'sudo ~/tug/runners/install.sh "$USER"'

const PEM = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs1", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } }).privateKey
const ENV = { TUG_APP_ID: "1", TUG_APP_PRIVATE_KEY: PEM, TUG_ACCOUNTS: "me,my-org", TUG_REVIEW_MODEL: "openai/gpt-6.1-sol", TUG_OPENAI_API_KEY: 'k=$x"`\\', TUG_REVIEWER: "someone", OTHER: "secret", PATH: "/bin" }

/** What systemd's EnvironmentFile reads from a double-quoted line. */
const unquote = (line: string) => /^(\w+)="(.*)"$/u.exec(line)!.slice(1, 3).map((part) => part.replace(/\\(["\\`$])/gu, "$1")) as [string, string]

describe("tug install and update", () => {
  it("downloads the commit, sends it and only the host settings as stdin, then installs", async () => {
    downloads.length = 0
    const { run, calls } = fakeRun()
    const result = await cli(["install", "--host", "box"], { run, request: commits(SHA), env: ENV })
    expect(result.code).toBe(0)
    expect(downloads).toEqual([`https://codeload.github.com/hellogafaro/tug/tar.gz/${SHA}`])
    expect(calls.map((call) => call.args.at(-1))).toEqual([FETCH, SETTINGS, INSTALL])
    expect(calls[0]).toEqual(ssh(FETCH, TARBALL))
    expect(calls[2]!.input).toBeUndefined()
    const lines = String(calls[1]!.input).split("\n")
    expect(lines.pop()).toBe("")
    expect(Object.fromEntries(lines.map(unquote))).toEqual({ ...ENV, TUG_APP_PRIVATE_KEY: PEM.trim().replaceAll("\n", " "), TUG_REVIEWER: undefined, OTHER: undefined, PATH: undefined })
    expect(JSON.parse(result.out)).toEqual({ host: "box", version: SHA, ref: "main" })
    expect(result.err).toBe("Installed 0123456 on box\n")
    expect(result.out + result.err).not.toContain("secret")
  })

  it("sends the private key on one line that gives the same key back, whether its line breaks came real, as spaces, escaped or not at all", async () => {
    for (const key of [PEM, PEM.replaceAll("\n", " "), PEM.replaceAll("\n", "\\n"), PEM.replaceAll("\n", "")]) {
      const { run, calls } = fakeRun()
      expect((await cli(["install", "--host", "box"], { run, request: commits(SHA), env: { ...ENV, TUG_APP_PRIVATE_KEY: key } })).code).toBe(0)
      const [, value] = unquote(String(calls[1]!.input).split("\n").find((line) => line.startsWith("TUG_APP_PRIVATE_KEY="))!)
      // The runner service's normalizePEM: the body's whitespace dropped, then 64 characters a line.
      const [, kind, body] = /^-----BEGIN ([A-Z ]+)-----(.*)-----END \1-----$/u.exec(value)!
      const rebuilt = `-----BEGIN ${kind}-----\n${body!.replace(/\s/gu, "").match(/.{1,64}/gu)!.join("\n")}\n-----END ${kind}-----\n`
      expect(rebuilt).toBe(PEM)
      expect(createPrivateKey(rebuilt).export({ type: "pkcs1", format: "pem" })).toBe(PEM)
    }
  })

  it.each([
    [{ TUG_ACCOUNTS: undefined }, "Set TUG_ACCOUNTS"],
    [{ TUG_REVIEW_MODEL: undefined }, "Set TUG_REVIEW_MODEL"],
    [{ TUG_OPENAI_API_KEY: undefined }, "Set TUG_OPENAI_API_KEY for openai/gpt-6.1-sol"],
    [{ TUG_APP_ID: "" }, "Set TUG_APP_ID"],
    [{ TUG_APP_PRIVATE_KEY: undefined }, "Set TUG_APP_PRIVATE_KEY"],
    [{ TUG_APP_PRIVATE_KEY: "not a key" }, "TUG_APP_PRIVATE_KEY is not a PEM key"],
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
      expect(path).toBe("/repos/hellogafaro/tug/commits/feat/own-host")
      return { sha: SHA }
    }) as Request
    const result = await cli(["update", "--host", "box", "--ref", "feat/own-host"], { run, request, env: ENV })
    expect(result.code).toBe(0)
    expect(calls).toEqual([ssh(FETCH, TARBALL), ssh(INSTALL)])
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
  const output = (services: string) => `services ${services}\nversion ${SHA}\nrunning 2\n`

  it("parses the host's answer and exits 0 when the runner and key services are active", async () => {
    const { run, calls } = fakeRun({ status: output("active active active") })
    const result = await cli(["status", "--host", "box"], { run })
    expect(result.code).toBe(0)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.args.at(-1)).toContain("systemctl is-active tug-runners tug-keys tug-prune.timer")
    expect(JSON.parse(result.out)).toEqual({ host: "box", version: SHA, services: { "tug-runners": "active", "tug-keys": "active", "tug-prune.timer": "active" }, running: 2 })
  })

  it("exits 1 when a service is down", async () => {
    const result = await cli(["status", "--host", "box"], { run: fakeRun({ status: output("active failed inactive") }).run })
    expect(result.code).toBe(1)
    expect(JSON.parse(result.out).services["tug-keys"]).toBe("failed")
  })

  it("reads an empty version as null", async () => {
    const result = await cli(["status", "--host", "box"], { run: fakeRun({ status: "services active active active\nversion \nrunning 0\n" }).run })
    expect(JSON.parse(result.out).version).toBeNull()
  })
})

describe("tug remove --host", () => {
  const REMOVE = "sudo ~/tug/runners/install.sh --uninstall && sudo rm -f /etc/tug/tug.env && rm -rf ~/tug"

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
    expect(calls).toEqual([{ ...ssh(REMOVE), input: undefined }])
    expect(JSON.parse(result.out)).toEqual({ host: "box", removed: true })
  })

  it("removes when the typed name matches on a terminal", async () => {
    const { run, calls } = fakeRun()
    const result = await cli(["remove", "--host", "box"], { run, tty: true, readLine: async () => "box" })
    expect(result.code).toBe(0)
    expect(result.err).toContain("Type box to remove Tug from it: ")
    expect(calls).toHaveLength(1)
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
