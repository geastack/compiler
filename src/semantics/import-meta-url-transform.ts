import { pathToFileURL } from 'node:url'
import type { SourceTransform } from './source-transform-protocol.js'

/**
 * `import.meta.url` as the module's own `file:` URL, spelled as a string
 * literal.
 *
 * A compiled program has no module loader to ask at run time, and the value
 * is fixed the moment the module is chosen: it names the source file, which
 * the compiler holds. So the honest native answer is the constant -- the same
 * one a bundler writes -- and nothing downstream needs to model `import.meta`
 * at all. Only the exact `import.meta.url` read is rewritten; strings,
 * template text and comments are skipped so a mention inside them stays as
 * written.
 */
export const importMetaUrlTransform: SourceTransform = ({ fileName, text }) => {
  const needle = 'import.meta.url'
  if (!text.includes(needle)) return null
  const literal = JSON.stringify(pathToFileURL(fileName).href)
  const isIdentifierChar = (code: number): boolean =>
    (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 36 || code === 95
  let out = ''
  let changed = false
  let index = 0
  while (index < text.length) {
    const ch = text.charCodeAt(index)
    // Line and block comments.
    if (ch === 47 && text.charCodeAt(index + 1) === 47) {
      const end = text.indexOf('\n', index)
      const stop = end < 0 ? text.length : end
      out += text.slice(index, stop)
      index = stop
      continue
    }
    if (ch === 47 && text.charCodeAt(index + 1) === 42) {
      const end = text.indexOf('*/', index + 2)
      const stop = end < 0 ? text.length : end + 2
      out += text.slice(index, stop)
      index = stop
      continue
    }
    // String and template literals.
    if (ch === 39 || ch === 34 || ch === 96) {
      let cursor = index + 1
      while (cursor < text.length && text.charCodeAt(cursor) !== ch) cursor += text.charCodeAt(cursor) === 92 ? 2 : 1
      out += text.slice(index, cursor + 1)
      index = cursor + 1
      continue
    }
    if (
      text.startsWith(needle, index) &&
      (index === 0 || (!isIdentifierChar(text.charCodeAt(index - 1)) && text.charCodeAt(index - 1) !== 46)) &&
      !isIdentifierChar(text.charCodeAt(index + needle.length))
    ) {
      out += literal
      index += needle.length
      changed = true
      continue
    }
    out += text[index]
    index++
  }
  return changed ? out : null
}
