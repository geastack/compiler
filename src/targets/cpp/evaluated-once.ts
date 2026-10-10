/**
 * ONE EVALUATION PER OPERAND, HOWEVER MANY TIMES A RENDERING NAMES IT.
 *
 * An operand's text is not always a name. A deferred value (`emit.ts`'s
 * withholding) renders as the expression that computes it, and a conversion
 * renders as the expression that performs it -- a record built field by field
 * out of a sidecar's dynamic reads, say. A renderer that names its input more
 * than once (a record recast reads the source once per field; a union
 * dispatch reads it in the test and again in the arm; `Object.entries`' static
 * arm reads it in the value, the presence test, the `[[Enumerable]]` test and
 * the creation-order walk) then pastes that whole expression once per use, so
 * the program RUNS it once per use: JavaScript evaluated the operand exactly
 * once. A `new C(a, b, this.options)` call pasted the options' record
 * conversion once per field of the parameter's options type -- 32 copies in
 * one 1.4 MB statement -- and each copy re-ran the conversion's sidecar reads.
 *
 * The rendering is taken with the operand's own text first, so an operand
 * named at most once -- the overwhelmingly common case -- renders exactly as
 * it always did. Only when the text occurs twice or more is the rendering
 * taken again over a name, bound in an immediately invoked lambda: the operand
 * initializes a local of its own, so it evaluates once, before the rendering.
 *
 * The binding is a LOCAL `auto&&` of a non-generic lambda, not a generic
 * lambda's `auto&&` parameter. A parameter of a generic lambda has a DEPENDENT
 * type, and a rendering that names a member template on it -- a tagged union's
 * `(*gea_once).is<0>()` -- then needs the `template` disambiguator C++ demands
 * in a template, which no renderer spells: an options field holding an
 * `Optional` of a string/document union boxed for a dynamic read, was rejected
 * by clang with "missing 'template' keyword prior to dependent template name".
 * A deduced local is not dependent. It is declared under a second name and
 * re-bound, because `auto&& gea_once = (text)` would name ITSELF in its own
 * initializer wherever `text` is an outer binding's rendering: the outer
 * `gea_once` is read by the initializer of the inner `gea_once_value`, and only
 * then shadowed.
 */

/** The name an operand is bound under; a lambda parameter, so every binding may reuse it. */
export const EVALUATED_ONCE_NAME = 'gea_once'

const isIdentifierStart = (code: number): boolean => (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95 // A-Z a-z _
const isIdentifierPart = (code: number): boolean => isIdentifierStart(code) || (code >= 48 && code <= 57)
const isDigit = (code: number): boolean => code >= 48 && code <= 57

/**
 * The end of the storage path starting at `at`, or -1. A path is a name, a
 * parenthesized path, or `*` of a path, followed by any number of `->field`,
 * `.field` and `::name` steps -- a load or a place, never a call, so naming it
 * twice reads the same storage twice and does no work.
 */
const storagePathEnd = (text: string, start: number): number => {
  let at = start
  if (text[at] === '*') {
    at = storagePathEnd(text, at + 1)
  } else if (text[at] === '(') {
    at = storagePathEnd(text, at + 1)
    if (at === -1 || text[at] !== ')') return -1
    at += 1
  } else {
    if (at >= text.length || !isIdentifierStart(text.charCodeAt(at))) return -1
    while (at < text.length && isIdentifierPart(text.charCodeAt(at))) at += 1
  }
  while (at !== -1 && at < text.length) {
    const step = text.startsWith('->', at) || text.startsWith('::', at) ? 2 : text[at] === '.' ? 1 : 0
    if (step === 0) return at
    at += step
    if (at >= text.length || !isIdentifierStart(text.charCodeAt(at))) return -1
    while (at < text.length && isIdentifierPart(text.charCodeAt(at))) at += 1
  }
  return at
}

const isStoragePath = (text: string): boolean => storagePathEnd(text, 0) === text.length

/** A number literal, optionally signed, or a string literal with no embedded quote. */
const isLiteral = (text: string): boolean => {
  if (text === 'nullptr' || text === 'true' || text === 'false') return true
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) return !text.slice(1, -1).includes('"')
  const digits = text.startsWith('-') ? text.slice(1) : text
  if (digits.length === 0 || !isDigit(digits.charCodeAt(0))) return false
  for (let at = 0; at < digits.length; at += 1) {
    const code = digits.charCodeAt(at)
    if (!isDigit(code) && !isIdentifierStart(code) && digits[at] !== '.') return false
  }
  return true
}

/**
 * Whether pasting `text` twice costs nothing and changes nothing: a storage
 * path (`storagePathEnd`) or a literal, possibly parenthesized. Anything else --
 * a call, a conversion, an arithmetic expression -- does work that must happen
 * once.
 */
export const isTrivialOperandText = (text: string): boolean => {
  let inner = text
  while (inner.length >= 2 && inner.startsWith('(') && inner.endsWith(')') && isLiteral(inner.slice(1, -1))) inner = inner.slice(1, -1)
  return isStoragePath(inner) || isLiteral(inner)
}

/** Past this many characters an operand is rendered over its name first (`evaluatedOnceText`). */
const LONG_OPERAND = 4096
const occurrencesOf = (haystack: string, needle: string, limit: number): number => {
  let count = 0
  for (let at = haystack.indexOf(needle); at !== -1 && count < limit; at = haystack.indexOf(needle, at + needle.length)) count += 1
  return count
}

/** Whether `rendered` names `text` more than once -- i.e. would evaluate it more than once. */
export const namesMoreThanOnce = (rendered: string, text: string): boolean =>
  !isTrivialOperandText(text) && occurrencesOf(rendered, text, 2) >= 2

/**
 * `render(text)`, with `text` evaluated exactly once in the result. A renderer
 * that refuses (`null`) refuses either way.
 */
export const evaluatedOnceText = <Rendered extends string | null>(text: string, render: (operand: string) => Rendered): Rendered => {
  // A LONG operand is rendered over the name first. Rendering it pasted, only
  // to count the pastes, is the blow-up this helper exists to prevent:
  // `Object.entries(this.options)` over a 200-field options family
  // pasted a 2.6 MB receiver conversion into every field's read and died with
  // "Invalid string length" before any count could run. The output is the
  // same as the pasted-first order: a name used at most once is re-rendered
  // with the operand itself.
  if (text.length > LONG_OPERAND && !isTrivialOperandText(text)) {
    const bound = render(EVALUATED_ONCE_NAME)
    if (bound !== null && occurrencesOf(bound, EVALUATED_ONCE_NAME, 2) >= 2) {
      return `([&]() { auto&& ${EVALUATED_ONCE_NAME}_value = ${text}; auto&& ${EVALUATED_ONCE_NAME} = ${EVALUATED_ONCE_NAME}_value; return ${bound}; }())` as Rendered
    }
  }
  const direct = render(text)
  if (direct === null || !namesMoreThanOnce(direct, text)) return direct
  const bound = render(EVALUATED_ONCE_NAME)
  if (bound === null) return direct
  return `([&]() { auto&& ${EVALUATED_ONCE_NAME}_value = ${text}; auto&& ${EVALUATED_ONCE_NAME} = ${EVALUATED_ONCE_NAME}_value; return ${bound}; }())` as Rendered
}
