// `finally` in the four ways ECMAScript can leave a try body, plus the fifth
// that is not a leave at all.
//
// The whole mechanism is `gea::ScopeExit`: an object whose destructor runs the
// clause. C++ destroys a scoped object however the scope is left -- falling off
// the end, `return`, a `goto` past it (which is what `break` and `continue`
// lower to), and an exception unwinding -- and that is the same list
// ECMAScript gives for when a finally clause runs. So none of the completions
// below needs a completion record or a dispatch: each stays an ordinary IR
// terminator.
//
// `break`/`continue` out of a try body is NOT exercised here because it does
// not compile yet, and it does not compile with a plain `catch` either: the
// loop's back edge re-enters the try body's entry block, which `renderTryRegion`
// correctly refuses as "a block reached by a jump from outside it". That gap is
// the try RENDERING's, not the finally clause's, and it predates this file.

const trace: string[] = []

// Ordinary completion, and the return path, in one function.
const readOrDefault = (values: string[], index: number): string => {
  try {
    const found = values[index]
    if (found !== undefined) return found
    return 'missing'
  } finally {
    trace.push('read')
  }
}

// A catch clause AND a finally clause: the guard wraps both.
const parseOrZero = (raw: string): number => {
  try {
    if (raw.length === 0) throw new Error('empty')
    return raw.length
  } catch {
    return 0
  } finally {
    trace.push('parse')
  }
}

// An exception propagating THROUGH a finally to a caller's catch.
const rethrows = (): number => {
  try {
    throw new Error('inner')
  } finally {
    trace.push('rethrow')
  }
}

const caught = (): number => {
  try {
    return rethrows()
  } catch {
    return 42
  }
}

const words: string[] = ['a', 'bb', 'cccc', 'd']

export const probe =
  readOrDefault(words, 2).length + readOrDefault(words, 9).length + parseOrZero('abc') + parseOrZero('') + caught() + trace.length

// Self-verifying: an uncaught throw at module scope aborts the process, so
// `scripts/run-emitted.mjs`'s exit status is the answer. A certificate and a
// clang-clean emit both say nothing about whether the clauses actually RAN, and
// the order they ran in is the entire feature.
//
// 4 (`'cccc'`) + 7 (`'missing'`) + 3 + 0 + 42 (caught through a finally)
// + 5 clause runs = 61.
if (probe !== 61) throw new Error('try/finally ran the wrong clauses')
