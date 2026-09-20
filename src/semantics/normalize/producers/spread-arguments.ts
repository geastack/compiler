import ts from 'typescript'
import { operationId, semanticResultId, type StructuralTypeId } from '../../../identity/ids.js'
import type { SemanticEdge } from '../../model/edges.js'
import type { OperandEvaluation, SemanticOperand } from '../../model/operands.js'
import type { SemanticOperation } from '../../model/operations.js'
import type { SelectedSignature } from '../../model/selected-signature.js'
import { isFixedArgumentsSpreadAt } from '../implicit-arguments-tuple.js'
import type { CensusCandidate } from '../census.js'
import type { ProducerContext } from '../producer-context.js'
import { argumentsObjectValueAt, isArgumentsObjectIdentifier } from './bindings.js'
import { operand } from './mint.js'
import { hasNativeIterationCursor, sourceForValue } from './shared.js'
import { isDynamicIterationSource } from './protocol.js'
import {
  isClosedTupleSpread,
  maxArityTupleElementTypesOf,
  maxArityTupleSpreadReads,
  mintPositionalSpreadReads,
  openTupleSpreadShapeOf,
  spreadReceiverOf,
  tupleSpreadReads,
  declaredTupleRestArityOf,
  declaredTupleRestSpreadReads
} from './tuple-spread.js'

/**
 * A call's argument list, with the two spread shapes this compiler can settle
 * without an iterator.
 *
 * `f(...xs)` is `ArgumentListEvaluation`, which drives GetIterator/next() over
 * `xs` and then hands the callee however many values came out. Two source
 * shapes make the outcome of that iteration a compile-time fact instead:
 *
 * - a CLOSED TUPLE, whose arity and per-position types are part of its type.
 *   `f(...pair)` is `f(pair[0], pair[1])` exactly, so `tuple-spread.ts`
 *   expands it into one positional argument per element (see that file for
 *   why the expansion is minted as real `[[Get]]` operations rather than
 *   performed inside a lowering).
 * - a NATIVELY ITERABLE source -- a plain array, a `Set<T>`, a `Map<K, V>`, a
 *   `string` or a `Generator<T, ...>` -- landing in the callee's REST TAIL.
 *   How many values each produces is a
 *   runtime fact, so it can never be matched against NAMED formals -- but a
 *   rest parameter does not have named formals to match: the language binds
 *   the whole tail into one fresh array, and `ir/lower-operands.ts`'s
 *   `packRestArguments` already builds exactly that array at every call site.
 *   Contributing the spread's source to it as a RANGE COPY (the same
 *   `appendRange`/`appendSetRange`/`appendCodePointRange` an array literal's
 *   own admitted spread emits) makes `f(a, ...xs)` into
 *   `f(a, [.a-range-copy-of-xs.])`, which is what the language specifies, with
 *   no iterator anywhere.
 *
 * v1 (`geatsc`) admits a strict subset of the second shape --
 * `spreadRestForwardIndex` in `targets/cpp/lowering/typed-ir/responsibilities/calls.ts`
 * forwards a SOLE tail spread into the rest formal WHOLESALE, aliasing the
 * caller's array rather than copying it, and declines `f(a, ...xs, b)`
 * outright. The range copy here is the same admission with the alias removed:
 * the rest array the callee binds is specified to be a fresh Array
 * (ECMA-262 10.2.11 `FunctionDeclarationInstantiation`, step 28's
 * `CreateListFromArrayLike`-shaped `ArrayCreate`), so a callee that pushes
 * onto its own `...rest` must not be writing into the caller's array, and a
 * mixed `f(a, ...xs, b)` composes for free.
 *
 * A third shape settles without an iterator too, in one narrow position: a
 * tuple whose only unsettled elements are a trailing OPTIONAL run (never a
 * `rest`/`variadic` one), spread as the call's LAST argument into a callee
 * with NO rest formal anywhere. `tuple-spread.ts`'s `maxArityTupleSpreadReads`
 * states why that position makes "omitted" and "explicitly `undefined`"
 * indistinguishable to the callee, which is exactly what licenses reading the
 * declared arity unconditionally instead of the tuple's true runtime length.
 *
 * Everything else -- a user-defined iterable, a hand-written
 * `[Symbol.iterator]()`, an optional-tailed tuple anywhere but a call's last
 * argument or into a rest formal, a natively iterable source in a NAMED
 * formal's position -- is refused by name. None of those has a compile-time
 * arity, and inventing one is the failure mode this refusal exists to
 * prevent.
 */

