import type { CallOperation } from '../../../ir/model.js'
import { nativeReflectFieldTransportOf } from '../../../ir/native-reflect-field.js'
import { createCppEmitBlockedError, operandText, type EmitContext } from '../emit-context.js'
import { boxedValueText, propertyKeyText, unboxedReadText } from '../emit-dynamic-properties.js'
import { regexpRoleOf } from '../prototype/emit-prototype-regexp.js'
import { declaredRecordFieldOf } from '../records.js'
import { cppTypeOf } from '../types.js'
import { alignedValueText } from '../emit-narrowing.js'
import { getOwnPropertyDescriptorText } from './emit-host-object.js'
import { unaddressableNativeSymbolKeyOf } from '../native-symbol-keys.js'

const ownKeysCallText = (ctx: EmitContext, operation: CallOperation): string => {
  const target = operation.arguments[0]
  const site = 'Reflect.ownKeys'
  const refuse = (reason: string): never => {
    throw createCppEmitBlockedError(`host-member-call:${site}`, reason)
  }
  if (!target || operation.argumentsAreSpread) return refuse('own-key enumeration requires a known target operand')
  const representation = target.representation
  const unsupportedSymbol = unaddressableNativeSymbolKeyOf(ctx, representation)
  if (unsupportedSymbol !== null) return refuse(`fixed symbol key ${unsupportedSymbol} has no retained runtime identity`)
  const receiver = operandText(ctx, target)
  const generated =
    representation.kind === 'record' ||
    representation.kind === 'record-with-index' ||
    representation.kind === 'class-ref' ||
    (representation.kind === 'native-record-ref' && representation.native === null)
  let preparation: string
  if (representation.kind === 'dynamic') {
    preparation = `const auto& __gea_target = ${receiver}; if (!gea::isObjectValue(__gea_target)) gea::host::throwRuntimeError("TypeError", "Reflect.ownKeys target must be an object"); const auto __gea_keys = __gea_target.ownPropertyKeys(); `
  } else if ((generated && representation.ownership === 'shared-refcount') || regexpRoleOf(representation) === 'pattern') {
    preparation = `const auto& __gea_target = ${receiver}; if (!__gea_target) gea::host::throwRuntimeError("TypeError", "Reflect.ownKeys target must be an object"); const auto __gea_keys = gea::nativeOwnPropertyKeys(__gea_target); `
  } else return refuse('the target has no supported native own-key protocol')
  if (!operation.result) return `([&]() { ${preparation}(void)__gea_keys; })()`
  const result = operation.result.representation
  if (result.kind !== 'array-object' || result.ownership !== 'shared-refcount') return refuse('the key list has no native array carrier')
  const stringKey = alignedValueText(ctx, site, { kind: 'string' }, result.element, '__gea_key.text()')
  const symbolKey = alignedValueText(
    ctx,
    site,
    { kind: 'symbol' },
    result.element,
    'gea::Symbol(static_cast<std::uint32_t>(__gea_key.symbolId()))'
  )
  if (stringKey === null || symbolKey === null) return refuse('the key element cannot retain both strings and symbols')
  return (
    `([&]() -> ${cppTypeOf(result)} { ${preparation}auto __gea_result = gea::makeRef<gea::ArrayObject<${cppTypeOf(result.element)}>>(); ` +
    `for (const auto& __gea_key : __gea_keys) { if (__gea_key.isSymbol()) __gea_result->push(${symbolKey}); ` +
    `else __gea_result->push(${stringKey}); } return __gea_result; })()`
  )
}

const methods = new Map([
  ['gea::reflectGet', 'get'],
  ['gea::reflectSet', 'set'],
  ['gea::reflectHas', 'has'],
  ['gea::reflectDelete', 'deleteProperty']
])

