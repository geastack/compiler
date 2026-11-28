import type { GetOperation } from '../../ir/model.js'
import { runtimeClassLayoutsOf } from '../../projection/classes.js'
import { representationKey, type Representation } from '../../representation/model.js'
import { createCppEmitBlockedError, operandText, type EmitContext } from './emit-context.js'
import { alignedValueText } from './emit-narrowing.js'
import { dispatchedLeafExpression, unionPropertyLeaves, type UnionPropertyLeaf } from './emit-union-properties.js'
import { isNativeError } from './error-types.js'
import { cppClassName, cppStringLiteral } from './types.js'

const errorHandle = 'gea::Ref<gea::runtime::Error>'

/** An Error instance's own handle as the intrinsic error it derives from in place, or `null` for any other carrier. */
const errorInstanceText = (carrier: Representation, text: string): string | null => {
  if (isNativeError(carrier)) return text
  // A compiled `class X extends Error` struct derives from the intrinsic at
  // offset zero, so the handle converts by the pointer alone: nothing about
  // the instance's members is read, only which object it is.
  if (carrier.kind === 'class-ref' && carrier.nativeBase !== undefined && isNativeError(carrier.nativeBase))
    return `${errorHandle}(${text})`
  return null
}

/**
 * `e.constructor` where `e` may be an intrinsic Error: the instance itself,
 * standing for its constructor (`representation/model.ts`'s
 * `error-constructor`). Per arm of a union, each arm's handle upcast to the
 * intrinsic error.
 */
export const errorConstructorGetText = (ctx: EmitContext, operation: GetOperation): string | null => {
  if (operation.result.representation.kind !== 'error-constructor') return null
  if (ctx.staticKeyTexts.get(operation.key.value) !== 'constructor')
    throw createCppEmitBlockedError(
      'property-access:error-constructor:get:false',
      'an Error constructor is published only by a "constructor" read'
    )
  const receiver = operation.receiver.representation
  const text = operandText(ctx, operation.receiver)
  // Filled rather than joined: the helper's leaves and a literal leaf are two
  // native layouts of `UnionPropertyLeaf[]`, and a join selected one unchecked.
  const leaves: UnionPropertyLeaf[] = []
  if (receiver.kind === 'tagged-union') leaves.push(...unionPropertyLeaves(receiver, text))
  else leaves.push({ representation: receiver, text, test: 'true' })
  const texts = leaves.map((leaf) => errorInstanceText(leaf.representation, leaf.text))
  const unhandled = leaves.find((_, index) => texts[index] === null)
  if (unhandled !== undefined)
    throw createCppEmitBlockedError(
      'property-access:error-constructor:get:false',
      `"constructor" of an arm carried as "${representationKey(unhandled.representation)}" is no Error instance's constructor`
    )
  const handles = texts.filter((entry): entry is string => entry !== null)
  const [sole] = handles
  if (receiver.kind !== 'tagged-union') return sole ?? null
  return dispatchedLeafExpression(leaves, handles)
}

/**
 * `e.constructor.name` off an `error-constructor`: the `[[Name]]` of the
 * constructor that allocated `e`. A compiled Error subclass is recognized by
 * the exact class layout of the allocation (`hasNativeClassLayoutRef` -- the
 * identity the block header records), and answers the name its constructor
 * object states; anything else is an intrinsic error, whose runtime kind IS
 * its constructor's name. A candidate that declares its own static `name`
 * shadows that fact, and the read refuses rather than guess.
 */
export const errorConstructorMemberText = (ctx: EmitContext, operation: GetOperation): string | null => {
  if (operation.receiver.representation.kind !== 'error-constructor') return null
  const key = ctx.staticKeyTexts.get(operation.key.value)
  if (key !== 'name')
    throw createCppEmitBlockedError(
      'property-access:error-constructor:get:false',
      `"${key ?? '<computed>'}" of an Error's constructor has no recipe; only its "name" does`
    )
  const candidates = runtimeClassLayoutsOf(ctx.classes)
    .filter(
      (layout) =>
        layout.instance?.kind === 'class-ref' && layout.instance.nativeBase !== undefined && isNativeError(layout.instance.nativeBase)
    )
    .sort((left, right) => String(left.declaration).localeCompare(String(right.declaration)))
  const shadowed = candidates.find(
    (layout) =>
      layout.name === null ||
      layout.staticFields.some((field) => field.key === 'name') ||
      layout.staticMethods.some((method) => method.key === 'name') ||
      layout.staticAccessors.some((accessor) => accessor.key === 'name')
  )
  if (shadowed !== undefined)
    throw createCppEmitBlockedError(
      'property-access:error-constructor:get:false',
      `class ${shadowed.declaration} states no [[Name]] of its own constructor object to read`
    )
  const branches = candidates.map(
    (layout) =>
      `if (gea::host::hasNativeClassLayoutRef<${cppClassName(layout.declaration)}>(gea_error)) return std::string(${cppStringLiteral(layout.name ?? '')});`
  )
  const name =
    `([&](const ${errorHandle}& gea_error) -> std::string { ` +
    `if (!gea_error) gea::host::throwRuntimeError("TypeError", "Cannot read properties of undefined (reading 'name')"); ` +
    `${branches.join(' ')} return gea_error->constructorName(); }(${operandText(ctx, operation.receiver)}))`
  return alignedValueText(ctx, 'emit-error-constructor.ts:name', { kind: 'string' }, operation.result.representation, name)
}
