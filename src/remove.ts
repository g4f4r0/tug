import { fileAt, type Request } from "./forge/github.ts"

const FILES = [".github/workflows/tug.yml", "tug.json"]

/** True when the person confirmed: `--yes`, or the typed name on a terminal. Prints why when not. */
export async function confirmed(name: string, options: { yes: boolean; tty: boolean; readLine: () => Promise<string>; err: (text: string) => void }): Promise<boolean> {
  if (options.yes) return true
  if (!options.tty) {
    options.err(`Refusing to remove ${name} without --yes\n`)
    return false
  }
  options.err(`Type ${name} to remove Tug from it: `)
  if ((await options.readLine()) === name) return true
  options.err("Not removed\n")
  return false
}

/** Opens a pull request that deletes Tug's workflow and `tug.json` from the repository's default branch. */
export async function removeRepo(request: Request, repo: string): Promise<{ repo: string; pr: string; files: string[] }> {
  const { default_branch: base } = await request<{ default_branch: string }>("GET", `/repos/${repo}`)
  const head = await request<{ sha: string; commit: { tree: { sha: string } } }>("GET", `/repos/${repo}/commits/${encodeURIComponent(base)}`)
  const files: string[] = []
  for (const path of FILES) if ((await fileAt(request, repo, path, head.sha)) !== null) files.push(path)
  if (files.length === 0) throw new Error(`${repo} has no Tug files`)

  const tree = await request<{ sha: string }>("POST", `/repos/${repo}/git/trees`, { body: { base_tree: head.commit.tree.sha, tree: files.map((path) => ({ path, mode: "100644", type: "blob", sha: null })) } })
  const commit = await request<{ sha: string }>("POST", `/repos/${repo}/git/commits`, { body: { message: "ci: Remove Tug", tree: tree.sha, parents: [head.sha] } })
  await request("POST", `/repos/${repo}/git/refs`, { body: { ref: "refs/heads/tug/remove", sha: commit.sha } })
  const body = `## Summary\n\nDeletes ${files.map((path) => `\`${path}\``).join(" and ")}, so the repository no longer runs Tug's review and merge.\n\n## Risk\n\nCI only. Undo by reverting.\n`
  const pull = await request<{ html_url: string }>("POST", `/repos/${repo}/pulls`, { body: { title: "ci: Remove Tug", head: "tug/remove", base, body } })
  return { repo, pr: pull.html_url, files }
}
