import type { DeclarationId } from '../identity/ids.js'
import type { Representation, TypedArrayElementDomain } from '../representation/model.js'
import type { ClassLayout } from './classes.js'
import { extendsClass } from './dispatch.js'

/** Authenticated constructor protocols map to native payload identities here. */
export const typedArrayConstructorDomains: ReadonlyMap<string, TypedArrayElementDomain> = new Map([
  ['Int8ArrayConstructor', 'int8'],
  ['Uint8ArrayConstructor', 'uint8'],
  ['Uint8ClampedArrayConstructor', 'uint8-clamped'],
  ['Int16ArrayConstructor', 'int16'],
  ['Uint16ArrayConstructor', 'uint16'],
  ['Int32ArrayConstructor', 'int32'],
  ['Uint32ArrayConstructor', 'uint32'],
  ['Float32ArrayConstructor', 'float32'],
  ['Float64ArrayConstructor', 'float64']
])

/** The `typeof` names of right-hand sides that are not Objects. */
export type NonObjectInstanceTarget = 'undefined' | 'null' | 'boolean' | 'number' | 'bigint' | 'string' | 'symbol'

/** Projection owns native and program-class membership; the target only spells these tests. */
export type ClassInstanceTest =
  | { readonly kind: 'constant'; readonly value: boolean }
  /**
   * ECMA-262 13.10.2 InstanceofOperator step 1: a right-hand side that is not
   * an Object throws a TypeError before anything about the left operand is
   * read. Not `false`: a guard that makes the test dead is control flow's
   * fact, and this recipe is the operator's own answer where it does run.
   */
  | { readonly kind: 'throws-non-object'; readonly target: NonObjectInstanceTarget }
  | { readonly kind: 'present' }
  | { readonly kind: 'boxed-typed-array'; readonly domain: TypedArrayElementDomain }
  | { readonly kind: 'class-family'; readonly members: readonly DeclarationId[]; readonly boxed: boolean }
  /**
   * A shared structural view tested through the class instance it was built
   * from, which the view remembers boxed (`gea::record::viewOrigin`). A view
   * built from anything but a class instance remembers nothing and is not an
   * instance.
   */
  | { readonly kind: 'view-origin'; readonly members: readonly DeclarationId[] }
  | { readonly kind: 'optional'; readonly payload: ClassInstanceTest }
  | { readonly kind: 'union'; readonly arms: readonly { readonly index: number; readonly test: ClassInstanceTest }[] }

export interface ClassInstanceTestRecipe {
  readonly test: ClassInstanceTest
  readonly nativeFieldProtocol?: 'unused'
}

/**
 * What the program knows about class prototype OBJECTS reaching a left
 * operand. A class's prototype object is native storage of that class's own
 * layout (`gea_native_class_prototype.h`) without being its instance: its
 * [[Prototype]] is its base's prototype, so `D.prototype instanceof m` holds
 * exactly when D strictly extends m (ECMA-262 7.3.22 OrdinaryHasInstance).
 */
export interface ClassPrototypeFacts {
  /** The class whose prototype object this left operand is, when its producer says so. */
  readonly prototypeOf: DeclarationId | null
  /** Every class whose native prototype object the program can materialize. */
  readonly materialized: ReadonlySet<DeclarationId>
  /**
   * Every class whose instances the program converts into a structural view
   * (`classViewCarrierKinds`). A view is a different allocation that no
   * longer carries its class, so an `instanceof` over a view carrier can
   * answer `false` only when no class of the tested family is ever viewed.
   */
  readonly viewed?: ReadonlySet<DeclarationId>
}

/** The object carriers a class instance can be converted into while losing its class (`targets/cpp/conversions.ts`'s record view). */
export const classViewCarrierKinds: ReadonlySet<Representation['kind']> = new Set([
  'record',
  'record-with-index',
  'native-record-ref',
  'dictionary'
])

export const noClassPrototypes: ClassPrototypeFacts = { prototypeOf: null, materialized: new Set(), viewed: new Set() }

/** A carrier that can hold only a primitive, never an Object. */
const nonObjectTargetOf = (right: Representation): NonObjectInstanceTarget | null => {
  switch (right.kind) {
    case 'undefined':
    case 'null':
    case 'string':
    case 'symbol':
      return right.kind
    case 'scalar':
      return right.domain === 'boolean' || right.domain === 'bigint' ? right.domain : 'number'
    default:
      return null
  }
}

