import type { IrArrayElement, IrBlockId } from './model.js'
import { representationKey, type Representation } from '../representation/model.js'
import { operandOf, type SemanticOperand } from '../semantics/model/operands.js'
import type { AllocationOperation } from '../semantics/model/operations.js'
import { IrLoweringBlockedError } from './lower-graph.js'
import {
  orderedOperandsOf,
  recordLayoutOf,
  registerResult,
  requireLineage,
  requireResultRepresentation,
  resolveRequiredOperand,
  type LoweringContext,
  enterRequiredOperand
} from './lower-operands.js'

/**
 * Allocation: the operations that mint a new object.
 *
 * Split out of `lower.ts` on the family boundary the semantic model already
 * draws, so the file that dispatches every family does not also carry one
 * family's whole implementation.
 */

/**
 * `[a, b]` whose type is a tuple, allocated as the record it is.
 *
 * The fields are matched to elements by *position*, because a tuple's key is
 * its position -- the layout's own key for slot `n` is the string `"n"`, and
 * reading it back that way is what keeps this and `cppRecordFieldName` from
 * being two opinions about the same member. A hole has no tuple meaning (the
 * language has no elision in a tuple type) and an element with no field, or a
 * field with no element, means this lowering and the plan disagree about the
 * arity, which is refused rather than padded.
 */
const lowerTupleLiteral = (
  ctx: LoweringContext,
  block: IrBlockId,
  operation: AllocationOperation,
  operands: readonly SemanticOperand[],
  tuple: Representation,
  representation: Representation
): void => {
  const lineage = requireLineage(operation)
  const layout = recordLayoutOf(ctx, tuple)
  if (!layout) {
    throw new IrLoweringBlockedError(
      `an array literal carries "${representationKey(tuple)}", which states no record layout to place its elements into`
    )
  }
  if (layout.length !== operands.length) {
    throw new IrLoweringBlockedError(
      `an array literal writes ${operands.length} element(s) into a layout of ${layout.length} field(s); ` +
        'a tuple carrier and its literal have to agree on arity'
    )
  }
  const fields = layout.map((field, index) => {
    const operand = operands[index]
    if (!operand || operand.source.kind === 'absent') {
      throw new IrLoweringBlockedError(`an array literal leaves position ${index} elided, which a tuple field cannot represent`)
    }
    if (field.key !== String(index)) {
      throw new IrLoweringBlockedError(
        `an array literal's field ${index} is keyed "${field.key}"; a tuple's key is its position, so this layout is not a tuple's`
      )
    }
    return { key: field.key, value: enterRequiredOperand(ctx, block, lineage, operation, operand) }
  })
  registerResult(ctx, operation, ctx.builder.allocateRecord(block, lineage, fields, representation))
}

/**
 * An array literal's own `element`/`spread` operands, merged back into one
 * source-ordered sequence.
 *
 * `allocations.ts` publishes an ordinary element under role `element` and an
 * admitted plain-Array spread's own source under the distinct role `spread`,
 * both keyed by the position they occupy in the element SEQUENCE the literal
 * builds -- one shared counter, so merging the two roles by ordinal recovers
 * exactly the order the literal was written in, without either role needing to
 * know the other exists. That position is not the syntactic index once a
 * closed-tuple spread has expanded one written element into several
 * (`tuple-spread.ts`), which is why the counter is the producer's and not
 * `forEach`'s.
 */
const arrayLiteralSlotsOf = (
  operation: AllocationOperation
): readonly (
  | { readonly ordinal: number; readonly kind: 'element'; readonly operand: SemanticOperand }
  | { readonly ordinal: number; readonly kind: 'spread'; readonly operand: SemanticOperand }
)[] => {
  const elements = orderedOperandsOf(operation, 'element').map((operand) => ({
    ordinal: operand.ordinal,
    kind: 'element' as const,
    operand
  }))
  const spreads = orderedOperandsOf(operation, 'spread').map((operand) => ({ ordinal: operand.ordinal, kind: 'spread' as const, operand }))
  return [...elements, ...spreads].sort((left, right) => left.ordinal - right.ordinal)
}

