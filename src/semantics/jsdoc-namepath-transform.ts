import ts from 'typescript'
import { documentationRangesIn } from './documentation-ranges.js'

/**
 * JSDoc namepaths (`WebGLRenderer~Options`), respelled as legal identifiers.
 *
 * JSDoc's own grammar scopes a name to its owner with `~` for an inner
 * declaration, `#` for an instance member and `.` for a static one. three
 * writes its configuration objects that way:
 *
 * ```js
 * /** @typedef {Object} WebGLRenderer~Options
 *  *  @property {DOMElement} [canvas]
 *  *  @property {boolean} [antialias] ... *\/
 *
 * /** @param {WebGLRenderer~Options} [parameters] *\/
 * constructor( parameters = {} ) { ... }
 * ```
 *
 * TypeScript has no `~` in a type name. It reads the `@typedef` name as far as
 * `WebGLRenderer` and stops, and the `@param` reference resolves to nothing --
 * which is `any`. So a type the library *did* state is lost twice over, and
 * `WebGLRenderer`'s entire configuration -- `canvas`, `context`, and every
 * flag -- arrives untyped.
 *
 * `~` is not meaning, it is punctuation: the namepath denotes exactly one
 * declaration and nothing about the program depends on how it is spelled.
 * Rewriting it to `_` before the checker parses the file gives that
 * declaration a name TypeScript can bind, and the existing `@typedef`/`@param`
 * machinery does the rest unmodified. This is the same shape of fix as
 * `definePropertySourceTransform`: state, in a spelling the checker already
 * understands, a fact the source had stated in one it does not.
 *
 * ## Why the rewrite is confined to JSDoc comments
 *
 * `~` is bitwise NOT. `a~b` is not valid expression syntax, but `x = ~y` is
 * everywhere, and a rewrite that ran over source text would corrupt it. Only
 * ranges the parser itself reports as `/**` comments are touched, so code --
 * and ordinary `//` and `/* *\/` comments -- are left exactly as written.
 *
 * ## What is deliberately left alone
 *
 * Only `~` is respelled. JSDoc's `#` and `.` separators are not: `.` is
 * already legal in a TypeScript qualified name and means something there, and
 * a `#` name would collide with private-field syntax. Neither appears in a
 * namepath this compiler has needed, and respelling a separator that already
 * has a meaning would be a change of meaning rather than of spelling.
 *
 * A collision is possible in principle -- a file could declare both
 * `A~B` and `A_B` -- and is not guarded, because the respelled name would then
 * be a duplicate declaration the checker reports, not a silently wrong answer.
 */

const NAMEPATH = /\b([A-Za-z_$][A-Za-z0-9_$]*)~([A-Za-z_$][A-Za-z0-9_$]*)\b/g

const scriptKindOf = (fileName: string): ts.ScriptKind =>
  fileName.endsWith('.tsx')
    ? ts.ScriptKind.TSX
    : fileName.endsWith('.jsx')
      ? ts.ScriptKind.JSX
      : fileName.endsWith('.js') || fileName.endsWith('.mjs') || fileName.endsWith('.cjs')
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS

export const jsdocNamepathTransform = (input: { readonly fileName: string; readonly text: string }): string | null => {
  // A declaration file states its types directly; there is no namepath to
  // rescue, and rewriting one would change a name the program may refer to.
  if (input.fileName.endsWith('.d.ts')) return null
  // One character test is what a file with no namepath in it costs.
  if (!input.text.includes('~')) return null
  const file = ts.createSourceFile(input.fileName, input.text, ts.ScriptTarget.Latest, true, scriptKindOf(input.fileName))
  const ranges = documentationRangesIn(file, input.text)
  if (ranges.length === 0) return null
  let rewritten = input.text
  let changed = false
  // Spliced from the end so every earlier range is still the range it was
  // measured at, exactly as `definePropertySourceTransform` does.
  for (const range of [...ranges].reverse()) {
    const comment = input.text.slice(range.pos, range.end)
    const respelled = comment.replace(NAMEPATH, '$1_$2')
    if (respelled === comment) continue
    changed = true
    rewritten = rewritten.slice(0, range.pos) + respelled + rewritten.slice(range.end)
  }
  return changed ? rewritten : null
}