/** Reflect over native data storage. Unsupported layouts must not enter a boxed host call implicitly. */
export const nativeReflectCallText = (ctx: EmitContext, operation: CallOperation, spelling: string): string | null => {
  if (spelling === 'gea::reflectOwnKeys({arg0})') return ownKeysCallText(ctx, operation)
  if (spelling === 'gea::reflectOwnDescriptor') {
    const target = operation.arguments[0]
    if (!target || target.representation.kind === 'dynamic') return null
    const representation = target.representation
    const generated =
      representation.kind === 'record' ||
      representation.kind === 'record-with-index' ||
      representation.kind === 'class-ref' ||
      (representation.kind === 'native-record-ref' && representation.native === null)
    if (!generated || operation.arguments.length !== 2 || operation.argumentsAreSpread) {
      throw createCppEmitBlockedError(
        'host-member-call:Reflect.getOwnPropertyDescriptor',
        'this native target or argument list has no supported descriptor protocol; the target must not be boxed'
      )
    }
    // Object and Reflect query the same own descriptor once the receiver is
    // known to be an object. Reflect additionally rejects a null native ref.
    const descriptor = getOwnPropertyDescriptorText(ctx, operation)
    if (representation.ownership !== 'shared-refcount') return descriptor
    return (
      `([&]() { if (!${operandText(ctx, target)}) gea::host::throwRuntimeError("TypeError", ` +
      `"Reflect.getOwnPropertyDescriptor target must be an object"); return ${descriptor}; })()`
    )
  }
  const method = methods.get(spelling)
  if (!method) return null
  const target = operation.arguments[0]
  if (!target || target.representation.kind === 'dynamic') return null
  const refuse = (reason: string): never => {
    // Same shape as Atomics' own call-support rule (`atomics.ts`): whether
    // this particular target/argument shape has a native recipe is a target
    // RULE over the call, not a manifest-registered set, so `host-member-call`
    // is the family even though the callee's own `host-invocation` demand
    // (raised at certify time) already passed.
    throw createCppEmitBlockedError(`host-member-call:Reflect.${method}`, `${reason}; native reflection cannot silently box its target`)
  }
  const representation = target.representation
  const expected = method === 'set' ? 3 : 2
  if (operation.arguments.length !== expected) return refuse('explicit receivers or omitted arguments have no native recipe')
  const key = operation.arguments[1]
  if (!key) return refuse('the property key is missing')
  const receiver = operandText(ctx, target)
  const site = `Reflect.${method} on a native target`
  const callable =
    representation.kind === 'function' ||
    representation.kind === 'function-family' ||
    representation.kind === 'function-value-family' ||
    representation.kind === 'function-value-dispatch' ||
    representation.kind === 'function-and-constructor'
  // Reflect's target stays a Callable(Constructor)Object. The one Value at
  // this boundary is the property payload, never a conversion of the target
  // that would erase its call/construct ABI intersection.
  if (callable) {
    const property = propertyKeyText(ctx, key, site)
    const constructorSetup =
      representation.kind === 'function-and-constructor'
        ? `if (!__gea_key.isSymbol() && __gea_key.text() == "prototype") gea::installCallableConstructorPrototype(__gea_callable); `
        : ''
    const prepare =
      `const auto& __gea_callable = ${receiver}; gea::installCallableOwnFacts(__gea_callable.functionObjectIdentity(), __gea_callable.name(), __gea_callable.length()); ` +
      `const gea::PropertyKey __gea_key = ${property}; ${constructorSetup}`
    if (method === 'get') {
      if (!operation.result) return `(void)gea::callableDynamicGet(${receiver}, ${property})`
      return unboxedReadText(operation.result.representation, `gea::callableDynamicGet(${receiver}, ${property})`, site)
    }
    if (method === 'has') {
      return `([&]() -> bool { ${prepare} return __gea_callable.functionObjectIdentity()->properties->hasProperty(__gea_key) || gea::callableDynamicGet(__gea_callable, __gea_key).tag() != gea::Value::Tag::Undefined; })()`
    }
    if (method === 'deleteProperty') {
      return `([&]() -> bool { ${prepare} return __gea_callable.functionObjectIdentity()->properties->deleteOwnProperty(__gea_key); })()`
    }
    return (
      `([&]() -> bool { ${prepare} return __gea_callable.functionObjectIdentity()->properties->set(__gea_key, ` +
      `${boxedValueText(ctx, operation.arguments[2]!, site)}, gea::Value::box(gea::Value::Tag::Function, __gea_callable)); })()`
    )
  }
  // Pattern is native, not a generated record, but its `lastIndex` hook is
  // the exact same fixed-own-property protocol. Keep the receiver native and
  // use the runtime dispatch only at the PropertyKey/Value reflection boundary.
  if (regexpRoleOf(target.representation) === 'pattern') {
    const property = propertyKeyText(ctx, key, site)
    if (method === 'get') {
      if (!operation.result) return `(void)gea::runtime::regex::dynamicGet(${receiver}, ${property})`
      return unboxedReadText(operation.result.representation, `gea::runtime::regex::dynamicGet(${receiver}, ${property})`, site)
    }
    if (method === 'has') return `gea::runtime::regex::dynamicHas(${receiver}, ${property})`
    if (method === 'deleteProperty') return `gea::nativeDynamicDelete(${receiver}, ${property})`
    return `gea::runtime::regex::dynamicSet(${receiver}, ${property}, ${boxedValueText(ctx, operation.arguments[2]!, site)})`
  }
  const generated =
    representation.kind === 'record' ||
    representation.kind === 'record-with-index' ||
    representation.kind === 'class-ref' ||
    // An Array's ordinary own properties live in the same identity-keyed
    // expando table `emit-dynamic-properties.ts`'s `nativeSidecarReceiver`
    // already grants `p[key] = v` on one; `Reflect.get(p, key)` reads the
    // same table.
    representation.kind === 'array-object' ||
    (representation.kind === 'native-record-ref' && representation.native === null)
  if (!generated || representation.ownership !== 'shared-refcount') return refuse('the target has no generated shared record layout')
  const property = propertyKeyText(ctx, key, site)
  const staticKey = ctx.staticKeyTexts.get(key.value)
  const field = staticKey === undefined ? null : declaredRecordFieldOf(ctx.deriver, representation, staticKey, ctx.classes)
  const transport = nativeReflectFieldTransportOf(operation, field)
  if (method === 'get') {
    const read = `gea::nativeDynamicGet(${receiver}, ${property})`
    if (!operation.result) return `(void)${read}`
    const decoded = unboxedReadText(operation.result.representation, read, site)
    return transport === 'native-read'
      ? `gea::nativeFieldGet<${cppTypeOf(operation.result.representation)}>(${receiver}, ${property}, [&]() { return ${decoded}; })`
      : decoded
  }
  if (method === 'has') return `gea::nativeDynamicHasProperty(${receiver}, ${property})`
  if (method === 'deleteProperty') return `gea::nativeDynamicDelete(${receiver}, ${property})`
  if (transport === 'native-write') {
    const value = operation.arguments[2]!
    return `gea::nativeFieldSet(${receiver}, ${property}, static_cast<${cppTypeOf(value.representation)}>(${operandText(ctx, value)}))`
  }
  return `gea::nativeDynamicSet(${receiver}, ${property}, ${boxedValueText(ctx, operation.arguments[2]!, site)})`
}
