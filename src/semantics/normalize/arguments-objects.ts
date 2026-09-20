import ts from 'typescript'
import { enclosingArgumentsFunction, implicitArgumentsSlotOf, isArgumentsObjectIdentifier } from './implicit-arguments.js'

/**
 * Which identifiers in this program are the magic `arguments` binding, and
 * what shape each one's value takes.
 *
 * The question is semantic -- it needs a `ts.TypeChecker`, because the only
 * thing that distinguishes the magic binding from an ordinary variable
 * someone named `arguments` is that its symbol declares nothing anywhere
 * (`isArgumentsObjectIdentifier`, `producers/bindings.ts`). The layer that
 * has to ask it is not: `references.ts`'s `citeExpressionResult` is a pure
 * predictor over syntax and identities, and threading a checker into it would
 * put one somewhere the architecture gate would rather it were not.
 *
 * So the checker answers once, here, and hands the citer a lookup -- exactly
 * the shape `absent-globals.ts` already uses for its own
 * checker-needs-to-answer-a-syntactic-layer question, and built beside it in
 * `frontend.ts` for the same reason.
 */
export interface ArgumentsObjectCensus {
  /** All references to each lexical arguments frame, including unsupported frames. */
  readonly usesByOwner: ReadonlyMap<ts.SignatureDeclaration, readonly ts.Identifier[]>
  /**
   * The phantom rest parameter's ordinal for an `arguments` identifier whose
   * value this compiler can build, and `null` for every other node --
   * including an `arguments` inside a function the checker published no
   * phantom for, which is a shape nothing here has confirmed the meaning of
   * and must keep failing closed rather than be guessed at.
   */
  readonly phantomOrdinalOf: (node: ts.Node) => number | null
  /** How many reference sites this census recognized, for measurement. */
  readonly count: number
}

export const emptyArgumentsObjectCensus: ArgumentsObjectCensus = { phantomOrdinalOf: () => null, usesByOwner: new Map(), count: 0 }

/**
 * One walk, one checker question per candidate identifier.
 *
 * Only identifiers spelled `arguments` are asked about at all: the predicate's
 * own first test is that spelling, so every other node would cost a symbol
 * resolution to answer `null`, and this walk runs over every source file of a
 * program the size of three.js.
 */
export const censusArgumentsObjects = (checker: ts.TypeChecker, files: readonly ts.SourceFile[]): ArgumentsObjectCensus => {
  const ordinals = new Map<ts.Node, number>()
  const usesByOwner = new Map<ts.SignatureDeclaration, ts.Identifier[]>()
  const ownerOrdinals = new Map<ts.SignatureDeclaration, number | null>()
  const visit = (node: ts.Node): void => {
    if (isArgumentsObjectIdentifier(node, checker)) {
      const owner = enclosingArgumentsFunction(node)
      if (owner) {
        let ordinal = ownerOrdinals.get(owner)
        if (ordinal === undefined) {
          const signature = checker.getSignatureFromDeclaration(owner)
          ordinal = signature ? (implicitArgumentsSlotOf(signature)?.ordinal ?? null) : null
          ownerOrdinals.set(owner, ordinal)
        }
        const uses = usesByOwner.get(owner) ?? []
        uses.push(node)
        usesByOwner.set(owner, uses)
        if (ordinal !== null) ordinals.set(node, ordinal)
      }
    }
    ts.forEachChild(node, visit)
  }
  for (const file of files) visit(file)
  return { phantomOrdinalOf: (node) => ordinals.get(node) ?? null, usesByOwner, count: ordinals.size }
}

/**
 * Whether a callable body reads its own `arguments` object, memoized per file
 * for the life of the checker.
 *
 * `sourceInvocationFrame` cannot publish a complete frame without this fact --
 * a body that reads `arguments[0]` reaches an actual argument through a cell no
 * parameter names -- and it takes the lookup as a parameter because
 * `callable-reach.ts` keys a memo on the function's identity. The census
 * itself depends on nothing but the file, so a consumer that has no such memo
 * should not have to build a fourth private cache to ask; it asks here.
 */
const censusesByChecker = new WeakMap<ts.TypeChecker, Map<ts.SourceFile, ArgumentsObjectCensus>>()
export const argumentsObjectUsesAt = (checker: ts.TypeChecker, body: ts.SignatureDeclaration): readonly ts.Identifier[] | undefined => {
  let byFile = censusesByChecker.get(checker)
  if (!byFile) censusesByChecker.set(checker, (byFile = new Map()))
  const file = body.getSourceFile()
  let census = byFile.get(file)
  if (!census) byFile.set(file, (census = censusArgumentsObjects(checker, [file])))
  return census.usesByOwner.get(body)
}
