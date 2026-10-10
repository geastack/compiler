import type { DeclarationId, IrValueId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import { extendsClass } from '../projection/dispatch.js'
import { representationKey, type Representation } from '../representation/model.js'
import { allOperationsOf, type CallOperation, type IrBody, type IrOperand, type IrOperation } from './model.js'
import { resultOfIrOperation } from './queries.js'

/**
 * `Object.setPrototypeOf(instance, M.prototype)` on a LIVE instance whose
 * class `S` is a proper base of `M`, where every class from `M` up to (not
 * including) `S` declares no instance field of its own.
 *
 * The measured case: a constructor re-classes its own `URLSearchParams` onto
 * a case-insensitive subclass a mixin factory builds
 * (`Object.setPrototypeOf(this.searchParams, mixin(this.searchParams.constructor).prototype)`),
 * and every later `this.searchParams.get(...)` must reach the override.
 *
 * A field-less subclass has exactly its base's storage, so the object the
 * program already holds is a valid `M` instance as it stands: re-classing it
 * is a change of IDENTITY (the ref header's class table and the instance's
 * `gea_method_state`), never of layout. The runtime half is
 * `gea::reparentInstance` (gea_runtime.h), which re-checks at run time what
 * this plan proves statically plus the one thing it cannot -- that the value
 * really is the prototype object of an `M` evaluation descending from the
 * instance's current class evaluation. Method dispatch follows the identity
 * through the reparent prefix `targets/cpp/virtual-methods.ts` puts on the
 * base's virtual members, which only the classes a proven reparent names pay
 * for (`instanceReparentTargetsOf`).
 *
 * Everything else refuses by name: a target that adds fields (the object
 * would be too small), a prototype value that is not a class's own
 * `.prototype` read, or an instance whose class is not a base of the target.
 */
export interface InstanceReparentPlan {
  /** The class the instance becomes. */
  readonly target: DeclarationId
  /**
   * Every class the instance may be before the call: its static class and each
   * field-less class between it and `target`. `target` itself is also
   * accepted at run time, as a no-op re-parent onto the class it already has.
   */
  readonly sources: readonly DeclarationId[]
  readonly instance: IrOperand
  readonly prototype: IrOperand
}

export type InstanceReparentVerdict =
  { readonly kind: 'plan'; readonly plan: InstanceReparentPlan } | { readonly kind: 'refused'; readonly reason: string }

const REPARENT = 'Object.setPrototypeOf on a live instance'

/**
 * The two facts the verdict reads off the IR around the call. Certification
 * holds the body's definitions; the printer holds only its per-body origin
 * maps -- one question, answered from whichever the stage has.
 */
export interface ReparentReads {
  /** The operand a `convert` result was converted from, or `null` for any other value. */
  readonly convertSourceOf: (value: IrValueId) => IrOperand | null
  /** Whether a value is a constant-keyed `.prototype` read off a class's constructor object. */
  readonly readsClassPrototype: (value: IrValueId) => boolean
}

export const reparentReadsOfDefinitions = (definitionOf: (value: IrValueId) => IrOperation | null): ReparentReads => ({
  convertSourceOf: (value) => {
    const definition = definitionOf(value)
    return definition?.kind === 'convert' ? definition.source : null
  },
  readsClassPrototype: (value) => {
    const read = definitionOf(value)
    if (read?.kind !== 'get') return false
    const key = definitionOf(read.key.value)
    return isClassConstructorCarrier(read.receiver.representation) && key?.kind === 'constant' && key.text === 'prototype'
  }
})

export const isClassConstructorCarrier = (representation: Representation): boolean =>
  representation.kind === 'constructor-family' || representation.kind === 'constructor-identity'

/** The operand a value was converted FROM, through any chain of `convert`s -- the host signature types both arguments `any`/`object`. */
export const reparentOperandSourceOf = (operand: IrOperand, reads: ReparentReads): IrOperand => {
  let current = operand
  const walked = new Set<IrValueId>()
  for (;;) {
    if (walked.has(current.value)) return current
    walked.add(current.value)
    const source = reads.convertSourceOf(current.value)
    if (source === null) return current
    current = source
  }
}

const classRefOf = (representation: Representation): Extract<Representation, { kind: 'class-ref' }> | null =>
  representation.kind === 'class-ref' ? representation : null

/** The physical slots a class's struct holds, inherited ones included, as one comparable text. */
const storageKeyOf = (layout: ClassLayout): string =>
  (layout.nativeStorage?.fields ?? []).map((field) => `${field.key}:${representationKey(field.value)}`).join(',')

/** Whether a class states anything an instance could carry beyond the storage of the class it is re-classed from. */
const addsInstanceState = (layout: ClassLayout, sourceStorage: string): string | null => {
  if (layout.fields.length > 0) return `declares instance field(s) ${layout.fields.map((field) => field.key).join(', ')}`
  if ((layout.methodOverrides?.length ?? 0) > 0) return 'carries own-property method shadows'
  if (storageKeyOf(layout) !== sourceStorage) return 'stores a different set of physical slots'
  if (layout.nativeBase !== null) return 'extends a native object'
  return null
}

export const instanceReparentVerdictOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  reads: ReparentReads,
  argumentsOf: readonly IrOperand[]
): InstanceReparentVerdict => {
  const refuse = (reason: string): InstanceReparentVerdict => ({ kind: 'refused', reason: `${REPARENT}: ${reason}` })
  const [instanceArgument, prototypeArgument] = argumentsOf
  if (instanceArgument === undefined || prototypeArgument === undefined) return refuse('the call passes fewer than two arguments')
  const instance = reparentOperandSourceOf(instanceArgument, reads)
  const prototype = reparentOperandSourceOf(prototypeArgument, reads)
  const from = classRefOf(instance.representation)
  if (from === null) {
    return refuse(
      `the object is carried as ${instance.representation.kind}, not as a program class instance, so there is no class ` +
        'identity to re-class'
    )
  }
  if (from.ownership !== 'shared-refcount') return refuse('the object is not a shared, reference-counted class instance')
  const to = classRefOf(prototype.representation)
  if (to === null) {
    return refuse(`the new prototype is carried as ${prototype.representation.kind}, not as the prototype of a class this program compiles`)
  }
  if (!reads.readsClassPrototype(prototype.value)) {
    return refuse("the new prototype is not a class's own .prototype read, so which class it is cannot be known at compile time")
  }
  const sourceLayout = classes.get(from.declaration)
  const targetLayout = classes.get(to.declaration)
  if (sourceLayout === undefined || targetLayout === undefined) return refuse('a class on either side has no layout')
  if (from.declaration === to.declaration) {
    return { kind: 'plan', plan: { target: to.declaration, sources: [from.declaration], instance, prototype } }
  }
  if (!extendsClass(classes, to.declaration, from.declaration)) {
    return refuse(
      `the object's class ${from.declaration} is not a base of the prototype's class ${to.declaration}, so the object would ` +
        'lack the storage the new methods read'
    )
  }
  if (sourceLayout.nativeBase !== null) {
    return refuse(`the object's class ${from.declaration} extends a native object, whose identity is not a program class table`)
  }
  const sources: DeclarationId[] = [from.declaration]
  const between: DeclarationId[] = []
  for (let current: DeclarationId | null = to.declaration; current !== null && current !== from.declaration;) {
    const layout = classes.get(current)
    if (layout === undefined) return refuse(`class ${current} between the two has no layout`)
    const state = addsInstanceState(layout, storageKeyOf(sourceLayout))
    if (state !== null) {
      return refuse(
        `class ${current} ${state}, so an object allocated as ${from.declaration} is smaller than an instance of ` +
          `${to.declaration} -- only a subclass that adds methods alone can be re-classed onto`
      )
    }
    if (current !== to.declaration) between.push(current)
    current = layout.base
  }
  sources.push(...between)
  return { kind: 'plan', plan: { target: to.declaration, sources, instance, prototype } }
}

