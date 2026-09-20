import type { DeclarationId, PhysicalBodyId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import { extendsClass } from '../projection/dispatch.js'
import { classMemberOf } from '../projection/fields.js'
import { canonicalIndexLiteral } from '../representation/array-index.js'
import type { Representation } from '../representation/model.js'
import { objectPrototypeMemberNames } from '../representation/record-fields.js'
import type { ConstantOperation, GetOperation, IrBody } from './model.js'
import type { ReflectionExposure } from './reflection-demand.js'

/**
 * A union read whose class arm has no such member at all.
 *
 * three asks `scene.background` -- a `Texture | Color` there -- for
 * `isCubeTexture`, `mapping` and `colorSpace`; `Color` declares none of them.
 * The reflection census used to require EVERY surface of the receiver to
 * declare the key, so the lacking arm promoted both classes to a full dynamic
 * protocol and the emitter read the `Color` arm through its expando table.
 *
 * In the language, reading a key an object neither owns nor inherits is
 * `undefined`. For a class instance the inherited half is closed by its
 * layouts: no class on the arm's chain declares the key, and neither does any
 * class below it (a `class-ref` arm holds subclass instances too), and the key
 * is not an `Object.prototype` member. The own half is what the reflection
 * census exists to decide: every way a program can give an instance an own
 * property its class does not declare -- a named or computed write, a
 * definition, a spread target, an escape to `dynamic` or to an unknown call --
 * promotes that class to a full protocol on its own. So the census does not
 * promote for this read (`absentClassArmRead`), and once the exposure is
 * closed, an arm whose class it still left without one provably answers
 * `undefined` (`finalizeAbsentClassArms`). Where the class did end up full, the
 * arm keeps the expando lookup, which is exact there.
 *
 * The result must hold that `undefined` natively, and its other values must be
 * primitive: the fallback expando read hands back a box, and only a primitive
 * payload unboxes without an object protocol the census did not publish.
 */

/** Whether a `class-ref(declaration)` value can own or inherit `key` by any declaration in the program. */
export const classFamilyLacksKey = (classes: ReadonlyMap<DeclarationId, ClassLayout>, declaration: DeclarationId, key: string): boolean => {
  if (objectPrototypeMemberNames.has(key) || key === '__proto__' || canonicalIndexLiteral(key) !== null) return false
  // `unknown-class` is a site too: a chain the layouts cannot see is not closed.
  if (classMemberOf(classes, declaration, key) !== null) return false
  for (const [candidate, layout] of classes) {
    if (candidate === declaration || !extendsClass(classes, candidate, declaration)) continue
    if (
      layout.fields.some((member) => member.key === key) ||
      layout.methods.some((member) => member.key === key) ||
      layout.accessors.some((member) => member.key === key)
    )
      return false
  }
  return true
}

const primitiveLeaf = (representation: Representation): boolean =>
  representation.kind === 'undefined' ||
  representation.kind === 'null' ||
  representation.kind === 'scalar' ||
  representation.kind === 'string'

/** A result that holds `undefined` without a box, and nothing but primitives otherwise. */
const holdsAbsentPrimitive = (representation: Representation): boolean => {
  if (representation.kind === 'undefined') return true
  if (representation.kind === 'optional') return representation.absence === 'undefined' && primitiveLeaf(representation.payload)
  if (representation.kind === 'tagged-union')
    return representation.arms.some((arm) => arm.value.kind === 'undefined') && representation.arms.every((arm) => primitiveLeaf(arm.value))
  return false
}

/**
 * The union a read dispatches over. A nullable union (`background &&` has not
 * stripped the carrier) still selects among the same arms once present; its
 * absent case is the read of a missing receiver, not of a class arm.
 */
const unionOf = (receiver: Representation): Extract<Representation, { kind: 'tagged-union' }> | null => {
  if (receiver.kind === 'tagged-union') return receiver
  if (receiver.kind === 'optional' && receiver.payload.kind === 'tagged-union') return receiver.payload
  return null
}

/** The census half: `surface` is a class arm of the union `receiver` that answers this read with `undefined`. */
export const absentClassArmRead = (
  receiver: Representation,
  surface: Representation,
  key: string,
  result: Representation,
  classes: ReadonlyMap<DeclarationId, ClassLayout>
): surface is Extract<Representation, { kind: 'class-ref' }> =>
  surface.kind === 'class-ref' &&
  (unionOf(receiver)?.arms.some((arm) => arm.value === surface) ?? false) &&
  holdsAbsentPrimitive(result) &&
  classFamilyLacksKey(classes, surface.declaration, key)

/** A class the closed exposure left without a dynamic protocol. A class it never rowed is fail-closed full. */
const withoutDynamicProtocol = (exposure: ReflectionExposure, declaration: DeclarationId): boolean => {
  const demand = exposure.classes.get(declaration)
  return demand !== undefined && demand.level !== 'full'
}

/** The class arms of `operation` that provably answer `undefined` for `key`, in arm order. */
const absentClassArmsOf = (
  operation: GetOperation,
  key: string,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  exposure: ReflectionExposure
): readonly DeclarationId[] => {
  const receiver = operation.receiver.representation
  const union = unionOf(receiver)
  if (union === null) return []
  const arms: DeclarationId[] = []
  for (const arm of union.arms) {
    const surface = arm.value
    if (!absentClassArmRead(receiver, surface, key, operation.result.representation, classes)) continue
    if (withoutDynamicProtocol(exposure, surface.declaration) && !arms.includes(surface.declaration)) arms.push(surface.declaration)
  }
  return arms
}

/** Certification's re-check of a published stamp against the same proof and the closed exposure. */
export const absentClassArmsHold = (
  operation: GetOperation,
  key: string | null,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  exposure: ReflectionExposure | undefined
): boolean => {
  const stamped = operation.absentClassArms ?? []
  if (key === null || !exposure?.complete || stamped.length === 0) return false
  const proven = absentClassArmsOf(operation, key, classes, exposure)
  return stamped.every((declaration) => proven.includes(declaration))
}

const constantsOf = (bodies: ReadonlyMap<PhysicalBodyId, IrBody>): ReadonlyMap<string, ConstantOperation> => {
  const constants = new Map<string, ConstantOperation>()
  for (const body of bodies.values())
    for (const block of body.blocks.values())
      for (const operation of block.operations) if (operation.kind === 'constant') constants.set(String(operation.result.id), operation)
  return constants
}

/**
 * Stamp every union read with the class arms the CLOSED exposure proves absent.
 * Runs after `closePhysicalClassReflection`: closure only ever adds a full
 * protocol (to a full class's ancestors), and a subclass that could hold the
 * key as an expando makes its ancestor full there, so the closed verdict on the
 * arm's own class already covers every instance the arm can hold.
 */
export const finalizeAbsentClassArms = (
  bodies: ReadonlyMap<PhysicalBodyId, IrBody>,
  exposure: ReflectionExposure,
  classes: ReadonlyMap<DeclarationId, ClassLayout>
): ReadonlyMap<PhysicalBodyId, IrBody> => {
  if (!exposure.complete) return bodies
  const constants = constantsOf(bodies)
  const finalized = new Map<PhysicalBodyId, IrBody>()
  let changedAny = false
  for (const [bodyId, body] of bodies) {
    let changed = false
    const blocks = new Map(body.blocks)
    for (const [blockId, block] of body.blocks) {
      let blockChanged = false
      const operations = block.operations.map((operation) => {
        if (operation.kind !== 'get' || unionOf(operation.receiver.representation) === null) return operation
        const constant = constants.get(String(operation.key.value))
        if (!constant || constant.literal !== 'string') return operation
        const arms = absentClassArmsOf(operation, constant.text, classes, exposure)
        if (arms.length === 0) return operation
        blockChanged = true
        changed = true
        return { ...operation, absentClassArms: arms }
      })
      if (blockChanged) blocks.set(blockId, { ...block, operations })
    }
    if (changed) changedAny = true
    finalized.set(bodyId, changed ? { ...body, blocks } : body)
  }
  return changedAny ? finalized : bodies
}
