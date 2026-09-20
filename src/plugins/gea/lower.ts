import type { OperationId } from '../../identity/ids.js'
import type { Representation } from '../../representation/model.js'
import { representationKey } from '../../representation/model.js'
import { operandOf, type SemanticOperand } from '../../semantics/model/operands.js'
import type { ElementOperation, SemanticOperation } from '../../semantics/model/operations.js'
import { IrLoweringBlockedError } from '../../ir/lower-graph.js'
import {
  abiOfCallee,
  orderedOperandsOf,
  recordLayoutOf,
  registerResult,
  requireLineage,
  requireResultRepresentation,
  resolveOptionalOperand,
  type LoweringContext,
  enterRequiredOperand
} from '../../ir/lower-operands.js'
import type { IrBlockId, IrOperand, IrRecordFieldInit } from '../../ir/model.js'
import { geaReconcilerAttributeName, type GeaElementFacts } from './contract.js'

/**
 * An element whose tag names a value, lowered the way gea means it.
 *
 * Two shapes, and they are genuinely different operations rather than two
 * spellings of one. A function component is a call the checker already
 * resolved: `<C a={x}>y</C>` builds the attributes object type and resolves a
 * signature of `C` against it, so lowering it as a call with one props argument
 * is not a desugaring choice -- it is the operation the checker validated. A
 * class component resolves a *construct* signature, and calling its body once
 * would compile, draw one frame, and never update again; what gea does instead
 * is construct the instance and enter the member its base names.
 *
 * The props record's carrier is read from the receiving convention rather than
 * assembled from the attributes. The caller must build the frame the callee
 * declares -- that is what an ABI is -- and a record built from whatever
 * attributes happened to be written is a second, weaker opinion about the same
 * layout, disagreeing exactly where an optional or defaulted prop is involved.
 */

/** One filled parameter slot, plus which of the element's attributes went into it. */
interface BuiltFrame extends IrOperand {
  readonly consumed: ReadonlySet<string>
  readonly tookChildren: boolean
}

export const lowerGeaElement = (
  ctx: LoweringContext,
  block: IrBlockId,
  operation: SemanticOperation,
  facts: ReadonlyMap<OperationId, GeaElementFacts>
): boolean => {
  if (operation.family !== 'element' || operation.form !== 'value') return false
  const resolved = facts.get(operation.id)
  if (!resolved) return false
  const lineage = requireLineage(operation)
  const keys = orderedOperandsOf(operation, 'prop-key')
  const children = orderedOperandsOf(operation, 'child').map((child) => enterRequiredOperand(ctx, block, lineage, operation, child))
  const tag = resolveOptionalOperand(ctx, block, lineage, operandOf(operation, 'tag', 0))
  const representation = requireResultRepresentation(ctx, operation, 'value', 'an element construction')
  if (resolved.invocation === 'construct') {
    lowerClassComponent(ctx, block, operation, resolved, tag, keys, children, representation)
    return true
  }
  lowerFunctionComponent(ctx, block, operation, tag, keys, children, representation)
  return true
}

/**
 * A function component element, lowered to what the checker checked: a call.
 *
 * No new emitter capability is involved: the record allocation and the generic
 * call path are the same primitives an ordinary `C({a: x})` goes through.
 */
const lowerFunctionComponent = (
  ctx: LoweringContext,
  block: IrBlockId,
  operation: ElementOperation,
  tag: IrOperand | null,
  keys: readonly SemanticOperand[],
  children: readonly IrOperand[],
  representation: Representation
): void => {
  const lineage = requireLineage(operation)
  if (!tag) throw new IrLoweringBlockedError('a component element names no tag to invoke')
  const abi = abiOfCallee(tag.representation)
  if (!abi)
    throw new IrLoweringBlockedError(`a component element's tag carries "${tag.representation.kind}", which declares no calling convention`)
  // The caller builds the frame the callee declares -- so the arguments are
  // the convention's parameters, each filled from the attributes. A component
  // that declares none gets none, which falls out of mapping an empty list
  // rather than being a case: `<Board/>`, whose whole state comes from a
  // store, goes down exactly the same path as `<Row label={x}/>`.
  if (abi.parameters.length > 1) {
    throw new IrLoweringBlockedError(
      `an element supplies one attributes object, but its tag's convention declares ${abi.parameters.length} parameters; ` +
        'the ones past the first have nothing in the element to fill them from'
    )
  }
  const built = abi.parameters.map((parameter) => buildPropsRecord(ctx, block, operation, keys, children, parameter.value))
  requireEveryAttributeConsumed(keys, children, built)
  registerResult(ctx, operation, ctx.builder.call(block, lineage, tag, null, built, representation))
}

