import type { DeclarationId, FunctionId, StructuralTypeId } from '../identity/ids.js'
import { instantiatedParameterTypes, type SelectedSignature } from '../semantics/model/selected-signature.js'
import type { SignatureShape, StructuralMember, StructuralShape, StructuralType } from '../semantics/model/structural-types.js'
import { genericFunctionSetMembersOf, runtimeSymbolMemberIndexOf } from '../semantics/model/structural-types.js'
import {
  carriableIndexesOf,
  dictionaryIndexOf,
  isDataOnlyDictionaryShape,
  isDataOnlyObjectShape,
  recordAccessorsOf,
  recordFieldKeyOf
} from './object-shape.js'
import type { AbiParameter, CallableAbi, RecordField, RecordIndexSidecar, Representation } from './model.js'
import { abiKey, passingOf, representationKey } from './model.js'
import {
  createIntersectionFlattener,
  intersectPropertyRepresentations,
  intersectionMemberKindOf,
  isPrimitiveValueShape
} from './intersection.js'
import { widestSubsumingAbi } from './host-abi.js'
import { primitiveCarrier, storedCarrier, unresolved } from './primitives.js'
import { createUnionDeriver } from './union.js'
import { deriveKeyedCollection } from './collections.js'
import type {
  DateDeclarationPolicy,
  HostBindingPolicy,
  HostNamespaceRootPolicy,
  KeyedCollectionPolicy,
  OwnershipPolicy,
  PromiseDeclarationPolicy,
  GeneratorDeclarationPolicy,
  RegExpDeclarationPolicy,
  StandardBufferPolicy,
  StringObjectDeclarationPolicy,
  ErrorDeclarationPolicy,
  FunctionDeclarationPolicy,
  ClassHeritagePolicy,
  ClassCopyPolicy,
  InterfaceImplementorPolicy,
  TypedArrayElementPolicy,
  ValueRecordPolicy
} from './policies.js'
import {
  defaultClassCopyPolicy,
  defaultDateDeclarationPolicy,
  defaultHostBindingPolicy,
  defaultHostNamespaceRootPolicy,
  defaultKeyedCollectionPolicy,
  defaultOwnershipPolicy,
  defaultPromiseDeclarationPolicy,
  defaultGeneratorDeclarationPolicy,
  defaultRegExpDeclarationPolicy,
  defaultStandardBufferPolicy,
  defaultStringObjectDeclarationPolicy,
  defaultErrorDeclarationPolicy,
  defaultFunctionDeclarationPolicy,
  defaultClassHeritagePolicy,
  defaultInterfaceImplementorPolicy,
  defaultTypedArrayElementPolicy,
  defaultValueRecordPolicy
} from './policies.js'
export type {
  DateDeclarationPolicy,
  HostBindingPolicy,
  HostNamespaceRootPolicy,
  HostProtocolBinding,
  KeyedCollectionFamily,
  KeyedCollectionPolicy,
  OwnershipPolicy,
  PromiseDeclarationPolicy,
  GeneratorDeclarationPolicy,
  RegExpDeclarationBinding,
  RegExpDeclarationKind,
  RegExpDeclarationPolicy,
  StandardBufferKind,
  StandardBufferPolicy,
  StringObjectDeclarationPolicy,
  ErrorDeclarationPolicy,
  FunctionDeclarationPolicy,
  ClassHeritagePolicy,
  ClassCopyPolicy,
  InterfaceImplementorPolicy,
  TypedArrayElementPolicy,
  ValueRecordPolicy
} from './policies.js'
export {
  defaultClassCopyPolicy,
  defaultDateDeclarationPolicy,
  defaultHostBindingPolicy,
  defaultHostNamespaceRootPolicy,
  defaultKeyedCollectionPolicy,
  defaultOwnershipPolicy,
  defaultPromiseDeclarationPolicy,
  defaultGeneratorDeclarationPolicy,
  defaultRegExpDeclarationPolicy,
  defaultStandardBufferPolicy,
  defaultStringObjectDeclarationPolicy,
  defaultErrorDeclarationPolicy,
  defaultFunctionDeclarationPolicy,
  defaultClassHeritagePolicy,
  defaultInterfaceImplementorPolicy,
  defaultTypedArrayElementPolicy,
  defaultValueRecordPolicy
}

/**
 * Selecting a physical carrier for a canonical structural shape.
 *
 * This is the only place a shape becomes a carrier, and it reads nothing but the
 * sealed structural table. It never consults the AST, a name, or a print form:
 * if a carrier cannot be selected from the shape alone, the shape did not carry
 * enough and the answer is `unresolved` with a reason, never a guess.
 * `unresolved` here is not failure -- it is the fail-closed answer that stops a
 * half-known value from reaching materialization. The opt-in fallback also
 * admits runtime-erased type expressions and proxy-connected types, selected
 * before publication. Missing structure remains unresolved in both modes.
 */

export interface RepresentationDeriver {
  readonly dynamicFallback?: boolean
  readonly derive: (type: StructuralTypeId) => Representation
  /**
   * The LAYOUT a shape id names, for a lookup that holds a `native-record-ref`
   * (or a `class-ref`, or a tuple's shape) and needs its fields -- as opposed
   * to `derive`, which is the carrier a VALUE of that type occupies. For every
   * shape but one the two are the same answer. The exception is an anonymous
   * record that contains itself (`nameSelfReferencedRecord`): `derive` spells
   * it by name at every value position so its key does not depend on walk
   * order, and this is where its record definition is still served from.
   * Every "what fields does this shape have" question must ask here, never
   * `derive`, or it reads the name back and finds no fields.
   */
  readonly layoutOf: (type: StructuralTypeId) => Representation
  /** The ABI of one signature shape, or `null` when its arity is not physical. */
  readonly abiOf: (signature: SignatureShape) => CallableAbi | null
  /**
   * The carrier a *stored* position holds -- see `primitives.ts`'s
   * `storedCarrier`. Exposed alongside `derive` because a stored position is
   * not only something this deriver builds internally (a record field, an
   * array element, a parameter's ABI slot): any external caller asking "what
   * does this cell physically hold" -- a binding's own storage, not a
   * transient expression result -- needs the identical `void`-is-`undefined`
   * correction `abiOf` already applies to every parameter slot, and had no
   * way to ask for it before this was added.
   */
  readonly deriveStored: (type: StructuralTypeId) => Representation
  /**
   * Whether a structural type's own shape is the primitive `never` --
   * distinct from asking whether its *carrier* is `{kind:'void'}`, which
   * `never` and a genuine completed-void evaluation share on purpose
   * (`primitives.ts`'s own comment: "physically both occupy no storage").
   * That equivalence is correct for storage and wrong for reachability: a
   * position whose structural type is `never` is provably never reached, so
   * an operation performed on it (a property read, an `instanceof` test, a
   * conversion) is dead code, while an operation on a genuine `void` result
   * is not. Consumers that need to tell "unreachable" from "a completed
   * evaluation with no result" must ask this, not compare carrier kinds.
   */
  readonly isNeverType: (type: StructuralTypeId) => boolean
  /**
   * Whether a shape is a CLOSED TUPLE -- the one record layout whose values
   * are Array exotic objects in the language.
   *
   * "There is deliberately no tuple carrier: a closed tuple is a record whose
   * keys are its indices", which is the right physical answer and loses the
   * one non-physical fact 23.1.2.2 asks for. `Array.isArray` is decided from
   * the carrier's kind alone (`isArrayConstantOf`), and `record` is in that
   * table's `false` set because an object literal is not an Array -- so a
   * tuple, whose record is indistinguishable from one, was answered `false`
   * for a value the language says `true` for. hono's trie router is the
   * measured case: `Pattern = readonly [string, string, RegExp | true] | '*'`
   * and `Array.isArray(pattern) ? pattern[0] : p` folded to the string arm at
   * compile time, so no parameterized route would ever have been registered.
   *
   * Asked of the SHAPE rather than carried on the carrier on purpose: the
   * record's layout is genuinely the same either way, and a flag on the
   * representation would make two physically identical carriers compare
   * unequal everywhere conversions and the certificate key them.
   */
  readonly isTupleShape: (type: StructuralTypeId) => boolean
  /**
   * The calling convention of one checker-authenticated source function that
   * semantic publication registered for dynamic Function-object storage.
   * StructuralTypeId is intentionally not accepted: unrelated functions can
   * share one signature shape and may never borrow each other's ABI.
   */
  readonly nativeCallableConventions: (functionId: FunctionId) => { call: CallableAbi; construct: CallableAbi | null } | null
  /**
   * Whether a carrier is the standard `Date`. The C++ spelling a Date is
   * carried in is a fact this layer only carries (`DateDeclarationPolicy`),
   * so the one place that can say "this `native-record-ref` is a Date" is
   * the deriver that stamped the spelling on. The slot census asks, because
   * ECMA-262 ToPrimitive of a Date prefers `valueOf` where every other object
   * this compiler carries has only `toString` to fall through to -- a
   * mixed-carrier `+`/`<` over a Date is not the ToString answer.
   */
  readonly isDateCarrier?: (representation: Representation) => boolean
}

/**
 * The `SignatureShape` a checker-resolved invocation actually calls.
 *
 * A callee's own declared type is an overload *set*, and `sharedAbiOf` below
 * correctly refuses to join it into one convention when the overloads are not
 * physically identical -- that is not a gap, it is the honest fact that one
 * value's general-purpose carrier has no single calling convention to state.
 * A call site is a different question: the checker already resolved it to
 * exactly one signature (`InvocationOperation.selectedSignature`,
 * `semantics/model/selected-signature.ts`), with no sibling overload left to
 * disagree with it, and `SelectedSignature` already carries every field
 * `abiOf` needs to answer that question -- it is a `SignatureShape` under
 * `returnType` instead of `result`. Naming that correspondence here, instead
 * of leaving it as an unstated coincidence two field lists happen to share, is
 * what makes it the one thing an invocation lowering has to reach for instead
 * of a joined lowest-common-denominator carrier it was never going to get.
 */
export const signatureShapeOfSelectedSignature = (signature: SelectedSignature): SignatureShape => ({
  parameters: signature.parameters,
  minimumArity: signature.minimumArity,
  thisParameter: signature.thisParameter,
  result: signature.returnType
})

/**
 * The frame one `new` of a host constructor fills, read off the overload the
 * checker selected at that site -- the construct-side use of
 * `signatureShapeOfSelectedSignature` above.
 *
 * `hostInvocationAbiOf` answers for the constructor VALUE, and for
 * `MapConstructor` (`new ()` beside `new <K, V>(entries?)`),
 * `WeakMapConstructor` (generic, plus an `Iterable` overload) and every
 * typed-array constructor (`length` / `ArrayLike<number>` / `buffer,
 * byteOffset?, length?`) it correctly answers "no single convention". Yet
 * every three.js renderer module builds its cache as `new WeakMap()` or
 * `new Map()` (`WebGLProperties`, `WebGLRenderStates`, `WebGLShaderCache`,
 * `WebGLGeometries`, ...), and each of those SITES resolved to exactly one
 * overload. Without a frame to test, the reflection census read each of them
 * as an unknown construction and published the new collection's key and
 * value carriers -- every field of every render-state record they hold.
 *
 * Only the formals the site FILLS are laid out. A formal the site omits is
 * optional by the checker's own resolution (`minimumArity`), the host
 * construction reads its absence itself (`emitKeyedCollectionConstruct`'s
 * zero-argument `gea::makeRef<T>()`), and no value is transported into it --
 * so it states nothing about the frame and, for a generic overload, never has
 * to be instantiated. A FILLED formal of a generic overload whose type
 * arguments the checker inferred is refused: `instantiatedParameterTypes`
 * withholds those on purpose, and reconstructing them here would be the
 * rediscovery that authority exists to prevent. A rest formal has no fixed
 * position to lay out and is refused with it.
 *
 * The result is the carrier the construction itself holds, not the
 * signature's return type: the checker defaults `new WeakMap()` to
 * `WeakMap<WeakKey, any>` while the collection census bound the key and value
 * the program actually stores (`collection-construct-type-inference`), and the
 * host renderer mints the held carrier directly. That is how a generic
 * overload's K/V are instantiated here -- from the construction's own result,
 * never from argument syntax.
 */
export const selectedHostConstructFrameOf = (
  deriver: Pick<RepresentationDeriver, 'abiOf'>,
  signature: SelectedSignature,
  received: number,
  result: Representation
): CallableAbi | null => {
  if (signature.provenance !== 'ambient' || signature.thisParameter !== null) return null
  if (received < signature.minimumArity || received > signature.parameters.length) return null
  const filled = signature.parameters.slice(0, received)
  if (filled.some((parameter) => parameter.rest)) return null
  if (filled.length > 0 && instantiatedParameterTypes(signature) === null) return null
  const abi = deriver.abiOf({ parameters: filled, minimumArity: received, thisParameter: null, result: signature.returnType })
  if (abi === null || abi.receiver !== null || abi.restFrom !== null) return null
  if (abi.parameters.some((parameter) => parameter.value.kind === 'unresolved')) return null
  return { ...abi, result }
}

