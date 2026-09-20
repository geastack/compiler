import ts from 'typescript'
import { semanticResultId, type StructuralTypeId } from '../../../identity/ids.js'
import type { SemanticEdge } from '../../model/edges.js'
import { normalCompletion, pureEffects, type OperandSource } from '../../model/operands.js'
import type { PropertyOperation } from '../../model/operations.js'
import type { CensusCandidate } from '../census.js'
import type { ProducerContext } from '../producer-context.js'
import { declaredClosedTupleRestElementsOf } from '../parameter-slot.js'
import { resolveExpressionOperand } from './boundary.js'
import { mintOperationId, mintResult, operand } from './mint.js'
import { resultEdge } from './shared.js'

/**
 * `...t` where `t` is a closed tuple: N positional reads, no iterator.
 *
 * A tuple is the one iterable whose iteration is settled before the program
 * runs. Its length is part of its type and each position carries its own
 * declared type, so `f(...pair)` is `f(pair[0], pair[1])` and `[...pair, x]`
 * is `[pair[0], pair[1], x]` -- exactly, not approximately. Driving
 * GetIterator/next() over it would ask the runtime to rediscover an arity the
 * checker already stated, and would hand every position the *union* of the
 * tuple's element types (`protocol.ts`'s `iterationElementType` has no other
 * answer to give for a per-step value), losing the per-position typing that
 * makes a tuple a tuple.
 *
 * The reads are minted as ordinary `[[Get]]`s with constant keys, which is
 * what a tuple position IS in this compiler: `lower-allocation.ts`'s
 * `lowerTupleLiteral` writes position `n` into the record field keyed
 * `String(n)`, and `lower-destructuring.ts`'s `lowerTuplePatternRead` already
 * reads one back with this identical shape. Minting a property operation
 * rather than expanding inside a lowering is what keeps the expansion visible
 * to every layer that has an opinion about a read: the representation plan
 * selects a carrier for each position's own result, `preflight/property-access.ts`
 * records a `property-access:<carrier>:get:false` obligation per read, and
 * `preflight/invocation-arguments.ts` / `array-literal-elements.ts` record the
 * conversion obligation for each expanded operand. An IR-level expansion would
 * be invisible to all four and would certify a program whose reads nothing
 * proved.
 *
 * Cross-family minting under one candidate is the established shape here --
 * `control.ts` mints `protocol` operations for a loop candidate,
 * `invocations.ts` mints the `reference`/`binding` pair `super(...)` needs --
 * and `contribution.ts` attributes each minted operation to its own family's
 * coverage rather than to the candidate's.
 */

/** One expanded position: the result to cite and the type that position carries. */
export interface TupleSpreadPosition {
  readonly source: OperandSource
  readonly type: StructuralTypeId
}

export interface TupleSpreadReads {
  readonly operations: readonly PropertyOperation[]
  readonly edges: readonly SemanticEdge[]
  /** One entry per tuple position, in position order. */
  readonly positions: readonly TupleSpreadPosition[]
}

/**
 * The per-position types of a tuple whose arity is closed, or `null` for
 * anything else.
 *
 * `optional`/`rest`/`variadic` elements are each a reason the arity is NOT
 * settled -- `[number, ...string[]]` has no compile-time length, and
 * `[number, string?]` has two possible ones -- so a tuple carrying any of them
 * is not admitted here and falls through to whatever its caller's general path
 * is. This is the same closed-arity requirement `lowerTupleLiteral`'s own
 * `layout.length !== operands.length` check enforces one layer down, asked
 * before the operands are built rather than after.
 */
export const closedTupleElementTypesOf = (context: ProducerContext, type: StructuralTypeId): readonly StructuralTypeId[] | null => {
  const shape = context.table.get(type).shape
  if (shape.kind !== 'tuple') return null
  if (shape.elements.some((element) => element.optional || element.rest || element.variadic)) return null
  return shape.elements.map((element) => element.type)
}

/**
 * An OPEN-ENDED tuple a spread can still settle positionally: `k` required
 * positions followed by exactly one `rest` element and nothing after it --
 * `[DiagnosticMessage, ...DiagnosticArguments]`. The fixed positions expand
 * to `[[Get]]`s like a closed tuple's (`mintPositionalSpreadReads`), and the
 * tail is a range copy from `fixed.length` into the callee's rest array,
 * which is exactly what the language's own iteration would hand it. An
 * optional position before the rest, or a variadic position, has no such
 * split and stays `null`.
 */
