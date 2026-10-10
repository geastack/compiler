import { gotoTargetsOf, identifiersOf } from './emit-scopes.js'

type Declaration = { readonly name: string; readonly type: string }

/**
 * A straight-line body long enough to be split into scoped segments. Below it
 * the function-scope layout costs nothing measurable, and leaving it alone
 * keeps every ordinary body's text exactly as it was.
 */
const segmentedStatementThreshold = 256
/** Statements per segment: small enough that few locals are live in one. */
const statementsPerSegment = 64

/**
 * The text split at its top-level statement boundaries: a newline at brace,
 * paren and bracket depth zero, outside every string, character and comment.
 * `null` when the text does not balance -- the split would then be a guess.
 */
const topLevelStatementsOf = (text: string): readonly string[] | null => {
  const statements: string[] = []
  let depth = 0
  let start = 0
  let index = 0
  while (index < text.length) {
    const char = text[index]!
    if (char === '"' || char === "'") {
      // A raw string `R"delim( ... )delim"` holds unescaped quotes.
      if (char === '"' && index > 0 && text[index - 1] === 'R') {
        const open = text.indexOf('(', index)
        if (open < 0) return null
        const delimiter = text.slice(index + 1, open)
        const close = text.indexOf(`)${delimiter}"`, open)
        if (close < 0) return null
        index = close + delimiter.length + 2
        continue
      }
      index += 1
      while (index < text.length && text[index] !== char) index += text[index] === '\\' ? 2 : 1
      if (index >= text.length) return null
      index += 1
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      const end = text.indexOf('\n', index)
      index = end < 0 ? text.length : end
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      if (end < 0) return null
      index = end + 2
      continue
    }
    if (char === '{' || char === '(' || char === '[') depth += 1
    else if (char === '}' || char === ')' || char === ']') {
      depth -= 1
      if (depth < 0) return null
    } else if (char === '\n' && depth === 0) {
      statements.push(text.slice(start, index))
      start = index + 1
    }
    index += 1
  }
  if (depth !== 0) return null
  statements.push(text.slice(start))
  return statements.filter((statement) => statement.trim() !== '')
}

const notDeclaringKeywords = new Set(['return', 'throw', 'delete', 'goto', 'co_return', 'co_yield', 'co_await', 'case', 'else', 'new'])

/** The name a statement declares in its own scope (`auto x = ...;`, `T x;`), if it is one. */
const statementDeclaredNameOf = (statement: string): string | null => {
  const text = statement.trimStart()
  let index = 0
  const word = (): string => {
    const start = index
    while (index < text.length && isIdentifierPart(text.charCodeAt(index))) index += 1
    return text.slice(start, index)
  }
  let type = word()
  while (type === 'const' || type === 'static' || type === 'constexpr') {
    const before = index
    while (index < text.length && text[index]!.trim() === '') index += 1
    if (before === index) return null
    type = word()
  }
  if (type === '' || notDeclaringKeywords.has(type)) return null
  while (text[index] === ':' && text[index + 1] === ':') {
    index += 2
    if (word() === '') return null
  }
  if (text[index] === '<') {
    let depth = 0
    do {
      const char = text[index]
      if (char === ';' || char === '=') return null
      if (char === '<') depth += 1
      else if (char === '>') depth -= 1
      index += 1
    } while (index < text.length && depth > 0)
    if (depth !== 0) return null
  }
  const separator = index
  while (index < text.length && (text[index]!.trim() === '' || text[index] === '*' || text[index] === '&')) index += 1
  if (index === separator || !isIdentifierStart(text.charCodeAt(index))) return null
  const name = word()
  while (index < text.length && text[index]!.trim() === '') index += 1
  return text[index] === '=' || text[index] === ';' || text[index] === '{' || text[index] === '(' ? name : null
}

/**
 * Whether a segment can run as a lambda of its own: nothing in it leaves the
 * segment except by finishing or throwing. Read off the whole text, nested
 * lambdas included, so a `return` inside one also keeps the block form --
 * conservative, never wrong.
 */
