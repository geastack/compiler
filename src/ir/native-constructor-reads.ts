import { nativePropertyKeyTextsOf } from './native-property-key-texts.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { DeclarationId, FunctionId } from '../identity/ids.js'
import { runtimeClassLayoutsOf, type ClassLayout } from '../projection/classes.js'
import { extendsClass } from '../projection/dispatch.js'
import { classStaticMemberOf } from '../projection/fields.js'
import { objectShapePrototypeMethods } from '../projection/callee.js'
import { representationKey, type CallableAbi, type Representation } from '../representation/model.js'
import { staticFieldSlotOf, type ClassStaticFieldSlots } from './class-static-fields.js'
import type { GetOperation, IrOperation } from './model.js'
import type { OperationConversionInput } from './operation-conversions.js'

const constructorIntrinsicKeys: ReadonlySet<string> = new Set([
  'name',
  'length',
  'prototype',
  'call',
  'apply',
  'bind',
  'arguments',
  'caller'
])

/** A complete program class can prove absence only outside the intrinsic Function and Object member domains. */
export const nativeConstructorPropertyMissing = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  declaration: DeclarationId,
  key: string
): boolean =>
  classStaticMemberOf(classes, declaration, key) === null && !constructorIntrinsicKeys.has(key) && !objectShapePrototypeMethods.has(key)

/** Constructor ABI values retain their evaluated class token, so static selection is a finite native dispatch. */
export const nativeConstructorPropertyClassesOf = (
  receiver: Representation,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  key: string | null,
  result: Representation
): readonly ClassLayout[] | null => {
  if (receiver.kind === 'constructor-family')
    return receiver.members.flatMap((declaration) => {
      const layout = classes.get(declaration)
      return layout === undefined ? [] : [layout]
    })
  if (receiver.kind !== 'constructor-value-dispatch') return null
  const instance = receiver.abi.result
  return runtimeClassLayoutsOf(classes).filter(
    (layout) =>
      layout.construct !== null &&
      (key === 'prototype' ||
        result.kind === 'dynamic' ||
        instance.kind !== 'class-ref' ||
        layout.declaration === instance.declaration ||
        extendsClass(classes, layout.declaration, instance.declaration))
  )
}

const leavesOf = (value: Representation): readonly Representation[] =>
  value.kind === 'optional'
    ? leavesOf(value.payload)
    : value.kind === 'borrowed-ref'
      ? leavesOf(value.referent)
      : value.kind === 'tagged-union'
        ? value.arms.flatMap((arm) => leavesOf(arm.value))
        : [value]

