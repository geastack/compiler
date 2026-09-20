import { operationOfResult, type SemanticResultId } from '../identity/ids.js'
import { carriesUndefined, representationKey, type Representation } from '../representation/model.js'
import { operandOf, type SemanticOperand } from '../semantics/model/operands.js'
import { IrLoweringBlockedError } from './lower-graph.js'
import type { FlowController } from './lower-flow.js'
import { mergeIncoming } from './lower-narrow.js'
import {
  convertTo,
  namedOperand,
  reactiveFieldReadOf,
  recordLayoutOf,
  registerResult,
  requireLineage,
  requireResultRepresentation,
  resolveRequiredOperand,
  type LoweringContext
} from './lower-operands.js'
import type { DestructuringOperation } from '../semantics/model/operations.js'
import type { IrBlockId, IrOperand } from './model.js'

/**
 * Destructuring, lowered as the operations it actually is.
 *
 * An object pattern's element is a `[[Get]]` with a static key and nothing
 * else: `const {a} = o` reads `o.a`, and there is no separate extraction step
 * in the language for it to be. Lowering it as a `get` is what lets it share
 * every property recipe, ownership rule, and carrier check an ordinary
 * property read already goes through, instead of acquiring a second spine that
 * would have to be kept in agreement with the first.
 *
 * An array pattern over a plain array source takes the same fast path a
 * spread does: `const [a,b] = xs` reads `xs->elementAt(0)`/`xs->elementAt(1)`
 * directly, and `const [head, ...tail] = xs` range-copies the remainder with
 * `appendRange`, exactly as `lower-allocation.ts`'s spread handling does.
 * `destructuring.ts`'s own semantic model never publishes a numeric index for
 * an element, though -- each bound/elided step only cites the *shared*
 * getIterator step's result as its `iterator` operand -- so the index has to
 * be recovered by walking the `evaluation`-edge chain the census wires
 * between them, which is what `arrayPatternIndexOf` does below. This is sound
 * only because `orderOwnerOperations` (`lower-graph.ts`) already guarantees
 * that chain is visited in the pattern's own written order.
 *
 * An array pattern over a *tuple* source (`record`/`native-record-ref` --
 * `lower-allocation.ts`'s `lowerTupleLiteral` doc comment is the reason there
 * is no separate tuple carrier: a tuple is a record whose keys are its
 * positions) takes a second, sibling fast path: `const [a,b] = pair` reads
 * `pair->gea_slot_0`/`pair->gea_slot_1`, an ordinary record field get keyed by
 * the position's own string, exactly as an object pattern's `[[Get]]` already
 * is. Neither fast path needs the iterator protocol -- a statically-typed
 * tuple's shape is closed at compile time, so GetIterator/next() would answer
 * a question a field lookup already answers directly.
 *
 * A `default-value` is a conditional evaluation whose guard is "the extracted
 * value is `undefined`": the extraction step it is chained after is the guard,
 * `gating.ts` puts the initializer in that guard's absent arm, and this merges
 * the two. An object-pattern rest element over a genuinely dynamic source is
 * still refused: `CopyDataProperties` over a key set computed at runtime has
 * no IR primitive. Over a `record`/`native-record-ref` source, though, the key
 * set is CLOSED -- TypeScript already resolved the rest binding's own type to
 * `Omit<Source, K>` -- so `lowerObjectPatternRest` reads it back as an
 * ordinary field-by-field copy, no different from an object literal's own
 * allocation.
 */

const chainSuccessorOf = (graph: LoweringContext['graph'], id: DestructuringOperation['id']): DestructuringOperation['id'] | null => {
  for (const edge of graph.edges) {
    if (edge.kind === 'evaluation' && edge.from === id) return edge.to
  }
  return null
}

/**
 * The zero-based position of an array-pattern element, recovered by walking
 * the `evaluation` chain from the pattern's own shared getIterator step until
 * `target` is reached. Throws rather than returning `-1` on a broken chain: a
 * `target` this walk never reaches is the semantic graph and this lowering
 * disagreeing about the pattern's own element order, which is a defect to
 * surface, not a position to guess at.
 */
const arrayPatternIndexOf = (
  graph: LoweringContext['graph'],
  iteratorRecord: SemanticResultId,
  target: DestructuringOperation['id']
): number => {
  let current = operationOfResult(iteratorRecord)
  let index = -1
  for (;;) {
    const next = chainSuccessorOf(graph, current)
    if (next === null) {
      throw new IrLoweringBlockedError(
        'an array-pattern element was not reachable by following the "evaluation" chain from its own shared getIterator step; ' +
          "the semantic graph and this lowering disagree about the pattern's element order"
      )
    }
    // Only THIS pattern's own element steps hold a position. A defaulted
    // element's `default-value` step sits on the same evaluation chain right
    // after its read, and counting it advanced every later position by one:
    // `const [, a, b = 'B', c = 'C', d] = arr` read `c` from slot 4 and `d`
    // from slot 6. An own element step is the one that names this pattern's
    // iterator record as its "iterator" operand; a nested pattern's steps
    // name their own.
    const step = graph.operations.get(next)
    const iterator = step ? operandOf(step, 'iterator') : undefined
    const own = iterator?.source.kind === 'result' && iterator.source.result === iteratorRecord
    if (own) index += 1
    if (next === target) {
      if (!own) {
        throw new IrLoweringBlockedError(
          "an array-pattern element step does not name its own pattern's iterator record; the semantic graph and this lowering disagree about the pattern's element order"
        )
      }
      return index
    }
    current = next
  }
}

