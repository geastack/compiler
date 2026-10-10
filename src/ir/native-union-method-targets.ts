import type { DeclarationId, IrValueId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import { classFamilyOverridesOf } from '../projection/dispatch.js'
import { classMemberOf, classMethodOverrideOf, classStaticMemberOf } from '../projection/fields.js'
import { abiOfCallee } from '../projection/callee.js'
import type { Representation } from '../representation/model.js'
import type { CallOperation, CallUnionArmTarget, IrOperation } from './model.js'

/** All union arms must resolve through the same closed member authority. */
export const nativeUnionMethodTargetsOf = (
  representation: Representation,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  key: string,
  path: readonly number[] = []
): readonly CallUnionArmTarget[] | null => {
  if (representation.kind === 'tagged-union') {
    const arms: CallUnionArmTarget[] = []
    for (const [index, arm] of representation.arms.entries()) {
      const nested = nativeUnionMethodTargetsOf(arm.value, classes, key, [...path, index])
      if (nested === null) return null
      arms.push(...nested)
    }
    return arms
  }
  // A static through one arm's class constructor
  // (`codecsByKey[k].fromJSON(...)`): the class's own static body,
  // which takes no receiver -- the caller states that with an unbound call.
  if (representation.kind === 'constructor-family') {
    const [member, ...others] = representation.members
    if (member === undefined || others.length !== 0) return null
    const site = classStaticMemberOf(classes, member, key)
    if (site === null || site.kind !== 'method' || site.method.callable === null) return null
    return [{ path, declaration: member, functionId: site.method.callable, static: true }]
  }
  if (representation.kind !== 'class-ref') return null
  if (classMethodOverrideOf(classes, representation.declaration, key)) return null
  const site = classMemberOf(classes, representation.declaration, key)
  if (site === null || site.kind !== 'method' || site.method.callable === null) return null
  if (classFamilyOverridesOf(classes, representation.declaration, key).length > 0) return null
  return [{ path, declaration: representation.declaration, functionId: site.method.callable }]
}

/** A published native arm must name the actual Function selected by the Get, even when another Function shares its ABI. */
export const nativeUnionMethodTargetMatches = (
  operation: CallOperation,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  definitionOf: (value: IrValueId) => IrOperation | null
): boolean => {
  const target = operation.target
  if (target?.kind !== 'union-arm') return true
  const read = definitionOf(operation.callee.value)
  const actual = operation.thisArgument ?? operation.receiver
  const statics = target.arms.every((arm) => arm.static === true)
  if (
    read?.kind !== 'get' ||
    read.result.id !== operation.callee.value ||
    (statics
      ? actual !== null && actual !== undefined
      : actual?.value !== read.receiver.value || abiOfCallee(operation.callee.representation)?.receiver == null)
  )
    return false
  const key = definitionOf(read.key.value)
  if (key?.kind !== 'constant' || key.result.id !== read.key.value || key.literal !== 'string') return false
  const expected = nativeUnionMethodTargetsOf(read.receiver.representation, classes, key.text)
  return (
    expected !== null &&
    expected.length > 0 &&
    expected.length === target.arms.length &&
    expected.every((arm, index) => {
      const published = target.arms[index]
      return (
        published !== undefined &&
        published.declaration === arm.declaration &&
        published.functionId === arm.functionId &&
        published.static === arm.static &&
        published.path.length === arm.path.length &&
        published.path.every((step, position) => step === arm.path[position])
      )
    })
  )
}