const isIdentifierStart = (code: number): boolean => (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 95
const isIdentifierPart = (code: number): boolean => isIdentifierStart(code) || (code >= 48 && code <= 57)
const transferKeywords = new Set(['return', 'goto', 'break', 'continue', 'co_await', 'co_yield', 'co_return'])
const lambdaSafe = (segment: string): boolean =>
  ![...identifiersOf(segment)].some((name) => transferKeywords.has(name)) && labelDefinitionsOf(segment).length === 0

const labelDefinitionsOf = (text: string): readonly string[] => {
  const labels: string[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    const definition = trimmed.endsWith(';') ? trimmed.slice(0, -1).trimEnd() : trimmed
    if (!definition.endsWith(':')) continue
    const name = definition.slice(0, -1).trimEnd()
    if (!isIdentifierStart(name.charCodeAt(0))) continue
    if (![...name].every((char) => isIdentifierPart(char.charCodeAt(0)))) continue
    if (name !== 'default' && name !== 'public' && name !== 'private') labels.push(name)
  }
  return labels
}

/**
 * One straight-line body re-written as consecutive segments -- each a
 * non-inlined lambda run in place (a block, when it transfers control out of
 * itself) -- declaring the locals only its own statements name.
 *
 * Every local of a single-block body is declared at the top of the function,
 * so each one is live across every statement. Under `-fexceptions` every call
 * that may throw needs a cleanup for every live local with a destructor, and
 * GCC's work grows with statements times live locals: a module body building a
 * few hundred static arrays (generated geometry tables and a font atlas:
 * 844 `gea::Ref` locals, ~3900 statements) did not finish compiling in 90
 * minutes at -O2, -O1 or -Os. Measured on that unit: 1656 statements, >170 s;
 * the same text with -fno-exceptions, 12 s. Scoping a temporary to the segment
 * that uses it bounds the live set by the segment, not the body, and a lambda
 * per segment bounds the function GCC allocates registers for.
 *
 * A local named in more than one segment, or by `rootText` (the entry
 * prologue), stays at the top. `null` -- keep the flat layout -- when the body
 * is short, does not split cleanly, jumps to a label in another segment, or a
 * statement declares a name of its own that a later segment still reads.
 */
export const segmentScopedBodyOf = (
  text: string,
  declarations: readonly Declaration[],
  rootText: string
): { readonly top: readonly Declaration[]; readonly text: string } | null => {
  const statements = topLevelStatementsOf(text)
  if (statements === null || statements.length < segmentedStatementThreshold) return null
  const segments: string[] = []
  for (let index = 0; index < statements.length; index += statementsPerSegment)
    segments.push(statements.slice(index, index + statementsPerSegment).join('\n'))
  const labelSegment = new Map<string, number>()
  for (const [index, segment] of segments.entries()) for (const label of labelDefinitionsOf(segment)) labelSegment.set(label, index)
  for (const [index, segment] of segments.entries())
    for (const target of gotoTargetsOf(segment)) if (labelSegment.has(target) && labelSegment.get(target) !== index) return null
  const mentions = segments.map((segment) => identifiersOf(segment))
  const segmentsNaming = (name: string): number[] => mentions.flatMap((names, index) => (names.has(name) ? [index] : []))
  for (const [index, segment] of segments.entries()) {
    for (const statement of segment.split('\n')) {
      const declared = statementDeclaredNameOf(statement)
      if (declared !== null && segmentsNaming(declared).some((other) => other !== index)) return null
    }
  }
  const root = identifiersOf(rootText)
  const top: Declaration[] = []
  const framed: Declaration[] = []
  const scoped = new Map<number, Declaration[]>()
  for (const entry of declarations) {
    if (root.has(entry.name)) {
      top.push(entry)
      continue
    }
    const where = segmentsNaming(entry.name)
    if (where.length !== 1) {
      framed.push(entry)
      continue
    }
    const list = scoped.get(where[0]!)
    if (list) list.push(entry)
    else scoped.set(where[0]!, [entry])
  }
  // A local several segments share lives in ONE frame object rather than as
  // its own variable: a nested literal (`kerning: [[88, 51, -2.27], ...]`)
  // builds every inner array before the outer one, so all of them cross
  // segments -- 1177 of them in one generated font atlas. As separate locals each is a
  // cleanup on every call and a variable for var-tracking (measured: 172 s, and
  // 69 s as references into a frame, 32 of them var-tracking); as members of
  // one object they are one cleanup and no variables at all.
  const frameNames = new Set(framed.map((entry) => entry.name))
  const frame =
    framed.length === 0 ? [] : ['struct GeaSegmentFrame {', ...framed.map((entry) => `${entry.type} ${entry.name};`), `} ${frameObject};`]
  const rendered = segments.map((segment, index) => {
    if (frameNames.size > 0) segment = withFrameMembers(segment, frameNames)
    const own = (scoped.get(index) ?? []).map((entry) => `${entry.type} ${entry.name};`)
    // Its own FUNCTION, not only its own scope: GCC's register allocation and
    // variable tracking grow faster than linearly in one function's size, so a
    // module body still took minutes as one function of scoped blocks
    // (measured: 25 segments, 79 s, 36 of them in "register information").
    // A segment that transfers control out of itself stays a block.
    if (lambdaSafe(segment)) return [`[&]() __attribute__((noinline)) -> void {`, ...own, segment, '}();'].join('\n')
    return own.length > 0 ? ['{', ...own, segment, '}'].join('\n') : segment
  })
  return { top, text: [...frame, ...rendered].join('\n') }
}

const frameObject = 'gea_segment_frame'

/**
 * `text` with every identifier in `names` spelled as a member of the frame
 * object. Strings, characters and comments are copied as they are, and a name
 * after `.`, `->` or `::` is some other object's member, not the local.
 */
const withFrameMembers = (text: string, names: ReadonlySet<string>): string => {
  let out = ''
  let index = 0
  const isWord = (code: number): boolean =>
    (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || code === 95 || (code >= 48 && code <= 57)
  while (index < text.length) {
    const char = text[index]!
    const start = index
    if (char === '"' || char === "'") {
      if (char === '"' && index > 0 && text[index - 1] === 'R') {
        const open = text.indexOf('(', index)
        const delimiter = text.slice(index + 1, open)
        index = text.indexOf(`)${delimiter}"`, open) + delimiter.length + 2
      } else {
        index += 1
        while (index < text.length && text[index] !== char) index += text[index] === '\\' ? 2 : 1
        index += 1
      }
      out += text.slice(start, index)
      continue
    }
    if (char === '/' && text[index + 1] === '/') {
      const end = text.indexOf('\n', index)
      index = end < 0 ? text.length : end
      out += text.slice(start, index)
      continue
    }
    if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2)
      index = end < 0 ? text.length : end + 2
      out += text.slice(start, index)
      continue
    }
    if (isWord(text.charCodeAt(index))) {
      while (index < text.length && isWord(text.charCodeAt(index))) index += 1
      const word = text.slice(start, index)
      const before = out.trimEnd()
      const member = before.endsWith('.') || before.endsWith('->') || before.endsWith('::')
      out += names.has(word) && !member ? `${frameObject}.${word}` : word
      continue
    }
    out += char
    index += 1
  }
  return out
}
