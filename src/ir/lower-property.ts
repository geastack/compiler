import type { IrBlockId } from './model.js'
import { narrowedOperandView } from '../conversion/operand-view.js'
import { callableOwnPrototypeAt } from '../semantics/callable-origins.js'
import type { PropertyOperation } from '../semantics/model/operations.js'
import { resultOf } from '../semantics/model/operands.js'
import { IrLoweringBlockedError } from './lower-graph.js'
import { pendingShortCircuitOf } from './lower-short-circuit.js'
import { methodValueOriginOf } from '../projection/callee.js'
import { propertyReadResultRepresentationOf } from '../projection/fields.js'
import { typedComputedReadRecipeOf, typedComputedWriteRecipeOf } from './typed-property-access.js'
import {
  namedOperand,
  optionalResultRepresentation,
  registerResult,
  requireLineage,
  requireResultRepresentation,
  resolveRequiredOperand,
  type LoweringContext,
  convertOrDrift,
  enterRequiredOperand,
  narrowedBindingRead,
  reactiveFieldReadOf
} from './lower-operands.js'

/**
 * Lowering the property family: the six object internal methods, and nothing
 * else.
 *
 * Property syntax has exactly one route to the runtime -- `[[Get]]`, `[[Set]]`,
 * `[[Delete]]`, `[[HasProperty]]`, `[[OwnPropertyKeys]]`,
 * `[[DefineOwnProperty]]` (`ir/model.ts`) -- so this file is a dispatch over
 * `internalMethod` with no second, source-shaped path for a property
 * expression to take. It lives apart from `lower.ts` for the same reason
 * `lower-element.ts` and `lower-destructuring.ts` do: one family, one file.
 */
/**
 * The class method body a property read names when it reads a method as a
 * VALUE: a callable carrier stating a receiver, read by a constant key off a
 * class instance (or a class constructor, for a static). What `enter` binds
 * the receiver to when the value reaches a receiver-less slot.
 */