/**
 * Whether a call's callee is `Object.setPrototypeOf` -- the same two readings
 * `certify/property-access.ts`'s `hostMemberOfCall` makes: the `get`'s own
 * host-method binding, or a constant `setPrototypeOf` key off the
 * `ObjectConstructor` handle.
 */
export const isObjectSetPrototypeOfCall = (operation: CallOperation, definitionOf: (value: IrValueId) => IrOperation | null): boolean => {
  const callee = definitionOf(operation.callee.value)
  if (callee?.kind !== 'get') return false
  if (callee.hostMethod) return callee.hostMethod.protocol === 'ObjectConstructor' && callee.hostMethod.member === 'setPrototypeOf'
  const receiver = callee.receiver.representation
  if (receiver.kind !== 'native-handle' || (receiver.native ?? receiver.protocol) !== 'ObjectConstructor') return false
  const key = definitionOf(callee.key.value)
  return key?.kind === 'constant' && key.text === 'setPrototypeOf'
}

export const irDefinitionsOf = (body: IrBody): ((value: IrValueId) => IrOperation | null) => {
  const definitions = new Map<IrValueId, IrOperation>()
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    for (const operation of allOperationsOf(block)) {
      const result = resultOfIrOperation(operation)
      if (result) definitions.set(result.id, operation)
    }
  }
  return (value) => definitions.get(value) ?? null
}

/**
 * Every class a planned re-parent re-classes an instance onto, with the
 * classes those instances may have been before it. Whole-program, because the
 * cost it licenses -- an identity test on the base's virtual members --
 * lands in the BASE's definitions, which every call site on a base receiver
 * reaches whether or not it is anywhere near the re-parent. Only the classes
 * named here pay it.
 */
export const instanceReparentTargetsOf = (
  bodies: Iterable<IrBody>,
  classes: ReadonlyMap<DeclarationId, ClassLayout>
): ReadonlyMap<DeclarationId, ReadonlySet<DeclarationId>> => {
  const targets = new Map<DeclarationId, Set<DeclarationId>>()
  for (const body of bodies) {
    let definitionOf: ((value: IrValueId) => IrOperation | null) | null = null
    for (const blockId of body.blockOrder) {
      const block = body.blocks.get(blockId)
      if (!block) continue
      for (const operation of allOperationsOf(block)) {
        if (operation.kind !== 'call') continue
        definitionOf ??= irDefinitionsOf(body)
        if (!isObjectSetPrototypeOfCall(operation, definitionOf)) continue
        const verdict = instanceReparentVerdictOf(classes, reparentReadsOfDefinitions(definitionOf), operation.arguments)
        if (verdict.kind !== 'plan' || verdict.plan.sources.every((source) => source === verdict.plan.target)) continue
        const sources = targets.get(verdict.plan.target) ?? new Set<DeclarationId>()
        for (const source of verdict.plan.sources) sources.add(source)
        targets.set(verdict.plan.target, sources)
      }
    }
  }
  return targets
}
