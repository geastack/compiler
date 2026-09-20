import ts from 'typescript'
import { disjointUnionTypeOf, joinOfWrites } from './derived-expression-type.js'
import {
  enclosingArgumentsFunction,
  implicitArgumentsSlotOf,
  isArgumentsObjectIdentifier,
  type ImplicitArgumentsSlot
} from './implicit-arguments.js'

/**
 * What the magic `arguments` frame of one source function holds, owned by the
 * parameter census and read by every consumer of that frame: the structural
 * mapper's phantom rest slot (`structural-parts.ts`), numeric reads of the
 * object (`implicitArgumentsReadTypeAt`), and the positional expansion of a
 * forwarded `...arguments` (`producers/spread-arguments.ts`).
 *
 * Two frames, chosen by how the body reads the object:
 *
 * - `tuple`: every read names a FIXED position -- a literal index, or a final
 *   `...arguments` spread into a callee convention with no rest formal, which
 *   reads positions `0..n-1` exactly. Each position is then its own fact,
 *   joined over the closed callers that fill it. This is the shape three's
 *   WebGL forwarding shims need: `texImage3D()` is called with numbers in its
 *   leading positions and `ArrayBufferView | null` in its last, and one element
 *   type over all ten positions could only be a union no caller wrote.
 *   Positions from `required` on are ones some closed caller omits, so they
 *   are optional: a read there is `T | undefined`, and the rest slot leaves
 *   the field absent rather than inventing a value.
 * - `array`: the body reads a position only known at run time
 *   (`arguments[i]`, `arguments.length`), reads its own element back through
 *   a recursive call, or declares parameters in front of the phantom slot.
 *   The frame is then a runtime-sized Array of one element type joined over
 *   every supplied position -- the frame this fact published before positions
 *   existed.
 */
export type ImplicitArgumentsTuple =
  | { readonly frame: 'tuple'; readonly elements: readonly ts.Type[]; readonly required: number }
  | { readonly frame: 'array'; readonly element: ts.Type }

/** The one convention fact the fixed-spread admission reads off a callee. */
export interface ArgumentsSpreadConvention {
  /** The callee's rest formal, or `null` when it declares none. */
  readonly restFrom: number | null
}

/**
 * Whether `args[index]` is a final magic-`arguments` spread into a callee
 * with a static convention and no rest formal.
 *
 * Such a spread fills the callee's formals POSITIONALLY: the frame's values
 * land at `0..n-1` exactly as a written argument list would, and a formal no
 * value reaches binds `undefined` the way an omitted argument does. It must be
 * the LAST argument, or a later written argument would land at a position only
 * the frame's runtime length knows; the callee must declare no rest formal, or
 * the split between named formals and the packed tail would be that same
 * runtime fact. `convention === null` is a callee with no static convention at
 * all, which states nothing to fill positionally.
 *
 * Shared by the census (which admits the spread as a read-only use of the
 * frame) and the producer (which mints one read per position): the two
 * deciding separately is how an admitted use would meet a refused expansion.
 */
export const isFixedArgumentsSpreadAt = (
  checker: ts.TypeChecker,
  args: readonly ts.Expression[],
  index: number,
  convention: ArgumentsSpreadConvention | null
): boolean => {
  const argument = args[index]
  return !!(
    argument &&
    ts.isSpreadElement(argument) &&
    index === args.length - 1 &&
    convention !== null &&
    convention.restFrom === null &&
    isArgumentsObjectIdentifier(argument.expression, checker)
  )
}

/**
 * The census-side convention of the callee a `...arguments` spread reaches:
 * the checker's resolved signature, with its rest formal where the producer's
 * `SelectedSignature` finds one (a parameter written with `...`). A callee
 * that is itself an `arguments` shim carries the checker's phantom rest slot,
 * which has no declaration to spell `...` but is a rest formal all the same
 * (`structural-parts.ts` publishes it as one), so a shim-to-shim spread is not
 * a fixed fill. No declaration at all is the producer's `selected === null`.
 */
const spreadConventionAt = (checker: ts.TypeChecker, call: ts.CallExpression | ts.NewExpression): ArgumentsSpreadConvention | null => {
  const signature = checker.getResolvedSignature(call)
  if (!signature?.declaration) return null
  const written = signature.getParameters().findIndex((parameter) => {
    const declaration = parameter.valueDeclaration
    return declaration !== undefined && ts.isParameter(declaration) && declaration.dotDotDotToken !== undefined
  })
  return { restFrom: written >= 0 ? written : (implicitArgumentsSlotOf(signature)?.ordinal ?? null) }
}

