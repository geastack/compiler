import { resolve } from 'node:path'
import ts from 'typescript'

/**
 * A copy of a type-guard function at an `any` tested parameter, for the calls
 * that hand it an `any` argument.
 *
 * ## The fact this states
 *
 * `any` is unchecked: TypeScript lets an `any` argument reach a parameter
 * whose declared type does not admit the runtime value. For most parameters
 * this compiler treats that crossing as an assertion -- the value is unboxed
 * into the parameter's native carrier and a value outside the type stops the
 * program -- because the program claimed the type. A type PREDICATE's tested
 * parameter is the one place that claim is not being made: `isMeta(t:
 * Direction): t is { $meta: string }` exists to TEST its argument, and a
 * caller holding `direction: any` calls it precisely because it does not know
 * what `direction` is. A sort-specification parser does exactly this, and
 * passes an ARRAY through that `any`; JavaScript answers `false`,
 * while the native parameter carrier (a tagged union of `number | string |
 * { $meta }`) has no arm for an array and aborts.
 *
 * The faithful meaning of such a call is the guard's body run over an
 * unchecked value -- the body as TypeScript types it when the tested parameter
 * is `any`. Every expression derived from that parameter changes type under
 * that reading (`t.$meta` is `any`, not `string`, so `typeof t.$meta` is no
 * longer a constant), so the copy cannot be made by substituting a carrier
 * after the fact: a narrowed read of `t` inside the typed body is typed at the
 * narrowed arm, and a dynamic value converted to that arm refuses exactly as
 * the call did. The checker is the only authority on how the body types at
 * `t: any`, so the copy is handed to the checker: the guard is cloned with the
 * tested parameter's annotation replaced by `any`, and the calls whose
 * argument is `any` name the clone. Callers holding a typed value keep the
 * native copy; only the unchecked callers reach the dynamic parameter, which
 * is a genuine dynamic boundary -- the program feeds that parameter values it
 * never checked.
 *
 * ## The guard
 *
 * A call is redirected when ALL of these hold:
 * - its callee is a plain identifier resolving (without an import alias) to a
 *   non-generic, non-overloaded `function` declaration with a body, declared
 *   at the top level of the same TypeScript file -- the clone is appended at
 *   the end of that file, where hoisting makes it visible to every caller and
 *   no earlier offset moves;
 * - the declaration's return type is a written type predicate
 *   (`t is X` / `asserts t is X`) naming an annotated, non-rest parameter;
 * - that parameter's declared type is neither `any` nor `unknown` -- those
 *   already are the dynamic parameter;
 * - the call's argument at that position is a non-spread expression the
 *   checker types `any`.
 *
 * Calls to the guard inside its own body name the clone within the clone, so
 * a recursive guard stays unchecked all the way down.
 */

export interface UncheckedGuardArgumentCopies {
  /** The rewritten text per resolved file name, derived from the text the program was built from. */
  readonly sourceText: ReadonlyMap<string, string>
  /**
   * Where each original guard's NAME sits in the rewritten text, per file. A
   * guard whose every caller was unchecked is no longer referenced, and the
   * unused-declaration diagnostic at that name is an artifact of the copy,
   * not of the program.
   */
  readonly originalNames: ReadonlyMap<string, readonly number[]>
}

interface Edit {
  readonly at: number
  readonly end: number
  readonly text: string
}

const unusedDeclarationCodes = new Set([6133, 6196])

/** The tested parameter a written type predicate names, when it is one this copy can retype. */
const testedParameterOf = (
  declaration: ts.FunctionDeclaration
): { readonly parameter: ts.ParameterDeclaration; readonly index: number } | null => {
  const predicate = declaration.type
  if (!predicate || !ts.isTypePredicateNode(predicate) || !ts.isIdentifier(predicate.parameterName)) return null
  const name = predicate.parameterName.text
  // A `this` parameter is not an argument position.
  const parameters = declaration.parameters.filter((parameter) => !(ts.isIdentifier(parameter.name) && parameter.name.text === 'this'))
  const index = parameters.findIndex((parameter) => ts.isIdentifier(parameter.name) && parameter.name.text === name)
  const parameter = parameters[index]
  if (!parameter || !parameter.type || parameter.dotDotDotToken) return null
  return { parameter, index }
}