const indexOfArrayPatternElement = (
  graph: LoweringContext['graph'],
  iteratorOperand: SemanticOperand,
  target: DestructuringOperation['id']
): number => {
  if (iteratorOperand.source.kind !== 'result') {
    throw new IrLoweringBlockedError(
      'an array-pattern element\'s own "iterator" operand names no prior result to trace back to its shared getIterator step'
    )
  }
  return arrayPatternIndexOf(graph, iteratorOperand.source.result, target)
}

const lowerObjectPatternStep = (ctx: LoweringContext, block: IrBlockId, operation: DestructuringOperation): void => {
  const lineage = requireLineage(operation)
  const receiver = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'base'))
  const keyOperand = namedOperand(operation, 'key')
  const key = resolveRequiredOperand(ctx, block, lineage, keyOperand)
  const representation = requireResultRepresentation(ctx, operation, 'value', 'an object destructuring step')
  // `const { count } = this` reads a class field exactly as `this.count` does
  // -- see `GetOperation.reactive` -- and this is the pattern's own `[[Get]]`,
  // not a second read the property path already covered.
  const reactive =
    keyOperand.source.kind === 'constant'
      ? reactiveFieldReadOf(ctx.program.classes, receiver.representation, keyOperand.source.text, ctx.program.reactiveFields)
      : false
  registerResult(ctx, operation, ctx.builder.get(block, lineage, receiver, key, representation, undefined, reactive))
}

/** Whether a carrier is one of the two record shapes a tuple can be given -- see `lower-allocation.ts`'s `lowerTupleLiteral` for why there is no separate tuple carrier. */
const isTupleCarrier = (kind: string): boolean => kind === 'record' || kind === 'native-record-ref'

/**
 * Whether a source carries a `tagged-union` all of whose arms are themselves
 * tuple carriers -- `[T, ParamIndexMap] | [T, Params]`, hono's own router
 * match result, is exactly this: a fixed-arity 2-tuple in EVERY arm, differing
 * only in one slot's own value type.
 *
 * A tuple's shape is closed and known at compile time, so reading its
 * position never needed the iterator protocol (`lowerTuplePatternRead`'s own
 * doc). That is equally true per arm here: every arm still has the SAME fixed
 * arity at the SAME positions (a tagged union's arms are already required to
 * share the discriminant read that told the two apart in the first place),
 * so the shared source step still has nothing for GetIterator/next() to
 * resolve -- it aliases straight to the base value, one union carrier
 * instead of one record carrier, and each element step reads position `i`
 * off whichever arm is live. `emit-union-properties.ts`'s `taggedUnionGetText`
 * already renders exactly that per-arm dispatch for a STATIC field key -- the
 * identical primitive an ordinary tuple's own `[[Get]]` reaches -- so nothing
 * new is needed on the emit side, only the acceptance here that a tagged
 * union of tuples is as closed-shape as a lone tuple is.
 */
const isTupleUnionCarrier = (representation: Representation): boolean =>
  representation.kind === 'tagged-union' && representation.arms.every((arm) => isTupleCarrier(arm.value.kind))

/** Whether a carrier is a source this pattern reads by SNAPSHOT rather than in place -- see `lowerArrayPatternSource`. */
const isSnapshotSource = (kind: string): boolean => kind === 'string' || kind === 'keyed-collection' || kind === 'native-record-ref'

/**
 * Whether a carrier is ALREADY the native cursor `gea::Iterator<E>` --
 * `Generator<T>`'s own carrier (`representation/derive.ts`'s
 * `GeneratorDeclarationPolicy`), reached either directly (`var [a] = g()`) or
 * because the resolved `[Symbol.iterator]()` is itself a generator method
 * (`producers/protocol.ts`'s `generatorRecordTypeOf`). `%GeneratorPrototype%
 * [@@iterator]` returns `this` (ECMA-262 27.5.1.2), so the pattern's own
 * "get iterator" step is an alias of the base value here too, exactly like the
 * tuple/array-object fast paths above -- see `lowerArrayPatternSource`'s own
 * widened guard and `lowerArrayPatternIteratorRead`/`lowerArrayPatternIteratorElision`
 * below for the per-position reads this one cursor answers.
 */
const isCursorCarrier = (kind: string): boolean => kind === 'iterator'

/**
 * The pattern's own shared getIterator step.
 *
 * For a plain array and for a tuple this aliases straight to the base value:
 * neither has a separate iterator record to materialize, and every element step
 * reads the base in place, by index or by field.
 *
 * For a `Set<T>` or a `string` it materializes an ARRAY SNAPSHOT instead --
 * the identical range copy `[...set]`/`[...str]` already build -- because the
 * element steps read BY POSITION and neither source offers positional access.
 * The snapshot is not this lowering's own idea: `representation/publish.ts`'s
 * `patternSourceSnapshotOf` is what published the `array-object` carrier this
 * step selected, so the plan and the IR state one answer, and that function's
 * comment carries the ECMA-262 7.4 divergence the snapshot implies. Reaching
 * here with a snapshot-shaped source whose declared carrier is NOT that array
 * means the override declined it (a `Map`, a weak collection), and it is
 * refused rather than materialized against a carrier nothing published.
 */
