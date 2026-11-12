/**
 * Glob filters as GitHub Actions reads branch and path filters: `*` matches within a path segment, `**` across
 * segments, `?` one character, and a leading `!` excludes. The last matching pattern wins, and a list of only `!`
 * entries starts from "everything". Every other character is literal, so `dependabot[bot]` names that login.
 */
export function globRegExp(glob: string): RegExp {
  let source = ""
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!
    if (char === "*" && glob[index + 1] === "*") {
      index++
      if (glob[index + 1] === "/") {
        index++
        source += "(?:.*/)?"
      } else source += ".*"
    } else if (char === "*") source += "[^/]*"
    else if (char === "?") source += "[^/]"
    else source += char.replace(/[\\^$.|+()[\]{}]/gu, "\\$&")
  }
  // dotAll: a git path can hold a newline, and `**` must still match it.
  return new RegExp(`^${source}$`, "su")
}

/** Whether `value` passes `patterns`. No patterns pass everything. */
export function passes(patterns: readonly string[] | undefined, value: string, options: { caseless?: boolean } = {}): boolean {
  if (!patterns || patterns.length === 0) return true
  const fold = (text: string) => (options.caseless ? text.toLowerCase() : text)
  let included = patterns.every((pattern) => pattern.startsWith("!"))
  for (const pattern of patterns) {
    const negated = pattern.startsWith("!")
    if (globRegExp(fold(negated ? pattern.slice(1) : pattern)).test(fold(value))) included = !negated
  }
  return included
}
