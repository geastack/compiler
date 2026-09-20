import type { DeclarationId } from '../../../identity/ids.js'
import type { Representation } from '../../../representation/model.js'
import type { ClassLayout } from '../../../projection/classes.js'
import { classPrototypeReadOf } from '../../../projection/class-prototype.js'
import { classMethodOverrideOf, classPrototypeMethodMutableOf, classPrototypeMethodFamilyMutableOf } from '../../../projection/fields.js'
import { createCppEmitBlockedError, type EmitContext } from '../emit-context.js'
import { alignedValueText } from '../emit-narrowing.js'
import {
  cppClassName,
  cppRecordFieldAttributesName,
  cppRecordFieldKeyIsSymbol,
  cppRecordFieldName,
  cppRecordFieldPresenceName,
  cppTypeOf
} from '../types.js'

export const nativePrototypeObjectText = (
  ctx: EmitContext,
  receiver: Extract<Representation, { kind: 'constructor-family' }>,
  result: Representation,
  receiverText: string,
  originalMethod: (
    owner: ClassLayout,
    method: ClassLayout['methods'][number],
    state: string
  ) => { text: string; representation: Representation }
): string => {
  if (receiver.members.length > 1) return familyPrototypeObjectText(ctx, receiver, result, receiverText, originalMethod)
  const layout = classPrototypeReadOf(ctx.classes, receiver, 'prototype', result)
  if (layout === null || layout.instance?.kind !== 'class-ref') {
    const reasons = receiver.members.length === 1 ? ctx.classes.get(receiver.members[0]!)?.prototypeUnsupportedUses : undefined
    if (reasons?.length) throw createCppEmitBlockedError('property-access:class-prototype:method-only', reasons.join('; '))
    throw createCppEmitBlockedError(
      'property-access:class-prototype:layout',
      'prototype read has no admitted native method-only class layout'
    )
  }
  const declaration = layout.declaration
  const chain: ClassLayout[] = []
  for (let current: DeclarationId | null = declaration; current !== null;) {
    // The shared projection authority has checked every ancestor and cycles.
    const entry: ClassLayout = ctx.classes.get(current)!
    chain.push(entry)
    current = entry.base
  }
  const clear = new Set<string>()
  const physicalAccessors = (entry: ClassLayout) =>
    entry.instance?.kind === 'class-ref'
      ? (ctx.layouts.accessorsForShape?.(entry.instance.shapeId) ?? []).filter((accessor) => !cppRecordFieldKeyIsSymbol(accessor.key))
      : []
  for (const entry of chain) {
    if (entry.instance?.kind === 'class-ref') {
      for (const field of ctx.layouts.forShape(entry.instance.shapeId) ?? []) clear.add(field.key)
    }
    // Semantic class accessors dispatch through bodies and need not allocate
    // record-property slots. Only the shared physical layout owns these bits.
    for (const accessor of physicalAccessors(entry)) clear.add(accessor.key)
  }
  const initialize = [...clear].map((key) => `gea_prototype->${cppRecordFieldPresenceName(key)} = false;`)
  for (const accessor of physicalAccessors(layout)) initialize.push(`gea_prototype->${cppRecordFieldPresenceName(accessor.key)} = true;`)
  for (const method of layout.methods) {
    const slot = classMethodOverrideOf(ctx.classes, declaration, method.key)
    if (slot === null || method.callable === null) continue
    const original = originalMethod(layout, method, 'gea_prototype->gea_method_state')
    const value = alignedValueText(ctx, 'native-prototype:initial-method', original.representation, slot.value, original.text)
    if (value === null)
      throw createCppEmitBlockedError(
        'property-access:class-prototype:method-slot',
        `prototype method ${method.key} cannot fill its native slot`
      )
    initialize.push(`gea_prototype->${cppRecordFieldName(method.key)} = ${value};`)
    initialize.push(`gea_prototype->${cppRecordFieldPresenceName(method.key)} = true;`)
    initialize.push(`gea_prototype->${cppRecordFieldAttributesName(method.key)}.enumerable = false;`)
  }
  const prototype = `gea::nativeClassPrototype<${cppClassName(declaration)}>(gea::nativeClassMethodStateFromEnvironment(${receiverText}.environment), [&](const auto& gea_prototype) { ${initialize.join(' ')} })`
  const converted = alignedValueText(ctx, 'native-prototype:result', layout.instance, result, prototype)
  if (converted === null)
    throw createCppEmitBlockedError(
      'property-access:class-prototype:result',
      'prototype native layout cannot fill the published class carrier'
    )
  return converted
}