const lowerArrayPatternSource = (ctx: LoweringContext, block: IrBlockId, operation: DestructuringOperation): void => {
  const lineage = requireLineage(operation)
  let source = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'base'))
  const declared = requireResultRepresentation(ctx, operation, 'iterator-record', 'an array binding pattern source')
  // A position that may run past a plain array's own length, or fed by an
  // enclosing pattern's own absent-capable element read, reaches here
  // wrapped: `optional(...)`, and -- when the source's own element is itself
  // a union like `number | number[]` -- a `tagged-union` around the payload
  // `declared` resolved to (`representation/publish.ts`'s `patternSourceArmOf`
  // is what resolved `declared` to that payload rather than the wrapper).
  // Both are real runtime facts ECMA-262 7.4.2's `GetIterator` throws over --
  // absence, and a union's non-iterable arm -- so both checks run, in
  // whichever order the value wraps them, before the positional fast path
  // below ever reads a position.
  if (source.representation.kind === 'optional') {
    const payload = source.representation.payload
    const value = ctx.builder.compute(block, lineage, 'require-iterable-present', 'RequireIterablePresent', [source], payload)
    source = { value, representation: payload }
  }
  if (source.representation.kind === 'tagged-union' && declared.kind !== 'tagged-union') {
    const armIndex = source.representation.arms.findIndex((arm) => representationKey(arm.value) === representationKey(declared))
    if (armIndex < 0) {
      throw new IrLoweringBlockedError(
        `an array binding pattern's source resolved to a tagged union none of whose arms carry the declared ` +
          `"${representationKey(declared)}" iterator-record shape`
      )
    }
    const value = ctx.builder.compute(block, lineage, 'require-tagged-union-arm', String(armIndex), [source], declared)
    source = { value, representation: declared }
  }
  if (isSnapshotSource(source.representation.kind) && declared.kind === 'array-object') {
    registerResult(ctx, operation, ctx.builder.allocateArrayObject(block, lineage, [{ kind: 'spread', value: source, from: 0 }], declared))
    return
  }
  // The true arm of `Array.isArray(dynamicValue)` remains a `gea::Value`, not
  // an `ArrayObject<Value>` projection.  The dynamic carrier is the original
  // object identity and its runtime metadata already records the Array exotic
  // operations.  Acquire the iterator through the generic protocol so a
  // custom @@iterator is still observed; the runtime falls back to the
  // native Array iterator only when that property is absent.  A typed array
  // never reaches this branch: its carrier is `array-object` above.
  if (source.representation.kind === 'dynamic' && declared.kind === 'dynamic') {
    registerResult(ctx, operation, ctx.builder.getIterator(block, lineage, 'iterator', source, null, declared))
    return
  }
  // A boxed value the program asserts to a tuple or array type
  // (`(res as any)[cacheKey] as InternalCache`) is read out of its box into
  // that carrier first, by the conversion census's own checked load.
  if (
    source.representation.kind === 'dynamic' &&
    (declared.kind === 'array-object' || isTupleCarrier(declared.kind) || isTupleUnionCarrier(declared))
  ) {
    const unboxed = convertTo(ctx, block, lineage, source, declared, 'array-pattern-source')
    if (unboxed !== null) source = unboxed
  }
  if (
    source.representation.kind !== 'array-object' &&
    !isTupleCarrier(source.representation.kind) &&
    !isTupleUnionCarrier(source.representation) &&
    !isCursorCarrier(source.representation.kind)
  ) {
    throw new IrLoweringBlockedError(
      `an array binding pattern's own source carries a "${source.representation.kind}" carrier; the array fast path only reads ` +
        'an "array-object" source by index, the tuple fast path only reads a "record"/"native-record-ref" source by position, a ' +
        'tagged-union-of-tuples source reads the same way per live arm, the Set/string snapshot path only covers a source whose ' +
        'own step published an "array-object", and the native cursor path only covers a source that is ALREADY a "Generator<T>" -- ' +
        'a general iterable needs the fully dynamic iterator protocol, which is not installed'
    )
  }
  if (representationKey(declared) !== representationKey(source.representation)) {
    throw new IrLoweringBlockedError(
      `an array binding pattern's source resolved to "${representationKey(source.representation)}", but its own iterator-record result ` +
        `selected "${representationKey(declared)}" -- the two must agree for the fast path's per-element index reads to be sound`
    )
  }
  registerResult(ctx, operation, source.value)
}

/**
 * `const [a, b] = pair` over a tuple source: a record field get keyed by the
 * position's own string, the same field `lowerTupleLiteral` wrote it under.
 * Never the iterator protocol -- a tuple's shape is closed and known at
 * compile time, so there is nothing for GetIterator/next() to resolve that
 * this field lookup does not already answer directly.
 */