/**
 * A class component element: construct the instance, then enter its render.
 *
 * The props carrier comes from the *render member's* convention, not the
 * constructor's. A component element writes attributes for the thing that reads
 * them, and it is the render member that declares a parameter for them; the
 * constructor of a component class takes none.
 */
const lowerClassComponent = (
  ctx: LoweringContext,
  block: IrBlockId,
  operation: ElementOperation,
  facts: GeaElementFacts,
  tag: IrOperand | null,
  keys: readonly SemanticOperand[],
  children: readonly IrOperand[],
  representation: Representation
): void => {
  const lineage = requireLineage(operation)
  if (!facts.renderMember) {
    throw new IrLoweringBlockedError(
      'this element constructs a class this library does not claim: none of the classes it derives from is the base gea exports, ' +
        'so nothing states which member constructing it is supposed to render through'
    )
  }
  if (!tag) throw new IrLoweringBlockedError('a class component element names no tag to construct')
  const construct = abiOfCallee(tag.representation)
  if (!construct) {
    throw new IrLoweringBlockedError(
      `a class component element's tag carries "${tag.representation.kind}", which declares no construct convention`
    )
  }
  if (construct.parameters.length > 0) {
    throw new IrLoweringBlockedError(
      `the component class this element constructs declares ${construct.parameters.length} constructor parameter(s), ` +
        'and an element passes none; a component whose construction takes arguments has no place to get them from'
    )
  }
  const instance = construct.result
  if (instance.kind !== 'class-ref') {
    throw new IrLoweringBlockedError(
      `constructing this component yields "${representationKey(instance)}"; only a class instance names the class whose render member ` +
        'this library points at'
    )
  }
  const layout = ctx.program.classes.get(instance.declaration)
  const member = layout?.methods.find((method) => method.key === facts.renderMember)
  const callable = member?.callable
  if (!callable) {
    throw new IrLoweringBlockedError(
      `this component class installs no member "${facts.renderMember}" of its own; a render inherited from a base is entered through ` +
        'the base that declares it, which this lowering does not yet resolve'
    )
  }
  const render = ctx.program.abis.get(callable)
  if (!render) throw new IrLoweringBlockedError(`the render member of this component class has no projected calling convention`)
  if (representationKey(render.result) !== representationKey(representation)) {
    throw new IrLoweringBlockedError(
      `this element is carried as "${representationKey(representation)}" but its component's render returns ` +
        `"${representationKey(render.result)}"; an element is exactly what its render produces`
    )
  }
  const built = render.parameters.map((parameter) => buildPropsRecord(ctx, block, operation, keys, children, parameter.value))
  requireEveryAttributeConsumed(keys, children, built)
  const created = ctx.builder.construct(
    block,
    lineage,
    tag,
    tag,
    { kind: 'open', evidence: ['plugin-lowered-jsx-class-component'] },
    [],
    instance
  )
  const receiver: IrOperand = { value: created, representation: instance }
  // The render member's function object, allocated with no environment: a
  // method declared on a class captures nothing, and its receiver travels as
  // the convention's own receiver rather than as a capture. The carrier is
  // minted here rather than read from the plan because no *program* result has
  // this value -- it exists only between this construction and the call that
  // consumes it.
  const bound = ctx.builder.allocateCallable(block, lineage, callable, [], { kind: 'function-value-dispatch', abi: render })
  registerResult(
    ctx,
    operation,
    ctx.builder.call(
      block,
      lineage,
      { value: bound, representation: { kind: 'function-value-dispatch', abi: render } },
      receiver,
      built,
      representation
    )
  )
}

/**
 * Nothing the author wrote may be dropped on the floor.
 *
 * An attribute the receiving layout has no field for, or a child with nowhere
 * to go, is a disagreement between this lowering and the checker that resolved
 * the element -- and the failure mode is the worst kind: the program compiles,
 * renders, and is missing a prop. The checker will normally have rejected it
 * first, which is exactly why reaching here means something is wrong rather
 * than merely unsupported.
 */
