import type { DeclarationId, FunctionId, SemanticResultId, StructuralTypeId } from '../identity/ids.js'
import { representationKey, walkRepresentation, type CallableAbi, type RecordField, type Representation } from '../representation/model.js'
import type { SealedRepresentationPlan } from '../representation/plan.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { symbolPropertyKeyDeclarationOf, type StructuralType } from '../semantics/model/structural-types.js'
import type { NativeClassStorage } from './class-storage.js'
import { operandOf, resultOf, type SemanticOperand } from '../semantics/model/operands.js'
import { abiOfCallee } from './callee.js'

/**
 * What each class is made of, assembled from the events its evaluation
 * published.
 *
 * A class is not one operation. `ClassDefinitionEvaluation` creates the
 * constructor object, then installs each method, then records each field --
 * and the target needs all of them at once to emit a construction. Recovering
 * that set by walking syntax would make this file a second authority over
 * which members a class has; reading the events keeps the graph the only one.
 *
 * Order is the order the events were published, which is the order class
 * evaluation runs them. A field initializer runs in field-declaration order at
 * every construction, so reordering here would change what the program does.
 */

export interface ClassField {
  readonly declaration: DeclarationId
  /** The written property key, from the definition's own key operand. */
  readonly key: string
  /** The function that computes this field's initial value, or `null` for a field declared without one. */
  readonly initializer: FunctionId | null
  /** The field's declared carrier, when its definition published one. */
  readonly representation: Representation | null
  /** The field exists only to type a base-typed duck-property read; it was not declared by the program's class. */
  readonly syntheticSubclassMemberOverlay: boolean
}

/**
 * The storage census for one synthetic subclass-member-overlay field.
 *
 * `evidenceOwner` is the class whose published field makes a base-typed
 * access type-check. It is deliberately separate from `physicalOwners`: an
 * overlay is evidence about the family surface, not a declaration that the
 * ancestor owns a slot. Each physical owner is a real field declaration in a
 * descendant and carries the representation that its storage uses. This is
 * published before target lowering so targets do not have to infer ownership
 * from flattened record shapes.
 */
export interface ClassFieldOwnership {
  readonly key: string
  readonly evidenceOwner: DeclarationId
  readonly evidence: ClassField
  readonly physicalOwners: readonly {
    readonly declaration: DeclarationId
    readonly field: ClassField
  }[]
}

/** One prototype method, and the body that implements it. */
export interface ClassMethod {
  readonly key: string
  readonly callable: FunctionId | null
  /** Convention of the installed method object, including its implicit receiver. */
  readonly representation?: Representation
  /** Public mutable member frame, distinct from the original implementation's frame. */
  readonly storageRepresentation?: Representation
}

/**
 * One accessor-backed member: the property a reader spells, and the functions
 * that implement reading and writing it.
 *
 * Kept apart from `methods` because a reader of `box.value` is not taking a
 * function object -- it is *calling* one, and the two lower to different C++.
 * Either half can be absent: a get-only accessor really has no setter, and
 * writing through it is a defect the target refuses by name rather than a
 * lookup that quietly finds a field.
 */
export interface ClassAccessor {
  readonly key: string
  readonly getter: FunctionId | null
  readonly setter: FunctionId | null
  /**
   * The getter's own callable carrier, whose `abi.result` is what reading the
   * member yields.
   *
   * A class's accessors are NOT members of the instance shape the deriver
   * lays out -- that shape enumerates storage, and an accessor has none -- so
   * `record.accessors` is empty for every class body and there is nowhere
   * else to ask what a class getter publishes. Carried here, from the same
   * selected representation `ClassMethod.representation` comes from, so the
   * two halves of "what does this class member hold" have one source.
   */
  readonly representation?: Representation
}

export interface ClassLayout {
  /** Proven layout demand with no reachable class evaluation/construction. */
  readonly layoutOnly?: boolean
  readonly nativeStorage?: NativeClassStorage
  /** Typed own-property shadows, initially absent; prototype methods remain methods. */
  readonly methodOverrides?: readonly RecordField[]
  /** Methods replaced on this prototype, rather than on ordinary instances. */
  readonly prototypeMethodMutations?: readonly string[]
  /** Uses outside the currently supported typed method-only prototype protocol. */
  readonly prototypeUnsupportedUses?: readonly string[]
  readonly declaration: DeclarationId
  /**
   * The class this one extends, or `null` for a base class.
   *
   * A derived class shares its base's storage and bodies: the base's fields are
   * its fields, the base's methods accept its instances, and its construction
   * runs the base's initialization first. None of that is derivable from this
   * class's own members, so the link is carried rather than rediscovered -- and
   * without it an inherited member reads a struct field nothing initialized.
   */
  readonly base: DeclarationId | null
  /**
   * `base` was linked by a modelled `Object.setPrototypeOf(C.prototype,
   * B.prototype)` rather than by `extends`: layout and dispatch inherit from
   * it, but this class's construction never runs the base's -- there is no
   * `super()` to run it (`semantics/prototype-reparenting.ts`).
   */
  readonly prototypeBase?: true
  /** No evaluation can produce an instance of this class (`semantics/uninstantiable-classes.ts`). */
  readonly uninstantiable?: true
  /** A built-in native class extended directly; currently the intrinsic Error family. */
  readonly nativeBase: {
    readonly protocol: string
    readonly instance: Extract<Representation, { readonly kind: 'native-record-ref' }>
  } | null
  /** The convention `new` invokes, from the constructor object's own carrier. */
  readonly construct: CallableAbi | null
  /** The carrier of an instance, which is what that convention returns. */
  readonly instance: Representation | null
  /** The written constructor's body, or `null` when the class relies on the implicit one. */
  readonly constructor: FunctionId | null
  readonly fields: readonly ClassField[]
  /** Ownership facts for synthetic overlay evidence declared by this class. */
  readonly fieldOwnership: readonly ClassFieldOwnership[]
  readonly methods: readonly ClassMethod[]
  readonly accessors: readonly ClassAccessor[]
  /**
   * The class's own *static* members -- kept apart from `fields`/`methods`/
   * `accessors` because a static lives on the constructor object, not on an
   * instance, and is read through a `constructor-family` receiver
   * (`Quaternion.fromEuler`) rather than a `class-ref` one
   * (`someQuaternion.multiply`). TypeScript allows a class to declare an
   * instance and a static member with the same key, so folding both into one
   * bucket (as this file did before) let a lookup silently return whichever
   * one the census happened to publish first, for either receiver kind.
   * `class-lifecycle`'s events already carry which is which
   * (`descriptor.placement`); these three lists are that fact, kept.
   */
  readonly staticFields: readonly ClassField[]
  readonly staticMethods: readonly ClassMethod[]
  readonly staticAccessors: readonly ClassAccessor[]
  /**
   * The class's `[[Name]]` -- `C.name` when no static member shadows it --
   * as the constructor-object allocation stated it (`functionName`, the same
   * field a function allocation fills), or `null` when no allocation of this
   * class's constructor object was censused.
   */
  readonly name: string | null
  /** The class's `Function.prototype.length` (`functionLength` on the same allocation), or `null` beside a `null` name. */
  readonly length: number | null
  /**
   * The census copy ids this physical class was published from (`decl|f0|36@0`,
   * `decl|f0|36@2`), when it is a generic's; absent for a class that was never
   * copied. A consumer holding a copy id from a class-lifecycle event resolves
   * its layout through `classLayoutOfCopy`, never by stripping the suffix --
   * a generic instantiated at two layouts has two physical classes, and the
   * root names neither.
   */
  readonly copies?: readonly DeclarationId[]
  /**
   * The class whose STATIC storage and static members this one shares -- the
   * generic root, for one physical layout of a generic instantiated at
   * several. Absent for a class that owns its own statics.
   *
   * A generic class is several structs and ONE constructor object: `Box` is
   * one binding, `Box.count` is one cell every layout's constructor
   * increments, and `Box.create` is one function. The layouts split what an
   * INSTANCE is, never what the class value is, so every physical class of
   * one root carries the same static members and they all resolve to one
   * storage owner (`ir/class-static-fields.ts`'s `staticFieldOwnerOf`).
   */
  readonly staticOwner?: DeclarationId
}