const lowerTuplePatternRead = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operation: DestructuringOperation,
  source: IrOperand,
  index: number
): void => {
  const layout = recordLayoutOf(ctx, source.representation)
  if (!layout) {
    throw new IrLoweringBlockedError(
      `an array-pattern element reads a "${representationKey(source.representation)}" source, which states no record layout to read position ${index} from`
    )
  }
  const field = layout[index]
  if (!field || field.key !== String(index)) {
    throw new IrLoweringBlockedError(
      `an array-pattern element reads position ${index} of a "${representationKey(source.representation)}" tuple, whose record layout has no field keyed "${index}"`
    )
  }
  const representation = requireResultRepresentation(ctx, operation, 'value', 'an array-pattern element')
  if (representationKey(representation) !== representationKey(field.value)) {
    throw new IrLoweringBlockedError(
      `an array-pattern element's own carrier ("${representationKey(representation)}") does not match its tuple source's field ${index} carrier ` +
        `("${representationKey(field.value)}")`
    )
  }
  const key: IrOperand = {
    value: ctx.builder.constant(block, lineage, String(index), 'string', { kind: 'string' }),
    representation: { kind: 'string' }
  }
  registerResult(ctx, operation, ctx.builder.get(block, lineage, source, key, representation))
}

/**
 * `const [a, b] = pair` over a `tagged-union` source whose every arm is a
 * tuple -- the union-of-arms mirror of `lowerTuplePatternRead` immediately
 * above, sharing its own reasoning: position `index` is closed and known at
 * compile time in EVERY arm, so there is nothing for GetIterator/next() to
 * resolve here either.
 *
 * The difference from a lone tuple is the per-arm check: every arm's own
 * record layout must have a field at `index`, and (deliberately as strict as
 * `lowerTuplePatternRead`'s own single-source check, rather than reaching for
 * the C++ backend's `narrowedLoadText` widening) that field's carrier must be
 * the EXACT one this element publishes -- a mismatched arm is refused by name
 * rather than silently routed through a reconciliation this IR layer has no
 * business performing; `emit-union-properties.ts`'s `taggedUnionGetText`
 * still reconciles per arm at emission time for the union's OWN published
 * result, this only has to agree that every arm's raw field is the same
 * shape to begin with.
 */
const lowerTaggedUnionTuplePatternRead = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  operation: DestructuringOperation,
  source: IrOperand,
  index: number
): void => {
  const receiver = source.representation
  if (receiver.kind !== 'tagged-union') {
    throw new IrLoweringBlockedError('an array-pattern element expected a "tagged-union" source to read a tuple-union position from')
  }
  const representation = requireResultRepresentation(ctx, operation, 'value', 'an array-pattern element')
  for (const arm of receiver.arms) {
    const layout = recordLayoutOf(ctx, arm.value)
    if (!layout) {
      throw new IrLoweringBlockedError(
        `an array-pattern element reads position ${index} of a tagged union whose arm is carried as "${representationKey(arm.value)}", which ` +
          'states no record layout to read that position from'
      )
    }
    const field = layout[index]
    if (!field || field.key !== String(index)) {
      throw new IrLoweringBlockedError(
        `an array-pattern element reads position ${index} of a tagged union whose arm "${representationKey(arm.value)}" has no field keyed "${index}"`
      )
    }
    if (representationKey(field.value) !== representationKey(representation)) {
      throw new IrLoweringBlockedError(
        `an array-pattern element's own carrier ("${representationKey(representation)}") does not match position ${index} of tagged-union ` +
          `arm "${representationKey(arm.value)}", carried as "${representationKey(field.value)}" -- not every arm of this union answers this ` +
          'position with the same carrier, which is a narrowing the source program should have stated'
      )
    }
  }
  const key: IrOperand = {
    value: ctx.builder.constant(block, lineage, String(index), 'string', { kind: 'string' }),
    representation: { kind: 'string' }
  }
  registerResult(ctx, operation, ctx.builder.get(block, lineage, source, key, representation))
}