export const openTupleSpreadShapeOf = (
  context: ProducerContext,
  type: StructuralTypeId
): { readonly fixed: readonly StructuralTypeId[]; readonly tail: StructuralTypeId } | null => {
  const shape = context.table.get(type).shape
  if (shape.kind !== 'tuple') return null
  const rest = shape.elements.findIndex((element) => element.rest)
  if (rest < 0 || rest !== shape.elements.length - 1) return null
  const fixed = shape.elements.slice(0, rest)
  if (fixed.some((element) => element.optional || element.rest || element.variadic)) return null
  const tail = shape.elements[rest]
  if (!tail || tail.variadic) return null
  return { fixed: fixed.map((element) => element.type), tail: tail.type }
}

/** Whether `...expression`'s own source is a closed tuple, asked without minting anything. */
export const isClosedTupleSpread = (context: ProducerContext, expression: ts.Expression): boolean =>
  closedTupleElementTypesOf(context, context.types.typeAt(expression)) !== null

/**
 * The arity a REST PARAMETER spread expands to when the parameter's own
 * declared type is a CLOSED tuple, or `null` for anything else.
 *
 * `/** @param {[number, number, number, number, number]} args *\/ function
 * texStorage2D( ...args ) { gl.texStorage2D( ...args ) }` -- three's
 * `WebGLState.js` as the native-webgl-angle plugin rewrites its
 * `...arguments` forwarders. The parameter's CELL is typed by
 * `structural.ts`'s `rest-parameter-array-element` form from call-site
 * evidence, an array of the joined argument types, so `isClosedTupleSpread`
 * above never sees a tuple and the spread fell through to the range-copy
 * refusal ("can only be range-copied into a rest parameter") against a host
 * function with five named formals. The cell's type is right -- the rest slot
 * materializes an array -- but the DECLARATION states its length: every
 * position required, no optional, rest or variadic element, and the checker
 * refuses any call site that passes a different count. That is exactly the
 * fact a closed tuple LOCAL supplies, asked of the declaration instead of the
 * cell; the reads it admits are ordinary constant-index `[[Get]]`s off the
 * array the cell holds (`declaredTupleRestSpreadReads`).
 *
 * Only an ARRAY-shaped cell qualifies: a parameter this compiler settled to
 * anything else has a different carrier, and a constant-index read against it
 * would be a claim this producer cannot check.
 */
const declaredTupleRestElementsOf = (context: ProducerContext, expression: ts.Expression): readonly ts.Type[] | null => {
  if (!ts.isIdentifier(expression)) return null
  const symbol = context.checker.getSymbolAtLocation(expression)
  const declaration = symbol ? context.identities.declarationOfSymbol(symbol) : null
  if (!declaration || !ts.isParameter(declaration)) return null
  const elements = declaredClosedTupleRestElementsOf(context.checker, declaration)
  if (elements === null) return null
  return context.table.get(context.types.typeAt(expression)).shape.kind === 'array' ? elements : null
}

export const declaredTupleRestArityOf = (context: ProducerContext, expression: ts.Expression): number | null =>
  declaredTupleRestElementsOf(context, expression)?.length ?? null

/**
 * The positional reads a declared-tuple rest parameter spread expands to
 * (`declaredTupleRestArityOf`), each typed as the DECLARED tuple's own
 * position -- not as the array cell's element. The cell holds the join of
 * every position (`[string, number, number]` is an array of `string | number`),
 * and a read typed by that join handed `describe( name, x, y )` a
 * `string | number` for `x`, which made `x * y` a dynamic multiplication with
 * no C++ spelling. The declaration is what fixes the value at each position,
 * and a closed tuple LOCAL's reads are typed the same way off the same
 * tagged-union carrier.
 */
export const declaredTupleRestSpreadReads = (
  context: ProducerContext,
  candidate: CensusCandidate,
  expression: ts.Expression
): TupleSpreadReads | null => {
  const elements = declaredTupleRestElementsOf(context, expression)
  if (elements === null) return null
  const receiver = spreadReceiverOf(context, expression)
  if (!receiver) return null
  return mintPositionalSpreadReads(
    context,
    candidate,
    receiver,
    elements.map((element) => context.types.typeOf(element))
  )
}