/**
 * The one class that owns the static storage behind these constructor-family
 * members, or `null` when they disagree -- which for a family of genuinely
 * different classes (a base's slot the program stores subclasses into) they
 * do, and for the layouts of ONE generic they never do.
 */
export const sharedStaticOwnerOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  members: readonly DeclarationId[]
): DeclarationId | null => {
  const [first, ...rest] = members
  if (first === undefined) return null
  const owner = classes.get(first)?.staticOwner ?? first
  return rest.every((member) => (classes.get(member)?.staticOwner ?? member) === owner) ? owner : null
}

/**
 * The physical class a census copy id belongs to.
 *
 * Exact id first (a physical id IS the copy id of its group's lowest copy,
 * and a non-generic class is its own only copy); then the class that lists
 * the copy among its `copies`; then the generic root, which is where a copy
 * with no constructor-object carrier of its own was published.
 */
export const classLayoutOfCopy = (classes: ReadonlyMap<DeclarationId, ClassLayout>, copy: DeclarationId): ClassLayout | undefined => {
  const exact = classes.get(copy)
  if (exact) return exact
  let index = copyIndexes.get(classes)
  if (!index) {
    index = new Map()
    for (const layout of classes.values()) for (const one of layout.copies ?? []) if (!index.has(one)) index.set(one, layout)
    copyIndexes.set(classes, index)
  }
  return index.get(copy) ?? classes.get(genericRootOf(copy))
}
const copyIndexes = new WeakMap<ReadonlyMap<DeclarationId, ClassLayout>, Map<DeclarationId, ClassLayout>>()

/** Runtime class candidates exclude definitions retained solely for type layout. */
/** The class whose construction this class's construction runs first, which a prototype-only base is not. */
export const constructedBaseOf = (layout: Pick<ClassLayout, 'base' | 'prototypeBase'>): DeclarationId | null =>
  layout.prototypeBase ? null : layout.base

export const runtimeClassLayoutsOf = (classes: ReadonlyMap<DeclarationId, ClassLayout>): readonly ClassLayout[] =>
  [...classes.values()].filter((layout) => layout.layoutOnly !== true)

/**
 * The physical facts needed to lay out a class reference.  This deliberately
 * has no constructor, method, accessor, or field-initializer members: a
 * class-ref can be retained because a value is typed by the class even when
 * no class-lifecycle event survived reachability.  Treating that evidence as
 * a full ClassLayout would invent callable bodies and make the target believe
 * an implicit constructor was emitted.
 */
export interface PhysicalClassLayout {
  readonly nativeStorage?: NativeClassStorage
  readonly declaration: DeclarationId
  /** The nearest authenticated base, or null for a root class. */
  readonly base: DeclarationId | null
  /** The exact class-ref carrier whose shape supplies this struct's fields. */
  readonly instance: Extract<Representation, { readonly kind: 'class-ref' }>
  /** Native base facts are preserved for ordinary projected classes. */
  readonly nativeBase: ClassLayout['nativeBase']
}

export interface PhysicalClassLayoutPublication {
  readonly layouts: ReadonlyMap<DeclarationId, PhysicalClassLayout>
  /** A missing direct base prevents a sound derived layout and must fail closed. */
  readonly complete: boolean
  readonly missingBases: readonly DeclarationId[]
}

export type PhysicalClassRefResolver = (declaration: DeclarationId) => Extract<Representation, { readonly kind: 'class-ref' }> | null

/**
 * Build the sealed class-ref authority used to close physical ancestry.
 * Existing runtime class layouts win because their instance carrier is the
 * projection's canonical shape. For type-only declarations, every
 * class-instance structural anchor is derived and grouped by declaration;
 * more than one distinct carrier is ambiguous and therefore resolves to null.
 */
export const physicalClassInstanceResolverOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  structuralTypes: ReadonlyMap<StructuralTypeId, StructuralType>,
  deriver: RepresentationDeriver
): PhysicalClassRefResolver => {
  const resolved = new Map<DeclarationId, Extract<Representation, { readonly kind: 'class-ref' }>>()
  const ambiguous = new Set<DeclarationId>()
  const candidates = new Map<DeclarationId, StructuralTypeId[]>()
  for (const [declaration, layout] of classes) {
    if (layout.instance?.kind === 'class-ref') resolved.set(declaration, layout.instance)
  }
  for (const [typeId, structural] of structuralTypes) {
    const shape = structural.shape
    if (shape.kind !== 'class-instance' || shape.body === null || resolved.has(shape.declaration)) continue
    const ids = candidates.get(shape.declaration) ?? []
    ids.push(typeId)
    candidates.set(shape.declaration, ids)
  }
  return (declaration) => {
    if (resolved.has(declaration)) return resolved.get(declaration) ?? null
    if (ambiguous.has(declaration)) return null
    let selected: Extract<Representation, { readonly kind: 'class-ref' }> | null = null
    for (const typeId of candidates.get(declaration) ?? []) {
      const representation = deriver.derive(typeId)
      if (representation.kind !== 'class-ref' || representation.declaration !== declaration) continue
      if (selected && representationKey(selected) !== representationKey(representation)) {
        ambiguous.add(declaration)
        return null
      }
      selected = representation
    }
    if (selected) resolved.set(declaration, selected)
    else ambiguous.add(declaration)
    return selected
  }
}

export interface ClassProjectionInput {
  readonly graph: SemanticGraph
  readonly plan: SealedRepresentationPlan
  readonly deriver: RepresentationDeriver
  /** Classes no evaluation can instantiate (`semantics/uninstantiable-classes.ts`). */
  readonly uninstantiable?: ReadonlySet<DeclarationId>
}