const lowerArrayPatternRead = (ctx: LoweringContext, block: IrBlockId, operation: DestructuringOperation): void => {
  const lineage = requireLineage(operation)
  const iteratorOperand = namedOperand(operation, 'iterator')
  const source = resolveRequiredOperand(ctx, block, lineage, iteratorOperand)
  const index = indexOfArrayPatternElement(ctx.graph, iteratorOperand, operation.id)
  if (isTupleCarrier(source.representation.kind)) {
    lowerTuplePatternRead(ctx, block, lineage, operation, source, index)
    return
  }
  if (isTupleUnionCarrier(source.representation)) {
    lowerTaggedUnionTuplePatternRead(ctx, block, lineage, operation, source, index)
    return
  }
  if (source.representation.kind === 'dynamic') {
    const representation = requireResultRepresentation(ctx, operation, 'value', 'an array-pattern element')
    registerResult(ctx, operation, ctx.builder.iteratorNext(block, lineage, source, null, representation))
    return
  }
  if (source.representation.kind !== 'array-object') {
    throw new IrLoweringBlockedError(
      `an array-pattern element reads a "${source.representation.kind}" source; the array/string fast path only reads an "array-object" ` +
        'source by index, and the tuple fast path only reads a "record"/"native-record-ref" source by position'
    )
  }
  const representation = requireResultRepresentation(ctx, operation, 'value', 'an array-pattern element')
  // A position the producer typed `undefined` outright lies past every
  // element the source can hold (`[x, y] = []`, a tuple shorter than the
  // pattern): the language's step yields `undefined` there and, over a plain
  // array, observes nothing -- so nothing is read.
  if (representation.kind === 'undefined') {
    registerResult(ctx, operation, ctx.builder.constant(block, lineage, 'undefined', 'undefined', representation))
    return
  }
  // An array whose ELEMENT is uninhabited (`[]` typed `never[]`, carried as
  // `array-object(undefined)`) holds nothing at any position, so a read
  // published with an absence is that absence, constant -- there is no
  // element carrier to bounds-test a read of.
  const sourceElement = source.representation.element
  if (
    (sourceElement.kind === 'undefined' || sourceElement.kind === 'void') &&
    representation.kind === 'optional' &&
    representation.absence === 'undefined'
  ) {
    registerResult(ctx, operation, ctx.builder.constant(block, lineage, 'undefined', 'undefined', representation))
    return
  }
  // The step reads the element WITH its absence -- `optional(E, undefined)`
  // over an array of `E` -- because the pattern may run past the array's
  // length; `emit-carrier-members.ts`'s `absentCapableElementText` is the
  // bounds-tested read that answers exactly that carrier for an indexed get.
  // ... or, for an element that already carries `null`, the same read spelled
  // as the tagged union `undefined | null | E`: an `Optional` of an `Optional`
  // has no primitive (`representation/optional.ts`), so `(number | null)[]`
  // read past its end publishes the three-armed union, and the emitter widens
  // the present element into it (`presentElementText`).
  const absentCapable =
    (representation.kind === 'optional' &&
      representation.absence === 'undefined' &&
      representationKey(representation.payload) === representationKey(source.representation.element)) ||
    isElementPlusUndefined(representation, source.representation.element)
  if (!absentCapable && representationKey(representation) !== representationKey(source.representation.element)) {
    throw new IrLoweringBlockedError(
      `an array-pattern element's own carrier ("${representationKey(representation)}") does not match its source's element carrier ` +
        `("${representationKey(source.representation.element)}")`
    )
  }
  const key: IrOperand = {
    value: ctx.builder.constant(block, lineage, String(index), 'number', { kind: 'scalar', domain: 'number' }),
    representation: { kind: 'scalar', domain: 'number' }
  }
  registerResult(ctx, operation, ctx.builder.get(block, lineage, source, key, representation))
}

const lowerArrayPatternRest = (ctx: LoweringContext, block: IrBlockId, operation: DestructuringOperation): void => {
  const lineage = requireLineage(operation)
  const iteratorOperand = namedOperand(operation, 'iterator')
  const source = resolveRequiredOperand(ctx, block, lineage, iteratorOperand)
  const representation = requireResultRepresentation(ctx, operation, 'value', 'an array-pattern rest element')
  // A dynamic pattern source has already performed GetIterator once in its
  // shared source step.  Gather the remaining values from that record; do not
  // restart from the original value, which would rerun @@iterator and include
  // positions the pattern already consumed.
  if (source.representation.kind === 'dynamic') {
    // Two destinations admit a native gather: an explicit "array of dynamic"
    // carrier, or the destination cell being `dynamic` itself -- `const [a,
    // ...rest] = anyIterable` types `rest` as a boxed `any[]`, exactly the
    // shape `allocation:array-literal:dynamic(dynamic-gather)` already
    // allocates for an array LITERAL's `[...anyIterable]` spread
    // (`lower-allocation.ts`, `emitAllocateArrayObject`'s `representation.kind
    // === 'dynamic'` branch). `reason` records only WHY a cell is dynamic
    // (`opt-in-fallback` for the literal path, ordinarily
    // `declared-any-never-narrowed` for a rest binding never subsequently
    // narrowed) -- it names no different runtime representation, so gating
    // this capability on one specific reason was the identical carrier
    // refusing itself over a label that carries no consequence for how
    // `gea::Value::box` stores the result.
    const dynamicDestination = representation.kind === 'dynamic'
    if (!dynamicDestination && (representation.kind !== 'array-object' || representation.element.kind !== 'dynamic')) {
      throw new IrLoweringBlockedError(
        `an array-pattern rest gathers dynamic iterator values into a "${representation.kind === 'array-object' ? representationKey(representation.element) : representation.kind}" carrier; ` +
          'per-element dynamic conversion is not installed'
      )
    }
    registerResult(ctx, operation, ctx.builder.allocateArrayObject(block, lineage, [{ kind: 'gather', iterator: source }], representation))
    return
  }
  if (source.representation.kind !== 'array-object') {
    throw new IrLoweringBlockedError(
      `an array-pattern rest element reads a "${source.representation.kind}" source; the array/string fast path only range-copies an "array-object" source`
    )
  }
  if (
    representation.kind !== 'array-object' ||
    representationKey(representation.element) !== representationKey(source.representation.element)
  ) {
    throw new IrLoweringBlockedError(
      "an array-pattern rest element's own carrier does not match its source's element carrier; a mismatch would need a per-element " +
        'conversion into the destination carrier, which the shared range-copy primitive does not perform'
    )
  }
  const index = indexOfArrayPatternElement(ctx.graph, iteratorOperand, operation.id)
  registerResult(
    ctx,
    operation,
    ctx.builder.allocateArrayObject(block, lineage, [{ kind: 'spread', value: source, from: index }], representation)
  )
}