/** Internal static storage, getter results and method frames use the same selected class as native Get. */
export const nativeConstructorGetInputsOf = (
  operation: GetOperation,
  keyText: string | null,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  abis: ReadonlyMap<FunctionId, CallableAbi>,
  slots?: ClassStaticFieldSlots
): readonly OperationConversionInput[] => {
  const result = operation.result.representation
  const inputs = new Map<string, OperationConversionInput>()
  const add = (role: OperationConversionInput['role'], source: Representation, target: Representation): void => {
    if (representationKey(source) !== representationKey(target))
      inputs.set(`${role}:${representationKey(source)}->${representationKey(target)}`, { role, source, target })
  }
  for (const receiver of leavesOf(operation.receiver.representation)) {
    const candidates = nativeConstructorPropertyClassesOf(receiver, classes, keyText, result)
    if (candidates === null) continue
    for (const layout of candidates) {
      const keys = new Set<string>(keyText === null ? (operation.provenKeyTexts ?? []) : [keyText])
      if (keyText === null && operation.provenKeyTexts === undefined) {
        const seen = new Set<DeclarationId>()
        for (let current: ClassLayout | undefined = layout; current !== undefined && !seen.has(current.declaration);) {
          seen.add(current.declaration)
          for (const field of current.staticFields) keys.add(field.key)
          for (const method of current.staticMethods) keys.add(method.key)
          for (const accessor of current.staticAccessors) keys.add(accessor.key)
          for (const key of slots?.slots.get(current.staticOwner ?? current.declaration)?.keys() ?? []) keys.add(key)
          if (current.name !== null) {
            keys.add('name')
            keys.add('length')
          }
          current = current.base === null ? undefined : classes.get(current.base)
        }
      }
      for (const key of keys) {
        if (key === 'prototype') {
          if (layout.instance?.kind === 'class-ref') add('field-read', layout.instance, result)
          continue
        }
        const stored = slots === undefined ? null : staticFieldSlotOf(slots, classes, [layout.declaration], key)
        if (stored !== null) {
          add('field-read', stored, result)
          continue
        }
        const site = classStaticMemberOf(classes, layout.declaration, key)
        if (site?.kind === 'field') {
          const field = classes.get(site.owner)?.staticFields.find((candidate) => candidate.key === key)
          if (field?.representation !== undefined && field.representation !== null) add('field-read', field.representation, result)
        } else if (site?.kind === 'accessor') {
          const abi = site.accessor.getter === null ? null : abis.get(site.accessor.getter)
          if (abi !== undefined && abi !== null) add('field-read', abi.result, result)
        } else if (site?.kind === 'method') {
          const abi = site.method.callable === null ? null : abis.get(site.method.callable)
          if (abi !== undefined && abi !== null) add('method-frame', { kind: 'function-value-dispatch', abi }, result)
        } else if (site === null && key === 'name' && layout.name !== null) add('field-read', { kind: 'string' }, result)
        else if (site === null && key === 'length' && layout.length !== null)
          add('field-read', { kind: 'scalar', domain: 'number' }, result)
        else if (receiver.kind === 'constructor-value-dispatch' && nativeConstructorPropertyMissing(classes, layout.declaration, key))
          add('field-read', { kind: 'undefined' }, result)
      }
    }
  }
  return [...inputs.values()]
}

/** Only an actual selected static method body supplies callable provenance; construct ABI spelling alone does not. */
export const nativeConstructorMethodBodiesOf = (
  operation: GetOperation,
  keyText: string | null,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  operations: readonly IrOperation[],
  placements: ReadonlyMap<DeclarationId, BindingPlacement> = new Map()
): readonly FunctionId[] | null => {
  const receivers = leavesOf(operation.receiver.representation)
  if (receivers.length === 0 || receivers.some((receiver) => receiver.kind !== 'constructor-family')) return null
  const keys = keyText === null ? (operation.provenKeyTexts ?? nativePropertyKeyTextsOf(operation.key, operations, placements)) : [keyText]
  if (keys === null || keys.length === 0) return null
  const methods = new Set<FunctionId>()
  const constants = new Map(
    operations.flatMap((candidate) =>
      candidate.kind === 'constant' && (candidate.literal === 'string' || candidate.literal === 'number')
        ? [[candidate.result.id, candidate.text] as const]
        : []
    )
  )
  for (const receiver of receivers) {
    if (receiver.kind !== 'constructor-family') return null
    const candidates = nativeConstructorPropertyClassesOf(receiver, classes, keyText, operation.result.representation)
    if (candidates === null || candidates.length === 0) return null
    for (const layout of candidates)
      for (const keyText of keys) {
        const site = classStaticMemberOf(classes, layout.declaration, keyText)
        if (site?.kind !== 'method' || site.method.callable === null) return null
        if (
          operations.some((candidate) => {
            if (candidate.kind === 'set' || candidate.kind === 'define-own-property' || candidate.kind === 'delete') {
              const changedKey = constants.get(candidate.key.value)
              return (
                (changedKey === undefined || changedKey === keyText) &&
                leavesOf(candidate.receiver.representation).some(
                  (held) =>
                    held.kind === 'constructor-family' &&
                    held.members.some(
                      (member) =>
                        member === layout.declaration ||
                        member === site.owner ||
                        classes.get(member)?.staticOwner === (classes.get(site.owner)?.staticOwner ?? site.owner)
                    )
                )
              )
            }
            return (
              candidate.kind === 'call' &&
              candidate.arguments.some((argument) =>
                leavesOf(argument.representation).some(
                  (held) =>
                    held.kind === 'constructor-family' &&
                    held.members.some((member) => member === layout.declaration || member === site.owner)
                )
              )
            )
          })
        )
          return null
        methods.add(site.method.callable)
      }
  }
  return methods.size === 0 ? null : [...methods]
}