/**
 * The callable each allocation's own published value names, by that value's id.
 *
 * One pass instead of one scan per member. The lookup below asks "which
 * allocation published this result", once per method, once per accessor half
 * and once per field initializer -- and answering it by walking the whole
 * operation table made class projection cost members x operations: 1,172 calls
 * against 104,641 operations on one measured application, which is 123 million
 * visits to answer 1,172 questions. The first allocation to publish a result id
 * wins, exactly as the scan's own `return` on first match did, so a table built
 * in `graph.operations` order gives the identical answer.
 */
const allocatedCallablesByResult = (graph: SemanticGraph): ReadonlyMap<string, FunctionId | null> => {
  const callables = new Map<string, FunctionId | null>()
  for (const operation of graph.operations.values()) {
    if (operation.family !== 'allocation') continue
    const published = resultOf(operation, 'value')
    if (!published || callables.has(published.id)) continue
    callables.set(published.id, operation.callable)
  }
  return callables
}

/** The function a `define-field`/`define-method` event's own allocation names, or `null`. */
const allocatedCallableOf = (callables: ReadonlyMap<string, FunctionId | null>, resultId: string | undefined): FunctionId | null =>
  resultId === undefined ? null : (callables.get(resultId) ?? null)

/**
 * The generic root of a declaration id, or the id itself when it names no copy.
 *
 * `identity/ids.ts` spells a monomorphized copy as `decl|file|ordinal@key`, so
 * the root is everything up to the separator -- read here rather than
 * reconstructed, because the two halves are minted in one place and a second
 * spelling of the same split is exactly the drift this collapse exists to end.
 */
const genericRootOf = (declaration: DeclarationId): DeclarationId => {
  const at = declaration.indexOf('@')
  return at === -1 ? declaration : (declaration.slice(0, at) as DeclarationId)
}

/**
 * One class, one published id.
 *
 * `class-lifecycle` events are minted inside the census's own per-copy walk, so
 * a GENERIC class publishes its members under a copy id (`decl|f71|904@0`).
 * Nothing else in the backend uses that id: `cppTypeOf` spells a `class-ref`'s
 * C++ type as `cppClassName(representation.declaration)`, and a `class-ref`
 * carrier's declaration is its structural shape's anchor, which is the generic
 * ROOT -- `structural.ts` deliberately keys the anchor on the root plus the
 * layout-RELEVANT type arguments, so that two instantiations differing only in
 * a phantom parameter share one physical layout. This same file already mixes
 * the two: `constructorBodies` above keys on the carrier's declaration while
 * every member bucket keys on the event's.
 *
 * The result was a class whose members were published under an id no consumer
 * ever asks about. `classMemberOf` looked up the carrier's root, found
 * nothing, and `emit-class-properties.ts` refused with "whose members no class
 * evaluation published" -- for hono's `Context` and `Hono`, whose every method
 * read (`c.text`, `c.json`, `c.req`, `app.fetch`) died on it.
 *
 * So the copy id is re-keyed onto the root, and ONLY when the root has exactly
 * one published copy and no publication of its own. That condition is the
 * whole proof: with one copy there is one layout, so the two ids denote one
 * struct and merging them invents nothing. A root with two published copies is
 * left exactly as it is -- those are two genuinely different layouts (a
 * `Context<E>` whose `env: E['Bindings']` field really does differ per `E`),
 * and collapsing them onto one root would give two structs one name. That case
 * still refuses, which is correct until a `class-ref` carrier can say WHICH
 * copy it holds; the carrier is the authority that has to grow, and this is
 * not a substitute for it.
 */
/**
 * Members unioned by KEY, never concatenated: every copy of one class installs
 * the same members from the same source declarations, so the copies' lists are
 * the same list seen N times. The first copy to publish a key wins.
 */
const mergedMembersByKey = <T extends { readonly key: string }>(
  layouts: readonly ClassLayout[],
  pick: (layout: ClassLayout) => readonly T[]
): readonly T[] => {
  const seen = new Map<string, T>()
  for (const layout of layouts) for (const entry of pick(layout)) if (!seen.has(entry.key)) seen.set(entry.key, entry)
  return [...seen.values()]
}

/**
 * Methods unioned by key AND BODY, because one key can legitimately name
 * several bodies: a generic method is monomorphized per type argument and
 * every copy installs under the name they share. Merging those by key alone
 * kept whichever copy the first class copy happened to publish, so a method
 * copy minted only under a LATER class copy -- `c.tag<number>()` on a
 * `Chain<string>`, where the two `Chain` copies share one layout and merge --
 * vanished before any call could resolve to it. A same-key list is not a
 * duplicate to collapse: `classMemberOf` disambiguates it by the site's own
 * convention, and every other consumer already walks the whole list because a
 * NON-generic class's generic method has always produced one.
 */
const mergedMethods = (layouts: readonly ClassLayout[], pick: (layout: ClassLayout) => readonly ClassMethod[]): readonly ClassMethod[] => {
  const seen = new Map<string, ClassMethod>()
  for (const layout of layouts)
    for (const entry of pick(layout)) {
      // Two entries that agree on the key AND on the installed convention are
      // one method. A folded class -- every copy naming one layout -- installs
      // the identical method once per copy, differing only in the ordinal
      // inside the callable id, and emitting all of them made the C++ reject
      // the redefinitions. A genuine method copy (`map<R>` at `number` and at
      // `string`) has a different convention and is kept.
      const identity = `${entry.key} ${entry.representation === undefined ? (entry.callable ?? '') : representationKey(entry.representation)}`
      if (!seen.has(identity)) seen.set(identity, entry)
    }
  return [...seen.values()]
}

/**
 * The static side every physical class of one generic root shares.
 *
 * Only the INSTANCE is split by layout. `Box<number>` and `Box<string>` are
 * two structs because their fields are physically different, while `Box`
 * itself is one constructor object with one `count` cell and one `create`
 * function -- so each layout is given the union of every layout's static
 * members, and `staticOwner` points them all at the root so the storage
 * census mints one cell rather than one per struct.
 */
const shareStaticSides = (merged: Map<DeclarationId, ClassLayout>): void => {
  const byGeneric = new Map<DeclarationId, DeclarationId[]>()
  for (const declaration of merged.keys()) {
    const root = genericRootOf(declaration)
    byGeneric.set(root, [...(byGeneric.get(root) ?? []), declaration])
  }
  for (const [root, family] of byGeneric) {
    if (family.length < 2) continue
    const layouts = family.flatMap((declaration) => {
      const layout = merged.get(declaration)
      return layout ? [layout] : []
    })
    const staticFields = mergedMembersByKey(layouts, (layout) => layout.staticFields)
    const staticMethods = mergedMethods(layouts, (layout) => layout.staticMethods)
    const staticAccessors = mergedMembersByKey(layouts, (layout) => layout.staticAccessors)
    const name = layouts.find((layout) => layout.name !== null)?.name ?? null
    const length = layouts.find((layout) => layout.length !== null)?.length ?? null
    for (const declaration of family) {
      const layout = merged.get(declaration)
      if (!layout) continue
      merged.set(declaration, { ...layout, staticOwner: root, staticFields, staticMethods, staticAccessors, name, length })
    }
  }
}