const requireEveryAttributeConsumed = (
  keys: readonly SemanticOperand[],
  children: readonly IrOperand[],
  frames: readonly BuiltFrame[]
): void => {
  const consumed = new Set(frames.flatMap((frame) => [...frame.consumed]))
  // One exemption, and it is not a relaxation: `key` is gea's own reconciler
  // hint, declared on every element's props so an author may write it, and
  // received by no component (`geaReconcilerAttributeName`). v1 drops it at the
  // same point for the same reason. Everything else still has to land in a
  // field, which is the whole of this guard.
  const missed = keys.find(
    (key) => key.source.kind !== 'constant' || (key.source.text !== geaReconcilerAttributeName && !consumed.has(key.source.text))
  )
  if (missed) {
    const named = missed.source.kind === 'constant' ? `"${missed.source.text}"` : 'a computed name'
    throw new IrLoweringBlockedError(
      `an element writes the attribute ${named}, which no field of the carrier its tag declares receives; ` +
        'passing the element without it would render a component the author did not write'
    )
  }
  if (children.length > 0 && !frames.some((frame) => frame.tookChildren)) {
    throw new IrLoweringBlockedError(
      `an element passes ${children.length} child(ren), which no field of the carrier its tag declares receives`
    )
  }
}

/**
 * The props object an element passes, built into the carrier the receiving
 * convention declares.
 *
 * Both element forms build the same object -- a class component's render member
 * takes props the same way a function component's parameter does -- so they
 * build it here, once.
 */
const buildPropsRecord = (
  ctx: LoweringContext,
  block: IrBlockId,
  operation: ElementOperation,
  keys: readonly SemanticOperand[],
  children: readonly IrOperand[],
  props: Representation
): BuiltFrame => {
  const lineage = requireLineage(operation)
  const layout = recordLayoutOf(ctx, props)
  if (!layout) {
    throw new IrLoweringBlockedError(
      `a component element builds its props object into the carrier its tag declares, which is "${representationKey(props)}"; ` +
        'only a record layout states the named fields to fill'
    )
  }

  // Keyed by the attribute name the producer published, so a field is filled by
  // the attribute that names it rather than by position: the record's field
  // order is the declared type's, and the attribute order is the author's.
  const written = new Map<string, SemanticOperand>()
  for (const key of keys) {
    if (key.source.kind !== 'constant') {
      throw new IrLoweringBlockedError(
        'a component element has an attribute whose name is not a constant, which no static record layout can place'
      )
    }
    const value = operandOf(operation, 'prop-value', key.ordinal)
    if (!value) throw new IrLoweringBlockedError(`a component element property at ordinal ${key.ordinal} names a key with no value operand`)
    written.set(key.source.text, value)
  }

  const child = children[0]
  const consumed = new Set<string>()
  let tookChildren = false
  const fields: IrRecordFieldInit[] = []
  for (const field of layout) {
    if (operation.childrenKey !== null && field.key === operation.childrenKey) {
      // One child is passed as itself, which is what a single-child element
      // means. Two or more are an array the language builds, and the props
      // field's own carrier is what would have to state that array -- it does
      // not, so the gap is named instead of packing them into a carrier the
      // convention never declared.
      if (children.length > 1) {
        throw new IrLoweringBlockedError(
          `a component element passes ${children.length} children, which the language groups into an array; ` +
            `the "${field.key}" field of its props carries ${representationKey(field.value)}, which states no such array`
        )
      }
      if (child) fields.push({ key: field.key, value: child })
      tookChildren = true
      continue
    }
    const supplied = written.get(field.key)
    if (supplied) {
      consumed.add(field.key)
      fields.push({ key: field.key, value: enterRequiredOperand(ctx, block, lineage, operation, supplied) })
      continue
    }
    // A required field with no attribute is a program the checker would have
    // rejected, so reaching here means this lowering and the checker disagree
    // about which fields the props type has.
    if (field.required) {
      throw new IrLoweringBlockedError(`a component element supplies no value for the required props field "${field.key}"`)
    }
  }

  return { value: ctx.builder.allocateRecord(block, lineage, fields, props), representation: props, consumed, tookChildren }
}