export const createRepresentationDeriver = (
  types: ReadonlyMap<StructuralTypeId, StructuralType>,
  ownership: OwnershipPolicy = defaultOwnershipPolicy,
  binding: HostBindingPolicy = defaultHostBindingPolicy,
  elements: TypedArrayElementPolicy = defaultTypedArrayElementPolicy,
  promise: PromiseDeclarationPolicy = defaultPromiseDeclarationPolicy,
  collections: KeyedCollectionPolicy = defaultKeyedCollectionPolicy,
  buffers: StandardBufferPolicy = defaultStandardBufferPolicy,
  namespaceRoots: HostNamespaceRootPolicy = defaultHostNamespaceRootPolicy,
  date: DateDeclarationPolicy = defaultDateDeclarationPolicy,
  generator: GeneratorDeclarationPolicy = defaultGeneratorDeclarationPolicy,
  regexp: RegExpDeclarationPolicy = defaultRegExpDeclarationPolicy,
  stringObject: StringObjectDeclarationPolicy = defaultStringObjectDeclarationPolicy,
  functionType: FunctionDeclarationPolicy = defaultFunctionDeclarationPolicy,
  heritage: ClassHeritagePolicy = defaultClassHeritagePolicy,
  valueRecords: ValueRecordPolicy = defaultValueRecordPolicy,
  implementors: InterfaceImplementorPolicy = defaultInterfaceImplementorPolicy,
  errors: ErrorDeclarationPolicy = defaultErrorDeclarationPolicy,
  dynamicFallback = false,
  dynamicFallbackTypes: ReadonlySet<StructuralTypeId> = new Set(),
  dynamicCallableShapes: ReadonlyMap<FunctionId, StructuralTypeId> = new Map(),
  dynamicWrittenTypes: ReadonlySet<StructuralTypeId> = new Set(),
  classCopies: ClassCopyPolicy = defaultClassCopyPolicy
): RepresentationDeriver => {
  const memo = new Map<StructuralTypeId, Representation>()
  // Every C++ spelling this deriver stamped on a Date's carrier, so `isDateCarrier` can read the fact back off a carrier.
  const dateNatives = new Set<string>()
  const active = new Set<StructuralTypeId>()
  // `active` answers membership; the ordered path says which native container
  // owns a back edge that returns through a callable or an optional rather than
  // through the container's own structural id.
  const activePath: StructuralTypeId[] = []
  // A back-edge through a native container is not a record reference: Map and
  // Array have no struct name of their own that C++ can forward-declare. Keep
  // one explicit indirection per structural identity while its equation is
  // built, then close it as the outer native wrapper. The reference is a
  // native-record-ref carrying a recursive marker: it is intentionally a leaf
  // to every existing record walker, so no visitor has to infer a JS object
  // cycle or impose its own depth limit.
  const recursiveReferences = new Map<StructuralTypeId, Representation>()
  // A named alias commonly has a distinct structural id for its `Map`/Array
  // body. Once the alias closes the equation, that body must read back as the
  // same wrapper too; otherwise a later body lookup could publish
  // `Map<K, Ref<wrapper>>` beside `Ref<wrapper>` for one physical object.
  const recursiveBodyIds = new Map<StructuralTypeId, StructuralTypeId>()
  // A replay of an active non-container root replaces exactly the container
  // edge that closes the equation. It is deliberately scoped to that replay:
  // publishing this reference as the container's ordinary answer would lose
  // its definition and leave the wrapper undeclared.
  const recursiveReplayReferences = new Map<StructuralTypeId, Representation>()
  const replaying = new Set<StructuralTypeId>()
  // Frames below a container back edge have been derived against its temporary
  // reference, not its closed definition. They may be returned to the active
  // container, but they cannot become canonical memo answers: map-first
  // derivation would otherwise leave a callable ABI permanently pointing only
  // at the reference, so a later root-only plan could not discover the wrapper
  // definition.
  const provisionalDependents = new Set<StructuralTypeId>()
  // Records whose own derivation re-entered their id through a field -- see
  // `nameSelfReferencedRecord` -- and the layouts `layoutOf` serves for them
  // once `derive` has started answering the name instead.
  const selfReferencedRecords = new Set<StructuralTypeId>()
  const definitions = new Map<StructuralTypeId, Representation>()
  // Record and native-container cycles have finite indirection. Any remaining
  // cycle reached this far has no carrier-specific way to close and must not
  // be memoized as though its individual structural id were sound.
  let guardFired = 0

  const shapeOf = (id: StructuralTypeId): StructuralShape | null => types.get(id)?.shape ?? null
  const typedArrayBufferKindOf = (shape: Extract<StructuralShape, { kind: 'declared' }>): 'array-buffer' | 'shared-array-buffer' => {
    for (const argument of shape.typeArguments) {
      const candidate = shapeOf(argument)
      if (candidate?.kind === 'declared' && buffers.forDeclaration(candidate.declaration) === 'shared-array-buffer')
        return 'shared-array-buffer'
    }
    return 'array-buffer'
  }

  /**
   * The class-instance shape an interface's sole implementor was interned
   * under, for the type arguments this reference carries.
   *
   * Built lazily and once: an index over the sealed structural table, which is
   * the only place an INSTANTIATED class shape exists. There is no public
   * checker API to instantiate `PatternRouter<T>` at `Router<[H,
   * RouterRoute]>`'s own arguments, and there is no need for one -- the
   * program constructed the class somewhere, so the checker already interned
   * that instantiation and this finds it rather than rebuilding it.
   *
   * Exact type arguments first. Falling back to a lone instantiation is not a
   * guess: one class-instance shape for the class means the program has
   * exactly one, so it is the shape any slot of that class holds. Two or more
   * with no exact match refuses, because picking between them would be one.
   */
  let implementorShapes: Map<DeclarationId, StructuralTypeId[]> | null = null
  /** Every class-instance shape the sealed table holds for this class declaration; empty for a class the program never instantiates or names. */
  const instanceShapesOf = (declaration: DeclarationId): readonly StructuralTypeId[] => {
    if (implementorShapes === null) {
      implementorShapes = new Map()
      for (const [candidate, entry] of types) {
        if (entry.shape.kind !== 'class-instance') continue
        const known = implementorShapes.get(entry.shape.declaration)
        if (known) known.push(candidate)
        else implementorShapes.set(entry.shape.declaration, [candidate])
      }
    }
    return implementorShapes.get(declaration) ?? []
  }
  const implementorShapeFor = (declaration: DeclarationId, typeArguments: readonly StructuralTypeId[]): StructuralTypeId | null => {
    const candidates = instanceShapesOf(declaration)
    if (candidates.length === 0) return null
    const exact = candidates.filter((candidate) => {
      const shape = shapeOf(candidate)
      if (shape?.kind !== 'class-instance' || shape.typeArguments.length !== typeArguments.length) return false
      return shape.typeArguments.every((argument, index) => argument === typeArguments[index])
    })
    if (exact.length === 1) return exact[0] ?? null
    return candidates.length === 1 ? (candidates[0] ?? null) : null
  }

  /** The carrier a *stored* position holds -- see `storedCarrier`. */
  const deriveStored = (id: StructuralTypeId): Representation => storedCarrier(derive(id))
  const isDataOnlyBody = (id: StructuralTypeId): boolean => isDataOnlyObjectShape(shapeOf(id), shapeOf)

  type RecursiveContainerSource =
    | {
        readonly kind: 'array'
        readonly shape: Extract<StructuralShape, { kind: 'array' }>
        readonly bodyId: StructuralTypeId
        readonly ownershipShape: StructuralShape
        readonly ownershipId: StructuralTypeId
      }
    | {
        readonly kind: 'dictionary'
        readonly shape: Extract<StructuralShape, { kind: 'object' }>
        readonly bodyId: StructuralTypeId
        readonly ownershipShape: StructuralShape
        readonly ownershipId: StructuralTypeId
      }
    | {
        readonly kind: 'keyed-collection'
        readonly shape: Extract<StructuralShape, { kind: 'declared' }>
        readonly bodyId: StructuralTypeId
        readonly ownershipShape: StructuralShape
        readonly ownershipId: StructuralTypeId
      }
    // A callable carries no ownership question: the wrapper struct is the
    // whole indirection and it is always held by value.
    | { readonly kind: 'callable'; readonly shape: Extract<StructuralShape, { kind: 'signature' }>; readonly bodyId: StructuralTypeId }

  /**
   * The container which a recursive type identity denotes, without expanding
   * its recursive argument. Named records intentionally do not pass here:
   * their existing `native-record-ref` is the native indirection. This answers
   * the three containers, and the plain callable, which otherwise have no
   * finite C++ spelling.
   */
  const recursiveContainerSourceOf = (id: StructuralTypeId): RecursiveContainerSource | null => {
    const outer = shapeOf(id)
    if (!outer) return null
    const body = outer.kind === 'declared' && outer.body !== null ? shapeOf(outer.body) : null
    const source = body ?? outer
    const sourceId = body === null ? id : (outer as Extract<StructuralShape, { kind: 'declared' }>).body!
    if (source.kind === 'array') {
      return { kind: 'array', shape: source, bodyId: sourceId, ownershipShape: source, ownershipId: sourceId }
    }
    if (source.kind === 'object' && dictionaryIndexOf(source)) {
      // A declared dictionary is selected in the declared branch itself, so
      // its ownership comes from that declaration rather than its body. The
      // identity memoized after the equation closes is still the actual body:
      // ownership identity and structural body identity answer different
      // questions and aliasing one to the other publishes two carriers.
      return { kind: 'dictionary', shape: source, bodyId: sourceId, ownershipShape: outer, ownershipId: id }
    }
    if (source.kind === 'declared' && collections.forDeclaration(source.declaration)) {
      return { kind: 'keyed-collection', shape: source, bodyId: sourceId, ownershipShape: source, ownershipId: sourceId }
    }
    // Exactly the shapes `deriveSignature` turns into `function-value-dispatch`.
    // A construct signature, a call/construct pair, and the open type of a
    // generic source function all select a different carrier, and naming a
    // wrapper for one of those here would claim a fixpoint whose base type
    // this file cannot spell.
    if (source.kind === 'signature' && source.call.length > 0 && source.construct.length === 0 && !source.generic) {
      return { kind: 'callable', shape: source, bodyId: sourceId }
    }
    return null
  }

  /** Builds the explicit reference half of one recursive container equation. */
  const recursiveReferenceOf = (id: StructuralTypeId): Representation | null => {
    const markProvisionalDependents = (): void => {
      const activeContainer = activePath.lastIndexOf(id)
      if (activeContainer >= 0) {
        for (let position = activeContainer + 1; position < activePath.length; position += 1) {
          const dependent = activePath[position]
          if (dependent !== undefined) provisionalDependents.add(dependent)
        }
      }
    }
    const cached = recursiveReferences.get(id)
    if (cached) {
      markProvisionalDependents()
      return cached
    }
    const source = recursiveContainerSourceOf(id)
    if (!source) return null
    markProvisionalDependents()
    const reference = {
      kind: 'native-record-ref' as const,
      shapeId: id,
      ownership: source.kind === 'callable' ? ('owned' as const) : ownership.forShape(source.ownershipShape, source.ownershipId),
      // A non-null marker makes `records.ts` correctly treat this as a name
      // whose body belongs elsewhere. `cppTypeOf` ignores the marker text and
      // spells the wrapper from `recursive`; it is never a host-native name.
      native: `recursive-container:${id}`,
      recursive: { type: id, container: source.kind === 'array' ? ('array-object' as const) : source.kind, role: 'reference' } as const
    }
    recursiveReferences.set(id, reference)
    recursiveBodyIds.set(id, source.bodyId)
    return reference
  }

  /** Marks the outer native container as the definition for a back-edge. */
  const closeRecursiveContainer = (id: StructuralTypeId, representation: Representation): Representation => {
    const reference = recursiveReferences.get(id)
    if (!reference) return representation
    if (reference.kind !== 'native-record-ref' || reference.recursive?.role !== 'reference' || representation.kind === 'unresolved') {
      guardFired += 1
      return unresolved(`recursive type ${id} does not close over one native container carrier`)
    }
    switch (representation.kind) {
      // A callable wrapper is one by-value struct with no pointer to own, so
      // the shared-refcount indirection the containers need does not apply --
      // `gea::CallableObject` stores a function pointer and a capture, never
      // the parameter types, so its own incomplete self is a legal base.
      case 'function-value-dispatch': {
        if (reference.ownership !== 'owned') {
          guardFired += 1
          return unresolved(`recursive type ${id} carries a callable back edge that is not held by value`)
        }
        const callable = { ...representation, recursive: { type: id, container: 'callable' as const, role: 'definition' as const } }
        const callableBody = recursiveBodyIds.get(id)
        if (callableBody !== undefined && callableBody !== id) memo.set(callableBody, callable)
        return callable
      }
      case 'array-object':
      case 'dictionary':
      case 'keyed-collection':
        if (representation.ownership !== reference.ownership) {
          guardFired += 1
          return unresolved(`recursive type ${id} changes ownership between its definition and back edge`)
        }
        if (representation.ownership !== 'shared-refcount') {
          guardFired += 1
          return unresolved(`recursive type ${id} needs shared-refcount ownership for its native reference indirection`)
        }
        const definition = { ...representation, recursive: { type: id, container: representation.kind, role: 'definition' as const } }
        const body = recursiveBodyIds.get(id)
        if (body !== undefined && body !== id) memo.set(body, definition)
        return definition
      default:
        guardFired += 1
        return unresolved(`recursive type ${id} closed through non-container carrier ${representation.kind}`)
    }
  }

  /** The innermost native container between an active root and its back edge. */
  const recursiveContainerOnActivePath = (from: number): StructuralTypeId | null => {
    for (let position = activePath.length - 1; position >= from; position -= 1) {
      const candidate = activePath[position]
      if (candidate !== undefined && recursiveContainerSourceOf(candidate)) return candidate
    }
    return null
  }

  /**
   * Re-derive an active function, constructor, optional, or alias with the
   * enclosing container already named. The replay gives the function's ABI its
   * real finite result type (`Ref<Wrapper>`); returning that ABI at the back
   * edge is essential, because a container reference cannot stand in for a
   * function value stored by that container.
   */
  const replayThroughRecursiveContainer = (id: StructuralTypeId, container: StructuralTypeId): Representation => {
    if (replaying.has(id)) {
      guardFired += 1
      return unresolved(`structural type ${id} recurs again before native container ${container} can close its carrier`)
    }
    const reference = recursiveReferenceOf(container)
    if (!reference) {
      guardFired += 1
      return unresolved(`structural type ${id} recurs through ${container}, which has no native container carrier`)
    }
    replaying.add(id)
    recursiveReplayReferences.set(container, reference)
    try {
      const shape = shapeOf(id)
      return shape ? deriveShape(id, shape) : unresolved(`structural type ${id} is not present in the sealed table`)
    } finally {
      recursiveReplayReferences.delete(container)
      replaying.delete(id)
    }
  }

  const derive = (id: StructuralTypeId): Representation => {
    const replayReference = recursiveReplayReferences.get(id)
    if (replayReference) return replayReference
    const cached = memo.get(id)
    if (cached) return cached
    if (active.has(id)) {
      const recursive = recursiveReferenceOf(id)
      if (recursive) return recursive
      const recurrenceStart = activePath.lastIndexOf(id)
      const container = recurrenceStart < 0 ? null : recursiveContainerOnActivePath(recurrenceStart)
      if (container) return replayThroughRecursiveContainer(id, container)
      // A record shape that recurs back to itself -- `self: Window & typeof
      // globalThis` interns to the identical `intersection` shape id as the
      // very type `Window`'s own "self" member declares, so flattening that
      // intersection (`deriveIntersection`) re-enters the id already
      // `active` -- has no finite BY-VALUE layout (a C++ aggregate cannot
      // embed itself), but it has an entirely finite BY-REFERENCE one: the
      // same `native-record-ref` a `'declared'`/`'class-instance'` wrapper
      // already hands every OTHER reference to a named record, naming the
      // shape rather than expanding it (see those cases above, and
      // `native-record-ref`'s own doc comment: "expanding a name whose body
      // refers back to itself has no finite carrier, so the name stays the
      // carrier"). Reusing it here -- for a record shape that cycles
      // directly, not only through a nominal wrapper -- is the
      // "shared-refcount handle with a forward declaration" this cycle
      // needs: `targets/cpp/records.ts` already forward-declares every
      // struct before defining it, so a field naming the struct's own shape
      // id compiles as a pointer to an as-yet-incomplete type, same as any
      // other native-record-ref field does.
      //
      // `'object'` and `'intersection'` are the only two structural shape
      // kinds `deriveShape` (below) ever turns into a `record`/
      // `record-with-index` carrier keyed by `shapeId: id` -- `deriveObject`
      // and `deriveIntersection` respectively -- so those are the only two
      // kinds a cycle back to `id` can mean "this record contains itself."
      // Every OTHER structural shape kind keeps the previous fail-closed
      // answer unchanged: a function, union, or tuple that cycles has no
      // such by-reference primitive, and inventing one for a shape this
      // deriver does not know how to indirect would be exactly the guess
      // this guard exists to refuse.
      const cyclic = shapeOf(id)
      if (cyclic?.kind === 'object' || cyclic?.kind === 'intersection') {
        selfReferencedRecords.add(id)
        return { kind: 'native-record-ref', shapeId: id, ownership: ownership.forShape(cyclic, id), native: null }
      }
      // A DECLARED name that cycles is the easiest case of all, and it only
      // became reachable once `structural-self-reference.ts` started closing a
      // re-instantiated alias into a real cycle instead of unrolling it into a
      // tower of distinct ids: mongodb reaches here 2,195 times. The answer is
      // the one the ordinary declared path already gives every OTHER reference
      // to a named record -- the name, not the expansion -- so the cycle takes
      // the same nominal carrier rather than a refusal. Only when the body is
      // a record layout: naming a union or a signature body here would hand
      // `records.ts` a struct id whose fields it cannot find, which is a
      // different failure wearing this one's clothes.
      if (cyclic?.kind === 'declared' && cyclic.body !== null) {
        const body = shapeOf(cyclic.body)
        if (body?.kind === 'object' || body?.kind === 'intersection')
          return { kind: 'native-record-ref', shapeId: cyclic.body, ownership: ownership.forShape(cyclic, id), native: null }
        // A named union is its body: the ordinary declared path derives a
        // union-bodied alias as `derive(shape.body)`, and the body id is
        // active alongside its name, so the union rule below answers.
        if (body?.kind === 'union') return derive(cyclic.body)
      }
      // A UNION that recurs has the by-reference layout its ARMS have. tsc's
      // `type TypeMapper = { kind: Simple; ... } | { kind: Composite; mapper1:
      // TypeMapper; mapper2: TypeMapper }` re-enters the union from inside an
      // arm's own field, and the checker's narrowed `(A & Node & { name?:
      // undefined }) | (B & Node & ...)` unions re-enter through the `Node`
      // family's parent field: 800 refusals on the tsc self-compile. Nothing
      // about the union needs a new indirection -- every record arm stores as
      // a `native-record-ref` already, and an arm that is itself active on the
      // cycle takes the record rule above -- so the union is derived here
      // exactly as its non-recursive form is, through the one union deriver,
      // and reaches the identical tagged-union the top-level derivation
      // memoizes: same shape, same canonical arm order, same discriminant. An
      // arm with no by-reference form (an array or signature that cycles) is
      // still refused by its own kind's guard on the way, so this loosens
      // nothing for the shapes the comment above rules out.
      if (cyclic?.kind === 'union') {
        // Memoized under the top-level rule (no guard fired while deriving),
        // because every later re-entry through any of the union's arms would
        // otherwise derive the same union again -- and tsc's Node-family
        // unions re-enter from hundreds of fields.
        const before = guardFired
        const derived = deriveUnionShape(cyclic)
        if (guardFired === before) memo.set(id, derived)
        return derived
      }
      guardFired += 1
      return unresolved(`structural type ${id} recurs without a nominal carrier on the cycle`)
    }
    const before = guardFired
    active.add(id)
    activePath.push(id)
    const shape = shapeOf(id)
    const derived: Representation =
      dynamicFallback && dynamicFallbackTypes.has(id)
        ? { kind: 'dynamic', reason: 'opt-in-fallback' }
        : dynamicWrittenTypes.has(id)
          ? { kind: 'dynamic', reason: 'declared-any-never-narrowed' }
          : shape
            ? deriveShape(id, shape)
            : unresolved(`structural type ${id} is not present in the sealed table`)
    active.delete(id)
    const popped = activePath.pop()
    if (popped !== id) throw new Error(`representation derivation path lost structural type ${id}`)
    const provisional = provisionalDependents.delete(id)
    // Deriving a body first can enter its declared alias, close the recursive
    // equation there, and install this body's canonical definition while the
    // outer body derivation is still unwinding. Keep that exact object instead
    // of overwriting it with the non-recursive expansion computed before the
    // alias closed.
    const canonical = memo.get(id)
    if (canonical) {
      if (guardFired === before && !provisional) return canonical
      // The outer derivation found a defect after the nested alias installed
      // the provisional body answer. Do not let that partial answer survive a
      // fail-closed guard.
      memo.delete(id)
    }
    const closed = guardFired === before ? nameSelfReferencedRecord(id, closeRecursiveContainer(id, derived)) : derived
    if (guardFired === before && !provisional) memo.set(id, closed)
    return closed
  }

  /**
   * A record that contains itself is spelled BY NAME at every value position,
   * and its layout is kept aside for `layoutOf`.
   *
   * A declared interface has two structural ids -- the name, which derives to
   * a `native-record-ref` without ever expanding, and the body, which is the
   * record -- so every reference to `interface Node { next: Node }` spells
   * one way no matter which walk reaches it first. An anonymous object type
   * that recurs (tsc's `type TypeMapper = {...} | { kind: Composite; mapper1:
   * TypeMapper; mapper2: TypeMapper }`, whose fifth arm is a type literal) has
   * ONE id for both roles, and until this rule it was spelled by whichever
   * role the walk happened to be in: the cycle rule above closes a back edge
   * as `native-record-ref(id)`, while a walk that entered the union from
   * outside the record expanded the same arm inline as `record(id, ...)`. Two
   * keys for one `gea::Ref<Struct>`, decided by memo order -- `let mapper:
   * TypeMapper | undefined` held the inline spelling and the narrowed read
   * after `mapper === undefined` wanted the by-name one, and no conversion
   * exists between them because none should: 19 binding-read rows on the tsc
   * self-compile, plus every merge and narrowed-arm read beside them.
   *
   * Only a shared-refcount record can take the rule: the name is a pointer to
   * an as-yet-incomplete struct, which is exactly what `records.ts`'s forward
   * declarations exist for, whereas a by-value record naming itself would be
   * the "by-value incomplete type" `compiler.ts`'s ownership policy refuses.
   * The by-name answer is memoized as the carrier; the record itself is the
   * definition `layoutOf` serves to every layout lookup, so a field read
   * through the name still finds its fields.
   */
  const nameSelfReferencedRecord = (id: StructuralTypeId, closed: Representation): Representation => {
    if (!selfReferencedRecords.has(id)) return closed
    if ((closed.kind !== 'record' && closed.kind !== 'record-with-index') || closed.ownership !== 'shared-refcount') return closed
    definitions.set(id, closed)
    return { kind: 'native-record-ref', shapeId: id, ownership: closed.ownership, native: null }
  }

  const layoutOf = (id: StructuralTypeId): Representation => {
    const carrier = derive(id)
    return definitions.get(id) ?? carrier
  }

  /**
   * The physical calling convention of one signature.
   *
   * A rest parameter has no fixed physical arity, and this layer has no
   * primitive that turns one into a call frame. Returning `null` states that
   * rather than silently lowering the rest parameter to its array type, which
   * would compile and then pass the wrong number of arguments.
   */
  const abiOf = (signature: SignatureShape): CallableAbi | null => {
    const parameters: AbiParameter[] = []
    let restFrom: number | null = null
    for (const [position, parameter] of signature.parameters.entries()) {
      // A rest parameter's declared type is already the Array the language
      // binds it to, so the slot derives like any other. Only a rest parameter
      // that is not the last one would be a frame this layer cannot lay out,
      // and TypeScript does not admit one.
      if (parameter.rest) {
        if (position !== signature.parameters.length - 1) return null
        restFrom = position
      }
      // An omitted argument is `undefined`, never `null`, and a defaulted
      // parameter widens the same way an optional one does: the physical slot
      // has to hold "the caller didn't supply a value" as well as the payload,
      // because the initializer runs at call time inside the callee, over
      // exactly this carrier (`semantics/normalize/producers/bindings.ts`'s
      // `contributeParameter`).
      //
      // The widening itself is not done here. It is a question about a TYPE --
      // `T` or `T | null` unioned with `undefined` -- and this layer cannot
      // ask it: the structural table is sealed by the time a carrier is
      // chosen, so there is no way to name a union that was not already
      // interned. Layering an absence FLAG over the derived carrier instead is
      // what this used to do, and it could not express the case where the
      // declared type already spends absence on `null`: one flag cannot say
      // which of the two absent values it holds, so `f(x: T | null = null)`
      // was refused outright. `SignatureParameter.slot` is that union, interned
      // by the normalizer where types are still being made, and it derives to
      // the three-armed tagged union the union deriver has always built.
      let value = deriveStored(parameter.slot)
      const slot = shapeOf(parameter.slot)
      // Rest packing creates a fresh ordinary Array; it cannot produce a proxy.
      // Keep the call frame concrete even when observable arrays of this type use fallback dispatch.
      if (parameter.rest && value.kind === 'dynamic' && value.reason === 'opt-in-fallback' && slot?.kind === 'array') {
        value = { kind: 'array-object', element: deriveStored(slot.element), ownership: 'shared-refcount', extension: null }
      }
      const parameterOwnership = ownership.forParameter(value)
      parameters.push({ value, ownership: parameterOwnership, passing: passingOf(value, parameterOwnership) })
    }
    const declaredReceiver = signature.thisParameter ? derive(signature.thisParameter) : null
    return {
      parameters,
      restFrom,
      result: derive(signature.result),
      // `this: void` is TypeScript's declaration that a function does not use
      // or require a receiver. It is not an `undefined` value passed in a
      // hidden receiver slot. BSON's optional WASM helpers deliberately use
      // this form so `(condition ? helpers.a : helpers.b)(...)` is an ordinary
      // unbound call. Preserve every other explicit this type as stored data.
      receiver: declaredReceiver?.kind === 'void' ? null : declaredReceiver === null ? null : storedCarrier(declaredReceiver)
    }
  }

  /**
   * The one physical convention a set of signatures shares, or `null`.
   *
   * An overload set is a checker-level fact about which signature a *call site*
   * resolved; it is not automatically a physical fact about the value. Where the
   * overloads project to the same frame -- which is what declaration merging
   * produces, and what an overload differing only in an erased type argument
   * produces -- there is exactly one convention, and refusing it would refuse a
   * value that has a single unambiguous layout.
   *
   * An exact match is tried first; failing that, `widestSubsumingAbi`
   * (host-abi.ts) tries the same widening test a host handle's own overload
   * set already gets -- one frame with a trailing optional parameter, spelled
   * as several overloads instead of one signature, which is what declaration
   * merging produces regardless of whether the merged declarations happen to
   * live in an ambient host library or in the program's own source. There is
   * nothing host-specific about the fact two overloads share a frame up to a
   * trailing optional; restricting the widening test to host bindings only
   * refused ordinary program-defined overloaded values -- `function f(x:
   * number): void; function f(x: number, y = 0): void {}` used as a
   * first-class value, never called through this exact reference -- for a
   * reason that has nothing to do with what makes the widening sound. Where
   * the overloads genuinely project to different frames, neither test passes
   * and this stays refused: a caller reaching one of them through the
   * other's frame would still pass the wrong arguments.
   */
  /**
   * The convention a set of overloads share once each parameter position is
   * allowed to become the UNION of what the overloads declare there.
   *
   * `widestSubsumingAbi` joins only by subsumption, so
   * `interface Operation { (v: number): number; (v: string): number }` -- used
   * as a stored FIELD, which is the shape `overloaded-callable-fields.ts`,
   * `generic-field-initializer.ts` and `builtin-function-name-length.runtime.js`
   * all refuse on -- has no join: `double` and `std::string` subsume neither
   * way. A field holds ONE frame for both calls, so per-call overload
   * selection (`singleConventionAt`) cannot answer it either.
   *
   * The frame that does hold both is the one the implementation already has:
   * TypeScript requires the value to satisfy every signature, so
   * `(value: string | number) => number` is what is actually assigned, and
   * `(TaggedUnion<double, std::string>) -> double` is its convention.
   *
   * Built from the SIGNATURES rather than from their ABIs, which is the whole
   * reason this lives here and not in `widestSubsumingAbi`: a `TaggedUnionArm`
   * needs a `semanticType` and an `AbiParameter` carries only a
   * `Representation`, so a join working on ABIs alone has nothing to build
   * arms from. Each `SignatureParameter.slot` is already an interned id, so
   * the ordinary union deriver produces the arms -- no hand-built union, and
   * nothing new interned into the sealed table.
   *
   * Refused, deliberately, where the join would be a guess rather than a
   * widening: a declared receiver or a rest parameter (either makes the frames
   * genuinely different rather than merely differently-typed), results that
   * disagree, and any position some overload does not declare -- differing
   * ARITY is an optionality question `widestSubsumingAbi` already answers, and
   * two answers to it here is the duplication this refactor exists to remove.
   */
  const unionJoinedAbi = (signatures: readonly SignatureShape[]): CallableAbi | null => {
    if (signatures.length < 2) return null
    if (signatures.some((signature) => signature.thisParameter !== null)) return null
    if (signatures.some((signature) => signature.parameters.some((parameter) => parameter.rest))) return null
    const results = signatures.map((signature) => derive(signature.result))
    const firstResult = results[0]
    if (!firstResult) return null
    const resultKey = representationKey(firstResult)
    if (results.some((result) => representationKey(result) !== resultKey)) return null
    const arity = signatures[0]?.parameters.length ?? 0
    if (signatures.some((signature) => signature.parameters.length !== arity)) return null
    const parameters: AbiParameter[] = []
    for (let position = 0; position < arity; position += 1) {
      const slots: StructuralTypeId[] = []
      for (const signature of signatures) {
        const own = signature.parameters[position]
        if (own === undefined) return null
        if (!slots.includes(own.slot)) slots.push(own.slot)
      }
      const sole = slots[0]
      if (sole === undefined) return null
      const value = slots.length === 1 ? deriveStored(sole) : storedCarrier(deriveUnionShape({ kind: 'union', members: slots }))
      // A union the deriver could not carry is not a frame; refusing keeps the
      // caller's existing message rather than publishing an unresolved slot.
      if (value.kind === 'unresolved') return null
      const parameterOwnership = ownership.forParameter(value)
      parameters.push({ value, ownership: parameterOwnership, passing: passingOf(value, parameterOwnership) })
    }
    return { parameters, restFrom: null, result: firstResult, receiver: null }
  }

  const sharedAbiOf = (
    signatures: readonly SignatureShape[],
    role: 'overload' | 'construct',
    joinsByUnion = false
  ): CallableAbi | string => {
    const abis: CallableAbi[] = []
    for (const signature of signatures) {
      const abi = abiOf(signature)
      // `abiOf` refuses exactly one thing, and naming it here keeps a variadic
      // signature from being reported as an overload disagreement.
      if (!abi) return 'no primitive for a variadic calling convention'
      abis.push(abi)
    }
    const first = abis[0]
    if (!first) return role === 'construct' ? 'shape with no construct signature' : 'callable shape with no call signature'
    const firstKey = abiKey(first)
    if (abis.every((abi) => abiKey(abi) === firstKey)) return first
    const widened = widestSubsumingAbi(abis)
    if (typeof widened !== 'string') return widened
    // Only where the caller says a union frame is admissible. A HOST overload
    // set is bound to a native implementation whose calling convention the
    // host layer states, so widening its parameters would rewrite the very ABI
    // that binding matches against -- the same reason the interface-receiver
    // work had to exclude ambient declarations.
    const unionJoined = joinsByUnion ? unionJoinedAbi(signatures) : null
    if (unionJoined) return unionJoined
    return role === 'construct'
      ? `no primitive joining ${signatures.length} construct signatures into one calling convention: ${widened}`
      : `no primitive joining ${signatures.length} overload signatures into one calling convention: ${widened}`
  }
  /**
   * A handle's own `[[Call]]`/`[[Construct]]` convention, or `null` (not
   * `unresolved`: unjoinable still leaves the handle usable for property
   * access). `sharedAbiOf` already tries the exact join and the widening
   * test; only the failure carrier differs here, because a handle stays
   * usable for property access with no callable convention at all.
   */
  const hostInvocationAbiOf = (signatures: readonly SignatureShape[], role: 'overload' | 'construct'): CallableAbi | null => {
    if (signatures.length === 0) return null
    const joined = sharedAbiOf(signatures, role)
    return typeof joined === 'string' ? null : joined
  }
  // An accessor-backed member has no storage, so it contributes no field. Both
  // halves read the same member list so the two can never disagree about which
  // members are laid out and which are called.
  const recordFieldsOf = (shape: Extract<StructuralShape, { kind: 'object' }>): readonly RecordField[] =>
    shape.members
      .filter((member) => member.accessor === null && runtimeSymbolMemberIndexOf(shape, member.key) === null)
      .map((member) => ({ key: recordFieldKeyOf(member.key), value: deriveStored(member.type), required: !member.optional }))

  /**
   * Derive and canonicalize the disjoint physical key domains of a record.
   * Number property keys alias their canonical string form in JavaScript, so a
   * string+number pair can share one string table only when its native value
   * carrier is exactly the same. Symbols never alias text and keep a separate
   * identity-keyed table.
   */
  const canonicalRecordIndexes = (indexes: readonly RecordIndexSidecar[]): readonly RecordIndexSidecar[] | string => {
    const byKey = new Map<RecordIndexSidecar['key'], Representation>()
    for (const index of indexes) {
      const existing = byKey.get(index.key)
      if (existing && representationKey(existing) !== representationKey(index.value))
        return `no primitive for a record whose ${index.key} index signatures have incompatible native value carriers`
      byKey.set(index.key, existing ?? index.value)
    }
    const stringValue = byKey.get('string')
    const numberValue = byKey.get('number')
    if (stringValue && numberValue && representationKey(stringValue) !== representationKey(numberValue))
      return 'no primitive for a record whose string and number index signatures have incompatible native value carriers'
    const result: RecordIndexSidecar[] = []
    if (stringValue) result.push({ key: 'string', value: stringValue })
    else if (numberValue) result.push({ key: 'number', value: numberValue })
    const symbolValue = byKey.get('symbol')
    if (symbolValue) result.push({ key: 'symbol', value: symbolValue })
    return result
  }

  const accessorIndexRecordRefusal = 'no native record carrier preserves both index storage and accessor descriptors'
  const recordIndexesOf = (shape: Extract<StructuralShape, { kind: 'object' }>): readonly RecordIndexSidecar[] | string => {
    const structural = carriableIndexesOf(shape)
    if (typeof structural === 'string') return structural
    if (structural.length > 0 && shape.members.some((member) => member.accessor !== null)) return accessorIndexRecordRefusal
    return canonicalRecordIndexes(structural.map((index) => ({ key: index.key, value: deriveStored(index.value) })))
  }

  /**
   * The fields an array-extending interface adds (`structural-types.ts`'s
   * `extension`), as the record fields the generated sidecar struct will
   * declare. Every field is a plain data member; an optional one carries the
   * same presence bit `records.ts` gives a record's optional field (tsc's
   * `JSDocArray extends Array<JSDoc>` declares `jsDocCache?`, and a read of
   * it before any write must be `undefined`, not a default-constructed
   * array). An accessor has a body and no storage, so it refuses by name
   * rather than laying out a member that lies.
   */
  const arrayExtensionFieldsOf = (extension: readonly StructuralMember[]): readonly RecordField[] | null | string => {
    if (extension.length === 0) return null
    const fields: RecordField[] = []
    for (const member of extension) {
      const key = recordFieldKeyOf(member.key)
      if (member.accessor !== null)
        return `an interface extending Array declares accessor "${key}"; only data fields are carried on an array's extension`
      fields.push({ key, value: deriveStored(member.type), required: !member.optional })
    }
    return fields
  }

  const deriveObject = (id: StructuralTypeId, shape: Extract<StructuralShape, { kind: 'object' }>): Representation => {
    const dictionaryIndex = dictionaryIndexOf(shape)
    if (dictionaryIndex) {
      return {
        kind: 'dictionary',
        key: dictionaryIndex.key,
        value: deriveStored(dictionaryIndex.value),
        ownership: ownership.forShape(shape, id)
      }
    }
    const fields = recordFieldsOf(shape)
    const indexes = recordIndexesOf(shape)
    // Index storage beside accessor descriptors has no native storage contract,
    // the same way incompatible overloads have no calling convention: it is the
    // storage static specialization cannot select, which the opt-in boxes.
    if (typeof indexes === 'string' && dynamicFallback && indexes === accessorIndexRecordRefusal)
      return { kind: 'dynamic', reason: 'opt-in-fallback' }
    if (typeof indexes === 'string') return unresolved(indexes)
    if (shape.members.length === 0 && indexes.length === 1) {
      const [index] = indexes
      if (index) return { kind: 'dictionary', key: index.key, value: index.value, ownership: ownership.forShape(shape, id) }
    }
    // `Record<string | symbol, any>` states no layout at all: every key of
    // every kind holds anything. Programs pass class instances and prototype
    // objects through it and store onto them by symbol, which only the object
    // itself can hold, so it is the dynamic object it declares rather than a
    // fresh sidecar record a conversion would copy into.
    const openDynamic = (value: Representation): boolean => value.kind === 'dynamic' && value.reason === 'declared-any-never-narrowed'
    if (shape.members.length === 0 && indexes.length > 1 && indexes.every((index) => openDynamic(index.value))) return indexes[0]!.value
    if (indexes.length > 0) {
      return {
        kind: 'record-with-index',
        shapeId: id,
        fields,
        indexes,
        ownership: ownership.forShape(shape, id)
      }
    }
    return {
      kind: 'record',
      shapeId: id,
      fields,
      accessors: recordAccessorsOf(shape, deriveStored),
      ownership: ownership.forShape(shape, id)
    }
  }

  /**
   * The object shape a member of an intersection contributes.
   *
   * A declared name contributes its body, because an intersection of two named
   * record types is one record with both member sets -- the names do not survive
   * the merge. A class instance contributes nothing: it is nominal, and merging
   * a class into a structural record would silently drop its identity.
   */
  const intersectionMemberShape = (member: StructuralTypeId): Extract<StructuralShape, { kind: 'object' }> | null => {
    const shape = shapeOf(member)
    if (!shape) return null
    if (shape.kind === 'object') return shape
    if (shape.kind !== 'declared' || !shape.body) return null
    const body = shapeOf(shape.body)
    return body?.kind === 'object' ? body : null
  }

  /**
   * A brand marker contributes no runtime structure to an intersection.
   *
   * `{ readonly [brand]?: never }` is the standard nominal-typing trick: every
   * member is optional and typed `never`, so no value can ever actually carry
   * one, and the checker's structural comparison only cares about what *can* be
   * assigned. A member shaped like this is a type-system-only fence around its
   * sibling and has no runtime footprint of its own -- `type f32 = number &
   * {...}` in the framework's own `.d.ts` is exactly this pattern, applied to a
   * primitive, which is why it never had a record shape to contribute.
   *
   * The declared `never` never actually reaches here as `never`, though:
   * `structural.ts` reads an optional member's type through
   * `checker.getTypeOfSymbolAtLocation`, which reports the type a *read* of the
   * property produces -- absent counts, so it is `never | undefined`, and the
   * checker eliminates the uninhabited arm before this sees it, leaving plain
   * `undefined`. Checking for `never` here would therefore never match the one
   * shape this exists to recognize; `undefined` is the observable fact.
   */
  const isAbsentMember = (member: StructuralTypeId): boolean => {
    const memberShape = shapeOf(member)
    return memberShape?.kind === 'primitive' && (memberShape.primitive === 'never' || memberShape.primitive === 'undefined')
  }

  /**
   * `unique symbol` is TypeScript's other brand idiom, alongside the
   * optional-`never` one this sits beside -- `type Rgb565 = number & {
   * readonly __geaRgb565: unique symbol }` in the framework's own `.d.ts`
   * (`rgb565()`'s return type). Where the never-brand fences a member no
   * value can ever populate, this one fences a *type* no ordinary expression
   * can ever produce: a `unique symbol` names exactly one symbol tied to its
   * own declaration, so the only way a value ever reaches that member's type
   * is a cast (`as Rgb565`), never a literal object expression. That makes
   * `required` a non-issue here, unlike the never-brand below: a required
   * `unique symbol` member is not a real, inhabited constraint the way a
   * required `never` member is -- it is exactly as vacuous as the optional
   * form, always, so this check does not consult `optional` at all.
   */
  const isUniqueSymbolMember = (member: StructuralTypeId): boolean => shapeOf(member)?.kind === 'unique-symbol'

  const isVacuousBrand = (member: StructuralTypeId): boolean => {
    const object = intersectionMemberShape(member)
    if (!object || object.index.length > 0 || object.members.length === 0) return false
    // `optional` is load-bearing for the never-brand test specifically: a
    // *required* member typed `never` means the object itself is
    // uninhabited, a real (if bizarre) constraint this must not silently
    // discard by treating it as a no-op brand. The unique-symbol test above
    // has no such exception, so it is checked unconditionally.
    return object.members.every((property) => isUniqueSymbolMember(property.type) || (property.optional && isAbsentMember(property.type)))
  }

  /**
   * Whether a member is a CLASS INSTANCE -- a type whose identity is its
   * declaration rather than its members.
   *
   * Asked through the declared wrapper as well as directly, because a class
   * reaches the deriver both ways: named in its own right, and as the body of
   * a `declared` shape.
   */
  const isNominalClassMember = (member: StructuralTypeId): boolean => {
    const shape = shapeOf(member)
    if (!shape) return false
    if (shape.kind === 'class-instance') return true
    return shape.kind === 'declared' && shape.body !== null && shapeOf(shape.body)?.kind === 'class-instance'
  }

  /**
   * One of the three standard regular-expression declarations
   * (`RegExpDeclarationPolicy`): a member whose only layout is the compiler's
   * own native one, so an intersection holding it is that native value.
   */
  const isNativeRegExpMember = (member: StructuralTypeId): boolean => {
    const shape = shapeOf(member)
    return shape?.kind === 'declared' && regexp.forDeclaration(shape.declaration) !== null
  }

  /**
   * One of the standard `Error` family declarations
   * (`ErrorDeclarationPolicy`): a member whose only layout is the compiler's
   * own `gea::runtime::Error`, so an intersection holding it is that native
   * value -- the same statement `isNativeRegExpMember` makes about a pattern.
   */
  const isNativeErrorMember = (member: StructuralTypeId): boolean => {
    const shape = shapeOf(member)
    return shape?.kind === 'declared' && errors.forDeclaration(shape.declaration) !== null
  }

  /** The class a nominal member names, or `null` when the member is not one. */
  const nominalClassDeclarationOf = (member: StructuralTypeId): DeclarationId | null => {
    const shape = shapeOf(member)
    if (!shape) return null
    if (shape.kind === 'class-instance') return shape.declaration
    if (shape.kind !== 'declared' || shape.body === null) return null
    const body = shapeOf(shape.body)
    return body?.kind === 'class-instance' ? body.declaration : null
  }

  /**
   * The one member of `nominal` that every other one is an ancestor of, or
   * `null` when no such member exists.
   *
   * `T & AggregateOperation` -- what `operation instanceof AggregateOperation`
   * narrows a `T extends AbstractOperation` parameter to, once
   * monomorphization has bound `T` to a concrete class -- has two nominal
   * members and exactly one inhabitant: an object can only pass the
   * `instanceof` if it IS an AggregateOperation, and it can only have reached
   * the parameter if it is a `T`, so the intersection is whichever of the two
   * descends from the other. That is the same argument the single-nominal
   * branch below already makes ("the class carrier is the only inhabited
   * one"), extended to the case the narrowing actually produces.
   *
   * When NEITHER descends from the other the pair stays refused, and that is
   * correct rather than conservative: two unrelated classes intersected is a
   * value with two identities, no C++ object is both, and the branch is dead
   * code this compiler has no way to prove dead.
   */
  const mostDerivedNominal = (nominal: readonly StructuralTypeId[]): StructuralTypeId | null => {
    const declarations = nominal.map((member) => nominalClassDeclarationOf(member))
    if (declarations.some((declaration) => declaration === null)) return null
    for (const [index, member] of nominal.entries()) {
      const own = declarations[index]
      if (own === undefined || own === null) continue
      const ancestors = heritage.forDeclaration(own)
      // Compared by MEMBER, not by declaration: two members of one generic
      // class at different type arguments (`Box<string> & Box<number>`) share
      // a declaration and are not one carrier, and a class is not its own
      // ancestor -- so that pair reduces to nothing and stays refused, which
      // is the correct answer for an intersection with no inhabitant this
      // compiler can name.
      const descendsFromEveryOther = nominal.every((other, position) => {
        if (position === index) return true
        const otherDeclaration = declarations[position]
        return other === member || (otherDeclaration !== null && otherDeclaration !== undefined && ancestors.includes(otherDeclaration))
      })
      if (descendsFromEveryOther) return member
    }
    return null
  }

  /**
   * Whether an intersection's nominal members prove it has NO INHABITANT.
   *
   * Two class members whose declarations are different and where neither
   * descends from the other describe a value with two identities. No object in
   * this backend is both -- `records.ts` emits one struct per class and a
   * struct has one base chain -- and no object in JavaScript is either, since
   * a prototype chain is linear. TypeScript does not reduce the pair to
   * `never` itself (it only does that for disjoint primitives and unit types),
   * so the fact has to be stated here.
   *
   * `mostDerivedNominal` returning `null` is NOT the same question and cannot
   * stand in for this one: it also answers `null` for `Box<string> &
   * Box<number>`, two instantiations of ONE declaration, where the erased
   * runtime class really is shared. Distinct declarations is what makes the
   * pair impossible, so that is what is tested.
   *
   * This is what `execute_operation.ts:198` compiles to, 28 monomorphized
   * copies over: `tryOperation<T extends AbstractOperation>` tests `operation
   * instanceof AggregateOperation`, and in every copy whose `T` is some other
   * operation class the narrowed type is two unrelated classes intersected.
   */
  const isUninhabitedNominalIntersection = (substantive: readonly StructuralTypeId[]): boolean => {
    const declarations = substantive.flatMap((member) => {
      const declaration = nominalClassDeclarationOf(member)
      return declaration === null ? [] : [declaration]
    })
    return declarations.some((one, index) =>
      declarations.some(
        (other, position) =>
          position !== index &&
          one !== other &&
          !heritage.forDeclaration(one).includes(other) &&
          !heritage.forDeclaration(other).includes(one)
      )
    )
  }

  /**
   * The primitive DOMAIN a member pins a value to, when it pins one: the name
   * of a primitive shape, or of the primitive a literal belongs to, read
   * through the declared wrapper the way `isPrimitiveValueShape` reads it.
   * The top types pin nothing and answer `null`.
   */
  const primitiveDomainOf = (member: StructuralTypeId): { readonly domain: string; readonly text: string | null } | null => {
    const memberShape = shapeOf(member)
    const body = memberShape?.kind === 'declared' && memberShape.body !== null ? shapeOf(memberShape.body) : memberShape
    if (!body) return null
    if (body.kind === 'primitive') {
      return body.primitive === 'any' || body.primitive === 'unknown' || body.primitive === 'never'
        ? null
        : { domain: body.primitive, text: null }
    }
    if (body.kind === 'literal') return { domain: body.primitive, text: body.text }
    return null
  }

  /**
   * Two PRIMITIVE members of different domains -- `number & null`, `string &
   * number` -- or two literals of one domain with different texts (`'a' &
   * 'b'`) leave the intersection uninhabited: a value has one primitive
   * domain, and this is exactly `isUninhabitedNominalIntersection`'s fact at
   * the other kind of member that cannot be merged.
   *
   * Where it comes from, every time: a monomorphized copy. The checker
   * narrows `value: T | undefined` under `value !== undefined` to `T & ({} |
   * null)` and distributes it to `(T & {}) | (T & null)`; against the generic
   * it leaves `T & null` unreduced, and the copy then substitutes the
   * argument for `T` structurally, so `number & null` reaches this deriver
   * with no checker ever having seen it. Refused as a merge ("`number` is not
   * a record shape"), that arm took the whole union down -- every
   * `Debug.checkDefined(x)` in TypeScript's own compiler, in every copy.
   */
  const isUninhabitedPrimitiveIntersection = (substantive: readonly StructuralTypeId[]): boolean => {
    const domains = substantive.flatMap((member) => {
      const domain = primitiveDomainOf(member)
      return domain === null ? [] : [domain]
    })
    if (
      domains.some((one, index) =>
        domains.some(
          (other, position) =>
            position !== index && (one.domain !== other.domain || (one.text !== null && other.text !== null && one.text !== other.text))
        )
      )
    )
      return true
    // A primitive beside a member only an OBJECT can satisfy -- an array, a
    // tuple, a callable, a class instance -- is the same fact one kind over:
    // `number & readonly any[]` has no value either. The checker's
    // `isArray(v)` guard narrows a `U` to `U & readonly any[]` in the taken
    // branch, and a copy with `U := number` substitutes it structurally, so
    // the arm reaches here unreduced exactly as `number & null` does. A
    // record member stays out of this rule on purpose: `string & { __brand:
    // 'id' }` is the ordinary branded primitive, and which of those are
    // fences is `isVacuousBrand`'s question, not this one's.
    return domains.length > 0 && substantive.some(isObjectOnlyMember)
  }

  /** A member no primitive value can satisfy: an array, a tuple, a callable or a class instance, read through the declared wrapper. */
  const isObjectOnlyMember = (member: StructuralTypeId): boolean => {
    if (isNominalClassMember(member)) return true
    const memberShape = shapeOf(member)
    const body = memberShape?.kind === 'declared' && memberShape.body !== null ? shapeOf(memberShape.body) : memberShape
    return body?.kind === 'array' || body?.kind === 'tuple' || body?.kind === 'signature'
  }

  /**
   * `(A | B | ...) & p & q` for primitive-domain `p`, `q`: the union of the
   * arms whose domain agrees with every primitive member, each carried as
   * itself. `null` unless exactly one member is a union, the others are all
   * primitive-domain members, and every surviving arm is itself a
   * primitive-domain member -- an arm that is structure beside a primitive is
   * the branded-primitive shape the branch below this one already answers.
   */
  const distributeUnionOverPrimitives = (substantive: readonly StructuralTypeId[]): Representation | null => {
    const unions = substantive.filter((member) => shapeOf(member)?.kind === 'union')
    if (unions.length !== 1) return null
    const others = substantive.filter((member) => shapeOf(member)?.kind !== 'union')
    if (others.length === 0 || !others.every((member) => primitiveDomainOf(member) !== null)) return null
    const union = shapeOf(unions[0]!)
    if (!union || union.kind !== 'union') return null
    const kept = union.members.filter((arm) => !isUninhabitedIntersection([arm, ...others]))
    if (kept.length === 0) return { kind: 'void' }
    if (!kept.every((arm) => primitiveDomainOf(arm) !== null)) return null
    return kept.length === 1 ? derive(kept[0]!) : deriveUnion({ kind: 'union', members: kept })
  }

  /** ONE answer to "can no value have this intersection's type", for the carrier and the reachability question alike. */
  const isUninhabitedIntersection = (substantive: readonly StructuralTypeId[]): boolean =>
    isUninhabitedNominalIntersection(substantive) || isUninhabitedPrimitiveIntersection(substantive)

  const intersectionMemberKind = (member: StructuralTypeId): string => intersectionMemberKindOf(shapeOf, member)
  const isPrimitiveValueMember = (member: StructuralTypeId): boolean => isPrimitiveValueShape(shapeOf, member)

  const flattenedIntersectionMembers = createIntersectionFlattener(shapeOf, (declaration) =>
    Boolean(binding.forDeclaration(declaration)?.native)
  )

  /**
   * `unknown` is the identity of `&`: `X & unknown` is `X`, for every X. It
   * reaches an intersection as a member because the empty object type `{}`
   * interns as the top type, and `T & {}` -- what the checker narrows `T |
   * undefined` to under a nullish test, and the whole of `NonNullable<T>` --
   * is the most common intersection a monomorphized copy ever meets. Against
   * the generic the checker reduces nothing; the copy substitutes `number`
   * for `T` and hands this deriver `number & unknown`, which as a merge
   * refused (`number` "is not a record shape").
   */
  const isIdentityMember = (member: StructuralTypeId): boolean => {
    const memberShape = shapeOf(member)
    const body = memberShape?.kind === 'declared' && memberShape.body !== null ? shapeOf(memberShape.body) : memberShape
    return body?.kind === 'primitive' && body.primitive === 'unknown'
  }

  /**
   * The members of an intersection that contribute a constraint: flattened,
   * with the brand fences and the identity members dropped. ONE list, read by
   * the carrier derivation and by `isNeverType`, so the two cannot disagree
   * about which members an intersection is made of.
   */
  const substantiveMembersOf = (members: readonly StructuralTypeId[]): readonly StructuralTypeId[] => {
    const substantive = flattenedIntersectionMembers(members).filter((member) => !isVacuousBrand(member) && !isIdentityMember(member))
    // `any[]` is the identity of `&` over ARRAY-shaped members, the way
    // `unknown` is over every member: `string[] & readonly any[]` is
    // `string[]`. The checker's `isArray(v)` guard narrows a generic `U` to
    // `U & readonly any[]`, and a copy with `U := string[]` substitutes it
    // structurally, so the intersection reaches here unreduced; merged as two
    // records it became a record-with-index no array converts to.
    return substantive.some(isArrayShapedMember) && substantive.some(isAnyArrayMember)
      ? substantive.filter((member) => !isAnyArrayMember(member))
      : substantive
  }

  const bodyShapeOf = (member: StructuralTypeId): StructuralShape | null => {
    const memberShape = shapeOf(member)
    return (memberShape?.kind === 'declared' && memberShape.body !== null ? shapeOf(memberShape.body) : memberShape) ?? null
  }
  /**
   * A callable member of an intersection contributes its invocation
   * conventions, while a structural object member contributes only expando
   * claims on that same native callable object.  Unwrap a declared alias here
   * for the same reason `intersectionMemberShape` unwraps an object alias:
   * aliases do not erase the physical callable carrier.
   */
  const intersectionCallableMemberShape = (member: StructuralTypeId): Extract<StructuralShape, { kind: 'signature' }> | null => {
    const body = bodyShapeOf(member)
    return body?.kind === 'signature' ? body : null
  }
  const isArrayShapedMember = (member: StructuralTypeId): boolean => {
    const body = bodyShapeOf(member)
    return body?.kind === 'array' || body?.kind === 'tuple'
  }
  const isAnyArrayMember = (member: StructuralTypeId): boolean => {
    const body = bodyShapeOf(member)
    if (body?.kind !== 'array') return false
    const element = shapeOf(body.element)
    return element?.kind === 'primitive' && element.primitive === 'any'
  }

  /**
   * The carrier of an intersection whose every member is a declared name for
   * the SAME interned object body, or `null` when the members name more than
   * one layout. Same body id means same struct: the deriver's declared path
   * carries a name as `native-record-ref` of its body, so every member here
   * derives to the identical reference and the first one answers for all.
   */
  const sharedBodyRefOf = (members: readonly StructuralTypeId[]): Representation | null => {
    const first = members[0]
    if (first === undefined || members.length < 2) return null
    let body: StructuralTypeId | null = null
    for (const member of members) {
      const memberShape = shapeOf(member)
      if (memberShape?.kind !== 'declared' || memberShape.body === null) return null
      if (shapeOf(memberShape.body)?.kind !== 'object') return null
      if (body === null) body = memberShape.body
      else if (body !== memberShape.body) return null
    }
    const derived = derive(first)
    return derived.kind === 'native-record-ref' ? derived : null
  }

  const deriveIntersection = (id: StructuralTypeId, shape: Extract<StructuralShape, { kind: 'intersection' }>): Representation => {
    // A HOST'S OWN NAME outranks the structure it erases to.
    //
    // The brand collapse below is right about the language -- `type Rgb565 =
    // number & { readonly __geaRgb565: unique symbol }` IS a number, and every
    // arithmetic use of one type-checks as one. It is wrong about the physical
    // carrier the moment a host states one: the framework's plugin maps
    // `Rgb565` to `gea::framework::graphics::pixel::NativeColor`, a value
    // already in the panel's native pixel format, and collapsing it to `double`
    // hands that native pixel to `canvasRgb565`'s ARITHMETIC overload, which
    // reads it as an `0xRRGGBBAA` app colour and repacks it. `rgb565(r, g, b)`
    // survived as a colour with r and g gone -- 64 randomly-coloured balls all
    // rendered blue, with nothing anywhere to report, because a number is a
    // number and every step compiled.
    //
    // Read before the collapse, never instead of it: a branded alias no host
    // states a carrier for still erases to its substantive member exactly as
    // before, which is what keeps every ordinary `A & B` unchanged.
    const stated = shape.declaration ? binding.forDeclaration(shape.declaration) : null
    if (stated?.native) {
      return {
        kind: 'native-handle',
        protocol: stated.protocol,
        version: stated.version,
        native: stated.native,
        bases: binding.basesOf(stated.native),
        call: null,
        construct: null
      }
    }
    // Brand members drop out before anything else asks whether a member "is a
    // record shape": they never were one, and answering that question about
    // them is what produced a refusal for a primitive that has its own
    // perfectly good carrier.
    const substantive = substantiveMembersOf(shape.members)
    if (substantive.length === 0) {
      // Nothing but identity members (`unknown & unknown`): the intersection
      // IS the top type, and carries what the top type carries.
      const identity = flattenedIntersectionMembers(shape.members).find(isIdentityMember)
      if (identity !== undefined) return derive(identity)
      return unresolved('no primitive for an intersection with no substantive member')
    }
    const only = substantive.length === 1 ? substantive[0] : undefined
    if (only !== undefined) {
      // With every other member vacuous, the intersection *is* this member --
      // not a record built to resemble it. A class instance keeps its own
      // nominal carrier instead of being flattened into a structural record and
      // losing its identity, and a primitive keeps its own scalar carrier
      // instead of being refused for not being a record at all.
      return derive(only)
    }
    // ONE LAYOUT, several names. Interface families (`interface-families.ts`)
    // give every `extends`-connected source interface the same interned body,
    // so `Identifier & Statement` -- what the checker produces when a type
    // predicate narrows a family-typed value, `hasJSDocNodes(updated)` on a
    // `T extends Node` -- is a value of that ONE layout seen through two of
    // its names. The checker's own reconciliation of the pair is a fresh
    // object shape, and deriving THAT below mints a by-value record no family
    // ref converts to: 117 rows on tsc, every one a narrowed read of a Node.
    // The intersection of names for one layout is that layout's own carrier.
    const familyRef = sharedBodyRefOf(substantive)
    if (familyRef !== null) return familyRef
    // A callable intersection has one native CallableObject carrier: callable
    // members contribute call/construct conventions and plain object members
    // contribute fields/expandos to its existing dynamic-property sidecar.
    // Treating the latter as a record would drop [[Call]]/[[Construct]];
    // treating the former as a record is the named AJV/Fastify census root.
    //
    // The signatures pool through `deriveSignature`, the one ABI authority
    // that already joins compatible overloads and refuses conflicting frames.
    // No FunctionId is invented here: structural signatures have no exact
    // source-function membership, and callable origins/mutation facts keep
    // that proof separately by FunctionId.
    const signatureShapes = substantive.map(intersectionCallableMemberShape)
    const callableSignatures = signatureShapes.filter(
      (candidate): candidate is Extract<StructuralShape, { kind: 'signature' }> => candidate !== null
    )
    if (
      callableSignatures.length > 0 &&
      substantive.every((member, index) => {
        const signature = signatureShapes[index]
        return signature !== undefined && signature !== null ? true : intersectionMemberShape(member) !== null
      })
    ) {
      return deriveSignature({
        kind: 'signature',
        call: callableSignatures.flatMap((candidate) => candidate.call),
        construct: callableSignatures.flatMap((candidate) => candidate.construct)
      })
    }
    // `any & T` IS `any` -- that is the language's own reduction, not a policy
    // choice here, and TypeScript applies it before anything else an
    // intersection means. A member declared `any` is a deliberate dynamic
    // boundary: the program said it has no static type, so the intersection
    // has none either, and the honest carrier is the dynamic one. Writing a
    // record carrier for `{ [k: string]: number } & { [k: string]: any }`
    // instead would silently narrow what the program declared it could hold.
    //
    // Checked before every carrier branch below because it OUTRANKS them: a
    // class or a primitive intersected with `any` is still `any`, and picking
    // the class's layout would be a claim the type does not make. Only the
    // host-stated name above outranks it, because a host naming a carrier is
    // stating a physical fact about a value the program never sees loosely.
    const dynamicMember = substantive.find((member) => {
      const candidate = shapeOf(member)
      return candidate?.kind === 'primitive' && candidate.primitive === 'any'
    })
    if (dynamicMember !== undefined) return derive(dynamicMember)
    // A TYPED ARRAY intersected with structural additions keeps its typed-array
    // carrier.
    //
    // BSON spells its local Node buffer view as
    // `ArrayBufferView & Uint8Array & { write(...); copy(...); ... }`. The
    // intersection still denotes the same byte view: every value has the
    // Uint8Array storage, indexing and aliasing semantics, while the final
    // member only describes additional operations on that view. Flattening the
    // checker-resolved body into `record-with-index` loses that physical fact
    // and makes Buffer-returning functions incompatible with Uint8Array-
    // returning slots even though TypeScript proves the subtype relationship.
    //
    // This is the buffer-shaped counterpart of the nominal-class rule below.
    // Exactly one physical typed-array carrier may survive (several members are
    // allowed only when they derive to the identical carrier), and every other
    // member must be plain structural shape. `Uint8Array & Int8Array` therefore
    // still refuses instead of choosing one element interpretation, while
    // `Uint8Array & { extra: ... }` preserves the one identity the value can
    // have. Added methods remain host-member questions at their own call sites;
    // this branch does not claim implementations for them.
    // Recognize the physical typed-array member before deriving structural
    // additions. A method on that structural half may return `this`, which is
    // the intersection currently being derived. Descending into it first
    // trips the general recursive-record guard and mints a nominal record
    // reference for a value whose typed-array carrier is already stated by
    // another member (`BufferFacade.swap32(): this` is the concrete case).
    //
    // Standard typed-array declarations are identified from the same
    // declaration policy used by the ordinary `declared` branch below. Plain
    // object members need no carrier of their own for this decision, so leave
    // them unexpanded. Other members still derive normally, preserving the
    // refusal for incompatible physical carriers.
    const intersectionCarriers = substantive.map((member) => {
      const memberShape = shapeOf(member)
      if (memberShape?.kind === 'declared') {
        const element = elements.forDeclaration(memberShape.declaration)
        if (element) {
          return {
            member,
            carrier: {
              kind: 'typed-array',
              element,
              buffer: typedArrayBufferKindOf(memberShape),
              ownership: ownership.forShape(memberShape, member)
            } as const
          }
        }
      }
      return { member, carrier: intersectionMemberShape(member) === null ? derive(member) : null }
    })
    const typedArrayCarriers = intersectionCarriers.filter(
      (candidate): candidate is { readonly member: StructuralTypeId; readonly carrier: Extract<Representation, { kind: 'typed-array' }> } =>
        candidate.carrier?.kind === 'typed-array'
    )
    const typedArray = typedArrayCarriers[0]?.carrier
    if (
      typedArray !== undefined &&
      intersectionCarriers.every(({ member, carrier }) =>
        carrier === null
          ? intersectionMemberShape(member) !== null
          : carrier.kind === 'typed-array'
            ? representationKey(carrier) === representationKey(typedArray)
            : intersectionMemberShape(member) !== null
      )
    ) {
      return typedArray
    }
    // A NOMINAL class intersected with structure carries the class.
    //
    // `x in obj` is where this shows up and it is ordinary TypeScript: narrowing
    // by a key the receiver's type does not declare produces `Vector3 &
    // Record<"w", unknown>`, and three.js writes the idiom directly --
    // `if ( 'w' in target ) target.w = 0;` in `Triangle.getInterpolation`, so
    // that one line refused a carrier for `target` throughout the file.
    //
    // The merge below cannot answer it, and correctly says so: a class is
    // nominal, and flattening one into a structural record drops the identity
    // that IS its carrier. But the intersection does not ask for a merge. A
    // value of `Vector3 & Record<"w", unknown>` is a `Vector3` -- the language
    // has no way to make it anything else -- and the structural half is a claim
    // about properties ON that instance. So the class's own carrier is the
    // answer, and reading `w` off it becomes the class's own question, which
    // its member rules answer or refuse BY NAME. That is strictly more precise
    // than refusing the carrier of every value that flows through the narrowing.
    //
    // Exactly one nominal member, and every other member a record shape: two
    // classes intersected is a value with two identities and no carrier, which
    // stays refused, and a member that is neither is the case the merge's own
    // refusal below still names.
    //
    // A PRIMITIVE member counts as structure here, and the class still wins.
    // `instanceof` narrowing is where that pair comes from: mongodb's
    // `ReadConcern.fromOptions` tests `readConcern instanceof ReadConcern`
    // where `readConcern: ReadConcern | { level: ReadConcernLevel } |
    // ReadConcernLevel`, and TypeScript narrows the string-literal arms by
    // intersecting rather than discarding them, so the true branch's type has
    // `'local' & ReadConcern` in it. Only an instance can pass `instanceof`;
    // a string never can, so the class carrier is the only inhabited one, and
    // the branch's `return readConcern` really does return a `ReadConcern`.
    // The checker agrees the other way and is no help: it reduces that pair to
    // `{ length, level }`, the String apparent members merged with the class's,
    // which is a carrier for neither. Note the ORDER -- the primitive branch
    // below answers `string & HtmlEscaped`, where the structural half is an
    // interface and no class is involved; when both a class and a primitive
    // are present the class is the one that can exist at runtime.
    const nominal = substantive.filter((member) => isNominalClassMember(member))
    const onlyNominal = nominal.length === 1 ? nominal[0] : (mostDerivedNominal(nominal) ?? undefined)
    if (
      onlyNominal !== undefined &&
      substantive.every(
        // Another NOMINAL member passes only because `mostDerivedNominal`
        // already proved `onlyNominal` descends from every one of them, which
        // is the whole warrant for reducing to it -- so it is admitted here by
        // membership in that proven set, never by being a class.
        (member) =>
          member === onlyNominal || nominal.includes(member) || isPrimitiveValueMember(member) || intersectionMemberShape(member) !== null
      )
    ) {
      return derive(onlyNominal)
    }
    // A NATIVE REGULAR-EXPRESSION member carries the intersection for the
    // reason a nominal class does: `gea::runtime::regex::Pattern` is the one
    // layout a pattern has (`RegExpDeclarationPolicy`), and the structural
    // half of `RegExp & { route?: string }` (`test/runtime/dynamic-regexp.ts`)
    // is an expando the pattern's own dynamic-property sidecar already holds,
    // resolved at its access site. `RegExp` is an INTERFACE in `lib.es5.d.ts`,
    // so the nominal branch never sees it, and the checker's `resolved` bag
    // won in the merge below: the cell became a by-value struct of the ten
    // `Pattern` fields plus `route`, a copy that shares no identity with the
    // pattern written into it and drifts against the initializer's
    // `native-record-ref`.
    const nativeRegExp = substantive.filter((member) => isNativeRegExpMember(member))
    if (
      nativeRegExp.length === 1 &&
      substantive.every(
        (member) => member === nativeRegExp[0] || isPrimitiveValueMember(member) || intersectionMemberShape(member) !== null
      )
    ) {
      return derive(nativeRegExp[0]!)
    }
    // A NATIVE ERROR member carries the intersection, for the reason the
    // pattern immediately above does. `Error` is an INTERFACE in
    // `lib.es5.d.ts`, so the nominal branch never sees it, and the checker's
    // `resolved` bag won in the merge below: `Error & { code: string }` --
    // `@hono/node-server`'s `handleResponseError`, and Node's own
    // `NodeJS.ErrnoException` shape -- became a by-value struct of Error's four
    // members plus `code`, a copy that shares no identity with the
    // `gea::runtime::Error` written into it. Nothing could produce one either:
    // both arms of `e instanceof Error ? e : new Error(...)` are the native
    // handle, so the declaration refused for want of a conversion that cannot
    // exist. The extra members are a claim about properties ON that error, and
    // reading one becomes the error carrier's own question, answered or refused
    // BY NAME at the access -- strictly more precise than refusing the carrier
    // of every value that flows through the alias.
    const nativeError = substantive.filter((member) => isNativeErrorMember(member))
    if (
      nativeError.length === 1 &&
      substantive.every((member) => member === nativeError[0] || isPrimitiveValueMember(member) || intersectionMemberShape(member) !== null)
    ) {
      return derive(nativeError[0]!)
    }
    // No most-derived nominal member, and two of them cannot coexist: the
    // intersection is UNINHABITED, so this position is `never`. The carrier
    // that answers is the one `never` already has (`primitives.ts`: "a value
    // that is never produced carries nothing"), not a refusal -- refusing
    // demands a carrier for a value that cannot exist, and every consumer that
    // asked for one got `unresolved` and turned a provably dead branch into a
    // reported gap. `isNeverType` below answers the same fact for the
    // reachability question, which is the one the obligation builders ask.
    if (isUninhabitedIntersection(substantive)) return { kind: 'void' }
    // A UNION member beside primitive members distributes, as TypeScript's
    // own reduction does: `(A | B) & undefined` is `(A & undefined) | (B &
    // undefined)`, each arm uninhabited where the domains disagree and the
    // arm itself where they agree. `value` narrowed by `=== undefined` inside
    // a copy of `assertIsDefined<T>` whose `T` is a union is the shape
    // (TypeScript's `debug.ts`, 410 rows once composite fillings closed those
    // copies): the checker's `resolved` keeps the intersection unreduced, and
    // the record merge below refuses a union member outright.
    const distributed = distributeUnionOverPrimitives(substantive)
    if (distributed !== null) return distributed
    // A PRIMITIVE intersected with structure carries the primitive -- the same
    // argument the nominal-class branch above makes, at the other kind of
    // member the record merge cannot absorb.
    //
    // `type HtmlEscapedString = string & HtmlEscaped` (hono's `utils/html.ts`,
    // where `HtmlEscaped` is `{ isEscaped: true; callbacks?: ... }`) is the
    // case, and it is not the brand shape `isVacuousBrand` already collapses:
    // these members are real, required, and written to. But a value of
    // `string & HtmlEscaped` IS a string -- the language has no way to make it
    // anything else, and every string use of one type-checks as one -- while
    // the structural half is a claim about properties ON that value. So the
    // primitive's own carrier is the answer, and reading `isEscaped` off it
    // becomes the string carrier's own question, which its member rules answer
    // or refuse BY NAME at the access. That is strictly more precise than
    // refusing a carrier for every value that flows through the alias, which
    // is what the merge below did: 96 obligations on one type alias.
    //
    // Exactly one primitive member, and every other member a record shape --
    // two primitives intersected is a value with two incompatible carriers and
    // stays refused, and a member that is neither is still the case the
    // merge's own refusal names.
    const primitives = substantive.filter((member) => {
      const candidate = shapeOf(member)
      return (
        candidate?.kind === 'primitive' ||
        (candidate?.kind === 'declared' && candidate.body !== null && shapeOf(candidate.body)?.kind === 'primitive')
      )
    })
    const onlyPrimitive = primitives.length === 1 ? primitives[0] : undefined
    if (
      onlyPrimitive !== undefined &&
      substantive.every((member) => member === onlyPrimitive || intersectionMemberShape(member) !== null)
    ) {
      return derive(onlyPrimitive)
    }
    // THE CHECKER ALREADY RECONCILED THIS INTERSECTION.
    //
    // Every branch above answers a question about CARRIERS -- which member is
    // nominal, which alias a host binds, whether the members are all callable,
    // whether a primitive survives the brand. None of those are type
    // arithmetic, and the checker does not answer them. What is left IS type
    // arithmetic: "what does key `k` of `A & B` hold", and TypeScript computes
    // it -- `getPropertiesOfType` synthesizes each property with the
    // constituents' types already intersected, `getIndexInfosOfType` the same
    // for the index. `structural.ts` interns that answer as `resolved`.
    //
    // The pairwise merge below was a SECOND authority over that one question,
    // and it disagreed with the first wherever TypeScript's reduction is not
    // carrier equality: `{ [k: string]: number } & { [k: string]: any }` is
    // `[k: string]: any` to the checker and two irreconcilable carriers to the
    // merge, which is why every mongodb update operator refused. Enumerating
    // reductions here can never finish -- there is no end to the pairs a
    // program can write -- so the fix is to stop having a second answer, not to
    // write more cases.
    //
    // Gated on no member having a carrier of its OWN that OUTRANKS the
    // reduction, which is a different question from every member being a
    // record shape -- and the reason the first spelling refused 53 carriers in
    // the mongodb driver over five intersections whose reconciliation the
    // checker had already computed. `WithId<T> = EnhancedOmit<T,'_id'> & {_id:
    // ...}` is the case, and `EnhancedOmit` is a CONDITIONAL type alias, so
    // `structural-declared-body.ts` interns it with no body at all: not a
    // record shape, not any other shape either, and nothing the merge below
    // could have walked. Demanding a record of it asked the wrong member the
    // wrong question -- the resolved branch reads NO member, only
    // `shape.resolved`.
    //
    // What genuinely outranks the checker's answer is a member whose own
    // carrier the branches ABOVE exist to keep: a nominal class or a primitive
    // value (each states in its own comment why the reduction is "a carrier for
    // neither"), a signature (a callable is not a record and the reduction
    // drops the call signature), and a type parameter (whose carrier is
    // monomorphization's to decide, not a structural reduction of its
    // constraint). Every one of those already has its own branch with its own
    // gate; this condition is what keeps this branch from swallowing a case one
    // of them is meant to answer. Everything else -- a conditional alias, a
    // mapped type, an interned shape the table could not build -- has no
    // competing carrier to lose, so the checker's reconciliation is the only
    // answer there is and also the right one.
    //
    // A shape interned with no reconciliation (the self-referential retry,
    // which has no table to intern one into) still falls through to the merge.
    const outranksCheckerReduction = (member: StructuralTypeId): boolean => {
      if (isNominalClassMember(member) || isPrimitiveValueMember(member)) return true
      const candidate = bodyShapeOf(member)?.kind
      return candidate === 'signature' || candidate === 'type-parameter'
    }
    if (shape.resolved !== null && !substantive.some(outranksCheckerReduction)) {
      return derive(shape.resolved)
    }
    const merged = new Map<string, RecordField>()
    // Every substantive member's own index signature applies at once, exactly
    // like a named field does below: a value satisfying the intersection has
    // one dynamic-property sidecar, not one per member, so two members with
    // an index must agree on its value carrier the same way two members with
    // the same named key must agree on theirs.
    const sidecars = new Map<RecordIndexSidecar['key'], Representation>()
    for (const member of substantive) {
      const object = intersectionMemberShape(member)
      if (!object)
        return unresolved(
          `no primitive for an intersection whose member ${member} (${intersectionMemberKind(member)}) is not a record shape`
        )
      const structuralIndexes = carriableIndexesOf(object)
      if (typeof structuralIndexes === 'string') return unresolved(structuralIndexes)
      // An index signature that can hold nothing is a type-system fence, not
      // storage -- `isVacuousBrand` above says the same about a member, and
      // this is that fact one spelling over. `type NotAcceptedFields<TSchema,
      // FieldType> = { readonly [key in KeysOfOtherType<TSchema, FieldType>]?:
      // never }` (mongodb's `mongo_types.ts`) is the shape: a mapped type whose
      // whole purpose is to FORBID the keys it names, intersected alongside the
      // member that really does carry them. Reading its `undefined` as a
      // competing sidecar makes every `PushOperator`/`PullOperator`/
      // `PullAllOperator` disagree with itself.
      //
      // `isAbsentMember` is the same test the named-member fence uses, asked of
      // the index's value, so the two can never disagree about what "holds
      // nothing" means. It reads `undefined` rather than `never` for the reason
      // stated there: the checker has already eliminated the uninhabited arm by
      // the time an optional member's type arrives.
      for (const sidecar of structuralIndexes) {
        if (isAbsentMember(sidecar.value)) continue
        const value = deriveStored(sidecar.value)
        // The key domain is as much a part of "the index signature carrier" as
        // the value type is: a member contributing `[k: string]: T` and one
        // contributing `[k: number]: T` do not describe one sidecar, even when
        // `T` happens to match, and merging them would silently pick whichever
        // arm's key domain the loop saw first.
        //
        // The VALUES reconcile through `intersectPropertyRepresentations`, the
        // same authority a named key present in two members goes through below
        // -- the comment above this loop already says an index must agree "the
        // same way two members with the same named key must agree", and raw key
        // equality was not that way. A reduction that fails still refuses by
        // name, exactly as it did.
        const existingSidecar = sidecars.get(sidecar.key)
        const reconciled: Representation | null = existingSidecar ? intersectPropertyRepresentations(existingSidecar, value) : value
        if (existingSidecar && !reconciled) {
          return unresolved('no primitive for an intersection whose members disagree on the index signature carrier')
        }
        sidecars.set(sidecar.key, reconciled ?? value)
      }
      for (const property of object.members) {
        const key = recordFieldKeyOf(property.key)
        const value = deriveStored(property.type)
        const existing = merged.get(key)
        // Every arm's constraint applies at once, so a key present twice must
        // agree -- reduced through `intersectPropertyRepresentations`, not
        // raw equality, so an absence arm one member disproves does not read
        // as a disagreement. Picking either side blind would make lookup
        // order decide the layout; a failed reduction still refuses by name.
        const reconciled = existing ? intersectPropertyRepresentations(existing.value, value) : value
        if (existing && !reconciled) {
          return unresolved(`no primitive for an intersection whose members disagree on the carrier of "${key}"`)
        }
        // Required in any arm is required overall: an intersection satisfies
        // every arm, so an optional field paired with a required one is present.
        merged.set(key, { key, value: reconciled as Representation, required: (existing?.required ?? false) || !property.optional })
      }
    }
    if (merged.size === 0 && sidecars.size === 0) return unresolved('no primitive for an empty intersection carrier')
    const fields = [...merged.values()]
    const indexes = canonicalRecordIndexes([...sidecars].map(([key, value]) => ({ key, value })))
    if (typeof indexes === 'string') return unresolved(indexes)
    if (indexes.length > 0) {
      return {
        kind: 'record-with-index',
        shapeId: id,
        fields,
        indexes,
        ownership: ownership.forShape(shape, id)
      }
    }
    // An intersection merges member *types*; neither side's accessors survive
    // as one member set this deriver could name, and TypeScript cannot produce
    // an intersection of two accessor-backed literals in the first place.
    return { kind: 'record', shapeId: id, fields, accessors: [], ownership: ownership.forShape(shape, id) }
  }

  /** A member list with every member that is itself a union -- directly or through a declared alias -- spliced in: the flat list `union.ts` expects, which the checker's own unions always are. */
  const flattenedUnionMembersOf = (members: readonly StructuralTypeId[]): StructuralTypeId[] => {
    const flat: StructuralTypeId[] = []
    const visit = (member: StructuralTypeId): void => {
      const body = bodyShapeOf(member)
      if (body?.kind === 'union') {
        for (const inner of body.members) visit(inner)
        return
      }
      if (!flat.includes(member)) flat.push(member)
    }
    for (const member of members) visit(member)
    return flat
  }

  const deriveTuple = (id: StructuralTypeId, shape: Extract<StructuralShape, { kind: 'tuple' }>): Representation => {
    // [] is still an observable Array: even an empty rest binding has length
    // and identity. An empty record lost that protocol and routed `.length`
    // through a boxed property read. Use the same uninhabited element storage
    // as never[] (storedCarrier maps never's void carrier to undefined).
    if (shape.elements.length === 0) {
      return { kind: 'array-object', element: { kind: 'undefined' }, ownership: ownership.forShape(shape, id), extension: null }
    }
    // A homogeneous closed tuple and T[] are views of the same JS array.
    // Positional record storage would require a copying conversion at that
    // boundary and break aliasing. Arity remains in the semantic tuple shape;
    // it does not require a different physical carrier.
    const first = shape.elements[0]
    const fixedArity = first !== undefined && shape.elements.every((element) => !element.optional && !element.rest && !element.variadic)
    // Homogeneous by CARRIER, not by structural type id. `['a', 'b'] as const`
    // is `readonly ["a", "b"]`: two distinct literal types, one physical
    // element -- `std::string` both times -- so it is a JS array in exactly
    // the sense this branch's own comment means, and laying it out as a
    // positional record is what left `names.forEach(...)` refusing with
    // `"Array.prototype.forEach" has no rendering off a record receiver`
    // (`overloaded-callable-fields.ts`). Comparing ids answered that question
    // with the SEMANTIC type, which is not the one aliasing and
    // `Array.prototype` dispatch depend on; the arity a read narrows with
    // still lives in the semantic tuple shape either way.
    const uniformElement = (() => {
      if (!fixedArity || first === undefined) return null
      const carrier = deriveStored(first.type)
      if (carrier.kind === 'unresolved') return null
      const key = representationKey(carrier)
      return shape.elements.every((element) => representationKey(deriveStored(element.type)) === key) ? carrier : null
    })()
    if (uniformElement) {
      return { kind: 'array-object', element: uniformElement, ownership: ownership.forShape(shape, id), extension: null }
    }
    // A rest or variadic position has no fixed arity, so the tuple is not a
    // record with a known field set -- it is an ARRAY, and its carrier is the
    // array carrier over the union of every position's type. tsc's
    // `[DiagnosticMessage, ...DiagnosticArguments]` (what `extraValidation`
    // returns, spread straight into `createDiagnostic`) is a runtime Array
    // whose length is a runtime fact; only its per-position TYPES are static,
    // and those are what the reads that know their position narrow to
    // (`spread-arguments.ts`'s open-tuple expansion, `structural-array-read.ts`).
    // Refusing the carrier outright cost 163 rows on the self-compile.
    if (shape.elements.some((element) => element.rest || element.variadic)) {
      const members: StructuralTypeId[] = []
      for (const element of shape.elements) {
        if (!element.variadic) {
          members.push(element.type)
          continue
        }
        // `...T` where `T extends any[]`: the position spreads T's own
        // elements. A checker-instantiated tuple type already has that
        // spread normalized away; this is the generic declaration's own shape.
        const spread = bodyShapeOf(element.type)
        if (spread?.kind === 'array') members.push(spread.element)
        else if (spread?.kind === 'tuple') {
          for (const inner of spread.elements) {
            if (inner.rest || inner.variadic) return unresolved('a variadic tuple position spreads a tuple that is itself open-ended')
            members.push(inner.type)
          }
        } else return unresolved('a variadic tuple position spreads a type that is neither an array nor a tuple')
      }
      const distinct = flattenedUnionMembersOf(members)
      const sole = distinct.length === 1 ? distinct[0] : undefined
      const element = sole !== undefined ? deriveStored(sole) : storedCarrier(deriveUnionShape({ kind: 'union', members: distinct }))
      if (element.kind === 'unresolved') return unresolved(`no primitive for an open-ended tuple's element: ${element.reason}`)
      return { kind: 'array-object', element, ownership: ownership.forShape(shape, id), extension: null }
    }
    const fields: RecordField[] = []
    for (const [position, element] of shape.elements.entries()) {
      // There is deliberately no tuple carrier: a closed tuple is a record
      // whose keys are its indices.
      fields.push({ key: String(position), value: deriveStored(element.type), required: !element.optional })
    }
    return { kind: 'record', shapeId: id, fields, accessors: [], ownership: ownership.forShape(shape, id) }
  }

  /**
   * The carrier of a class's constructor object.
   *
   * The family is closed: this class, plus every derived class the program
   * stores where this constructor is declared. That is a stronger fact than a
   * dispatching callable, and stating it is what lets construction resolve to
   * a known class rather than a runtime lookup when the family has one member.
   */
  /**
   * The physical class a class shape denotes.
   *
   * A generic class is one struct per LAYOUT, not per copy and not per
   * class: `Box<number>` and `Box<string>` store different things and are
   * two structs, while hono's `Hono<E,S,BasePath>` across every route
   * registration is one, and so are `Carrier<'a' | 'b'>` and
   * `Carrier<string>`, whose `data` fields are the same carrier. The
   * layouts are the groups of the class's copies by the REPRESENTATION of
   * their layout-relevant fillings (`ClassCopyPolicy`), and a group is
   * named by its lowest copy ordinal -- `decl|f0|36@1`, a spelling
   * `identity/ids.ts` reserves for a copy, so the class-lifecycle events
   * that copy minted, its constructor body and its struct name meet under
   * one id (`projection/classes.ts`'s `physicalOf`). With one group the
   * root names it, exactly as before there were groups.
   *
   * Asked with the shape's own folded arguments: the instance side's written
   * ones, the constructor side's copy fillings. A shape whose arguments
   * match no copy (a constructor object read outside every copy, an
   * instantiation the census never minted) is the root's, which owns no
   * layout once there are two -- and fails closed downstream rather than
   * being handed one of them.
   *
   * A filling that is itself an instance of the class being grouped
   * (`Box<Box<number>>`) is keyed by its structural id rather than
   * derived: deriving it would ask for the groups this walk is computing.
   */
  const classGroups = new Map<DeclarationId, ReadonlyMap<string, number> | null>()
  const classArgumentKeyOf = (root: DeclarationId, id: StructuralTypeId): string => {
    const argument = shapeOf(id)
    // A filling that is itself this class (`Box<Box<number>>`) is keyed by
    // its structural id rather than derived: deriving it would ask for the
    // groups this walk is computing.
    if (argument && (argument.kind === 'class-instance' || argument.kind === 'class-constructor') && argument.declaration === root)
      return `self:${id}`
    return representationKey(deriveStored(id))
  }
  const classGroupsOf = (root: DeclarationId): ReadonlyMap<string, number> | null => {
    const known = classGroups.get(root)
    if (known !== undefined) return known
    const copies = classCopies.copiesOf(root)
    if (copies.length < 2) {
      classGroups.set(root, null)
      return null
    }
    // Reserved as "one group" while the copies' fillings derive, for a filling
    // that reaches this class through another (`Box<Pair<Box<T>>>`).
    classGroups.set(root, null)
    const seen = new Map<string, number>()
    for (const copy of copies) {
      const key = copy.typeArguments.map((id) => classArgumentKeyOf(root, id)).join(',')
      if (!seen.has(key)) seen.set(key, copy.ordinal)
    }
    classGroups.set(root, seen)
    return seen
  }
  /**
   * The physical class a class shape denotes, its group's REPRESENTATIVE copy
   * (the lowest ordinal, whose constructor convention the whole group shares),
   * and the family the shape's VALUE names.
   *
   * A shape with no type arguments is the class value read outside every copy
   * -- `Box.count`, `x instanceof Box`, `Box.create(...)`. There is one
   * such object however many structs the class has, so it names the whole
   * family: its static members resolve through the shared static owner, and
   * an `instanceof` against it admits an instance of any layout.
   */
  const physicalClassGroupOf = (
    shape: Extract<StructuralShape, { kind: 'class-constructor' | 'class-instance' }>
  ): { readonly declaration: DeclarationId; readonly representative: number | null; readonly family: readonly DeclarationId[] } => {
    const root = shape.declaration
    const groups = classGroupsOf(root)
    if (groups === null) return { declaration: root, representative: null, family: [root] }
    const ordinals = [...new Set(groups.values())].sort((left, right) => left - right)
    if (shape.typeArguments.length === 0) {
      const representative = ordinals[0] ?? null
      return {
        declaration: root,
        representative,
        family: groups.size > 1 ? ordinals.map((ordinal) => `${root}@${ordinal}` as DeclarationId) : [root]
      }
    }
    const ordinal = groups.get(shape.typeArguments.map((id) => classArgumentKeyOf(root, id)).join(',')) ?? null
    // One group is one physical class, named by the root exactly as before
    // there were groups; its representative is still the lowest copy, whose
    // constructor convention every copy of the class shares.
    if (groups.size < 2) return { declaration: root, representative: ordinal, family: [root] }
    const declaration = ordinal === null ? root : (`${root}@${ordinal}` as DeclarationId)
    return { declaration, representative: ordinal, family: [declaration] }
  }
  const physicalClassDeclarationOf = (shape: Extract<StructuralShape, { kind: 'class-constructor' | 'class-instance' }>): DeclarationId =>
    physicalClassGroupOf(shape).declaration

  const deriveClassConstructor = (shape: Extract<StructuralShape, { kind: 'class-constructor' }>): Representation => {
    // An ambient `declare class`'s value IS a host handle, on the same
    // ground the `declared` case a few hundred lines below already stands on
    // for `declare var Map: MapConstructor` -- reaching the identical fact
    // through class syntax instead of interface-plus-var syntax is not a
    // different fact. Checked before `shape.construct`: a bound ambient class
    // with no declared constructor (`static`-only, e.g. `ObjCTarget`) is
    // still a real host handle, just one nothing may `new`.
    const bound = binding.forDeclaration(shape.declaration)
    if (bound) {
      const signature = shape.construct ? shapeOf(shape.construct) : null
      const construct = signature?.kind === 'signature' ? hostInvocationAbiOf(signature.construct, 'construct') : null
      return {
        kind: 'native-handle',
        protocol: bound.protocol,
        version: bound.version,
        native: bound.native,
        bases: binding.basesOf(bound.native),
        call: null,
        construct
      }
    }
    // The convention is the physical class's, which is its group's
    // REPRESENTATIVE copy's -- the lowest ordinal, the copy that completed
    // the one shared anchor before there were copies. Two copies of one
    // layout can still spell two construct signatures (`Carrier<'a' | 'b'>`
    // and `Carrier<string>` take a `Payload<'a' | 'b'>` and a
    // `Payload<string>`, two records), and one struct has one thunk:
    // publishing each copy's own would give the class two conventions and
    // the thunk whichever the projection kept last.
    const group = physicalClassGroupOf(shape)
    const representative =
      group.representative === null
        ? null
        : classCopies.copiesOf(shape.declaration).find((copy) => copy.ordinal === group.representative)?.constructor
    const representativeShape = representative === undefined || representative === null ? null : shapeOf(representative)
    const construct = representativeShape?.kind === 'class-constructor' ? representativeShape.construct : shape.construct
    if (!construct) return unresolved(`class ${shape.declaration} declares no construct signature to invoke`)
    const signature = shapeOf(construct)
    if (!signature || signature.kind !== 'signature') return unresolved(`class ${shape.declaration} has no interned construct signature`)
    if (signature.construct.length === 0) return unresolved(`class ${shape.declaration} has no interned construct signature`)
    const abi = sharedAbiOf(signature.construct, 'construct')
    if (typeof abi === 'string') return unresolved(abi)
    // A derived class the program stores into this constructor's slot is a
    // member too: naming only the base would let construction and static
    // reads resolve to the base while the cell holds the derived class.
    const members = [...group.family, ...heritage.constructorSlotSubclassesOf(shape.declaration)]
    return { kind: 'constructor-family', members, abi }
  }

  /**
   * `(...args: never[]) => R` -- a function value with NO calling convention.
   *
   * `never` is uninhabited, so no call through this slot can ever supply an
   * argument, and the type is TypeScript's way of writing "some function,
   * which nobody here calls": it is `AnyFunction` in tsc's own `core.ts`, and
   * every use of it there ends at `Error.captureStackTrace`. Giving it a frame
   * is where the silent miscompile lives -- a concrete `f(a, b, c)` converted
   * into a zero-argument frame compiles and then runs with garbage the first
   * time anyone does call it -- so the truthful carrier is the identity half,
   * and a call through it is refused rather than invented.
   *
   * Asked of the DECLARED type, not the widened slot, and through the
   * deriver's own `isNeverType` rather than a shape test of this file's own:
   * by the time `abiOf` has built a carrier, `never` and `undefined` are both
   * physically nothing (`primitives.ts`), and telling them apart down there
   * would be the second authority this compiler exists to avoid.
   */
  const isIdentityOnlySignature = (signature: SignatureShape): boolean => {
    const parameter = signature.parameters[0]
    if (signature.parameters.length !== 1 || parameter === undefined || !parameter.rest) return false
    const declared = shapeOf(parameter.type)
    return declared?.kind === 'array' && isNeverType(declared.element)
  }

  const deriveSignature = (shape: Extract<StructuralShape, { kind: 'signature' }>): Representation => {
    if (shape.construct.length > 0) {
      // A construct signature with no class anchor -- `new () => Component` --
      // is a constructor whose class is not proven. That is a complete answer,
      // not a gap: the convention is what a construction goes through, exactly
      // as an unproven callable is called through its own. A value that is both
      // callable and constructable keeps both conventions, because `Number(x)`
      // and `new Number(x)` do genuinely different things.
      const shared = sharedAbiOf(shape.construct, 'construct')
      if (typeof shared === 'string') return unresolved(shared)
      // `[[Construct]]` MANUFACTURES its receiver -- ECMA-262 10.2.2 creates
      // the object from the constructor's `prototype` and only then enters the
      // body with it -- so a construct convention never has one to declare,
      // whatever the interned signature says. It can say something: a JS
      // constructor function's call and construct signatures share one
      // declaration, so `structural-receiver.ts`'s implicit receiver (which
      // exists for the BODY's sake -- see its `jsConstructorReceiverOf`)
      // arrives on both. Dropping it here, at the one place that knows which
      // convention is which, keeps the two answers from becoming two
      // authorities: a construction site would otherwise have to push a
      // receiver argument nothing evaluates, and `emit-callable.ts`'s
      // construct thunk is the code that actually allocates it.
      const constructAbi = shared.receiver === null ? shared : { ...shared, receiver: null }
      if (shape.call.length === 0) return { kind: 'constructor-value-dispatch', abi: constructAbi }
      const callAbi = sharedAbiOf(shape.call, 'overload', true)
      return typeof callAbi === 'string'
        ? unresolved(callAbi)
        : { kind: 'function-and-constructor', call: callAbi, construct: constructAbi }
    }
    if (shape.call.length === 0) return unresolved('callable shape with no call signature')
    // The OPEN type of a generic source function is not a callable the
    // runtime can hold -- there is no frame until a call instantiates it --
    // it is a choice of which generic function a cell holds. See
    // `generic-function-set` (model.ts).
    if (shape.generic) return { kind: 'generic-function-set', members: [shape.generic] }
    if (shape.call.every(isIdentityOnlySignature)) return { kind: 'callable-identity' }
    const abi = sharedAbiOf(shape.call, 'overload', true)
    // The target set of a first-class function value is not a structural fact,
    // so the carrier is the dispatching one. Naming a single `function` carrier
    // here would claim a proof the shape does not contain.
    if (typeof abi !== 'string') return { kind: 'function-value-dispatch', abi }
    // Incompatible declared overloads are missing a native storage contract,
    // not a dynamic source boundary. Normalization must publish the stored
    // implementation's signature when it can prove one; otherwise the value
    // has no calling convention -- which is a fact about it, not a gap.
    if (dynamicFallback) return { kind: 'dynamic', reason: 'opt-in-fallback' }
    // `Array.from` is four overloads that genuinely disagree at parameter 0,
    // and `Object.getOwnPropertyDescriptor(Array.from, 'name')` never calls
    // it. Refusing the whole program said "I cannot name the frame" about a
    // read that asks for no frame; joining the overloads would invent one.
    // The identity half is what the shape actually contains, and it is the
    // SAME answer `isIdentityOnlySignature` above reaches by the other route
    // -- a call through it is refused by name at emission
    // (`call-abi:no-invoke-path:callable-identity`), so nothing here is
    // fail-open.
    return { kind: 'callable-identity' }
  }

  // `isNeverType` is declared below; the union deriver only calls it later,
  // per arm, so the closure is what is handed over rather than the value.
  const deriveUnion = createUnionDeriver({ shapeOf, derive, isNeverType: (id) => isNeverType(id) })
  const deriveUnionShape = (shape: Extract<StructuralShape, { kind: 'union' }>): Representation => {
    // A choice among generic source functions is ONE set, tagged by
    // member, not a sum of markers: `cond ? identity : setOriginalNode`.
    const genericMembers = genericFunctionSetMembersOf(shapeOf, shape)
    if (genericMembers) return { kind: 'generic-function-set', members: genericMembers }
    return deriveUnion(shape)
  }

  function deriveShape(id: StructuralTypeId, shape: StructuralShape): Representation {
    // A host namespace ROOT is answered before the shape is looked at, and it
    // is the only policy here that has to be. The other four -- `binding`,
    // `elements`, `promise`, `collections` -- are consulted inside `'declared'`
    // (and `binding` also inside the two class cases) because each answers a
    // question about a declared TYPE, so the declaration the checker resolved
    // is both available and the right key. This one answers a question about a
    // VALUE the host owns, whose type is routinely not `'declared'` at all:
    // `window`'s is the intersection `Window & typeof globalThis`. Reaching
    // the switch first would flatten that intersection into a record of
    // lib.dom's `Window`, which is the answer this exists to displace; see
    // `HostNamespaceRootPolicy` (policies.ts) for
    // the whole of why, and for why the carrier is a stated-native
    // `native-record-ref` rather than a handle or a refusal.
    //
    // `owned`, matching the stated-native record the `'declared'` case below
    // already builds for a host's data-only type: the host holds one object
    // (`inline constexpr WindowFacade window{}`), so a value of it is a copy
    // of that object rather than a share of it. `borrowed` -- the other
    // reading of "an external owner" -- spells `T&`, and the host's object is
    // `constexpr`, so a non-const reference to it would not bind.
    const namespaceRoot = namespaceRoots.forType(id)
    if (namespaceRoot !== null) return { kind: 'native-record-ref', shapeId: id, ownership: 'owned', native: namespaceRoot }
    switch (shape.kind) {
      case 'primitive': {
        const carrier = primitiveCarrier(shape.primitive)
        // A symbol is a value the language creates, compares by identity, and
        // uses as a property key. None of the carriers model that, and boxing it
        // would be the forbidden shortcut, so the gap is stated instead.
        return carrier ?? unresolved(`no primitive for a ${shape.primitive}-valued carrier`)
      }
      case 'literal': {
        const carrier = primitiveCarrier(shape.primitive)
        return carrier ?? unresolved(`no primitive for a ${shape.primitive} literal carrier`)
      }
      case 'unique-symbol':
        // A `unique symbol`'s whole purpose is to be its own TYPE, so that one
        // framework key is not assignable where another is declared. That is a
        // checking fact; physically every one of them is one interned id, which
        // is the symbol carrier.
        return { kind: 'symbol' }
      case 'declared': {
        // A typed array is core ECMAScript, not a host protocol: `Uint8Array`
        // and its seven siblings are declared ambiently by the standard lib
        // (no body this compiler can derive a layout from) but are not
        // something any host installs -- so they are resolved by their own
        // policy, checked first, rather than falling into `binding` (host
        // protocols) or the ambient-with-no-protocol refusal below.
        const element = elements.forDeclaration(shape.declaration)
        if (element)
          return { kind: 'typed-array', element, buffer: typedArrayBufferKindOf(shape), ownership: ownership.forShape(shape, id) }
        // `ArrayBuffer`/`DataView`, checked here with the typed arrays because
        // they are the same family and reach the same trap: both are declared
        // ambiently with no body this compiler can lay out, both are core
        // ECMAScript rather than anything a host installs, and both are
        // ALREADY bound as opaque host protocols by the ambient-value census
        // (`ArrayBuffer` through `Uint8ArrayConstructor`'s own
        // `Uint8Array<ArrayBuffer>` return type). Falling through to `binding`
        // is what made every ArrayBuffer in three.js an opaque handle with no
        // bytes behind it. See `StandardBufferPolicy`.
        const buffer = buffers.forDeclaration(shape.declaration)
        if (buffer) return { kind: buffer, ownership: ownership.forShape(shape, id) }
        // `Promise<T>` is checked immediately after, for the identical
        // reason and ahead of `binding`/the ambient-body walk below: run
        // through `declaredBodyOf`'s data-only member stripping, the ambient
        // `Promise` interface's body is NOT empty (`then`/`catch`/`finally`
        // are methods, stripped, but other symbol-keyed members can survive)
        // -- so without this check, `Promise<T>` would silently derive as a
        // `native-record-ref` to a bogus struct instead of refusing or
        // deriving `T` at all. See design.md and citations.md finding 3 for
        // the concrete miscompile this produced before this check existed
        // (a `Promise<number>` parameter derived as a one-field struct while
        // the matching call result derived as plain `double`, and the two
        // disagreeing answers reached clang as a hard `no viable overloaded
        // '='` error). `shape.typeArguments[0]` reads `T` directly off the
        // `'declared'` shape's own field -- the same field `representationKey`
        // already prints for a declared shape -- never off the interface's
        // member list, which this check is precisely what keeps unconsulted.
        if (promise.forDeclaration(shape.declaration)) {
          const payload = shape.typeArguments[0]
          return payload
            ? { kind: 'promise', value: derive(payload) }
            : unresolved('Promise<T> reached representation with no type argument')
        }
        // `Map`/`Set`/`WeakMap`/`WeakSet`, checked here for the same two
        // reasons `Promise<T>` is checked immediately above: their ambient
        // bodies are not empty after `declaredBodyOf`'s method stripping (a
        // `Map` keeps `size` and `[Symbol.toStringTag]`), so falling through
        // would seal a struct of leftovers; and the ambient-value census has
        // ALREADY bound `Map` as an opaque host protocol through
        // `MapConstructor.groupBy`'s return type, so falling through to
        // `binding` below would carry every `Map<K, V>` as a handle with no
        // key or value at all. See `KeyedCollectionPolicy`'s own comment.
        // `Generator<T, TReturn, TNext>`, checked here for the same two reasons
        // `Promise<T>` is checked immediately above: its ambient body is not
        // empty after `declaredBodyOf`'s method stripping, so falling through
        // would seal a struct of leftovers a generator value has none of; and
        // the carrier it needs is not a layout at all but the CURSOR
        // `gea::Iterator<T>` -- which is the same carrier the language itself
        // says a generator is, since `%GeneratorPrototype%[@@iterator]` returns
        // `this`. One carrier, `iterator(T)`, for a value that is both the
        // coroutine and the iterator over it.
        //
        // `TReturn`/`TNext` are carried when the checker resolved them to a
        // concrete, native carrier -- a `return 23` inside the body settles
        // `TReturn` to `number` the same way any other unannotated function's
        // inferred return settles, and an explicit `Generator<Y, R, N>`
        // annotation settles `N` the identical way a declared parameter does.
        // Neither is ever boxed to get there: a `TReturn`/`TNext` that
        // resolves to `dynamic`/`unresolved` (an unannotated generator's
        // implicit `TNext = unknown`, most commonly) collapses to
        // `{ kind: 'undefined' }` instead -- the cursor's own honest "stores
        // nothing here" carrier, matching what its default-constructed
        // `TReturn`/`TNext` slot already is at the C++ layer
        // (`runtime/gea_runtime.h`'s `Iterator<E, TReturn, TNext>`). A
        // generator whose resume value or completion value is actually READ
        // reaches its own refusal downstream, by name, exactly like any other
        // read through an `undefined` carrier already does -- never a widened
        // claim this compiler cannot back with real storage.
        if (generator.forDeclaration(shape.declaration)) {
          const yielded = shape.typeArguments[0]
          if (!yielded) return unresolved('Generator<T, TReturn, TNext> reached representation with no type argument')
          const nativeOrUndefined = (typeArgument: StructuralTypeId | undefined): Representation => {
            if (!typeArgument) return { kind: 'undefined' }
            const derived = deriveStored(typeArgument)
            return derived.kind === 'dynamic' || derived.kind === 'unresolved' ? { kind: 'undefined' } : derived
          }
          return {
            kind: 'iterator',
            element: deriveStored(yielded),
            completion: nativeOrUndefined(shape.typeArguments[1]),
            resume: nativeOrUndefined(shape.typeArguments[2]),
            source: 'generator'
          }
        }
        const family = collections.forDeclaration(shape.declaration)
        if (family) return deriveKeyedCollection(family, shape, id, deriveStored, ownership)
        // `Date`, checked here for the same two reasons `Promise<T>` and the
        // keyed collections are checked above it. Its ambient body survives
        // `declaredBodyOf`'s method stripping as an EMPTY object shape, so
        // falling through would seal a layout of nothing and every member
        // access would then emit as a struct field that is not there; and the
        // carrier is the runtime's own `gea::runtime::Date`, which is a
        // STATED native type rather than one this compiler lays out --
        // `native` is what says so, and `records.ts` emits no struct for it.
        //
        // `native-record-ref` and not `native-handle`, on evidence: a
        // `native-handle` "carries absence" (types.ts's `carriesAbsence`), so
        // `representation/optional.ts` would collapse `Date | null` onto the
        // handle itself and spell `null` as an empty Date. A Date has no such
        // empty value. The shape id is the body's, so a program that reaches a
        // Date dynamically still finds the same sealed entry every other
        // record does.
        const dateNative = date.forDeclaration(shape.declaration)
        if (dateNative !== null && shape.body) {
          dateNatives.add(dateNative)
          return { kind: 'native-record-ref', shapeId: shape.body, ownership: ownership.forShape(shape, id), native: dateNative }
        }
        // `RegExp`, `RegExpExecArray` and `RegExpMatchArray`, checked here for
        // the same two reasons the three policies above are, both of which
        // hold for these as measured facts rather than by analogy.
        //
        // Their bodies survive `declaredBodyOf`'s method stripping: `RegExp`
        // keeps exactly ten data members (`source`, `global`, `ignoreCase`,
        // `multiline`, `lastIndex`, `flags`, `sticky`, `unicode`, `dotAll`,
        // `hasIndices`), and the two result interfaces keep
        // `index`/`input`/`groups`/`length` plus a number index signature. So
        // falling through would seal a plausible-looking struct for each and
        // emit a program that compiles and is not a regular expression.
        //
        // And the ambient-value census has ALREADY bound `RegExp` as an opaque
        // host protocol -- `lib.es5.d.ts` declares `var RegExp: RegExpConstructor`,
        // and the constructor's own `new (...): RegExp` result carries the
        // INTERFACE into the closure. Falling through to `binding` below would
        // give every pattern in the program a `native-handle` with no layout,
        // so `re.source` would have nowhere to go. The constructor's own handle
        // (`RegExpConstructor@1`) is untouched and stays a host boundary, which
        // is correct: `RegExp` the value really is an ambient constructor object.
        //
        // `shared-refcount` rather than the `owned` the bound data-only case
        // below uses, and that is not a default: a pattern is MUTABLE STATE
        // shared by reference. `re.lastIndex` advances across `exec` calls, and
        // `s.replace(re, ...)` resets it -- so two copies of one pattern would
        // silently drift apart. The ownership policy is not consulted for the
        // same reason: this is a fact about what a regular expression IS, not a
        // preference about how records are held.
        const pattern = regexp.forDeclaration(shape.declaration)
        if (pattern) {
          return shape.body
            ? { kind: 'native-record-ref', shapeId: shape.body, ownership: 'shared-refcount', native: pattern.native }
            : unresolved(`the standard ${pattern.kind} declaration reached representation with no structural body`)
        }
        // `String`, the wrapper OBJECT (`new String(x)`), checked here for the
        // identical two reasons `RegExp` immediately above is -- see
        // `StringObjectDeclarationPolicy`'s own doc comment for both in full.
        // `shared-refcount` for the same reason a pattern is: this is an
        // object with identity, not a value, and a program that stores a
        // dynamic property on one (hono's `escapedString.isEscaped = true`)
        // must see that write from every reference to the same object.
        const stringObjectNative = stringObject.forDeclaration(shape.declaration)
        if (stringObjectNative !== null) {
          return shape.body
            ? { kind: 'native-record-ref', shapeId: shape.body, ownership: 'shared-refcount', native: stringObjectNative }
            : unresolved('the standard String declaration reached representation with no structural body')
        }
        const errorNative = errors.forDeclaration(shape.declaration)
        if (errorNative !== null) {
          return shape.body
            ? { kind: 'native-record-ref', shapeId: shape.body, ownership: 'shared-refcount', native: errorNative }
            : unresolved('a standard Error declaration reached representation with no structural body')
        }
        // The bare `Function` interface, checked here for the same first
        // reason every policy above it is -- the ambient-value census has
        // already bound it as an opaque host protocol through
        // `FunctionConstructor`'s own `new (...): Function` result, so falling
        // through to `binding` mints `native-boundary:Function@1`, which no
        // target can register because there is no C++ type for "some callable,
        // signature unknown" -- and for one reason none of them share: the
        // answer is not a carrier at all. `Function` states callability and
        // nothing else, so there is no frame to choose, and the honest carrier
        // is the box. See `'untyped-callable'` (model.ts) for why that is a
        // genuine dynamic boundary rather than a lowering not yet written, and
        // `FunctionDeclarationPolicy` (policies.ts) for why the body is not
        // sealed into a `name`/`length`/`prototype` struct instead.
        if (functionType.forDeclaration(shape.declaration)) return { kind: 'dynamic', reason: 'untyped-callable' }
        // An interface the classes of this program declare themselves the
        // implementations of. Nothing constructs an interface, so a slot typed
        // by one holds one of those classes and nothing else -- see
        // `InterfaceImplementorPolicy` and the census behind it. One class is
        // the class; several are their tagged sum, which dispatches a member
        // call per arm exactly as a written class union does. All or nothing:
        // an implementor whose instantiation this cannot find would leave the
        // sum missing an arm the program can store, and a missing arm is a
        // miscompile, not a narrower answer, so the interface keeps its own
        // layout below and the store refuses by name instead. Checked after
        // every standard-library policy above (all of which answer for
        // ambient interfaces no program implements) and before `binding` and
        // the structural-body path below, which are the two that would
        // otherwise give the interface a layout of its own.
        // An implementor the sealed table holds NO instance shape for is a
        // class the program never constructs and never names as a type -- a
        // `PatternRouter` compiled in from a package file nothing imports a
        // value from -- and a class that is never constructed cannot be what
        // the slot holds, so it contributes no arm. That is different from an
        // implementor with instantiations none of which this reference's
        // arguments select: that one CAN be stored, and leaving it out is the
        // miscompile the all-or-nothing below refuses.
        const implementorDeclarations = implementors
          .forDeclaration(shape.declaration)
          .filter((implementor) => instanceShapesOf(implementor).length > 0)
        if (implementorDeclarations.length > 0) {
          const instances: StructuralTypeId[] = []
          for (const implementor of implementorDeclarations) {
            const instance = implementorShapeFor(implementor, shape.typeArguments)
            if (instance !== null) instances.push(instance)
          }
          if (instances.length === implementorDeclarations.length) {
            const sole = instances.length === 1 ? instances[0] : undefined
            return sole !== undefined ? derive(sole) : deriveUnionShape({ kind: 'union', members: instances })
          }
        }
        // A bound declaration is a host handle, full stop: the protocol is its
        // complete definition, and neither an empty structural body (a JSX
        // `Element` interface with no members) nor a missing one changes that.
        // "Host handle" is not "data-only handle": `declaredBodyOf` (structural.ts)
        // gives a call/construct-bearing type `signature` kind unconditionally,
        // dropping members it also has (`DateConstructor` keeps `now`/`parse`/`UTC`
        // out alongside its `new` overloads). Reading `call`/`construct` off that
        // shape is the checker's answer to "invoke path?" -- never a protocol check.
        const bound = binding.forDeclaration(shape.declaration)
        // ...with one exception the checker itself states. A bound declaration
        // whose body is DATA ONLY is not opaque -- the program builds one, and a
        // handle states a protocol and NO layout, so its keys have nowhere to
        // go. A body with methods stays a handle, which is what keeps
        // `GeaEmbeddedImage`/`FetchResponse` where they were. The record carrier
        // spells the host's own struct, so members emit BY NAME and clang
        // rejects any the C++ type lacks; `owned` because the host returns by
        // value (`isDataOnlyObjectShape`, object-shape.ts, states the rule).
        if (bound?.native && !bound.opaque && shape.body && isDataOnlyBody(shape.body)) {
          return { kind: 'native-record-ref', shapeId: shape.body, ownership: 'owned', native: bound.native }
        }
        // A binding that names NO C++ type, over a data-only body, is not a
        // claim -- it is a gap, and a handle is the one carrier that cannot
        // say so. `host-protocols.ts`'s closure walk binds whatever a host
        // MEMBER or CALL hands back, and its own `native` comes from the
        // plugin's `nativeTypes` keyed by name, so a host method returning an
        // ordinary data interface the plugin never named (`createOffer():
        // Promise<RTCSessionDescriptionInit>`) registered a protocol with a
        // null carrier. Read as a handle, that demands
        // `native-boundary:RTCSessionDescriptionInit@1` -- an obligation the
        // manifest can never satisfy, because nothing ever claimed a C++ type
        // for it -- and refuses the whole program (`examples/dialer`, every
        // one of its twelve rows). It is not opaque either: the app writes
        // `{ type, sdp }` object literals of it and reads their fields, which
        // is the definition of a layout this compiler owns. So it falls
        // through to the record path below, exactly as it did before anything
        // handed it across a boundary.
        //
        // A bound body with METHODS keeps the handle, carrier or not: its
        // operations belong to the host whether or not this compiler was told
        // the type's spelling, and inventing a layout for it would be the
        // guess this rule exists to prevent.
        const boundWithoutCarrier =
          bound !== null &&
          !bound.native &&
          shape.body !== null &&
          (isDataOnlyBody(shape.body) || isDataOnlyDictionaryShape(shapeOf(shape.body), shapeOf))
        if (bound && !boundWithoutCarrier) {
          const invocable = shape.body ? shapeOf(shape.body) : null
          const call = invocable?.kind === 'signature' ? hostInvocationAbiOf(invocable.call, 'overload') : null
          const construct = invocable?.kind === 'signature' ? hostInvocationAbiOf(invocable.construct, 'construct') : null
          return {
            kind: 'native-handle',
            protocol: bound.protocol,
            version: bound.version,
            native: bound.native,
            bases: binding.basesOf(bound.native),
            call,
            construct
          }
        }
        // No body means the declaration is ambient: it declares a shape the
        // compiler did not define, so its carrier has to come from an installed
        // host protocol rather than from a layout guessed here.
        if (!shape.body) return unresolved(`declared type ${shape.declaration} is ambient and has no installed host protocol`)
        const body = shapeOf(shape.body)
        if (body?.kind === 'signature') return deriveSignature(body)
        // A name for a structure with no layout of its own IS that structure.
        // `type Result<T> = [...] | [...]` carries whatever the union carries;
        // there is nothing nominal to hold, and holding it as a
        // `native-record-ref` over a union shape would name a record layout
        // the sealed table never built. Only an `object` body has a layout of
        // its own, which is why that is the one kind that falls through to the
        // dictionary/record routing below.
        if (body !== null && body.kind !== 'object') return derive(shape.body)
        // A named declaration answers the identical "does this body have a
        // record layout" question `deriveObject` answers for an anonymous one,
        // read structurally off the body's own `index`/`members` keys -- never
        // by deriving the body wholesale, which would walk every member and
        // trip the recursion guard on the ordinary self-referential case this
        // carrier exists to support. A symbol-keyed member (an ambient
        // interface's `[Symbol.toStringTag]`) is an ordinary member here, the
        // same as it is for `deriveObject`: `recordFieldsOf` gives it a field
        // keyed by its own declaration identity rather than refusing the body
        // over it. A body that mixes named members with a string- or
        // number-keyed index signature is *not* refused either: it stays
        // nominal like any other record body, and `targets/cpp/records.ts`
        // derives the body's own shape again at emission, landing on the same
        // `record-with-index` carrier `deriveObject` would produce for it
        // directly -- a named declaration and an anonymous object ask the
        // identical layout question here, they just answer it at different
        // times.
        if (body?.kind === 'object') {
          const dictionaryIndex = dictionaryIndexOf(body)
          if (dictionaryIndex) {
            return {
              kind: 'dictionary',
              key: dictionaryIndex.key,
              value: deriveStored(dictionaryIndex.value),
              ownership: ownership.forShape(shape, id)
            }
          }
          const indexes = recordIndexesOf(body)
          if (typeof indexes === 'string') return unresolved(indexes)
        }
        // A name for a VALUE record is that record. Expanding a name is what
        // `native-record-ref` exists to avoid -- `interface Node { next: Node }`
        // has no finite by-value carrier -- but a value record has no reference
        // field at all by construction, so the body is finite and expanding it
        // is what lets `type Point = { x: number }` be a struct rather than a
        // handle. Delegating (rather than minting a second carrier here) keeps
        // the name and the body one answer, which is what `publish.ts` seals.
        if (valueRecords.forType(shape.body)) return derive(shape.body)
        // Otherwise a declared name is carried nominally: its layout is
        // resolved from the sealed table by shape id at emission. Expanding it
        // here is what would make `interface Node { next: Node }` an infinite
        // carrier.
        return { kind: 'native-record-ref', shapeId: shape.body, ownership: ownership.forShape(shape, id), native: null }
      }
      case 'object-anchor': {
        // A callable-bearing object literal's nominal anchor (`structural.ts`).
        // Unlike `declared`, this shape never comes from an ambient/host
        // declaration -- an object literal is always defined in-program, so
        // there is no host-protocol branch to consult, and `shape.body` is
        // always built by `objectShapeOf` and therefore always `kind: 'object'`,
        // never `'signature'`. What DOES carry over from `declared`'s tail is
        // the dictionary/record-with-index routing: an object literal can
        // combine a method or accessor with a string- or number-keyed index
        // signature (`{ [k: string]: number; bump() {...} }`), and that
        // combination is answered the identical way a named declaration's body
        // answers it -- read structurally off the body's own shape, never by
        // deriving the body wholesale (which would walk `bump` again and trip
        // the recursion guard the anchor exists to avoid).
        const body = shapeOf(shape.body)
        if (body?.kind === 'object') {
          const dictionaryIndex = dictionaryIndexOf(body)
          if (dictionaryIndex) {
            return {
              kind: 'dictionary',
              key: dictionaryIndex.key,
              value: deriveStored(dictionaryIndex.value),
              ownership: ownership.forShape(shape, id)
            }
          }
          const indexes = recordIndexesOf(body)
          if (typeof indexes === 'string') return unresolved(indexes)
        }
        // The literal is carried nominally, exactly as `declared` carries an
        // interface or class: its layout is resolved from the sealed table by
        // shape id at emission (`targets/cpp/records.ts`'s `recordLayoutOfShape`),
        // never expanded here.
        return { kind: 'native-record-ref', shapeId: shape.body, ownership: ownership.forShape(shape, id), native: null }
      }
      case 'class-instance': {
        // Checked before `shape.body`, the same order the `declared` case
        // above already uses: `classInstanceBodyOf` (structural.ts)
        // enumerates a class's DATA properties in `data-only` mode whether or
        // not the class is ambient, so an ambient class with at least one
        // declared property (`UIScreen.bounds`, `UIScreen.scale`) already has
        // a non-null `shape.body` -- checking `!shape.body` first would route
        // it to `class-ref` regardless of being bound, and `class-ref`'s own
        // recipe is claimed flatly (`manifest.ts`) with no per-declaration
        // censused-check the way `constructor-family` has one
        // (`preflight/run.ts`'s `constructorFamilyIsCensused`) -- certifying,
        // then refusing at emission with "no class evaluation published" for
        // a class `class-lifecycle` never censused.
        const bound = binding.forDeclaration(shape.declaration)
        if (bound) {
          return {
            kind: 'native-handle',
            protocol: bound.protocol,
            version: bound.version,
            native: bound.native,
            bases: binding.basesOf(bound.native),
            call: null,
            construct: null
          }
        }
        // No body means the class was declared and not defined -- its instances
        // are built by something outside this program, and their layout belongs
        // to that host protocol rather than to a struct enumerated here.
        if (!shape.body) {
          return unresolved(`class ${shape.declaration} is declared without a body and has no installed host protocol`)
        }
        return {
          kind: 'class-ref',
          declaration: physicalClassDeclarationOf(shape),
          shapeId: shape.body,
          ownership: ownership.forShape(shape, id),
          ancestors: heritage.forDeclaration(shape.declaration)
        }
      }
      case 'class-constructor':
        return deriveClassConstructor(shape)
      case 'object':
        return deriveObject(id, shape)
      case 'array':
        // Always the observable Array, never the dense buffer: holes, index key
        // domain, and `length` semantics are observable, and a private buffer
        // has none of them. Selecting a buffer is a separate, proven decision.
        const extension = arrayExtensionFieldsOf(shape.extension)
        if (typeof extension === 'string') return unresolved(extension)
        return { kind: 'array-object', element: deriveStored(shape.element), ownership: ownership.forShape(shape, id), extension }
      case 'tuple':
        return deriveTuple(id, shape)
      case 'union':
        return deriveUnionShape(shape)
      case 'intersection':
        return deriveIntersection(id, shape)
      case 'signature':
        return deriveSignature(shape)
      case 'type-parameter':
        if (dynamicFallback) return { kind: 'dynamic', reason: 'opt-in-fallback' }
        return unresolved(`type parameter ${shape.declaration} reached representation without monomorphization`)
      case 'unresolved':
        if (dynamicFallback && shape.fallback === 'erased-type-expression') return { kind: 'dynamic', reason: 'opt-in-fallback' }
        // Bottom propagates. Substituting any carrier here would turn a stated
        // gap into a silently wrong answer.
        return unresolved(shape.reason)
    }
  }

  const isNeverType = (id: StructuralTypeId): boolean => {
    const shape = shapeOf(id)
    if (shape?.kind === 'primitive') return shape.primitive === 'never'
    // An intersection of two classes neither of which descends from the other
    // is `never` in every sense this predicate is asked about -- unreachable,
    // no value, nothing to load -- even though TypeScript leaves the pair
    // unreduced and the shape therefore still says `intersection`. The
    // deriver's own intersection case answers the carrier half of this same
    // fact; consumers asking about REACHABILITY have to be told too, or a
    // provably dead branch keeps owing conversions for loads it never performs.
    if (shape?.kind !== 'intersection') return false
    return isUninhabitedIntersection(substantiveMembersOf(shape.members))
  }

  // An OPEN tuple derives `array-object` already and is answered by its kind;
  // only the closed one lands in a record and needs the shape consulted.
  const isTupleShape = (id: StructuralTypeId): boolean => bodyShapeOf(id)?.kind === 'tuple'

  /**
   * The `[[Call]]`/`[[Construct]]` convention of one exact source function
   * whose semantic allocation was registered in `dynamicCallableShapes`.
   * The lookup starts with FunctionId, not a structural signature id: two
   * unrelated functions may share the latter, while only one may own the
   * mutable `.prototype`/expando table that required boxing.
   *
   * Calling `deriveSignature` directly, rather than going through the
   * memoized `derive`, is what bypasses the override without touching it:
   * `derive`'s own short-circuit remains the general type answer. This narrow
   * path returns `null` for an unjoinable overload and, critically, for a
   * construct-only signature: `[[Construct]]` has no caller-supplied receiver,
   * but its BODY does. Publishing that receiver-less construct ABI as an
   * ordinary call frame would enter the body with a slot nobody supplied.
   */
  const nativeCallableConventions = (functionId: FunctionId): { call: CallableAbi; construct: CallableAbi | null } | null => {
    const id = dynamicCallableShapes.get(functionId)
    if (id === undefined) return null
    const shape = shapeOf(id)
    if (shape?.kind !== 'signature') return null
    const native = deriveSignature(shape)
    if (native.kind === 'function-value-dispatch') return { call: native.abi, construct: null }
    if (native.kind === 'function-and-constructor') return { call: native.call, construct: native.construct }
    return null
  }

  const isDateCarrier = (representation: Representation): boolean =>
    representation.kind === 'native-record-ref' && representation.native !== null && dateNatives.has(representation.native)

  return { derive, layoutOf, abiOf, deriveStored, isNeverType, isTupleShape, nativeCallableConventions, isDateCarrier, dynamicFallback }
}