const collapseSpecializations = (
  layouts: ReadonlyMap<DeclarationId, ClassLayout>,
  physicalOf: ReadonlyMap<DeclarationId, DeclarationId>
): ReadonlyMap<DeclarationId, ClassLayout> => {
  // One bucket per PHYSICAL class: the id the copy's own constructor-object
  // carrier named (`structural.ts`'s `physicalClassDeclarationOf` -- the
  // root, or `root@<ordinal>` when the class has more than one layout), and
  // the root for a copy that published no carrier of its own.
  const byRoot = new Map<DeclarationId, ClassLayout[]>()
  for (const [declaration, layout] of layouts) {
    const root = physicalOf.get(declaration) ?? genericRootOf(declaration)
    byRoot.set(root, [...(byRoot.get(root) ?? []), layout])
  }
  const merged = new Map<DeclarationId, ClassLayout>()
  for (const [root, group] of byRoot) {
    const [first, ...rest] = group
    if (!first) continue
    const copies = group.map((layout) => layout.declaration).filter((one) => one !== genericRootOf(one))
    if (rest.length === 0) {
      merged.set(
        root,
        first.declaration === root && copies.length === 0
          ? first
          : { ...first, declaration: root, ...(copies.length > 0 ? { copies } : {}) }
      )
      continue
    }
    const mergeByKey = <T extends { readonly key: string }>(pick: (layout: ClassLayout) => readonly T[]): readonly T[] =>
      mergedMembersByKey(group, pick)
    merged.set(root, {
      declaration: root,
      ...(group.every((layout) => layout.layoutOnly) ? { layoutOnly: true } : {}),
      base: group.find((layout) => layout.base !== null)?.base ?? null,
      ...(group.find((layout) => layout.base !== null)?.prototypeBase ? { prototypeBase: true as const } : {}),
      ...(group.every((layout) => layout.uninstantiable) ? { uninstantiable: true as const } : {}),
      nativeBase: group.find((layout) => layout.nativeBase !== null)?.nativeBase ?? null,
      construct: group.find((layout) => layout.construct !== null)?.construct ?? null,
      instance: group.find((layout) => layout.instance !== null)?.instance ?? null,
      constructor: group.find((layout) => layout.constructor !== null)?.constructor ?? null,
      fields: mergeByKey((layout) => layout.fields),
      fieldOwnership: [],
      methods: mergedMethods(group, (layout) => layout.methods),
      accessors: mergeByKey((layout) => layout.accessors),
      staticFields: mergeByKey((layout) => layout.staticFields),
      staticMethods: mergedMethods(group, (layout) => layout.staticMethods),
      staticAccessors: mergeByKey((layout) => layout.staticAccessors),
      name: group.find((layout) => layout.name !== null)?.name ?? null,
      length: group.find((layout) => layout.length !== null)?.length ?? null,
      ...(copies.length > 0 ? { copies } : {})
    })
  }
  shareStaticSides(merged)
  // A base link names whichever id its heritage carrier stated -- a physical
  // id, which this merge published as-is when the base has that layout, and
  // otherwise a copy this merge just retired onto its root.
  const relinked = new Map<DeclarationId, ClassLayout>()
  for (const [declaration, layout] of merged) {
    const base = layout.base === null || merged.has(layout.base) ? layout.base : genericRootOf(layout.base)
    relinked.set(declaration, base === layout.base ? layout : { ...layout, base })
  }
  return relinked
}

/** Whether `candidate` reaches `ancestor` through the published base links. */
const descendsFrom = (layouts: ReadonlyMap<DeclarationId, ClassLayout>, candidate: DeclarationId, ancestor: DeclarationId): boolean => {
  const seen = new Set<DeclarationId>()
  let current = layouts.get(candidate)?.base ?? null
  while (current !== null && !seen.has(current)) {
    if (current === ancestor) return true
    seen.add(current)
    current = layouts.get(current)?.base ?? null
  }
  return false
}

/**
 * Publish synthetic overlay ownership after specialization collapse.
 *
 * This pass records evidence and physical owners without changing `fields`.
 * Keeping the existing field list intact is intentional: access recipes and
 * the target layout must consume this census before any storage can be
 * removed. A missing representation remains visible as an owner but cannot
 * be treated as a typed storage recipe by a later consumer.
 */
export const publishClassFieldOwnership = (layouts: ReadonlyMap<DeclarationId, ClassLayout>): ReadonlyMap<DeclarationId, ClassLayout> => {
  const published = new Map<DeclarationId, ClassLayout>()
  for (const [declaration, layout] of layouts) {
    const ownership = layout.fields
      .filter((field) => field.syntheticSubclassMemberOverlay)
      .map((evidence) => {
        const physicalOwners = [...layouts.entries()]
          .filter(([candidate, candidateLayout]) => {
            if (candidate === declaration || !descendsFrom(layouts, candidate, declaration)) return false
            return candidateLayout.fields.some((field) => field.key === evidence.key && !field.syntheticSubclassMemberOverlay)
          })
          .flatMap(([candidate, candidateLayout]) => {
            const field = candidateLayout.fields.find((entry) => entry.key === evidence.key && !entry.syntheticSubclassMemberOverlay)
            return field ? [{ declaration: candidate, field }] : []
          })
          .sort((left, right) => (left.declaration < right.declaration ? -1 : left.declaration > right.declaration ? 1 : 0))
        return { key: evidence.key, evidenceOwner: declaration, evidence, physicalOwners }
      })
    published.set(declaration, { ...layout, fieldOwnership: ownership })
  }
  return published
}

/**
 * Publish physical class ancestry for the final carrier set.
 *
 * `projectClasses` is intentionally event-driven: it describes executable
 * class lifecycle, so a class used only as a retained field type may have no
 * entry there.  The target still needs its authenticated base link to avoid
 * flattening inherited storage into the derived struct.  This pass publishes
 * only that physical fact from the already-sealed class-ref carriers and
 * reuses full projected layouts where they exist.  It must run on the final
 * emission carrier set, after shaking, so a dropped type-only value cannot
 * root a class merely because it appeared in the plan.
 */