/**
 * `const { strict, ...rest } = options` over a source whose shape is CLOSED
 * and known at compile time (`record`/`native-record-ref`) -- never the
 * general "{...rest}" case (`CopyDataProperties` over a key set computed at
 * runtime, still refused above): TypeScript already resolved the rest
 * binding's own type to `Omit<Source, K>`, one field short of the source, so
 * the field set to copy is not runtime state this lowering has to discover --
 * it is the rest binding's own required representation, read back the same
 * way `lowerTuplePatternRead`'s field lookup already is. Each remaining field
 * is an ordinary keyed `[[Get]]` off the source (`ctx.builder.get`, the same
 * primitive an object-pattern element read uses), assembled into a fresh
 * record with `allocateRecord` -- the identical primitive an object literal's
 * own allocation uses. No CopyDataProperties, no runtime key enumeration: the
 * key set is closed, so there is nothing dynamic left to perform.
 */
const lowerObjectPatternRest = (ctx: LoweringContext, block: IrBlockId, operation: DestructuringOperation): void => {
  const lineage = requireLineage(operation)
  const source = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'base'))
  const representation = requireResultRepresentation(ctx, operation, 'value', 'an object-pattern rest element')

  // CopyDataProperties over an open dictionary is a runtime key walk. Reuse
  // object spread's exact dictionary copy primitive, then delete the excluded
  // keys from the new table. Dictionary entries are data properties, so this
  // produces the same key order and values as skipping those keys during the
  // copy, while keeping the source untouched.
  if (source.representation.kind === 'dictionary' && representation.kind === 'dictionary') {
    const value = ctx.builder.allocateRecord(block, lineage, [], representation)
    const target: IrOperand = { value, representation }
    ctx.builder.spreadCopy(block, lineage, target, source)
    const excluded = operation.operands
      .filter((operand) => operand.role === 'excluded-key')
      .sort((left, right) => left.ordinal - right.ordinal)
    for (const operand of excluded) {
      const key = resolveRequiredOperand(ctx, block, lineage, operand)
      // Object-rest's internal CopyDataProperties exclusion is not source
      // `delete` syntax, so its successful bookkeeping erase has no strict
      // Reference Record to propagate.
      ctx.builder.delete(block, lineage, target, key, false, null)
    }
    registerResult(ctx, operation, value)
    return
  }

  const sourceLayout = recordLayoutOf(ctx, source.representation)
  if (!sourceLayout) {
    throw new IrLoweringBlockedError(
      `an object-pattern rest element reads a "${representationKey(source.representation)}" source, which states no record layout to copy fields from`
    )
  }
  const targetLayout = recordLayoutOf(ctx, representation)
  if (!targetLayout) {
    throw new IrLoweringBlockedError(
      `an object-pattern rest element's own carrier "${representationKey(representation)}" states no record layout to build`
    )
  }
  const fields = targetLayout.map((field) => {
    const sourceField = sourceLayout.find((candidate) => candidate.key === field.key)
    if (!sourceField || representationKey(sourceField.value) !== representationKey(field.value)) {
      throw new IrLoweringBlockedError(
        `an object-pattern rest element's own field "${field.key}" has no matching field in its source's record layout, or the two ` +
          'carry different carriers -- a mismatch would need a per-field conversion this fast path does not perform'
      )
    }
    const key: IrOperand = {
      value: ctx.builder.constant(block, lineage, field.key, 'string', { kind: 'string' }),
      representation: { kind: 'string' }
    }
    return { key: field.key, value: { value: ctx.builder.get(block, lineage, source, key, field.value), representation: field.value } }
  })
  registerResult(ctx, operation, ctx.builder.allocateRecord(block, lineage, fields, representation))
}

/**
 * `const [a] = g()`'s own per-element read over a source already resolved to
 * the native `gea::Iterator<E>` cursor -- see `isCursorCarrier`'s own doc for
 * why `lowerArrayPatternSource` aliases such a source rather than building an
 * iterator record for it. Each bound position advances that ONE shared
 * cursor with `arrayNext()`, the identical primitive a `for`-`of` over the
 * same generator already lowers through (`ir/lower-protocol.ts`'s `next`
 * case) -- called once per POSITION here instead of once per loop iteration,
 * which is sound because `orderOwnerOperations` (`lower-graph.ts`) already
 * guarantees the pattern's elements are visited in their own written order,
 * exactly the guarantee `arrayPatternIndexOf`'s own doc relies on above.
 *
 * A position this producer's own typing proves PRESENT reads the bare element
 * carrier; a position the cursor may already be exhausted at
 * (`extractedArrayTypeOf`, producers/destructuring.ts) reads an `optional`
 * one instead, and the carrier check below accepts either -- the merge itself
 * (the done-check and the phi to `undefined`) is not built here: `iteratorNext`
 * mints one IR op regardless of which carrier it is asked for, and
 * `emit-iterator.ts`'s own `next` case is what renders the done-check and
 * wraps the read into the requested carrier. A carrier that is neither the
 * exact element nor an absence-capable widening of it is refused by name
 * rather than approximated, the same fail-closed posture `lowerDefaultValueStep`'s
 * own guard check takes for the identical reason.
 */
