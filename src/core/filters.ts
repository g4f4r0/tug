/**
 * Glob filters as GitHub Actions reads branch and path filters: `*` matches within a path segment, `**` across
 * segments, `?` one character, and a leading `!` excludes. The last matching pattern wins, and a list of only `!`
 * entries starts from "everything". Every other character is literal, so `dependabot[bot]` names that login.
 */
function globRegExp(glob: string): RegExp {
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

const negated = (pattern: string) => pattern.startsWith("!")

/** The last of `patterns` that `value` matches, or undefined. */
function lastMatch(patterns: readonly string[], value: string, caseless: boolean): string | undefined {
  const fold = (text: string) => (caseless ? text.toLowerCase() : text)
  return patterns.findLast((pattern) => globRegExp(fold(negated(pattern) ? pattern.slice(1) : pattern)).test(fold(value)))
}

/** Whether `value` passes `patterns`. No patterns pass everything. */
export function passes(patterns: readonly string[] | undefined, value: string, options: { caseless?: boolean } = {}): boolean {
  if (!patterns || patterns.length === 0) return true
  const match = lastMatch(patterns, value, options.caseless === true)
  return match === undefined ? patterns.every(negated) : !negated(match)
}

/**
 * Why a pull request's `labels` fail `patterns`, matched without case: the first label whose last match is a `!`
 * pattern, or "" when the list has an include pattern and no label matches one. Null when they pass, and always with
 * no patterns. For a single label it agrees with `passes`.
 */
export function labelsMiss(patterns: readonly string[] | undefined, labels: readonly string[]): string | null {
  if (!patterns || patterns.length === 0) return null
  const matches = labels.map((label) => ({ label, match: lastMatch(patterns, label, true) }))
  const excluded = matches.find(({ match }) => match !== undefined && negated(match))
  if (excluded) return excluded.label
  return patterns.every(negated) || matches.some(({ match }) => match !== undefined) ? null : ""
}