export const physicalClassLayoutsOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  representations: readonly Representation[],
  resolveClassRef: PhysicalClassRefResolver | null = null
): PhysicalClassLayoutPublication => {
  const carriers = new Map<DeclarationId, Extract<Representation, { readonly kind: 'class-ref' }>>()
  for (const representation of representations)
    for (const nested of walkRepresentation(representation))
      if (nested.kind === 'class-ref' && !carriers.has(nested.declaration)) carriers.set(nested.declaration, nested)

  const layouts = new Map<DeclarationId, PhysicalClassLayout>()
  for (const [declaration, layout] of classes) {
    if (layout.instance?.kind !== 'class-ref') continue
    layouts.set(declaration, {
      declaration,
      base: layout.base,
      instance: layout.instance,
      nativeBase: layout.nativeBase,
      ...(layout.nativeStorage === undefined ? {} : { nativeStorage: layout.nativeStorage })
    })
  }
  for (const [declaration, instance] of carriers) {
    if (layouts.has(declaration)) continue
    layouts.set(declaration, {
      declaration,
      base: instance.ancestors[0] ?? null,
      instance,
      nativeBase: null
    })
  }

  // A type-only carrier can name a direct base whose own carrier was not
  // independently retained.  Ask the sealed structural publisher for that
  // declaration's authenticated class-ref and continue the same closure; a
  // resolver that cannot prove one unique carrier leaves the publication
  // incomplete rather than guessing a shape from the descendant.
  const resolved = new Set<DeclarationId>()
  let changed = true
  while (changed) {
    changed = false
    for (const layout of [...layouts.values()]) {
      if (layout.base === null || layouts.has(layout.base) || resolved.has(layout.base)) continue
      resolved.add(layout.base)
      const instance = resolveClassRef?.(layout.base) ?? null
      if (!instance || instance.declaration !== layout.base) continue
      layouts.set(instance.declaration, {
        declaration: instance.declaration,
        base: instance.ancestors[0] ?? null,
        instance,
        nativeBase: null
      })
      changed = true
    }
  }
  const missingBases = new Set<DeclarationId>()
  for (const layout of layouts.values()) if (layout.base !== null && !layouts.has(layout.base)) missingBases.add(layout.base)
  return Object.freeze({
    layouts,
    complete: missingBases.size === 0,
    missingBases: Object.freeze([...missingBases])
  })
}

