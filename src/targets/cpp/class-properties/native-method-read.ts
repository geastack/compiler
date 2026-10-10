import type { CallableAbi, Representation } from '../../../representation/model.js'
import { abiOfCallee } from '../../../projection/callee.js'
import { classMethodValueArmsOf, methodCopyHeldBy } from '../../../projection/dispatch.js'
import { classMethodOverrideOf } from '../../../projection/fields.js'
import type { ConversionSite } from '../emit-narrowing.js'
import { cppThunkEntryText, createCppEmitBlockedError } from '../emit-context.js'
import { cppCallableDeclarationTagName, cppClassName, cppRecordFieldName, cppRecordFieldPresenceName, cppTypeOf } from '../types.js'
import { nativePrototypeMethodFallbackText, type NativeMethodReadConversion } from './native-prototype.js'

/** Read-time prototype selection preserves the Function object; invocation supplies its own logical receiver. */
export const nativeClassMethodReadText = (
  ctx: ConversionSite,
  source: Representation,
  carrier: Representation,
  key: string,
  text: string,
  convert: NativeMethodReadConversion
): string | null => {
  if (source.kind !== 'class-ref' || ctx.abiOfCallable === undefined) return null
  const held = abiOfCallee(carrier)
  // A dynamic slot holds the method's own Function value; no held frame selects among copies.
  const dynamic = carrier.kind === 'dynamic'
  const arms = classMethodValueArmsOf(ctx.classes, source.declaration, key)
  if ((held === null && !dynamic) || arms === null) return null
  const branches: string[] = []
  const valueType = cppTypeOf(carrier)
  for (const arm of arms) {
    const owner = ctx.classes.get(arm.owner)
    if (owner === undefined)
      throw createCppEmitBlockedError(
        'property-access:native-method-owner',
        `method "${key}" names a declaring class with no published layout`
      )
    const copies = owner.methods.filter((method) => method.key === key)
    const method = copies.length < 2 ? arm.method : held === null ? null : methodCopyHeldBy(copies, held, ctx.abiOfCallable)
    if (method?.callable === null || method?.callable === undefined) return null
    const ownAbi: CallableAbi | null = ctx.abiOfCallable(method.callable)
    if (ownAbi === null) return null
    const own: Representation = { kind: 'function-value-dispatch', abi: ownAbi }
    const capture = ctx.captures.of(method.callable)
    if (capture.kind !== 'none' && ctx.methodEnvironment === undefined)
      throw createCppEmitBlockedError(
        'capture:native-method-view',
        `a structural read of method "${key}" cannot name its published lexical environment in this frame`
      )
    const environment = ctx.methodEnvironment?.(method.callable, `a structural read of method "${key}"`) ?? 'nullptr'
    const entry = cppThunkEntryText({ functionFacts: ctx.functionFacts, abiOfCallable: ctx.abiOfCallable }, method.callable)
    const object = 'gea_method_object'
    const state = `${object}->gea_method_state`
    const native =
      `gea::nativeClassMethodValue<${cppClassName(owner.declaration)}, &${cppCallableDeclarationTagName(method.callable)}>` +
      `(${state}, ${cppTypeOf(own)}{${entry}, ${environment}})`
    const converted = convert('native-method-read:prototype', own, carrier, native)
    if (converted === null) return null
    const allocation = ctx.classes.get(arm.allocation)?.instance
    if (allocation?.kind !== 'class-ref') return null
    const fallback = nativePrototypeMethodFallbackText(ctx, allocation, key, owner, carrier, object, converted, false, convert)
    const override = classMethodOverrideOf(ctx.classes, arm.allocation, key)
    let selection = `return ${fallback};`
    if (override !== null) {
      const stored = convert('native-method-read:own', override.value, carrier, `${object}->${cppRecordFieldName(key)}`)
      if (stored === null) return null
      selection = `if (${object}->${cppRecordFieldPresenceName(key)}) return ${stored}; ${selection}`
    }
    branches.push(
      `if (gea::host::hasNativeClassLayoutRef<${cppClassName(arm.allocation)}>(gea_method_receiver)) { ` +
        `const auto ${object} = gea::Ref<void>(gea_method_receiver).staticCast<${cppClassName(arm.allocation)}>(); ${selection} }`
    )
  }
  return (
    `[&](const auto& gea_method_receiver) -> ${valueType} { ` +
    `${branches.join(' ')} gea::host::throwRuntimeError("TypeError", "a native method read names no authenticated class allocation"); }(${text})`
  )
}