/**
 * `C.prototype` where `C` may hold more than one class -- `global.Response`,
 * which `@hono/node-server` replaces with its own subclass. The class
 * evaluation the value carries names which one it is, and each member's
 * prototype is built as a lone class's would be and stored as the published
 * carrier.
 */
const familyPrototypeObjectText = (
  ctx: EmitContext,
  receiver: Extract<Representation, { kind: 'constructor-family' }>,
  result: Representation,
  receiverText: string,
  originalMethod: Parameters<typeof nativePrototypeObjectText>[4]
): string => {
  const branches = receiver.members.map((member) => {
    const instance = ctx.classes.get(member)?.instance
    if (instance?.kind !== 'class-ref')
      throw createCppEmitBlockedError('property-access:class-prototype:layout', `family member ${member} has no native class layout`)
    const own = nativePrototypeObjectText(ctx, { ...receiver, members: [member] }, instance, 'gea_constructor', originalMethod)
    const stored = alignedValueText(ctx, 'native-prototype:family-result', instance, result, own)
    if (stored === null)
      throw createCppEmitBlockedError(
        'property-access:class-prototype:result',
        `the prototype of family member ${member} cannot fill the published class carrier`
      )
    return `if (gea_state->declaration == &gea::nativeClassMethodDeclaration<${cppClassName(member)}>) return ${stored};`
  })
  return (
    `[&](const auto& gea_constructor) -> ${cppTypeOf(result)} { ` +
    `const auto gea_state = gea::nativeClassMethodStateFromEnvironment(gea_constructor.environment); ` +
    `if (gea_state) { ${branches.join(' ')} } ` +
    `gea::host::throwRuntimeError("TypeError", "a constructor's prototype names no class this program compiled"); }(${receiverText})`
  )
}

/** Add live prototype lookup beneath the instance's own-method shadow. */
export const nativePrototypeMethodFallbackText = (
  ctx: EmitContext,
  receiver: Representation,
  key: string,
  owner: ClassLayout,
  valueRepresentation: Representation,
  receiverText: string,
  original: string,
  superAccess: boolean
): string => {
  if (receiver.kind !== 'class-ref') return original
  const mutable = superAccess
    ? classPrototypeMethodMutableOf(ctx.classes, receiver.declaration, key)
    : classPrototypeMethodFamilyMutableOf(ctx.classes, receiver.declaration, key)
  if (!mutable) return original
  const slot = classMethodOverrideOf(ctx.classes, owner.declaration, key)
  if (slot === null) return original
  const type = cppTypeOf(valueRepresentation)
  const held = alignedValueText(
    ctx,
    'native-prototype:live-method',
    slot.value,
    valueRepresentation,
    `gea_prototype.${cppRecordFieldName(key)}`
  )
  if (held === null)
    throw createCppEmitBlockedError(
      'property-access:class-prototype:live-method',
      `prototype method ${key} cannot fill its read convention`
    )
  const state = `${receiverText}->gea_method_state`
  const start = superAccess ? `gea::nativeClassPrototypeLookupStart<${cppClassName(receiver.declaration)}>(${state})` : state
  return `gea::nativeClassPrototypeMethod<${cppClassName(owner.declaration)}>(${start}, ${original}, [](const ${cppClassName(owner.declaration)}& gea_prototype) -> std::optional<${type}> { if (gea_prototype.${cppRecordFieldPresenceName(key)}) return ${held}; return std::nullopt; })`
}