/** The fixed position a numeric element read names, or `null` for a position only known at run time. */
const fixedPositionOf = (checker: ts.TypeChecker, access: ts.ElementAccessExpression): number | null => {
  const key = checker.getTypeAtLocation(access.argumentExpression)
  const value = key.isNumberLiteral()
    ? key.value
    : key.isStringLiteral() && key.value !== '' && String(Number(key.value)) === key.value
      ? Number(key.value)
      : null
  return value !== null && Number.isInteger(value) && value >= 0 ? value : null
}

/**
 * How one use of the frame reads it, with the expression that reads it, or
 * `null` when the object escapes the reads this fact can describe.
 */
const useOf = (
  checker: ts.TypeChecker,
  use: ts.Identifier
): { readonly read: 'fixed' | 'indexed'; readonly access: ts.Expression } | null => {
  const access = use.parent
  if (ts.isElementAccessExpression(access) && access.expression === use)
    return { read: fixedPositionOf(checker, access) === null ? 'indexed' : 'fixed', access }
  if (ts.isPropertyAccessExpression(access) && access.expression === use && access.name.text === 'length')
    return { read: 'indexed', access }
  if (ts.isSpreadElement(access) && access.expression === use) {
    const call = access.parent
    if ((ts.isCallExpression(call) || ts.isNewExpression(call)) && call.arguments) {
      const args = call.arguments
      if (isFixedArgumentsSpreadAt(checker, args, args.indexOf(access), spreadConventionAt(checker, call))) return { read: 'fixed', access }
    }
  }
  return null
}

export interface ImplicitArgumentsEvidence {
  readonly checker: ts.TypeChecker
  readonly owner: ts.SignatureDeclaration
  readonly slot: ImplicitArgumentsSlot
  /** Every reference to the owner's own `arguments` frame. */
  readonly uses: readonly ts.Identifier[]
  /** The owner's closed call sites; the census has already proved the set closed. */
  readonly calls: readonly (ts.CallExpression | ts.NewExpression)[]
  /** The arguments a call site passes, after the census's explicit-`this` rewrite. */
  readonly argumentsOf: (call: ts.CallExpression | ts.NewExpression) => readonly ts.Expression[]
  /** Whether the shared write inventory names this node as a write target. */
  readonly isWritten: (node: ts.Expression) => boolean
  readonly isRecursiveCall: (call: ts.CallExpression | ts.NewExpression) => boolean
  /** The settled type an argument holds, or `null` when it states nothing usable. */
  readonly argumentTypeOf: (argument: ts.Expression) => ts.Type | null
  /** The owner's own declared parameter types that state a usable upper bound. */
  readonly statedElements: readonly ts.Type[]
}

export type ImplicitArgumentsInference =
  { readonly tuple: ImplicitArgumentsTuple } | { readonly refused: string; readonly evidence?: ts.Node }

/**
 * The frame fact for one owner, from its uses and its closed callers.
 *
 * Never inferred from only the callers that happened to type: one caller
 * whose argument states nothing refuses the whole frame, because the frame is
 * what EVERY caller fills.
 */
