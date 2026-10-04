import type { GetOperation } from '../../ir/model.js'
import { representationKey } from '../../representation/model.js'
import { createCppEmitBlockedError, operandText, type EmitContext } from './emit-context.js'
import { typedArrayNameOf } from './emit-buffers.js'
import { alignedValueText } from './emit-narrowing.js'
import { dispatchedLeafExpression, unionPropertyLeaves } from './emit-union-properties.js'
import { cppStringLiteral } from './types.js'

/**
 * `array.constructor` off a standard typed array: the array itself, standing
 * for its constructor (`representation/model.ts`'s `typed-array-constructor`).
 */
export const typedArrayConstructorGetText = (ctx: EmitContext, operation: GetOperation): string | null => {
  const result = operation.result.representation
  if (result.kind !== 'typed-array-constructor') return null
  if (ctx.staticKeyTexts.get(operation.key.value) !== 'constructor')
    throw createCppEmitBlockedError(
      'property-access:typed-array-constructor:get:false',
      'a typed array constructor is published only by a "constructor" read'
    )
  return alignedValueText(
    ctx,
    'emit-typed-array-constructor.ts:constructor',
    operation.receiver.representation,
    result.instance,
    operandText(ctx, operation.receiver)
  )
}

/**
 * `array.constructor.name`: the [[TypedArrayName]] of the array's own class,
 * one constant per arm of a union. Only `name` is answered; the constructor
 * as an object (`new`, `===`, its statics) has no carrier here.
 */
export const typedArrayConstructorMemberText = (ctx: EmitContext, operation: GetOperation): string | null => {
  const receiver = operation.receiver.representation
  if (receiver.kind !== 'typed-array-constructor') return null
  const key = ctx.staticKeyTexts.get(operation.key.value)
  if (key !== 'name')
    throw createCppEmitBlockedError(
      'property-access:typed-array-constructor:get:false',
      `"${key ?? '<computed>'}" of a typed array's constructor has no recipe; only its "name" does`
    )
  const leaves = unionPropertyLeaves(receiver.instance, operandText(ctx, operation.receiver))
  const names = leaves.map((leaf) => (leaf.representation.kind === 'typed-array' ? typedArrayNameOf(leaf.representation) : null))
  const unhandled = leaves.find((_, index) => names[index] === null)
  if (unhandled !== undefined)
    throw createCppEmitBlockedError(
      'property-access:typed-array-constructor:get:false',
      `"name" of the constructor of an arm carried as "${representationKey(unhandled.representation)}" is no typed array's`
    )
  const name = dispatchedLeafExpression(
    leaves,
    names.map((entry) => `std::string(${cppStringLiteral(entry ?? '')})`)
  )
  if (name === null) return null
  return alignedValueText(ctx, 'emit-typed-array-constructor.ts:name', { kind: 'string' }, operation.result.representation, name)
}