/** The role a rest-tail range copy is published under, kept distinct from a positional `argument`. */
export const spreadArgumentRole = 'spread-argument'

export type ArgumentListBuild =
  | {
      readonly kind: 'operands'
      readonly operands: readonly SemanticOperand[]
      /** The `[[Get]]`s a tuple spread expanded to; published with the call that cites them. */
      readonly operations: readonly SemanticOperation[]
      readonly edges: readonly SemanticEdge[]
    }
  | { readonly kind: 'refused'; readonly reason: string }

/**
 * The index of the callee's rest formal, or `null` when it declares none.
 *
 * Read off the signature the checker already selected for THIS call rather
 * than off the callee's carrier: the carrier is a representation-layer answer
 * this layer has not reached yet, and the two agree by construction --
 * `representation/derive.ts` builds `CallableAbi.restFrom` from the same
 * declared rest parameter `SelectedSignature.parameters[i].rest` records.
 */
const restFormalIndexOf = (selected: SelectedSignature | null): number | null => {
  if (!selected) return null
  const index = selected.parameters.findIndex((parameter) => parameter.rest)
  return index >= 0 ? index : null
}

/**
 * Whether the formals between a spread's landing position and the callee's
 * rest formal are indistinguishable from the rest formal's own element.
 *
 * `console.log(...args)` is the case that matters, and the disagreement is in
 * the TYPE DECLARATIONS rather than in this compiler: `lib.dom.d.ts` declares
 * `log(...data: any[])`, so the rest begins at index 0 and a spread at
 * position 0 range-copies straight into it, while `@types/node`'s
 * `console.d.ts` declares `log(message?: any, ...optionalParams: any[])`,
 * where the rest begins at index 1 and the same spread lands one position
 * BEFORE it. Which of the two a program gets depends only on whether it pulled
 * in the DOM or the Node types; `console.log(...args)` is the same call either
 * way, and it was compiling under one and refused under the other.
 *
 * The refusal below is right in general: this compiler cannot know how many
 * values a runtime iteration produces, so it cannot say which of them fill
 * named formals and which reach the rest. That question stops mattering when
 * every formal in between is OPTIONAL and holds the same type the rest's
 * element does -- wherever the split falls, each value lands in a slot of that
 * type and the callee observes the same list. `message?: any` beside
 * `...optionalParams: any[]` is exactly that, and so is every other
 * `f(first?: T, ...rest: T[])` written to give the leading argument a name.
 *
 * Optionality is load-bearing and not decoration: a REQUIRED leading formal
 * means the callee is entitled to an argument the spread might not produce
 * (`[...[]]` yields none), so the arity question is real again even when the
 * types match.
 */
const restAbsorbsLeadingFormals = (context: ProducerContext, selected: SelectedSignature, from: number, restFrom: number): boolean => {
  const rest = selected.parameters[restFrom]
  if (rest === undefined) return false
  const restShape = context.table.get(rest.type).shape
  if (restShape.kind !== 'array') return false
  for (let index = from; index < restFrom; index += 1) {
    const parameter = selected.parameters[index]
    if (parameter === undefined || !parameter.optional || parameter.rest) return false
    if (parameter.type !== restShape.element) return false
  }
  return true
}

/**
 * Whether the spread argument at `index` may read its optional-tailed
 * tuple's positions at the tuple's DECLARED (maximum) arity -- see
 * `tuple-spread.ts`'s `maxArityTupleSpreadReads` for why that is exact rather
 * than approximate here specifically.
 *
 * `selected !== null` keeps this to callees this compiler already checked a
 * static convention for -- the same ground `positionsOccupiedBy`'s caller
 * uses elsewhere in this file -- and `index === args.length - 1` is what
 * keeps a following written argument from landing at a position only the
 * tuple's true runtime length would know.
 */