export const inferImplicitArgumentsTuple = (evidence: ImplicitArgumentsEvidence): ImplicitArgumentsInference => {
  const { checker, owner, slot, uses } = evidence
  let indexed = slot.ordinal > 0
  for (const use of uses) {
    // A lexical arguments capture needs a frame identity shared with its
    // outer function; a local ordinal alone cannot establish that identity.
    for (let parent = use.parent; parent !== owner; parent = parent.parent) {
      if (ts.isArrowFunction(parent)) return { refused: 'implicit-arguments-lexical-capture' }
    }
    const reading = useOf(checker, use)
    if (reading === null) return { refused: 'implicit-arguments-object-escapes' }
    if (reading.read === 'indexed') indexed = true
    // The shared write inventory already includes parenthesized targets,
    // destructuring, updates, loops and deletes. Do not invent a second
    // assignment classifier for this one binding.
    if (evidence.isWritten(use) || evidence.isWritten(reading.access)) return { refused: 'implicit-arguments-mutated' }
  }
  if (evidence.calls.length === 0) return { refused: 'implicit-arguments-no-callers' }
  const passed: ts.Type[] = []
  const positions: ts.Type[][] = []
  let required = Number.POSITIVE_INFINITY
  let readsOwnElement = false
  for (const call of evidence.calls) {
    const args = evidence.argumentsOf(call)
    if (args.length < slot.ordinal) return { refused: 'implicit-arguments-omitted-prefix' }
    if (args.some(ts.isSpreadElement)) return { refused: 'implicit-arguments-spread-caller' }
    required = Math.min(required, args.length)
    for (const [position, argument] of args.entries()) {
      // This back edge only selects an existing element, or undefined.
      // Solve T = join(external writes, T | undefined) from independent
      // seeds, never from the prior round's answer to its own cycle.
      if (
        evidence.isRecursiveCall(call) &&
        ts.isElementAccessExpression(argument) &&
        isArgumentsObjectIdentifier(argument.expression, checker) &&
        enclosingArgumentsFunction(argument.expression) === owner &&
        (checker.getTypeAtLocation(argument.argumentExpression).flags & ts.TypeFlags.NumberLike) !== 0
      ) {
        readsOwnElement = true
        continue
      }
      const type = evidence.argumentTypeOf(argument)
      if (!type) return { refused: 'implicit-arguments-unresolved-caller', evidence: argument }
      const widened = type.isLiteral() ? checker.getBaseTypeOfLiteralType(type) : type
      passed.push(widened)
      ;(positions[position] ??= []).push(widened)
    }
  }
  if (passed.length === 0) return { refused: 'implicit-arguments-no-element-evidence' }
  if (!indexed && !readsOwnElement) {
    // Phantom ordinal 0, so the owner declares no parameter to state a bound:
    // each position is exactly the join of what its callers write there.
    const elements: ts.Type[] = []
    for (const [position, written] of Array.from(positions, (entry) => entry ?? []).entries()) {
      const element = written.length > 0 ? (joinOfWrites(checker, written) ?? disjointUnionTypeOf(checker, written)) : null
      if (!element) return { refused: 'implicit-arguments-disjoint-position' }
      elements[position] = element
    }
    return { tuple: { frame: 'tuple', elements, required: Math.min(required, elements.length) } }
  }
  // An annotation can supply a common upper bound absent from the
  // observed subclasses. It is only a candidate: every supplied position,
  // including extra arguments, must fit it through the same write join.
  const element =
    joinOfWrites(checker, passed) ??
    evidence.statedElements.map((stated) => joinOfWrites(checker, [...passed, stated])).find((joined) => joined !== null) ??
    disjointUnionTypeOf(checker, passed)
  return element
    ? { tuple: { frame: 'array', element: readsOwnElement ? checker.getNullableType(element, ts.TypeFlags.Undefined) : element } }
    : { refused: 'implicit-arguments-disjoint-elements' }
}

/** One element read's type out of a settled frame: `index === null` is a position only known at run time. */
export const implicitArgumentsElementTypeOf = (
  checker: ts.TypeChecker,
  tuple: ImplicitArgumentsTuple,
  index: number | null
): ts.Type | null => {
  if (tuple.frame === 'array') return checker.getNullableType(tuple.element, ts.TypeFlags.Undefined)
  // A tuple frame is only ever settled for a body whose reads all name a fixed position.
  if (index === null) return null
  const element = tuple.elements[index]
  if (element === undefined) return checker.getUndefinedType()
  return index >= tuple.required ? checker.getNullableType(element, ts.TypeFlags.Undefined) : element
}

/** Every numeric read consumes the owning frame's fact, including reads published to sibling censuses. */
export const implicitArgumentsReadTypeAt = (
  checker: ts.TypeChecker,
  node: ts.Node,
  tupleAt: (owner: ts.Node) => ImplicitArgumentsTuple | null
): ts.Type | null => {
  if (!ts.isElementAccessExpression(node) || !isArgumentsObjectIdentifier(node.expression, checker)) return null
  const key = checker.getTypeAtLocation(node.argumentExpression)
  const numericKey =
    (key.flags & ts.TypeFlags.NumberLike) !== 0 ||
    (key.isStringLiteral() && key.value !== '' && String(Number(key.value)) === key.value && Number.isInteger(Number(key.value)))
  if (!numericKey) return null
  const owner = enclosingArgumentsFunction(node.expression)
  const tuple = owner ? tupleAt(owner) : null
  return tuple ? implicitArgumentsElementTypeOf(checker, tuple, fixedPositionOf(checker, node)) : null
}

/** Two settled frame facts state the same frame: the fixpoint's identity test for this query. */
export const sameImplicitArgumentsTuple = (left: ImplicitArgumentsTuple, right: ImplicitArgumentsTuple): boolean => {
  if (left.frame === 'array' || right.frame === 'array') {
    return left.frame === 'array' && right.frame === 'array' && left.element === right.element
  }
  return (
    left.required === right.required &&
    left.elements.length === right.elements.length &&
    left.elements.every((element, index) => element === right.elements[index])
  )
}