/**
 * The receiver both expansions below read positions off: `resolveExpressionOperand`'s
 * own VALUE identity (which family published this expression's result --
 * correctly resolved past an `as`/`satisfies`/`<T>` wrapper, since none of
 * those own a runtime operation of their own), paired with the TYPE asked
 * directly at `expression`, exactly as `isClosedTupleSpread`/
 * `admitsMaxArityTupleSpread` (`spread-arguments.ts`) already ask it -- not
 * `resolveExpressionOperand`'s own bundled `.type`, which asks past the same
 * wrapper for the type too and disagrees with both admission gates the
 * moment one is present. `args as Parameters<NewResponse>` (hono's
 * `Context.newResponse`) is the concrete case: the CAST states a real closed
 * shape the underlying `args` binding does not have on its own (an ordinary,
 * open-arity array, once the rest-parameter census has done its job) -- an
 * admission gate that reads the cast agrees to expand it, and an expansion
 * that then reads past the cast right back to the array finds no tuple
 * there and refuses, silently, for an admission that already said yes.
 * `local-bindings.ts`'s `knownOrResolve` draws this identical line for a
 * cast ("the checker's own answer there is taken as-is and never read
 * past"); this is that same rule, asked with the SAME node the two
 * admission gates already use, so the three can only ever agree.
 */
export const spreadReceiverOf = (
  context: ProducerContext,
  expression: ts.Expression
): { readonly source: OperandSource; readonly type: StructuralTypeId } | null => {
  const resolved = resolveExpressionOperand(context, expression)
  return resolved ? { source: resolved.source, type: context.types.typeAt(expression) } : null
}

/**
 * The `[[Get]]`s a tuple's positions expand to, shared by every admission
 * shape below -- each differs only in WHICH element types it is sound to ask
 * for, never in how a position, once admitted, is read.
 *
 * The receiver is cited ONCE and read N times, which is what the language
 * does: `f(...sideEffect())` evaluates `sideEffect()` a single time and then
 * indexes the result. Citing the expression per position instead would name
 * the same published result N times, which is harmless, but building the
 * operand once makes that single evaluation explicit rather than incidental.
 */
export const mintPositionalSpreadReads = (
  context: ProducerContext,
  candidate: CensusCandidate,
  receiver: { readonly source: OperandSource; readonly type: StructuralTypeId },
  elements: readonly StructuralTypeId[],
  firstIndex = 0
): TupleSpreadReads => {
  // A tuple position's key is a String, the same way every other static key in
  // this compiler is: `properties.ts`'s `keyOf` interns exactly this type for
  // `o[0]`, on the grounds that ToPropertyKey turns a numeric index into a
  // String and two spellings of one key must not look like two keys.
  const keyType = context.table.intern({ kind: 'primitive', primitive: 'string' })
  const operations: PropertyOperation[] = []
  const edges: SemanticEdge[] = []
  const positions: TupleSpreadPosition[] = []
  for (const [offset, elementType] of elements.entries()) {
    const index = firstIndex + offset
    const id = mintOperationId(context.ordinals, candidate.id, 'property')
    operations.push({
      id,
      family: 'property',
      internalMethod: 'get',
      strict: true,
      keyIsComputed: false,
      // A read consults whatever descriptor is installed; it states none.
      descriptor: null,
      caller: candidate.caller,
      operands: [
        operand('receiver', 0, receiver.source, receiver.type),
        operand('key', 0, { kind: 'constant', text: String(index), literal: 'string' }, keyType)
      ],
      results: [mintResult(id, 'value', elementType)],
      // A tuple type excludes `null`/`undefined` by construction, so the read
      // cannot be the nullish-receiver TypeError an ordinary `[[Get]]` guards
      // against, and a tuple position is native storage rather than an
      // accessor, so nothing user-written runs here either.
      completion: normalCompletion,
      effects: { ...pureEffects, readsMutableState: true },
      evaluationOrdinal: candidate.evaluationOrdinal
    })
    const edge = resultEdge(receiver.source, id, 'receiver', 0)
    if (edge) edges.push(edge)
    positions.push({ source: { kind: 'result', result: semanticResultId(id, 'value') }, type: elementType })
  }
  return { operations, edges, positions }
}

/**
 * The positional reads `...expression` expands to, or `null` when the source
 * is not a closed tuple or when no operation publishes its value.
 */