const lowerArrayPatternIteratorRead = (ctx: LoweringContext, block: IrBlockId, operation: DestructuringOperation): void => {
  const lineage = requireLineage(operation)
  const iteratorOperand = namedOperand(operation, 'iterator')
  const iterator = resolveRequiredOperand(ctx, block, lineage, iteratorOperand)
  if (iterator.representation.kind !== 'iterator') {
    throw new IrLoweringBlockedError(
      `an array-pattern element's own cursor read expected an "iterator" source, but resolved a "${iterator.representation.kind}" one`
    )
  }
  const representation = requireResultRepresentation(ctx, operation, 'value', 'an array-pattern element')
  // The read is the element itself where the typing proved the position
  // present, and the element-or-absence where it did not: a cursor that is
  // exhausted before this position hands the pattern `undefined` (ECMA-262
  // 8.6.2, IteratorStep returning done), which the `next` step spells as the
  // absence of the result's own carrier (`emit-iterator.ts`).
  if (representationKey(representation) !== representationKey(iterator.representation.element) && !carriesUndefined(representation)) {
    throw new IrLoweringBlockedError(
      `an array-pattern element's own carrier ("${representationKey(representation)}") does not match its cursor source's element ` +
        `carrier ("${representationKey(iterator.representation.element)}") and holds no absence for an exhausted cursor`
    )
  }
  registerResult(ctx, operation, ctx.builder.iteratorNext(block, lineage, iterator, null, representation))
}

const lowerArrayPatternStep = (ctx: LoweringContext, block: IrBlockId, operation: DestructuringOperation): void => {
  const role = operation.results[0]?.role
  if (role === 'iterator-record') {
    lowerArrayPatternSource(ctx, block, operation)
    return
  }
  if (role === undefined) {
    // An elision binds nothing, but over a cursor it still STEPS: ECMA-262
    // 8.6.2 IteratorDestructuringAssignmentEvaluation's `Elision` rule calls
    // `IteratorStep` and discards the result, so `[,] = g()` resumes the
    // generator once -- and a generator that throws on its first resume
    // throws out of the pattern. An array or tuple source reads by position
    // and has nothing to do for a skipped one.
    const elided = operandOf(operation, 'iterator')
    if (!elided || elided.source.kind !== 'result') return
    const lineage = elided.source.result
    const cursor = resolveRequiredOperand(ctx, block, lineage, elided)
    if (cursor.representation.kind === 'iterator') ctx.builder.iteratorNext(block, lineage, cursor, null, cursor.representation.element)
    // A dynamic pattern cursor is the same stateful iterator record as a
    // dynamic for-of cursor.  An elision still performs IteratorStep; omitting
    // it would make `[ , value ] = dynamic` read the first item for `value`.
    if (cursor.representation.kind === 'dynamic')
      ctx.builder.iteratorNext(block, lineage, cursor, null, { kind: 'dynamic', reason: 'declared-any-never-narrowed' })
    return
  }
  const iteratorOperand = operandOf(operation, 'iterator')
  if (iteratorOperand) {
    const lineage = requireLineage(operation)
    const iterator = resolveRequiredOperand(ctx, block, lineage, iteratorOperand)
    if (iterator.representation.kind === 'iterator') {
      lowerArrayPatternIteratorRead(ctx, block, operation)
      return
    }
    if (iterator.representation.kind === 'dynamic') {
      lowerArrayPatternRead(ctx, block, operation)
      return
    }
  }
  lowerArrayPatternRead(ctx, block, operation)
}

/**
 * A `default-value` step: a merge over a presence guard.
 *
 * The extracted value on the branch where it was proven present, the
 * initializer's own value on the branch where it was `undefined`. The guard has
 * to already exist -- `flow.requireMergeSources` only closes branches
 * `lower-flow.ts`'s `ensureGuardBlocks` opened, which happens only for a result
 * some other pass already gated -- so this is scoped to the one producer that
 * installs one today: a defaulted parameter's raw argument
 * (`semantics/normalize/producers/bindings.ts`'s `contributeDefaultedParameter`).
 * An object or array pattern's own default (`{a = 1}`) has no such guard and is
 * refused by name rather than approximated.
 */
/** The arms a carrier holds, by key: a tagged union's own, an optional's absence and payload, else the carrier itself. */
const armKeysOf = (representation: Representation): readonly string[] =>
  representation.kind === 'tagged-union'
    ? representation.arms.map((arm) => representationKey(arm.value))
    : representation.kind === 'optional'
      ? [representation.absence, representationKey(representation.payload)]
      : [representationKey(representation)]

const isElementPlusUndefined = (read: Representation, element: Representation): boolean => {
  if (read.kind !== 'tagged-union' || !carriesUndefined(read)) return false
  const present = armKeysOf(read).filter((key) => key !== 'undefined')
  const held = armKeysOf(element)
  return present.length === held.length && held.every((key) => present.includes(key))
}