const admitsMaxArityTupleSpread = (
  context: ProducerContext,
  args: readonly ts.Expression[],
  index: number,
  restFrom: number | null,
  selected: SelectedSignature | null
): boolean => {
  const argument = args[index]
  if (!argument || !ts.isSpreadElement(argument) || selected === null || restFrom !== null || index !== args.length - 1) return false
  return maxArityTupleElementTypesOf(context, context.types.typeAt(argument.expression)) !== null
}

/**
 * How many argument-list positions one written argument occupies.
 *
 * A closed tuple occupies its own arity; everything else occupies one. Needed
 * BEFORE the operands are built, because whether a plain-array spread is
 * admissible depends on the position it lands in, and that position depends on
 * how many positions the arguments before it expanded to.
 */
const positionsOccupiedBy = (context: ProducerContext, argument: ts.Expression): number => {
  if (!ts.isSpreadElement(argument)) return 1
  const type = context.types.typeAt(argument.expression)
  const open = openTupleSpreadShapeOf(context, type)
  if (open !== null) return open.fixed.length + 1
  const declaredRest = declaredTupleRestArityOf(context, argument.expression)
  if (declaredRest !== null) return declaredRest
  const shape = context.table.get(type).shape
  return shape.kind === 'tuple' ? shape.elements.length : 1
}

/**
 * Whether an open-ended tuple spread at `scan` lands its range-copied tail
 * at or past the callee's rest slot -- the same admission the plain-array
 * spread below needs, asked of the tail alone, because the fixed positions
 * before it are read explicitly and land wherever named formals do.
 */
const admitsOpenTupleSpread = (
  context: ProducerContext,
  argument: ts.Expression,
  scan: number,
  restFrom: number | null,
  selected: SelectedSignature | null
): boolean => {
  if (!ts.isSpreadElement(argument)) return false
  const open = openTupleSpreadShapeOf(context, context.types.typeAt(argument.expression))
  if (open === null) return false
  return selected === null || (restFrom !== null && scan + open.fixed.length >= restFrom)
}

/** A final magic `arguments` spread can fill a fixed signature positionally. */
const admitsFixedArgumentsSpread = (
  context: ProducerContext,
  args: readonly ts.Expression[],
  index: number,
  restFrom: number | null,
  selected: SelectedSignature | null
): boolean => isFixedArgumentsSpreadAt(context.checker, args, index, selected === null ? null : { restFrom })