const guardsIn = (
  file: ts.SourceFile
): ReadonlyMap<ts.FunctionDeclaration, { readonly parameter: ts.ParameterDeclaration; readonly index: number }> => {
  const found = new Map<ts.FunctionDeclaration, { readonly parameter: ts.ParameterDeclaration; readonly index: number }>()
  for (const statement of file.statements) {
    if (!ts.isFunctionDeclaration(statement) || !statement.body || !statement.name || statement.typeParameters) continue
    if (
      statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword || modifier.kind === ts.SyntaxKind.DeclareKeyword
      )
    )
      continue
    const tested = testedParameterOf(statement)
    if (tested) found.set(statement, tested)
  }
  return found
}

const freshName = (file: ts.SourceFile, base: string): string => {
  let name = `${base}__uncheckedArgument`
  for (let suffix = 1; file.text.includes(name); suffix += 1) name = `${base}__uncheckedArgument${suffix}`
  return name
}

const isTopType = (type: ts.Type): boolean => (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0

/**
 * An argument whose own syntax already fixes a non-`any` type is never asked
 * about. Beyond saving the query, it keeps this pass from asking the checker
 * for a literal's type ahead of the census: the checker allocates a fresh
 * object-literal type per public query (`stable-checker.ts`), so an early
 * question about one would reorder the types every later reader sees.
 */
const mayBeUnchecked = (argument: ts.Expression): boolean =>
  !ts.isSpreadElement(argument) &&
  !ts.isObjectLiteralExpression(argument) &&
  !ts.isArrayLiteralExpression(argument) &&
  !ts.isFunctionLike(argument) &&
  !ts.isClassExpression(argument) &&
  !ts.isLiteralExpression(argument) &&
  !ts.isTemplateExpression(argument) &&
  !ts.isNoSubstitutionTemplateLiteral(argument)

/** Replace every range in `edits` (absolute offsets inside `[from, to)`) within that slice of `text`. */
const spliceSlice = (text: string, from: number, to: number, edits: readonly Edit[]): string => {
  let slice = text.slice(from, to)
  for (const edit of [...edits].sort((left, right) => right.at - left.at)) {
    slice = `${slice.slice(0, edit.at - from)}${edit.text}${slice.slice(edit.end - from)}`
  }
  return slice
}

const cloneText = (
  file: ts.SourceFile,
  declaration: ts.FunctionDeclaration,
  parameter: ts.ParameterDeclaration,
  name: string,
  selfReferences: readonly ts.Identifier[]
): string => {
  const type = parameter.type as ts.TypeNode
  const asynchronous = declaration.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword) ? 'async ' : ''
  const star = declaration.asteriskToken ? '*' : ''
  const parameters = spliceSlice(file.text, declaration.parameters.pos, declaration.parameters.end, [
    { at: type.getStart(file), end: type.end, text: 'any' }
  ])
  const rest = spliceSlice(
    file.text,
    declaration.parameters.end,
    declaration.end,
    selfReferences.map((reference) => ({ at: reference.getStart(file), end: reference.end, text: name }))
  )
  return `\n${asynchronous}function${star} ${name}(${parameters}${rest}\n`
}