const lowerDefaultValueStep = (ctx: LoweringContext, flow: FlowController, operation: DestructuringOperation): void => {
  const lineage = requireLineage(operation)
  const extracted = namedOperand(operation, 'extracted')
  if (extracted.source.kind !== 'result') {
    throw new IrLoweringBlockedError('a "default-value" destructuring step has no guard result to branch on')
  }
  const guardResult = extracted.source.result
  const guardOperation = ctx.graph.operations.get(operationOfResult(guardResult))
  // Two producers install a presence-tested guard for their own extraction, and
  // the merge below is the same merge over either. A defaulted PARAMETER tests
  // its raw argument (`reference`/`parameter-value`); a defaulted binding
  // ELEMENT tests what the pattern read out of the source, which is the
  // extraction step this one is chained after. Anything else has no guard, so
  // the arms this merge needs were never opened, and refusing by name is what
  // keeps that from being approximated into a fallback that always runs.
  // An array-pattern step is absence-capable too: its producer types the read
  // `E | undefined` for any source that can be exhausted before the position
  // (`extractedArrayTypeOf`), and the carrier test below is what proves it.
  const extractsFromPattern =
    guardOperation?.family === 'destructuring' && (guardOperation.form === 'object-pattern' || guardOperation.form === 'array-pattern')
  const bindsAParameter = guardOperation?.family === 'reference' && guardOperation.form === 'parameter-value'
  if (!extractsFromPattern && !bindsAParameter) {
    throw new IrLoweringBlockedError(
      'a "default-value" destructuring step needs a presence-tested guard installed for its own extraction, ' +
        'which only a defaulted parameter or a defaulted pattern element has'
    )
  }
  // A guard carrier with no `undefined` state answers the definedness test
  // with the constant `true` (`emit-presence.ts`, one rule, shared): the
  // default arm is dead and the present arm reads the value unconditionally.
  // That is the language's own answer for a position the source PROVES --
  // `var [a, b = 5] = [1, 2]` binds 2 and never evaluates `5`, and a
  // parameter pattern every call site fills (`impliedPatternPositionPresent-
  // Everywhere`) is the same fact one census over. Both censuses type such a
  // read without the absence on purpose, so the dead arm here is the proof
  // arriving, not a name's type standing in for the read's.
  const sources = flow.requireMergeSources(guardResult)
  const representation = requireResultRepresentation(ctx, operation, 'value', 'a default-value step')
  // A default's truthy arm is the raw extraction after the `is-defined`
  // guard proved every top-level `undefined` arm dead. Carry that site-local
  // proof into the IR instead of asking the representation-only conversion
  // renderer to rediscover it. `T | null | undefined` -> `T | null` is the
  // important shape: the surviving `null` and `T` arms must be dispatched
  // separately, or stripping the result's optional wrapper first reads the
  // inactive `T` arm when the caller explicitly supplied `null`.
  const extractedIncoming = resolveRequiredOperand(ctx, sources.truthy, lineage, extracted)
  const liveDefinedArms =
    extractedIncoming.representation.kind === 'tagged-union'
      ? extractedIncoming.representation.arms
          .map((arm, index) => (arm.value.kind === 'undefined' ? -1 : index))
          .filter((index): index is number => index >= 0)
      : []
  const present =
    extractedIncoming.representation.kind === 'tagged-union' &&
    liveDefinedArms.length > 0 &&
    liveDefinedArms.length < extractedIncoming.representation.arms.length
      ? {
          value: ctx.builder.mergeLiveArmRebuild(
            sources.truthy,
            lineage,
            extractedIncoming,
            representation,
            liveDefinedArms,
            false,
            ctx.program.conversions
          ),
          representation
        }
      : mergeIncoming(ctx, sources.truthy, lineage, operation, 'extracted', extracted, representation)
  const fallback = mergeIncoming(ctx, sources.falsy, lineage, operation, 'fallback', namedOperand(operation, 'fallback'), representation)
  registerResult(
    ctx,
    operation,
    ctx.builder.phi(
      sources.join,
      lineage,
      [
        { block: sources.truthy, value: present },
        { block: sources.falsy, value: fallback }
      ],
      representation
    )
  )
}

export const lowerDestructuring = (
  ctx: LoweringContext,
  flow: FlowController,
  block: IrBlockId,
  operation: DestructuringOperation
): void => {
  if (operation.form === 'object-source') {
    const lineage = requireLineage(operation)
    const source = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'base'))
    const result = ctx.builder.compute(
      block,
      lineage,
      'require-object-coercible',
      'RequireObjectCoercible',
      [source],
      source.representation
    )
    registerResult(ctx, operation, result)
    return
  }
  if (operation.form === 'object-pattern') {
    lowerObjectPatternStep(ctx, block, operation)
    return
  }
  if (operation.form === 'array-pattern-close') {
    const lineage = requireLineage(operation)
    const iterator = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'iterator'))
    if (iterator.representation.kind !== 'dynamic' && iterator.representation.kind !== 'iterator') {
      throw new IrLoweringBlockedError(
        `a finite array-pattern close expected a dynamic or generator iterator, but resolved a "${iterator.representation.kind}" carrier`
      )
    }
    const completion = operation.results.find((result) => result.role === 'completion')
    const representation = completion ? requireResultRepresentation(ctx, operation, 'completion', 'a finite array-pattern close') : null
    const result = ctx.builder.iteratorClose(block, lineage, iterator, representation, true)
    if (completion && result) ctx.values.set(completion.id, result)
    return
  }
  if (operation.form === 'array-pattern') {
    lowerArrayPatternStep(ctx, block, operation)
    return
  }
  if (operation.form === 'rest-element') {
    if (operandOf(operation, 'iterator', 0)) {
      lowerArrayPatternRest(ctx, block, operation)
      return
    }
    lowerObjectPatternRest(ctx, block, operation)
    return
  }
  lowerDefaultValueStep(ctx, flow, operation)
}