export const classInstanceTestOf = (
  left: Representation,
  right: Representation,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  prototypes: ClassPrototypeFacts
): ClassInstanceTestRecipe | undefined => {
  // The throw precedes every read of the left operand, whatever it carries.
  const nonObject = nonObjectTargetOf(right)
  if (nonObject !== null) return { test: { kind: 'throws-non-object', target: nonObject }, nativeFieldProtocol: 'unused' }
  if (right.kind === 'native-handle') {
    const domain = typedArrayConstructorDomains.get(right.protocol)
    if (domain !== undefined) return typedArrayInstanceTestOf(left, domain)
  }
  if (right.kind !== 'constructor-family') return undefined
  const belongs = (declaration: DeclarationId, members: readonly DeclarationId[]): boolean =>
    members.some((member) => declaration === member || extendsClass(classes, declaration, member))
  const extension = [...classes.keys()].filter((declaration) => belongs(declaration, right.members))
  const strictlyBelow = (declaration: DeclarationId): boolean => right.members.some((member) => extendsClass(classes, declaration, member))
  if (prototypes.prototypeOf !== null)
    return { test: { kind: 'constant', value: strictlyBelow(prototypes.prototypeOf) }, nativeFieldProtocol: 'unused' }
  // A layout test answers `belongs` for D's prototype object and the language
  // answers `strictlyBelow`: they disagree exactly for the prototype of a
  // member that extends no other member.
  const misanswered = [...prototypes.materialized].filter(
    (declaration) => right.members.includes(declaration) && !strictlyBelow(declaration)
  )
  const mayHoldMisanswered = (declaration: DeclarationId): boolean =>
    misanswered.some((prototype) => prototype === declaration || extendsClass(classes, prototype, declaration))
  // A view carrier holds a family member only if some instance of it exists
  // and was converted into a view -- through its own class-ref or through an
  // ancestor's, which may hold it. A prototype object may be viewed as well.
  const mayBeViewed = (): boolean => {
    const viewed = prototypes.viewed
    if (viewed === undefined) return true
    // A materialized prototype travels as its class's own class-ref, so a
    // view of it is a view the census already counted for that class.
    return extension.some(
      (member) =>
        (prototypes.materialized.has(member) || !classes.get(member)?.uninstantiable) &&
        (viewed.has(member) || [...viewed].some((holder) => extendsClass(classes, member, holder)))
    )
  }
  let native = true
  let refused = false
  const plan = (value: Representation): ClassInstanceTest => {
    if (value.kind === 'class-ref') {
      if (belongs(value.declaration, right.members)) {
        if (!mayHoldMisanswered(value.declaration))
          return value.ownership === 'shared-refcount' ? { kind: 'present' } : { kind: 'constant', value: true }
        // `instanceOfClassFamilyRef` tells a prototype object from an instance
        // by its method state and walks the prototype's own chain, over the
        // whole family: the prototype's ancestors may be members themselves.
        if (value.ownership === 'shared-refcount') return { kind: 'class-family', members: extension, boxed: false }
        refused = true
        return { kind: 'constant', value: false }
      }
      // No ancestor of a class outside the family is in it, so the runtime
      // chain walk over these descendants answers prototypes exactly too.
      const members = extension.filter((candidate) => belongs(candidate, [value.declaration]))
      return members.length === 0 ? { kind: 'constant', value: false } : { kind: 'class-family', members, boxed: false }
    }
    if (value.kind === 'dynamic') {
      native = false
      // `instanceOfClassFamily` re-reads a boxed member at its own class and
      // tells its prototype object from an instance, as the handle test does.
      return { kind: 'class-family', members: extension, boxed: true }
    }
    if (value.kind === 'optional') return { kind: 'optional', payload: plan(value.payload) }
    // A view of a family member would answer `false` for a `true` value. An
    // unknown view census proves nothing, so it refuses too.
    if (classViewCarrierKinds.has(value.kind) && mayBeViewed()) {
      // Only a shared view has an identity to remember its origin under; the
      // origin is tested as a box, which tells a prototype object apart.
      const shared = 'ownership' in value && value.ownership === 'shared-refcount' && value.kind !== 'dictionary'
      if (!shared) {
        refused = true
        return { kind: 'constant', value: false }
      }
      native = false
      return { kind: 'view-origin', members: extension }
    }
    if (value.kind === 'tagged-union') {
      const arms = value.arms.flatMap((arm, index) => {
        if (
          arm.value.kind === 'class-ref' ||
          arm.value.kind === 'optional' ||
          arm.value.kind === 'tagged-union' ||
          arm.value.kind === 'dynamic'
        )
          return [{ index, test: plan(arm.value) }]
        if (classViewCarrierKinds.has(arm.value.kind)) {
          const test = plan(arm.value)
          return test.kind === 'view-origin' ? [{ index, test }] : []
        }
        return []
      })
      return { kind: 'union', arms }
    }
    return { kind: 'constant', value: false }
  }
  const test = plan(left)
  if (refused) return undefined
  return { test, ...(native ? { nativeFieldProtocol: 'unused' as const } : {}) }
}

/** Nested sums retain their discriminant path; an enclosing sum is not an incompatible leaf. */
const typedArrayInstanceTestOf = (left: Representation, domain: TypedArrayElementDomain): ClassInstanceTestRecipe => {
  let native = true
  const plan = (value: Representation): ClassInstanceTest => {
    if (value.kind === 'typed-array') return value.element === domain ? { kind: 'present' } : { kind: 'constant', value: false }
    if (value.kind === 'dynamic') {
      native = false
      return { kind: 'boxed-typed-array', domain }
    }
    if (value.kind === 'optional') return { kind: 'optional', payload: plan(value.payload) }
    if (value.kind === 'tagged-union') {
      const arms = value.arms.flatMap((arm, index) => {
        const test = plan(arm.value)
        return test.kind === 'constant' && !test.value ? [] : [{ index, test }]
      })
      return { kind: 'union', arms }
    }
    return { kind: 'constant', value: false }
  }
  const test = plan(left)
  return { test, ...(native ? { nativeFieldProtocol: 'unused' as const } : {}) }
}