export const buildArgumentOperands = (
  context: ProducerContext,
  candidate: CensusCandidate,
  args: readonly ts.Expression[],
  evaluation: OperandEvaluation,
  selected: SelectedSignature | null,
  shortCircuits: boolean
): ArgumentListBuild => {
  const spreads = args.filter(ts.isSpreadElement)
  if (spreads.length > 0 && shortCircuits) {
    // An optional call evaluates its arguments only on the branch where the
    // guard is present, and `normalize/gating.ts` places that gated region by
    // walking the ARGUMENT SYNTAX. Both admitted shapes here publish something
    // that walk cannot see -- a tuple expansion mints `[[Get]]`s against this
    // CALL's candidate, and a rest range copy changes which operand holds the
    // tail -- so the placement would be made on a claim this producer cannot
    // support. Gating a minted operation is a real capability, not a detail to
    // assume.
    return {
      kind: 'refused',
      reason: 'a spread argument in an optional call needs the gated placement of a minted read, which is not installed'
    }
  }

  const restFrom = restFormalIndexOf(selected)
  // Which positions each written argument will occupy, walked once up front so
  // a spread's own admissibility can be decided against the position it lands
  // in rather than against where it was written.
  let scan = 0
  for (const [scanIndex, argument] of args.entries()) {
    if (
      ts.isSpreadElement(argument) &&
      openTupleSpreadShapeOf(context, context.types.typeAt(argument.expression)) !== null &&
      !admitsOpenTupleSpread(context, argument, scan, restFrom, selected)
    ) {
      return {
        kind: 'refused',
        reason:
          'a spread of an open-ended tuple range-copies its rest tail, which can only land in a rest parameter; ' +
          'this call has no rest formal at or before the position the tail reaches'
      }
    }
    if (
      ts.isSpreadElement(argument) &&
      !isClosedTupleSpread(context, argument.expression) &&
      declaredTupleRestArityOf(context, argument.expression) === null &&
      !admitsOpenTupleSpread(context, argument, scan, restFrom, selected) &&
      !admitsMaxArityTupleSpread(context, args, scanIndex, restFrom, selected) &&
      !admitsFixedArgumentsSpread(context, args, scanIndex, restFrom, selected)
    ) {
      // The magic `arguments` object -- `IArguments` has no native iteration
      // cursor of its own (it is not a `Set`/`Map`/`Array`/`string`/
      // `Generator`), so `hasNativeIterationCursor` correctly says no for it.
      // It is admitted here on a SEPARATE ground: once bound
      // (`argumentsObjectValueAt`, `bindings.ts`) it names a genuine array
      // this compiler minted, with exactly the arity `arguments.length`
      // itself reports -- not a runtime iteration this layer has to model,
      // an already-materialized value.
      const isArguments = isArgumentsObjectIdentifier(argument.expression, context.checker)
      if (
        !isArguments &&
        !hasNativeIterationCursor(context, context.types.typeAt(argument.expression)) &&
        !isDynamicIterationSource(context, context.types.typeAt(argument.expression))
      ) {
        return {
          kind: 'refused',
          reason:
            'a spread argument whose source is not an array, a Set, a Map, a string, a generator or a genuinely dynamic value needs the general ' +
            'iterator protocol, which is not installed'
        }
      }
      // `selected === null` is a callee with no static convention to check
      // AT ALL -- `invocations.ts` only leaves it null for a callee its own
      // `calleeType` resolved genuinely dynamic (see the comment over
      // `calleeIsDynamic` there) -- so "this call has no rest formal at this
      // position" is not a question a `gea::Value::callAsFunction` dynamic
      // call has an answer to: it has no named formals to be at or before,
      // and takes every argument as a box regardless of position. Refusing
      // it here would refuse a call that has no ABI to check the refusal
      // against, the same shape `invocationArgumentTarget`
      // (`preflight/invocation-arguments.ts`) already treats as satisfied
      // outright for a dynamic callee's ordinary arguments.
      if (selected !== null && (restFrom === null || (scan < restFrom && !restAbsorbsLeadingFormals(context, selected, scan, restFrom)))) {
        // How many values a native range copy produces is a runtime fact.
        // Matching it against named formals would need the arity the iteration
        // produces, which is exactly what this compiler does not have -- so the
        // refusal names the shape rather than the protocol: no iterator would
        // help a callee whose formals are named.
        return {
          kind: 'refused',
          reason:
            'a spread argument whose source has a native iteration cursor can only be range-copied into a rest parameter; ' +
            'this call has no rest formal at or before that position'
        }
      }
    }
    scan += positionsOccupiedBy(context, argument)
  }

  const operands: SemanticOperand[] = []
  const operations: SemanticOperation[] = []
  const edges: SemanticEdge[] = []
  let position = 0
  for (const [buildIndex, argument] of args.entries()) {
    if (ts.isSpreadElement(argument)) {
      if (admitsFixedArgumentsSpread(context, args, buildIndex, restFrom, selected)) {
        const value = argumentsObjectValueAt(argument.expression, candidate.id, candidate.caller, candidate.evaluationOrdinal, context)
        if (!value || !selected) {
          return {
            kind: 'refused',
            reason: 'a fixed-signature spread of `arguments` needs the enclosing function phantom rest array and a selected signature'
          }
        }
        // A tuple frame states each position's own type, optional positions
        // read with `undefined` beside it -- the omitted-equals-undefined
        // ground `maxArityTupleSpreadReads` states for this same final-spread,
        // no-rest-formal position. An array frame has one element type for
        // every position the callee names.
        const shape = context.table.get(value.type).shape
        const positions =
          shape.kind === 'tuple'
            ? maxArityTupleElementTypesOf(context, value.type)
            : shape.kind === 'array'
              ? Array<StructuralTypeId>(Math.max(0, selected.parameters.length - position)).fill(shape.element)
              : null
        if (positions === null) {
          return {
            kind: 'refused',
            reason: 'a fixed-signature spread of `arguments` resolved to a value that is neither a closed tuple nor an array'
          }
        }
        operations.push(...value.operations)
        edges.push(...value.edges)
        const expanded = mintPositionalSpreadReads(
          context,
          candidate,
          { source: { kind: 'result', result: value.value }, type: value.type },
          positions
        )
        operations.push(...expanded.operations)
        edges.push(...expanded.edges)
        for (const slot of expanded.positions) {
          operands.push(operand('argument', position, slot.source, slot.type, evaluation))
          position += 1
        }
        continue
      }
      const open = openTupleSpreadShapeOf(context, context.types.typeAt(argument.expression))
      if (open !== null) {
        const receiver = spreadReceiverOf(context, argument.expression)
        if (!receiver) return { kind: 'refused', reason: 'no normalized operation identifies the value an open-ended tuple spread reads' }
        const head = mintPositionalSpreadReads(context, candidate, receiver, open.fixed)
        operations.push(...head.operations)
        edges.push(...head.edges)
        for (const slot of head.positions) {
          operands.push(operand('argument', position, slot.source, slot.type, evaluation))
          position += 1
        }
        operands.push({ ...operand(spreadArgumentRole, position, receiver.source, receiver.type, evaluation), from: open.fixed.length })
        position += 1
        continue
      }
      const expanded =
        tupleSpreadReads(context, candidate, argument.expression) ??
        declaredTupleRestSpreadReads(context, candidate, argument.expression) ??
        (admitsMaxArityTupleSpread(context, args, buildIndex, restFrom, selected)
          ? maxArityTupleSpreadReads(context, candidate, argument.expression)
          : null)
      if (expanded) {
        operations.push(...expanded.operations)
        edges.push(...expanded.edges)
        for (const slot of expanded.positions) {
          operands.push(operand('argument', position, slot.source, slot.type, evaluation))
          position += 1
        }
        continue
      }
      // The rest-tail range copy. The operand names the WHOLE array, so it
      // occupies one argument-list position the way a `spread` element of an
      // array literal occupies one slot of `arrayLiteralSlotsOf`'s ordered
      // run: `ir/lower-invocation.ts` merges the two roles back by ordinal and
      // hands `packRestArguments` a per-slot kind, and nothing else in the
      // pipeline has to know the difference.
      //
      // `arguments` has no ordinary `citeExpressionResult` citation --
      // `references.ts` resolves an identifier's value through its
      // DECLARATION, and the magic `arguments` binding has none -- so it is
      // sourced directly through `argumentsObjectValueAt` instead of
      // `sourceForValue`, and the auxiliary operations that value needs
      // (the phantom rest slot's own read, and -- only when a real declared
      // parameter precedes it -- the array literal that concatenates the
      // two) are minted here, against this call's own candidate, exactly as
      // `tupleSpreadReads` above mints its `[[Get]]`s.
      if (isArgumentsObjectIdentifier(argument.expression, context.checker)) {
        const value = argumentsObjectValueAt(argument.expression, candidate.id, candidate.caller, candidate.evaluationOrdinal, context)
        if (!value) {
          return {
            kind: 'refused',
            reason: 'a spread of `arguments` needs the enclosing function to have exactly the phantom rest shape this compiler recognizes'
          }
        }
        operations.push(...value.operations)
        edges.push(...value.edges)
        operands.push(
          operand(
            spreadArgumentRole,
            position,
            { kind: 'result', result: value.value },
            context.types.typeAt(argument.expression),
            evaluation
          )
        )
        position += 1
        continue
      }
      const sourceType = context.types.typeAt(argument.expression)
      const source = isDynamicIterationSource(context, sourceType)
        ? {
            kind: 'result' as const,
            result: semanticResultId(operationId(context.identities.nodeIdOf(argument), 'protocol', 1), 'iterator-record')
          }
        : sourceForValue(context, argument.expression)
      operands.push(operand(spreadArgumentRole, position, source, sourceType, evaluation))
      position += 1
      continue
    }
    operands.push(operand('argument', position, sourceForValue(context, argument), context.types.typeAt(argument), evaluation))
    position += 1
  }
  return { kind: 'operands', operands, operations, edges }
}