export const lowerProperty = (ctx: LoweringContext, block: IrBlockId, operation: PropertyOperation): void => {
  const lineage = requireLineage(operation)
  if (operation.internalMethod === 'get' && operation.resolvedBinding !== undefined) {
    const representation = requireResultRepresentation(ctx, operation, 'value', 'a resolved binding property read')
    const value = narrowedBindingRead(ctx, block, lineage, operation, operation.resolvedBinding, representation)
    registerResult(ctx, operation, value)
    if (operation.shortCircuitAlwaysPresent) {
      const expression = resultOf(operation, 'short-circuit')
      if (expression) ctx.values.set(expression.id, value)
      return
    }
    const pending = pendingShortCircuitOf(ctx, operation, { value, representation })
    if (pending) ctx.shortCircuits.set(pending.result, pending)
    return
  }
  const receiverOperand = namedOperand(operation, 'receiver')
  const incoming = resolveRequiredOperand(ctx, block, lineage, receiverOperand)
  const view = narrowedOperandView(incoming.representation, receiverOperand, ctx.constantDeriver)
  const receiver = convertOrDrift(ctx, block, lineage, operation.id, 'receiver', receiverOperand.ordinal, incoming, view, 'receiver-view')
  switch (operation.internalMethod) {
    case 'own-property-keys': {
      const representation = requireResultRepresentation(ctx, operation, 'value', 'an own-property-keys operation')
      registerResult(ctx, operation, ctx.builder.ownPropertyKeys(block, lineage, receiver, representation))
      return
    }
    case 'get': {
      const keyOperand = namedOperand(operation, 'key')
      const key = resolveRequiredOperand(ctx, block, lineage, keyOperand)
      const representation = requireResultRepresentation(ctx, operation, 'value', 'a property get operation')
      const reactive =
        keyOperand.source.kind === 'constant'
          ? reactiveFieldReadOf(ctx.program.classes, receiver.representation, keyOperand.source.text, ctx.program.reactiveFields)
          : false
      const held =
        keyOperand.source.kind === 'constant'
          ? propertyReadResultRepresentationOf(
              ctx.constantDeriver,
              ctx.program.classes,
              ctx.program.abis,
              receiver.representation,
              keyOperand.source.text
            )
          : null
      // The declaration's own `prototype` fact, asked once and carried on the
      // read (`GetOperation.callableOwnPrototype`). The printer cannot ask:
      // the census lives on the semantic graph, and by emission time only the
      // carrier is left -- which is precisely the authority that used to
      // answer this question by accident.
      const callableOwnPrototype =
        keyOperand.source.kind === 'constant' &&
        keyOperand.source.text === 'prototype' &&
        receiver.representation.kind === 'function-value-dispatch'
          ? (callableOwnPrototypeAt(ctx.graph, operation) ?? undefined)
          : undefined
      const typedComputedRead = typedComputedReadRecipeOf(
        ctx.graph,
        operation,
        receiver.representation,
        held ?? representation,
        key.representation,
        ctx.constantDeriver,
        ctx.program.classes,
        ctx.program.conversions
      )
      const raw = ctx.builder.get(
        block,
        lineage,
        receiver,
        key,
        held ?? representation,
        operation.hostMethod,
        reactive,
        callableOwnPrototype,
        operation.normalResult,
        typedComputedRead ?? undefined,
        operation.provenKeyTexts
      )
      const value =
        held === null
          ? raw
          : convertOrDrift(ctx, block, lineage, operation.id, 'read', 0, { value: raw, representation: held }, representation, 'field-read')
              .value
      registerResult(ctx, operation, value)
      const method =
        keyOperand.source.kind === 'constant'
          ? methodValueOriginOf(ctx.program.classes, receiver.representation, keyOperand.source.text, representation)
          : null
      if (method !== null) ctx.program.methodValueReceivers.set(value, { receiver, method })
      if (operation.shortCircuitAlwaysPresent) {
        const expression = resultOf(operation, 'short-circuit')
        if (expression) ctx.values.set(expression.id, value)
        return
      }
      // `a?.b` publishes a second value -- what the *expression* evaluates to --
      // which is a merge this arm cannot close. It is recorded and settled once
      // an operation outside the guard runs (`lower-short-circuit.ts`).
      const pending = pendingShortCircuitOf(ctx, operation, { value, representation })
      if (pending) ctx.shortCircuits.set(pending.result, pending)
      return
    }
    case 'has-property': {
      const key = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'key'))
      const representation = requireResultRepresentation(ctx, operation, 'value', 'a has-property operation')
      registerResult(ctx, operation, ctx.builder.hasProperty(block, lineage, receiver, key, representation))
      return
    }
    case 'delete': {
      const key = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'key'))
      registerResult(
        ctx,
        operation,
        ctx.builder.delete(block, lineage, receiver, key, operation.strict, optionalResultRepresentation(ctx, operation, 'value'))
      )
      return
    }
    case 'set': {
      const key = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'key'))
      const value = enterRequiredOperand(ctx, block, lineage, operation, namedOperand(operation, 'value'))
      registerResult(
        ctx,
        operation,
        ctx.builder.set(
          block,
          lineage,
          receiver,
          key,
          value,
          operation.strict,
          optionalResultRepresentation(ctx, operation, 'value'),
          typedComputedWriteRecipeOf(ctx.graph, operation, receiver.representation, ctx.constantDeriver, ctx.program.classes) ?? undefined,
          operation.provenKeyTexts
        )
      )
      return
    }
    case 'define-own-property': {
      const key = resolveRequiredOperand(ctx, block, lineage, namedOperand(operation, 'key'))
      const value = enterRequiredOperand(ctx, block, lineage, operation, namedOperand(operation, 'value'))
      // The attributes are the operation's own, never defaults chosen here: a
      // definition with no stated descriptor is an unanswerable question, not
      // a permissive one, and guessing would install a property the source
      // never described.
      const descriptor = operation.descriptor
      if (!descriptor) {
        throw new IrLoweringBlockedError('a define-own-property operation states no descriptor for the IR to install')
      }
      registerResult(
        ctx,
        operation,
        ctx.builder.defineOwnProperty(
          block,
          lineage,
          receiver,
          key,
          value,
          { writable: descriptor.writable, enumerable: descriptor.enumerable, configurable: descriptor.configurable },
          optionalResultRepresentation(ctx, operation, 'value')
        )
      )
      return
    }
  }
}