export const lowerAllocation = (ctx: LoweringContext, block: IrBlockId, operation: AllocationOperation): void => {
  const lineage = requireLineage(operation)
  const representation = requireResultRepresentation(ctx, operation, 'value', 'an allocation operation')
  switch (operation.allocated) {
    case 'object-literal': {
      // The carrier decides the machinery. A literal whose type is a record
      // allocates a record: giving it an ordinary object instead would mean
      // laying out a dictionary for a value the plan already proved has a
      // fixed, native shape, and every field access after it would then have
      // to agree with a layout nobody selected. Fields install as their own
      // `define-own-property` operations, so none are supplied here.
      // A `dictionary` carrier is native storage for the same reason a record
      // is -- the plan proved the literal's whole layout is one keyed
      // container -- so it allocates through the same primitive.
      // `record-with-index` is the split layout of the same struct (named
      // fields plus an index-signature sidecar member) -- `cppTypeOf` spells
      // it identically to `record`, and `emitAllocateRecord` already accepts
      // it -- so routing it anywhere but here left every such literal on the
      // unimplemented `OrdinaryObject` path despite a plan that had already
      // proved it native. Only a carrier the plan left as the dynamic object
      // substrate still gets an `OrdinaryObject`.
      const carrier = representation.kind === 'borrowed-ref' ? representation.referent : representation
      const native =
        carrier.kind === 'record' ||
        carrier.kind === 'native-record-ref' ||
        carrier.kind === 'dictionary' ||
        carrier.kind === 'record-with-index'
      const allocate = native
        ? ctx.builder.allocateRecord(block, lineage, [], representation)
        : ctx.builder.allocateOrdinaryObject(block, lineage, representation)
      registerResult(ctx, operation, allocate)
      return
    }
    case 'array-literal': {
      // A tuple is a record whose keys are positions -- there is no separate
      // tuple carrier by design -- so a literal the plan gave a record carrier
      // allocates a record, exactly as an object literal with a record carrier
      // does. Building an Array exotic object for it instead would allocate
      // length, holes and index-key semantics for a value whose layout the
      // plan already proved is a fixed struct. A `spread` operand never
      // reaches this branch: `allocations.ts` publishes that role ONLY for a
      // plain-Array source (a closed-tuple source is expanded into ordinary
      // `element` operands instead, one per position, by `tuple-spread.ts`),
      // and a plain-Array-typed literal never derives to a record carrier --
      // so one arriving here would be a producer/representation disagreement
      // this lowering does not try to paper over. The `element` operands it
      // does read are already the post-expansion run, keyed by their position
      // in the element SEQUENCE rather than in the written syntax, which is
      // exactly the key `lowerTupleLiteral` matches against the layout.
      const tuple = representation.kind === 'borrowed-ref' ? representation.referent : representation
      if (tuple.kind === 'record' || tuple.kind === 'native-record-ref') {
        lowerTupleLiteral(ctx, block, operation, orderedOperandsOf(operation, 'element'), tuple, representation)
        return
      }
      const elements: IrArrayElement[] = arrayLiteralSlotsOf(operation).map((slot): IrArrayElement => {
        if (slot.kind === 'spread') {
          let source = resolveRequiredOperand(ctx, block, lineage, slot.operand)
          // `hasNativeIterationCursor` admits an optional native source through
          // its present payload. ArrayAccumulation still starts by calling
          // GetIterator, so an absent source throws; it is not an empty range.
          // Unwrapping here makes the range-copy lanes below read the same
          // payload carrier the census admitted, rather than handing an
          // Optional<T> to an Array/Set/string cursor that cannot consume it.
          if (source.representation.kind === 'optional') {
            const payload = source.representation.payload
            const value = ctx.builder.compute(block, lineage, 'require-iterable-present', 'RequireIterablePresent', [source], payload)
            source = { value, representation: payload }
          }
          // Dynamic spread operands cite the already-acquired iterator
          // record.  A `Value` does not become an ArrayObject projection just
          // because it is being spread: only the gather primitive may drain
          // it, and only into an explicitly dynamic-element destination.
          if (source.representation.kind === 'dynamic') {
            // A `dynamic` destination cell IS an explicitly dynamic-element
            // one: `emitAllocateArrayObject`'s `representation.kind ===
            // 'dynamic'` branch allocates `ArrayObject<gea::Value>`, drains
            // the iterator through `runtime::iterator::appendGather` and
            // boxes the result, for every reason a cell can be `dynamic` --
            // `opt-in-fallback` (this literal's own declared fallback) and
            // `declared-any-never-narrowed` (`const copied = [...anySource]`
            // with `copied` never subsequently narrowed) alike. `reason`
            // records only WHY the cell is dynamic, not a different runtime
            // representation, so checking one specific reason here refused a
            // capability the emitter grants to every `dynamic` result. Reading
            // the element carrier off the `array-object` spelling alone would
            // separately refuse the one carrier where the element type is
            // fixed by construction, so a capability the target certifies and
            // the emitter renders had no lowering to reach it either way.
            const dynamicDestination = tuple.kind === 'dynamic'
            if (!dynamicDestination && (tuple.kind !== 'array-object' || tuple.element.kind !== 'dynamic')) {
              throw new IrLoweringBlockedError(
                `an array literal gathers dynamic iterator values into a "${tuple.kind === 'array-object' ? representationKey(tuple.element) : tuple.kind}" element carrier; ` +
                  'per-element dynamic conversion is not installed'
              )
            }
            return { kind: 'gather', iterator: source }
          }
          // The element carrier the source's own range copy will produce, or
          // `null` when this source has no native range copy at all. The four
          // sources here are exactly the four `producers/shared.ts`'s
          // `hasNativeIterationCursor` admits, and the check is a fail-closed
          // re-statement of that admission rather than a second opinion.
          //
          // A `Map` is the one whose element cannot be named from the source's
          // own carrier: it yields a freshly built `[K, V]` PAIR, whose record
          // shape id lives on the DESTINATION's element carrier and nowhere on
          // the collection. So this arm reads the destination's own pair --
          // which `emit-arrays.ts` then re-checks field by field against the
          // collection's key and value before spelling `appendMapRange`.
          const collection = source.representation.kind === 'keyed-collection' ? source.representation : null
          const destinationElement = tuple.kind === 'array-object' ? tuple.element : null
          const spreadElement =
            source.representation.kind === 'array-object'
              ? source.representation.element
              : collection?.family === 'set'
                ? collection.key
                : collection?.family === 'map'
                  ? destinationElement
                  : source.representation.kind === 'string'
                    ? ({ kind: 'string' } as const)
                    : source.representation.kind === 'iterator'
                      ? source.representation.element
                      : null
          if (spreadElement === null) {
            throw new IrLoweringBlockedError(
              `an array literal spreads a "${representationKey(source.representation)}" source; the native range copy only covers an ` +
                '"array-object", a "Set", a "Map", a "string" and a cursor'
            )
          }
          if (tuple.kind !== 'array-object' || representationKey(spreadElement) !== representationKey(tuple.element)) {
            throw new IrLoweringBlockedError(
              `an array literal spreads a source whose element carrier ("${representationKey(spreadElement)}") does not match ` +
                `this literal's own element carrier ("${tuple.kind === 'array-object' ? representationKey(tuple.element) : tuple.kind}"); a mismatch would need a ` +
                'per-element conversion into the destination carrier, which this range copy does not perform'
            )
          }
          return { kind: 'spread', value: source, from: 0 }
        }
        return slot.operand.source.kind === 'absent'
          ? { kind: 'hole' }
          : { kind: 'element', value: enterRequiredOperand(ctx, block, lineage, operation, slot.operand) }
      })
      registerResult(ctx, operation, ctx.builder.allocateArrayObject(block, lineage, elements, representation))
      return
    }
    case 'class-constructor-object': {
      const shape = ctx.graph.structuralTypes.get(operation.shape)?.shape
      if (!shape || shape.kind !== 'class-constructor') {
        throw new IrLoweringBlockedError(
          'a class-constructor-object allocation has no class-constructor shape to recover its declaration from'
        )
      }
      const captures = orderedOperandsOf(operation, 'capture').map((operand) => resolveRequiredOperand(ctx, block, lineage, operand))
      // The heritage event and this allocation are siblings from one
      // `contributeClass` call, and both name the class through the
      // producer's identities -- which, inside a monomorphized copy of a
      // generic class, carry that copy's specialization (`decl|f80|43@0` for
      // hono's `Hono<E, S, BasePath>`). The structural shape names the class
      // by its unspecialized declaration, which is right for the one C++
      // struct every copy shares but pairs with no event of a generic class:
      // `Hono` was evaluated with no heritage, its method-state owner had no
      // parent, and the first `HonoBase` method read as a value on an instance
      // aborted with "no matching class evaluation". A class expression with
      // no members publishes no `classDeclaration`; the shape is its name.
      const evaluatedClass = operation.classDeclaration ?? shape.declaration
      const heritageEvent = [...ctx.graph.operations.values()].find(
        (event) => event.family === 'class-lifecycle' && event.event === 'evaluate-heritage' && event.classDeclaration === evaluatedClass
      )
      const heritageOperand = heritageEvent ? operandOf(heritageEvent, 'heritage') : undefined
      const heritage =
        heritageOperand && heritageOperand.source.kind !== 'absent'
          ? resolveRequiredOperand(ctx, block, lineage, heritageOperand)
          : undefined
      // `GEA_HERITAGE_DEBUG=1`: one stderr row per evaluated class saying
      // whether its `extends` reached this allocation. A derived class
      // evaluated with no heritage operand allocates a method-state owner with
      // no parent, and the first base method read as a VALUE on one of its
      // instances aborts ("no matching class evaluation") with nothing in the
      // message naming the class -- this row is where that gap is visible.
      if (process.env.GEA_HERITAGE_DEBUG !== undefined)
        console.error(
          `[HERITAGE] class=${String(shape.declaration)} event=${heritageEvent ? 'found' : 'missing'} ` +
            `source=${heritageOperand?.source.kind ?? 'none'} layoutOnly=${String(heritageEvent !== undefined && 'classLayoutOnly' in heritageEvent && heritageEvent.classLayoutOnly === true)} ` +
            `representation=${heritage?.representation.kind ?? 'none'}` +
            (heritageEvent
              ? ''
              : ` heritageEventsInFile=${[...ctx.graph.operations.values()]
                  .flatMap((event) =>
                    event.family === 'class-lifecycle' &&
                    event.event === 'evaluate-heritage' &&
                    String(event.classDeclaration).startsWith(String(shape.declaration).split('|').slice(0, 2).join('|'))
                      ? [String(event.classDeclaration)]
                      : []
                  )
                  .join(',')}`)
        )
      // The PHYSICAL class this constructor object constructs -- the carrier's
      // own answer (`constructor-family.members[0]`, derive.ts's
      // `physicalClassDeclarationOf`): the root for a class with one layout,
      // and `decl|f0|36@1` for the second layout of a generic instantiated
      // at two, whose struct and construct thunk are named by exactly that id
      // (`projection/classes.ts`). The shape's own declaration is always the
      // root, which names no struct once there are two.
      const constructed =
        representation.kind === 'constructor-family' && representation.members[0] !== undefined
          ? representation.members[0]
          : shape.declaration
      registerResult(ctx, operation, ctx.builder.allocateConstructor(block, lineage, constructed, captures, representation, heritage))
      return
    }
    case 'function-object': {
      const callable = operation.callable
      if (!callable) {
        throw new IrLoweringBlockedError('a function-object allocation names no function to allocate a callable for')
      }
      // Captures are the operands the allocation carries; a function that closes
      // over nothing carries none, and that is the whole capture set, not a
      // partial one this layer would have to complete from elsewhere.
      const captures = orderedOperandsOf(operation, 'capture').map((operand) => resolveRequiredOperand(ctx, block, lineage, operand))
      registerResult(ctx, operation, ctx.builder.allocateCallable(block, lineage, callable, captures, representation))
      return
    }
    case 'template-object': {
      // The texts came off the template literal's own tokens as constants, and
      // they are read back here as constants: `orderedOperandsOf` keeps them in
      // the ordinal order the producer wrote them in, which is segment order.
      // A non-constant operand would mean something computed a segment, which
      // no step of the language does, so it is refused rather than resolved.
      const raw = orderedOperandsOf(operation, 'raw').map((operand) => {
        if (operand.source.kind !== 'constant') {
          throw new IrLoweringBlockedError(
            "a template object's raw segment is not a constant; template segments are source text, never computed values"
          )
        }
        if (operand.source.literal !== 'string') {
          throw new IrLoweringBlockedError(
            "a template object's raw segment is not a string constant; Template Raw Values are always strings"
          )
        }
        return operand.source.text
      })
      const cooked = orderedOperandsOf(operation, 'cooked').map((operand) => {
        if (operand.source.kind !== 'constant') {
          throw new IrLoweringBlockedError(
            "a template object's cooked segment is not a constant; template segments are source values, never computed values"
          )
        }
        if (operand.source.literal === 'undefined') return { kind: 'undefined' as const }
        if (operand.source.literal === 'string') return { kind: 'string' as const, text: operand.source.text }
        throw new IrLoweringBlockedError("a template object's cooked segment is neither a string nor undefined")
      })
      if (cooked.length !== raw.length) {
        throw new IrLoweringBlockedError(
          `a template object carries ${cooked.length} cooked segment(s) and ${raw.length} raw one(s); GetTemplateObject builds both arrays from the same segment list`
        )
      }
      registerResult(ctx, operation, ctx.builder.allocateTemplateObject(block, lineage, cooked, raw, representation))
      return
    }
    case 'regexp-object': {
      // The pattern and its flags came off the literal's own token as
      // constants and are read back here as constants, exactly as a template
      // object's segments are above. A non-constant operand would mean
      // something computed a pattern, which no step of the language does for a
      // LITERAL (`new RegExp(expr)` is an invocation, not this operation), so
      // it is refused rather than resolved.
      const textOf = (role: 'pattern-source' | 'pattern-flags'): string => {
        const found = operandOf(operation, role)
        if (!found)
          throw new IrLoweringBlockedError(
            `a regexp allocation carries no ${role} operand; the literal's own token is where both come from`
          )
        if (found.source.kind !== 'constant') {
          throw new IrLoweringBlockedError(
            `a regexp allocation's ${role} is not a constant; a literal's pattern and flags are source text, never computed values`
          )
        }
        return found.source.text
      }
      registerResult(
        ctx,
        operation,
        ctx.builder.allocateRegExp(block, lineage, textOf('pattern-source'), textOf('pattern-flags'), representation)
      )
      return
    }
    case 'construction-result':
      throw new IrLoweringBlockedError(
        'a construction-result allocation has no independent IR primitive; the construct operation that follows it produces the instance directly'
      )
  }
}