export const tupleSpreadReads = (
  context: ProducerContext,
  candidate: CensusCandidate,
  expression: ts.Expression
): TupleSpreadReads | null => {
  const receiver = spreadReceiverOf(context, expression)
  if (!receiver) return null
  const elements = closedTupleElementTypesOf(context, receiver.type)
  if (!elements) return null
  return mintPositionalSpreadReads(context, candidate, receiver, elements)
}

/**
 * The per-position types of a tuple whose only "unsettled" elements are a
 * trailing OPTIONAL run, or `null` for anything else -- including a `rest`/
 * `variadic` element, which still has no settled arity at all.
 *
 * `closedTupleElementTypesOf` above is right to refuse an optional-tailed
 * tuple for its own callers: a spread's DESTINATION cares about the source's
 * true runtime LENGTH (`[...t]` with `t.length === 1` must allocate a
 * one-element array, not `[t[0], undefined]`), and expanding to the tuple's
 * full declared arity would silently manufacture a longer collection than the
 * source ever had. `maxArityTupleSpreadReads` is the one context where a
 * fixed-at-declared-arity expansion is still exact rather than approximate --
 * see it for why.
 *
 * The type widening happens HERE, at the element, rather than being layered
 * onto every read: `t[i]` for an absent optional position `i` already reads
 * `undefined` by ordinary out-of-bounds `[[Get]]`, so the element's own type
 * has to say so, exactly the way `parameter-slot.ts`'s `parameterSlotTypeOf`
 * widens an optional PARAMETER's slot with `undefined` for the same reason.
 * The union is flattened rather than nested -- a member that is already a
 * union has its own members spliced in -- because only a flat union derives
 * to this compiler's three-armed optional carrier (`parameter-slot.ts`'s own
 * comment states why a nested one would not).
 */
export const maxArityTupleElementTypesOf = (context: ProducerContext, type: StructuralTypeId): readonly StructuralTypeId[] | null => {
  const shape = context.table.get(type).shape
  if (shape.kind !== 'tuple') return null
  if (shape.elements.some((element) => element.rest || element.variadic)) return null
  return shape.elements.map((element) => (element.optional ? widenedWithUndefined(context, element.type) : element.type))
}

const widenedWithUndefined = (context: ProducerContext, type: StructuralTypeId): StructuralTypeId => {
  const undefinedType = context.table.intern({ kind: 'primitive', primitive: 'undefined' })
  if (type === undefinedType) return type
  const shape = context.table.get(type).shape
  if (shape.kind === 'union') {
    return shape.members.includes(undefinedType)
      ? type
      : context.table.intern({ kind: 'union', members: [...shape.members, undefinedType] })
  }
  return context.table.intern({ kind: 'union', members: [type, undefinedType] })
}

/**
 * `...expression`'s positional reads, over an OPTIONAL-tailed tuple, for the
 * one context where that is still sound: a CALL ARGUMENT, where an omitted
 * argument and an explicitly `undefined` one read identically at the callee.
 *
 * Ordinary JS parameter binding makes that true unconditionally: an omitted
 * argument binds `undefined` (ECMA-262 `FunctionDeclarationInstantiation` /
 * `IteratorBindingInitialization` over a shorter argument list), and a
 * defaulted parameter's initializer triggers on `undefined` however it
 * arrived -- there is no third state a NAMED, non-rest parameter can
 * observe. So `f(...t)` with `t: [A, B?]` reads IDENTICALLY at the callee
 * whether `t`'s true runtime length is 1 or 2, PROVIDED:
 *
 *  - the callee has no REST formal anywhere the tuple's positions could
 *    land -- a rest parameter's own `.length` DOES observe the caller's true
 *    argument count, which this fixed-at-declared-arity expansion cannot
 *    track;
 *  - nothing else follows this spread in the argument list -- a written
 *    argument after it would land at a position that shifts with the
 *    tuple's TRUE length, which only the real spread ever knows.
 *
 * Both conditions are the CALLER's to check (`spread-arguments.ts`'s
 * `restFrom` and its own last-argument scan) -- this function only expands
 * the positions, exactly as `tupleSpreadReads` does for a closed tuple.
 */
export const maxArityTupleSpreadReads = (
  context: ProducerContext,
  candidate: CensusCandidate,
  expression: ts.Expression
): TupleSpreadReads | null => {
  const receiver = spreadReceiverOf(context, expression)
  if (!receiver) return null
  const elements = maxArityTupleElementTypesOf(context, receiver.type)
  if (!elements) return null
  return mintPositionalSpreadReads(context, candidate, receiver, elements)
}