export const projectClasses = (input: ClassProjectionInput): ReadonlyMap<DeclarationId, ClassLayout> => {
  const allocatedCallables = allocatedCallablesByResult(input.graph)
  const fields = new Map<DeclarationId, ClassField[]>()
  const methods = new Map<DeclarationId, ClassMethod[]>()
  const accessors = new Map<DeclarationId, ClassAccessor[]>()
  const staticFields = new Map<DeclarationId, ClassField[]>()
  const staticMethods = new Map<DeclarationId, ClassMethod[]>()
  const staticAccessors = new Map<DeclarationId, ClassAccessor[]>()
  const constructs = new Map<DeclarationId, CallableAbi | null>()
  const instances = new Map<DeclarationId, Representation | null>()
  const constructors = new Map<DeclarationId, FunctionId | null>()
  const layoutOnly = new Set<DeclarationId>()
  const bases = new Map<DeclarationId, DeclarationId>()
  const prototypeBases = new Set<DeclarationId>()
  const nativeBases = new Map<DeclarationId, NonNullable<ClassLayout['nativeBase']>>()
  const names = new Map<DeclarationId, string>()
  const lengths = new Map<DeclarationId, number>()
  const nativeErrorConstructors = new Set([
    'ErrorConstructor',
    'EvalErrorConstructor',
    'RangeErrorConstructor',
    'ReferenceErrorConstructor',
    'SyntaxErrorConstructor',
    'TypeErrorConstructor',
    'URIErrorConstructor'
  ])

  // The physical class each census copy belongs to, read off the copy's own
  // carriers: its constructor object names the class it constructs
  // (`constructor-family.members[0]`), a layout-only copy's instance carrier
  // names the class it is an instance of. Both are `structural.ts`'s
  // `physicalClassDeclarationOf` answer for that copy's own fillings.
  const physicalOf = new Map<DeclarationId, DeclarationId>()
  const publishPhysical = (copy: DeclarationId, physical: DeclarationId | undefined): void => {
    if (physical !== undefined && !physicalOf.has(copy) && genericRootOf(physical) === genericRootOf(copy)) physicalOf.set(copy, physical)
  }
  for (const operation of input.graph.operations.values()) {
    if (
      operation.family === 'allocation' &&
      operation.allocated === 'class-constructor-object' &&
      operation.classDeclaration !== undefined
    ) {
      const published = resultOf(operation, 'value')
      const carrier = published ? input.plan.selected.get(published.id) : undefined
      if (carrier?.kind === 'constructor-family') publishPhysical(operation.classDeclaration, carrier.members[0])
      continue
    }
    if (operation.family !== 'class-lifecycle') continue
    if (operation.event === 'bind-class-value' && operation.classLayoutOnly) {
      layoutOnly.add(operation.classDeclaration)
      const storage = operation.operands.find((operand) => operand.role === 'instance-layout')
      if (storage) {
        const instance = input.deriver.derive(storage.type)
        instances.set(operation.classDeclaration, instance)
        if (instance.kind === 'class-ref') publishPhysical(operation.classDeclaration, instance.declaration)
      }
    }
  }

  // Constructor bodies are identified by their producer, never by an ABI
  // shared with ordinary callbacks and methods (class receiver, void result).
  const constructorBodies = new Map<string, FunctionId>()
  for (const operation of input.graph.operations.values()) {
    if (
      operation.family !== 'allocation' ||
      operation.allocated !== 'function-object' ||
      !operation.callable ||
      !operation.classConstructorBodyOf
    )
      continue
    constructorBodies.set(operation.classConstructorBodyOf, operation.callable)
  }

  // A constructor-family carrier names its members by generic ROOT -- the
  // anchor `structural.ts` keys a `class-ref` on -- while `class-lifecycle`
  // minted the body's ownership above under the census's per-copy id
  // (`decl|f168|1@0`): the same two spellings `collapseSpecializations`
  // reconciles for every other member bucket. Looked up by the member alone,
  // the body of every GENERIC class was simply never found: `new Box<T>(v)`
  // allocated, ran its field initializers and returned, with `this.value = v`
  // never executed -- a construction that silently skipped its constructor,
  // the exact half-emission `constructionsOf` refuses by name when it can see
  // it. One copy with a body is one answer. Two copies with different bodies
  // is the two-layout case `collapseSpecializations` leaves refused, and it
  // gets no answer here either.
  const constructorBodyOfRoot = (member: DeclarationId): FunctionId | null => {
    const root = genericRootOf(member)
    const bodies = new Set<FunctionId>()
    for (const [owner, body] of constructorBodies) if (genericRootOf(owner as DeclarationId) === root) bodies.add(body)
    return bodies.size === 1 ? [...bodies][0]! : null
  }

  /**
   * The body belonging to the COPY this constructor object is the constructor
   * object OF.
   *
   * `constructorBodyOfRoot` above answers for a root with exactly one body,
   * and abstains when several copies each minted their own -- there is no way
   * to pick between two bodies knowing only the root. The allocation knows:
   * `classDeclaration` is the per-copy id this constructor object was minted
   * for, and `constructorBodies` is keyed by exactly that spelling, so the
   * copy's own body is a direct lookup rather than a choice.
   *
   * `runtime/node/globals.ts`'s `class MessageEvent<T = any> extends Event` is
   * why this exists. The census holds two copies of it -- one from the
   * argument `websocket.ts` constructs with, one from the listener type it is
   * handed to -- whose layouts collapse onto one struct, so the abstention
   * above left the class with NO constructor and `constructionsOf` built the
   * implicit `super(...args)` instead: `data` was never assigned, and the
   * forwarded second argument was a `MessageEventInit` where the base's
   * `EventInit` was declared, which is the store clang refused.
   */
  const constructorBodyOfCopy = (operation: { readonly classDeclaration?: DeclarationId }): FunctionId | null =>
    operation.classDeclaration === undefined ? null : (constructorBodies.get(String(operation.classDeclaration)) ?? null)

  for (const operation of input.graph.operations.values()) {
    if (operation.family === 'allocation' && operation.allocated === 'class-constructor-object') {
      const published = resultOf(operation, 'value')
      const carrier = published ? input.plan.selected.get(published.id) : undefined
      // The construction's result carrier is the instance carrier: it is the
      // constructor's own published convention, not a second derivation of what
      // an instance of this class looks like.
      const abi = carrier && (carrier.kind === 'constructor-family' || carrier.kind === 'function') ? carrier.abi : null
      // Only the class this allocation evaluates: a family may also name the
      // subclasses the program stores into this constructor's slot, and those
      // have constructions of their own.
      const allocated = operation.classDeclaration === undefined ? null : genericRootOf(operation.classDeclaration)
      const members = carrier?.kind === 'constructor-family' ? carrier.members : []
      for (const member of members.filter((one) => allocated === null || members.length === 1 || genericRootOf(one) === allocated)) {
        constructs.set(member, abi)
        instances.set(member, abi?.result ?? null)
        constructors.set(member, constructorBodies.get(member) ?? constructorBodyOfCopy(operation) ?? constructorBodyOfRoot(member))
      }
      if (operation.classDeclaration !== undefined && operation.functionName !== undefined)
        names.set(operation.classDeclaration, operation.functionName)
      if (operation.classDeclaration !== undefined && operation.functionLength !== undefined)
        lengths.set(operation.classDeclaration, operation.functionLength)
      continue
    }
    if (operation.family !== 'class-lifecycle') continue
    // A modelled prototype re-parenting links the two classes exactly as
    // `extends` does for layout and dispatch; its heritage operand is read the
    // same way.
    if (operation.event === 'evaluate-heritage' || operation.event === 'reparent-prototype') {
      if (operation.event === 'reparent-prototype') prototypeBases.add(operation.classDeclaration)
      const heritage = operation.operands.find((operand) => operand.role === 'heritage')
      const carrier =
        heritage?.source.kind === 'result'
          ? input.plan.selected.get(heritage.source.result)
          : operation.classLayoutOnly && heritage
            ? input.deriver.derive(heritage.type)
            : null
      if (!carrier) continue
      // The base is read off the heritage value's own carrier rather than off
      // the syntax: `class D extends B` and `class D extends mixin(B)` are the
      // same event, and only the carrier says which class the evaluated value
      // actually constructs. A family naming several classes states no single
      // base, so it is left absent instead of resolved to whichever came first.
      if (
        carrier?.kind === 'native-handle' &&
        nativeErrorConstructors.has(carrier.protocol) &&
        carrier.construct?.result.kind === 'native-record-ref'
      ) {
        nativeBases.set(operation.classDeclaration, { protocol: carrier.protocol, instance: carrier.construct.result })
        continue
      }
      if (carrier?.kind !== 'constructor-family') continue
      const [only, ...rest] = carrier.members
      if (!only) continue
      if (rest.length === 0) {
        bases.set(operation.classDeclaration, only)
        continue
      }
      // A base's constructor slot that also holds subclasses: the family's
      // declared class is the base, and the emitted heritage evaluation checks
      // the value is exactly it (`gea::exactNativeClassHeritage`).
      const declared = carrier.abi.result.kind === 'class-ref' ? carrier.abi.result.declaration : null
      if (declared !== null && carrier.members.includes(declared)) bases.set(operation.classDeclaration, declared)
      continue
    }
    if (operation.event === 'define-method') {
      const key = operation.operands.find((operand) => operand.role === 'key')
      const method = operation.operands.find((operand) => operand.role === 'method')
      const storage = operandOf(operation, 'method-storage')
      if (key?.source.kind !== 'constant') continue
      const target = operation.placement === 'static' ? staticMethods : methods
      const bucket = target.get(operation.classDeclaration) ?? []
      bucket.push({
        key: key.source.text,
        callable: method?.source.kind === 'result' ? allocatedCallableOf(allocatedCallables, method.source.result) : null,
        ...(method?.source.kind === 'result' && input.plan.selected.get(method.source.result)
          ? { representation: input.plan.selected.get(method.source.result)! }
          : {}),
        ...(storage ? { storageRepresentation: input.deriver.derive(storage.type) } : {})
      })
      target.set(operation.classDeclaration, bucket)
      continue
    }
    if (operation.event === 'define-getter' || operation.event === 'define-setter') {
      const key = operation.operands.find((operand) => operand.role === 'key')
      const half = operation.operands.find((operand) => operand.role === 'method')
      if (key?.source.kind !== 'constant') continue
      const name = key.source.text
      const callable = half?.source.kind === 'result' ? allocatedCallableOf(allocatedCallables, half.source.result) : null
      const target = operation.placement === 'static' ? staticAccessors : accessors
      const bucket = target.get(operation.classDeclaration) ?? []
      // A getter and its setter are two events over one member, so the second
      // fills in the half the first left null rather than appending a second
      // entry a lookup would then have to choose between.
      const existing = bucket.find((entry) => entry.key === name)
      const selected = half?.source.kind === 'result' ? (input.plan.selected.get(half.source.result) ?? null) : null
      const merged: ClassAccessor =
        operation.event === 'define-getter'
          ? { key: name, getter: callable, setter: existing?.setter ?? null, ...(selected ? { representation: selected } : {}) }
          : {
              key: name,
              getter: existing?.getter ?? null,
              setter: callable,
              ...(existing?.representation ? { representation: existing.representation } : {})
            }
      if (existing) bucket[bucket.indexOf(existing)] = merged
      else bucket.push(merged)
      target.set(operation.classDeclaration, bucket)
      continue
    }
    if (operation.event !== 'define-field') continue
    const initializerOperand = operation.operands.find((operand) => operand.role === 'initializer')
    const keyOperand = operation.operands.find((operand) => operand.role === 'key')
    // A field whose key is not a constant is skipped rather than guessed: a
    // computed key names a member no fixed struct layout has, and inventing a
    // name for it would produce a store into a field nothing declares.
    if (keyOperand?.source.kind !== 'constant') continue
    const target = operation.placement === 'static' ? staticFields : fields
    const bucket = target.get(operation.classDeclaration) ?? []
    bucket.push({
      declaration: operation.declaration,
      key: keyOperand.source.text,
      initializer:
        initializerOperand?.source.kind === 'result' ? allocatedCallableOf(allocatedCallables, initializerOperand.source.result) : null,
      representation: (() => {
        const storage = operandOf(operation, 'field-storage')
        return storage ? input.deriver.derive(storage.type) : null
      })(),
      syntheticSubclassMemberOverlay: operation.syntheticSubclassMemberOverlay === true
    })
    target.set(operation.classDeclaration, bucket)
  }

  const layouts = new Map<DeclarationId, ClassLayout>()
  for (const declaration of new Set([
    ...instances.keys(),
    ...fields.keys(),
    ...methods.keys(),
    ...accessors.keys(),
    ...staticFields.keys(),
    ...staticMethods.keys(),
    ...staticAccessors.keys(),
    ...bases.keys(),
    ...nativeBases.keys(),
    ...names.keys()
  ])) {
    layouts.set(declaration, {
      declaration,
      ...(layoutOnly.has(declaration) ? { layoutOnly: true } : {}),
      base: bases.get(declaration) ?? null,
      ...(prototypeBases.has(declaration) && bases.has(declaration) ? { prototypeBase: true as const } : {}),
      ...(input.uninstantiable?.has(declaration) ? { uninstantiable: true as const } : {}),
      nativeBase: nativeBases.get(declaration) ?? null,
      construct: constructs.get(declaration) ?? null,
      instance: instances.get(declaration) ?? null,
      constructor: constructors.get(declaration) ?? null,
      fields: fields.get(declaration) ?? [],
      fieldOwnership: [],
      methods: methods.get(declaration) ?? [],
      accessors: accessors.get(declaration) ?? [],
      staticFields: staticFields.get(declaration) ?? [],
      staticMethods: staticMethods.get(declaration) ?? [],
      staticAccessors: staticAccessors.get(declaration) ?? [],
      name: names.get(declaration) ?? null,
      length: lengths.get(declaration) ?? null
    })
  }
  return publishClassMethodOverrides(publishClassFieldOwnership(collapseSpecializations(layouts, physicalOf)), input)
}