export const uncheckedGuardArgumentCopies = (program: ts.Program, checker: ts.TypeChecker): UncheckedGuardArgumentCopies => {
  const sourceText = new Map<string, string>()
  const originalNames = new Map<string, number[]>()
  for (const file of program.getSourceFiles()) {
    // A JavaScript file states its predicate in JSDoc, which has no written
    // annotation to retype, so `testedParameterOf` finds nothing there.
    if (file.isDeclarationFile) continue
    const guards = guardsIn(file)
    if (guards.size === 0) continue
    const symbols = new Map<ts.Symbol, ts.FunctionDeclaration>()
    for (const declaration of guards.keys()) {
      const symbol = declaration.name ? checker.getSymbolAtLocation(declaration.name) : undefined
      // Overloads share one symbol; a clone of the implementation alone would drop them.
      if (symbol && symbol.declarations?.length === 1) symbols.set(symbol, declaration)
    }
    if (symbols.size === 0) continue
    // Spelling only narrows which calls are ASKED about; the symbol decides.
    const names = new Set([...symbols.values()].map((declaration) => declaration.name?.text))
    const guardAt = (identifier: ts.Identifier): ts.FunctionDeclaration | undefined => {
      if (!names.has(identifier.text)) return undefined
      const symbol = checker.getSymbolAtLocation(identifier)
      return symbol ? symbols.get(symbol) : undefined
    }
    const redirected = new Map<ts.FunctionDeclaration, ts.Identifier[]>()
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && !node.questionDotToken) {
        const declaration = guardAt(node.expression)
        const tested = declaration ? guards.get(declaration) : undefined
        const argument = tested ? node.arguments[tested.index] : undefined
        if (
          declaration &&
          tested &&
          argument &&
          mayBeUnchecked(argument) &&
          !node.arguments.slice(0, tested.index).some(ts.isSpreadElement) &&
          !isTopType(checker.getTypeFromTypeNode(tested.parameter.type as ts.TypeNode)) &&
          (checker.getTypeAtLocation(argument).flags & ts.TypeFlags.Any) !== 0
        ) {
          const calls = redirected.get(declaration) ?? []
          calls.push(node.expression)
          redirected.set(declaration, calls)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
    if (redirected.size === 0) continue
    const edits: Edit[] = []
    const clones: string[] = []
    const originals: number[] = []
    for (const [declaration, calls] of redirected) {
      const tested = guards.get(declaration)
      if (!tested || !declaration.name) continue
      const name = freshName(file, declaration.name.text)
      // Calls inside the guard's own body are rewritten in the clone only; the
      // typed original keeps calling itself.
      const inside = (identifier: ts.Identifier): boolean => identifier.pos >= declaration.pos && identifier.end <= declaration.end
      for (const call of calls) if (!inside(call)) edits.push({ at: call.getStart(file), end: call.end, text: name })
      const selfReferences: ts.Identifier[] = []
      const collect = (node: ts.Node): void => {
        if (ts.isIdentifier(node) && !ts.isShorthandPropertyAssignment(node.parent) && guardAt(node) === declaration)
          selfReferences.push(node)
        ts.forEachChild(node, collect)
      }
      if (declaration.type) collect(declaration.type)
      if (declaration.body) collect(declaration.body)
      clones.push(cloneText(file, declaration, tested.parameter, name, selfReferences))
      originals.push(declaration.name.getStart(file))
    }
    const shiftOf = (offset: number): number =>
      edits.reduce((shift, edit) => (edit.end <= offset ? shift + edit.text.length - (edit.end - edit.at) : shift), 0)
    let text = file.text
    for (const edit of [...edits].sort((left, right) => right.at - left.at))
      text = `${text.slice(0, edit.at)}${edit.text}${text.slice(edit.end)}`
    const fileName = resolve(file.fileName)
    sourceText.set(fileName, `${text}${clones.join('')}`)
    originalNames.set(
      fileName,
      originals.map((offset) => offset + shiftOf(offset))
    )
  }
  return { sourceText, originalNames }
}

/** Whether a diagnostic is the unused-declaration report at a guard this pass left without callers. */
export const isUncheckedGuardCopyArtifact = (diagnostic: ts.Diagnostic, originalNames: ReadonlyMap<string, readonly number[]>): boolean =>
  unusedDeclarationCodes.has(diagnostic.code) &&
  diagnostic.file !== undefined &&
  diagnostic.start !== undefined &&
  (originalNames.get(resolve(diagnostic.file.fileName))?.includes(diagnostic.start) ?? false)