/**
 * Whether a runtime property key held in `carrier` can never be a Symbol.
 *
 * ToPropertyKey (ECMA-262 7.1.19) returns a Symbol only for a Symbol, or for
 * an object whose ToPrimitive answers one. Every other primitive becomes its
 * string. So a key carried as a string, a number, a boolean or an absence --
 * or a union of only those -- spells string keys alone; an object, a symbol
 * or a dynamic key may spell either and answers `false`.
 */
export const keyExcludesSymbols = (carrier: Representation): boolean => {
  switch (carrier.kind) {
    case 'string':
    case 'scalar':
    case 'null':
    case 'undefined':
      return true
    case 'optional':
      return keyExcludesSymbols(carrier.payload)
    case 'borrowed-ref':
      return keyExcludesSymbols(carrier.referent)
    case 'tagged-union':
      return carrier.arms.length > 0 && carrier.arms.every((arm) => keyExcludesSymbols(arm.value))
    default:
      return false
  }
}

/** A write creates an own callable property without replacing its prototype declaration. */
export const publishClassMethodOverrides = (
  layouts: ReadonlyMap<DeclarationId, ClassLayout>,
  input: ClassProjectionInput
): ReadonlyMap<DeclarationId, ClassLayout> => {
  const overrides = new Map<DeclarationId, Map<string, RecordField>>()
  const prototypeMutations = new Map<DeclarationId, Set<string>>()
  const prototypes = new Map<SemanticResultId, Set<DeclarationId>>()
  const prototypeBindings = new Map<DeclarationId, Set<DeclarationId>>()
  const mergeOrigins = <K>(map: Map<K, Set<DeclarationId>>, key: K, origins: Iterable<DeclarationId>): boolean => {
    const prior = map.get(key) ?? new Set<DeclarationId>()
    const size = prior.size
    for (const declaration of origins) prior.add(declaration)
    if (prior.size === size) return false
    map.set(key, prior)
    return true
  }
  let changed = true
  while (changed) {
    changed = false
    for (const operation of input.graph.operations.values()) {
      const result = resultOf(operation, 'value')
      if (operation.family === 'property' && operation.internalMethod === 'get') {
        const key = operandOf(operation, 'key')
        const receiver = operandOf(operation, 'receiver')
        const carrier = receiver?.source.kind === 'result' ? input.plan.selected.get(receiver.source.result) : null
        if (result && key?.source.kind === 'constant' && key.source.text === 'prototype' && carrier?.kind === 'constructor-family')
          changed = mergeOrigins(prototypes, result.id, carrier.members.map(genericRootOf)) || changed
      } else if (operation.family === 'binding') {
        if (operation.action === 'read' && result)
          changed = mergeOrigins(prototypes, result.id, prototypeBindings.get(operation.declaration) ?? []) || changed
        else if (operation.action === 'write' || operation.action === 'initialize') {
          const source = operandOf(operation, operation.action === 'initialize' ? 'initializer' : 'value')
          if (source?.source.kind === 'result') {
            changed = mergeOrigins(prototypeBindings, operation.declaration, prototypes.get(source.source.result) ?? []) || changed
            if (result) changed = mergeOrigins(prototypes, result.id, prototypes.get(source.source.result) ?? []) || changed
          }
        }
      } else if (operation.family === 'computation' && result && (operation.form === 'conditional' || operation.form === 'logical')) {
        for (const operand of operation.operands)
          if (operand.source.kind === 'result')
            changed = mergeOrigins(prototypes, result.id, prototypes.get(operand.source.result) ?? []) || changed
      }
    }
  }
  const unsupportedPrototypes = new Map<DeclarationId, Set<string>>()
  const unsupported = (declaration: DeclarationId, reason: string): void => {
    const reasons = unsupportedPrototypes.get(declaration) ?? new Set<string>()
    reasons.add(reason)
    unsupportedPrototypes.set(declaration, reasons)
  }
  const prototypeMemberIsMethod = (declaration: DeclarationId, key: string): boolean => {
    const seen = new Set<DeclarationId>()
    for (let current: DeclarationId | null = declaration; current !== null && !seen.has(current);) {
      seen.add(current)
      const layout = layouts.get(current)
      if (!layout) return false
      if (layout.fields.some((field) => field.key === key) || layout.accessors.some((accessor) => accessor.key === key)) return false
      if (layout.methods.some((method) => method.key === key)) return true
      current = layout.base
    }
    return false
  }
  for (const operation of input.graph.operations.values()) {
    for (const operand of operation.operands) {
      if (operand.source.kind !== 'result') continue
      const origins = prototypes.get(operand.source.result)
      if (!origins?.size) continue
      if (operation.family === 'binding' || operation.family === 'reference') continue
      if (
        operation.family === 'computation' &&
        (operation.form === 'conditional' ||
          operation.form === 'logical' ||
          operation.form === 'typeof' ||
          operation.form === 'equality' ||
          operation.form === 'instanceof')
      )
        continue
      if (operation.family === 'property' && operand.role === 'receiver') {
        const key = operandOf(operation, 'key')
        const name = key?.source.kind === 'constant' ? key.source.text : null
        for (const declaration of origins) {
          if (
            (operation.internalMethod === 'get' || operation.internalMethod === 'set') &&
            name !== null &&
            prototypeMemberIsMethod(declaration, name)
          )
            continue
          unsupported(declaration, `prototype ${operation.internalMethod} of ${name ?? 'a runtime key'} has no typed method protocol`)
        }
      } else {
        for (const declaration of origins) unsupported(declaration, `prototype escapes through ${operation.family}:${operand.role}`)
      }
    }
  }
  const mark = (receiver: Representation, key: string | null, prototype: DeclarationId | null = null, symbolKeys = true): void => {
    if (receiver.kind === 'optional') return mark(receiver.payload, key, prototype, symbolKeys)
    if (receiver.kind === 'borrowed-ref') return mark(receiver.referent, key, prototype, symbolKeys)
    if (receiver.kind === 'tagged-union') {
      for (const arm of receiver.arms) mark(arm.value, key, prototype, symbolKeys)
      return
    }
    if (receiver.kind !== 'class-ref') return
    const chain: ClassLayout[] = []
    const seen = new Set<DeclarationId>()
    for (let declaration: DeclarationId | null = genericRootOf(receiver.declaration); declaration !== null && !seen.has(declaration);) {
      seen.add(declaration)
      const layout = layouts.get(declaration)
      if (!layout) break
      chain.push(layout)
      declaration = layout.base
    }
    // A runtime key reaches every method its key domain can spell. A key that
    // can only be a string or number never names a symbol-keyed member
    // (`*[Symbol.iterator]()` is `sym(<declaration>)`), so it reserves no own
    // slot for one -- reserving it anyway put a symbol key in the instance
    // layout, which no fixed-slot protocol can prove.
    const names =
      key === null
        ? new Set(
            chain.flatMap((layout) =>
              layout.methods.map((method) => method.key).filter((name) => symbolKeys || symbolPropertyKeyDeclarationOf(name) === null)
            )
          )
        : new Set([key])
    for (const name of names) {
      // A real own field/accessor hides the prototype method and owns its own
      // storage contract. A method override in a subclass shares the root slot.
      const visible = chain.find(
        (layout) =>
          layout.fields.some((field) => field.key === name) ||
          layout.accessors.some((field) => field.key === name) ||
          layout.methods.some((method) => method.key === name)
      )
      if (!visible?.methods.some((method) => method.key === name)) continue
      let owner = visible
      for (const ancestor of chain.slice(chain.indexOf(visible) + 1)) {
        if (ancestor.fields.some((field) => field.key === name) || ancestor.accessors.some((field) => field.key === name)) break
        if (ancestor.methods.some((method) => method.key === name)) owner = ancestor
      }
      const method = owner.methods.find((method) => method.key === name)
      const representation = method?.storageRepresentation ?? method?.representation
      if (!representation) continue
      const abi = abiOfCallee(representation)
      if (!abi) continue
      const fields = overrides.get(owner.declaration) ?? new Map<string, RecordField>()
      fields.set(name, { key: name, value: { kind: 'function-value-dispatch', abi }, required: false })
      overrides.set(owner.declaration, fields)
      if (prototype !== null) {
        const keys = prototypeMutations.get(prototype) ?? new Set<string>()
        keys.add(name)
        prototypeMutations.set(prototype, keys)
      }
    }
  }
  const carrierOf = (operand: SemanticOperand): Representation =>
    (operand.source.kind === 'result' ? input.plan.selected.get(operand.source.result) : undefined) ?? input.deriver.derive(operand.type)
  for (const operation of input.graph.operations.values()) {
    let receiver
    let key: string | null = null
    // The operand a runtime key is computed from, when the write names one.
    // Intrinsics without a key operand (`Object.assign`) copy whatever own
    // keys their source holds, symbols included, and keep `undefined` here.
    let runtimeKey: SemanticOperand | undefined
    if (
      operation.family === 'property' &&
      (operation.internalMethod === 'set' || operation.internalMethod === 'delete' || operation.internalMethod === 'define-own-property')
    ) {
      receiver = operandOf(operation, 'receiver')
      const named = operandOf(operation, 'key')
      if (named?.source.kind === 'constant') key = named.source.text
      else runtimeKey = named
    } else if (operation.family === 'invocation' && operation.intrinsicMutation) {
      receiver = operation.operands.find((operand) => operand.role === 'argument' && operand.ordinal === 0)
      if (operation.intrinsicMutation === 'reflect-set' || operation.intrinsicMutation === 'object-define-property') {
        const named = operation.operands.find((operand) => operand.role === 'argument' && operand.ordinal === 1)
        if (named?.source.kind === 'constant') key = named.source.text
        else runtimeKey = named
      }
    }
    if (!receiver) continue
    const symbolKeys = runtimeKey === undefined || !keyExcludesSymbols(carrierOf(runtimeKey))
    const selected = receiver.source.kind === 'result' ? input.plan.selected.get(receiver.source.result) : undefined
    const prototypeOrigins = receiver.source.kind === 'result' ? prototypes.get(receiver.source.result) : undefined
    if (prototypeOrigins?.size) {
      for (const declaration of prototypeOrigins) {
        const instance = layouts.get(declaration)?.instance
        if (instance) mark(instance, key, declaration, symbolKeys)
      }
    } else mark(selected ?? input.deriver.derive(receiver.type), key, null, symbolKeys)
  }
  return new Map(
    [...layouts].map(([declaration, layout]) => {
      const fields = overrides.get(declaration)
      const prototypeKeys = prototypeMutations.get(declaration)
      const unsupportedUses = unsupportedPrototypes.get(declaration)
      return [
        declaration,
        {
          ...layout,
          ...(fields ? { methodOverrides: [...fields.values()] } : {}),
          ...(prototypeKeys ? { prototypeMethodMutations: [...prototypeKeys] } : {}),
          ...(unsupportedUses ? { prototypeUnsupportedUses: [...unsupportedUses] } : {})
        }
      ]
    })
  )
}
