import type { DeclarationId, StructuralTypeId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { representationKey, type Representation } from '../representation/model.js'

/**
 * Whether a native object has only compiler-owned, fixed slots.
 *
 * This is a fact about the object's own slots, not the protocol of their
 * payloads. An array, optional, callable or host reference in a fixed field
 * does not make reading that field dynamic. `directChildrenOf` separately
 * censuses those payloads, and `promoteFull` closes over them when an actual
 * operation exposes the enclosing object. Requiring a child's layout to be
 * closed here retains unused boxed reads on an otherwise closed parent.
 * `native-record-ref` is admitted only when it names a compiler-owned record
 * layout from the sealed deriver. Host layouts, index sidecars and record
 * accessors still require their own full protocol. Class prototype accessors
 * are body entries, not own storage; their effects belong to accessor flow.
 * Recursive native wrappers remain
 * excluded because their physical layout is not the ordinary record layout.
 *
 * A container with an intrinsically open element/key domain -- `array-object`,
 * `dictionary`, `keyed-collection` -- asks a narrower version of the same
 * question. Their indexed/keyed storage is never finite (that openness is
 * what makes them a container rather than a record) and is never what this
 * function is being asked about: reads and writes through it are served by
 * their own dedicated native transports (`native-array-transport.ts`,
 * `native-dictionary-transport.ts`, direct `get`/`set`/`has` method calls),
 * never by the generic `gea_readOwnField`/`gea_ownFieldDescriptor` hooks this
 * proof gates. What is left to check is only the OWN NAMED-FIELD surface
 * beyond that index -- an array's `extension`, or nothing at all for a plain
 * array, a bare dictionary, or a Map/Set/WeakMap/WeakSet -- which can be
 * exactly as closed as an ordinary record's fields even though the container
 * around it is open-ended.
 */
export const hasClosedFixedLayout = (
  representation: Representation,
  deriver: Pick<RepresentationDeriver, 'layoutOf'> | null,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  visiting = new Set<string>(),
  completed = new Map<string, boolean>()
): boolean => {
  // `representationKey` intentionally folds recursive wrapper metadata into
  // the same physical native-record-ref identity.  Inspect this marker before
  // consulting the key cache so a plain record reference cannot certify a
  // recursive array/dictionary/callable wrapper that happens to share its
  // shape id.
  if (representation.kind === 'native-record-ref' && representation.recursive !== undefined) return false
  const identity = representationKey(representation)
  const known = completed.get(identity)
  if (known !== undefined) return known
  if (visiting.has(identity)) return false
  visiting.add(identity)
  let closed = false
  switch (representation.kind) {
    case 'record':
      closed =
        representation.accessors.length === 0 &&
        representation.fields.every((field) => !field.key.startsWith('sym(') && field.value.kind !== 'unresolved')
      break
    case 'native-record-ref': {
      // A stated native name is a host-owned layout.  Its fields are not a
      // sealed compiler fact, even when a deriver can describe the shape.
      if (representation.native !== null || representation.recursive !== undefined || deriver === null) break
      closed = hasClosedFixedLayout(deriver.layoutOf(representation.shapeId as StructuralTypeId), deriver, classes, visiting, completed)
      break
    }
    case 'class-ref': {
      const layout = classes.get(representation.declaration)
      // A class the lifecycle census published no layout for is still emitted.
      // `targets/cpp/records.ts` renders its struct from the CARRIER'S OWN
      // SHAPE (`recordLayoutOfShape`), standalone -- `classBaseLinks` walks the
      // same layout map, so it has no row to give this struct a base clause --
      // which makes that shape's fields the exact slots the object has. They
      // are as compiler-owned and as fixed as any other class's, so a missing
      // lifecycle row is evidence about the CENSUS, not about the storage.
      // Asking the shape here asks the one authority the struct was rendered
      // from, exactly as the `native-record-ref` case above already does.
      // Answering "unproven" instead retained the unrestricted field protocol
      // for a struct whose every slot the compiler itself chose: in the three.js app the
      // carriers in this state are reached only through an INFERRED field type
      // -- no live identifier spells the class, so reachability never opens its
      // declaration -- and the generic protocol they kept was the single
      // largest source of reflection boxing in the program.
      if (layout === undefined) {
        closed =
          deriver !== null &&
          hasClosedFixedLayout(deriver.layoutOf(representation.shapeId as StructuralTypeId), deriver, classes, visiting, completed)
        break
      }
      const instanceShape = layout?.instance
      const shape =
        deriver !== null && instanceShape?.kind === 'class-ref' ? deriver.layoutOf(instanceShape.shapeId as StructuralTypeId) : null
      // Parameter properties and inferred fields acquire their carrier during
      // lowering. The earlier declaration can remain unrepresented after the
      // physical census has published a complete, typed storage slot.
      const fields =
        layout?.nativeStorage?.fields.map((field) => ({ key: field.key, value: field.value })) ??
        layout?.fields.map((field) => ({ key: field.key, value: field.representation })) ??
        []
      const unprovenAncestry = (() => {
        const seen = new Set<DeclarationId>()
        let current: DeclarationId | null = representation.declaration
        while (current !== null && !seen.has(current)) {
          seen.add(current)
          const currentLayout = classes.get(current)
          if (!currentLayout) return true
          if (currentLayout.nativeBase !== null) return true
          current = currentLayout.base
        }
        return false
      })()
      closed =
        layout !== undefined &&
        layout.nativeBase === null &&
        !unprovenAncestry &&
        shape?.kind === 'record' &&
        shape.fields.every((field) => !field.key.startsWith('sym(') && field.value.kind !== 'unresolved') &&
        fields.every(
          (field) =>
            !field.key.startsWith('sym(') &&
            field.value !== null &&
            // Slot eligibility is independent from the nested carrier's own
            // reflection demand.  A typed Array/Map/callable field is still
            // a sealed native slot; its child surface is censused separately
            // through directChildrenOf and must not force this class's generic
            // field protocol to remain available.
            field.value.kind !== 'unresolved'
        )
      break
    }
    // An Array's own indexed storage (`length`, holes, index reads/writes) is
    // deliberately NOT what this checks -- that is served entirely by
    // `native-array-transport.ts`'s dedicated recipes, independent of this
    // proof. What is left is the `extension`: the closed, typed field set an
    // interface like `NodeArray<T>` adds on top of `Array<T>`
    // (`representation/model.ts`'s own doc on `extension`). A plain array
    // (`extension === null`) adds none, so it is trivially closed; an
    // extended one is closed on exactly the same terms a `record`'s fields
    // are, above. `element` must still have an actual carrier -- lattice
    // bottom here is a failed derivation, not a legitimate payload, exactly
    // as an unresolved record field is refused above. `recursive` is excluded
    // for the same reason the `native-record-ref` case excludes it before
    // touching the cache: a recursive array's `representationKey` collapses
    // to `recursive(type,container,ownership)` (`representation/model.ts`'s
    // `buildRepresentationKey`), which drops `extension`/`element` entirely,
    // so a `true` cached under that identity would not actually have come
    // from checking THIS array's own fields.
    case 'array-object':
      closed =
        representation.recursive === undefined &&
        representation.element.kind !== 'unresolved' &&
        (representation.extension === null ||
          representation.extension.every((field) => !field.key.startsWith('sym(') && field.value.kind !== 'unresolved'))
      break
    // A dictionary IS its index -- `interface StringCounts { [key: string]:
    // number }` names no member at all -- so it is the degenerate case of
    // `record-with-index` with an empty `fields` array, and the same "key
    // enumeration consumes the protocol, not the values stored in it"
    // argument that admits that sidecar (see `hasNativePropertyLayout`'s own
    // doc, and `nativeDictionaryTransportOf` for the per-operation half of the
    // same proof) applies here with nothing else left to check. `recursive`
    // is excluded for the identical key-collapsing reason given at
    // `array-object` above.
    case 'dictionary':
      closed = representation.recursive === undefined && representation.value.kind !== 'unresolved'
      break
    // `Map`/`Set`/`WeakMap`/`WeakSet` are read and written through `get`/
    // `set`/`has`/`delete` METHOD CALLS, not ordinary property gets -- an
    // unmodified instance has ZERO enumerable own data properties for
    // `Object.keys`/`for`-`in` to find, and a program typed against a plain
    // `Map<K, V>` is refused by the checker for `someMap.x = 1` the same way
    // it is for a plain array or dictionary. The own-field surface this proof
    // covers is therefore vacuously empty no matter what `key`/`value` carry;
    // `recursive` is excluded for the same key-collapsing reason as the two
    // cases above.
    case 'keyed-collection':
      closed =
        representation.recursive === undefined &&
        representation.key.kind !== 'unresolved' &&
        (representation.value === null || representation.value.kind !== 'unresolved')
      break
    // Left unproven, deliberately:
    // - `native-handle`: a host-declared protocol (`Math`, `Date`, an
    //   embedder type, ...) whose member set lives in an external plugin
    //   manifest this function has no access to, exactly like a
    //   `native-record-ref` carrying a stated `native` name above. There is
    //   no field list here to check for symbol keys or unresolved values, so
    //   there is nothing to prove -- a host name is not a sealed compiler
    //   fact any more for a handle than it is for a record reference.
    // - `optional`, `tagged-union`, `borrowed-ref`: wrapper kinds, not
    //   objects. `objectSurfacesOf` (`reflection-demand.ts`) already unwraps
    //   every one of these before this function is ever asked about a
    //   "surface", and neither of this function's own recursive callers
    //   (`native-record-ref`, `class-ref` above) can hand one back from
    //   `deriver.layoutOf`: both name an OBJECT shape, never a union or an
    //   optional value. Proving one closed here would also be the wrong
    //   question -- "closed" has to mean something about the payload it
    //   unwraps to, and unwrapping first (as every actual caller does) already
    //   gives that an honest answer.
    // - `native-sequence`, `dense-buffer`: compiler/runtime-private storage
    //   with no JavaScript identity and no source syntax a program could ever
    //   name as a class's or interface's own shape, so `deriver.layoutOf`
    //   cannot produce either one here either.
    default:
      break
  }
  visiting.delete(identity)
  completed.set(identity, closed)
  return closed
}

/** A typed native index has a complete property protocol even though its key
 * set changes at runtime. Key enumeration consumes that protocol, not the
 * values stored in it. Keep fixed-slot proofs separate: an index must never
 * qualify a record for a finite-field lookup or fixed-layout conversion.
 */
export const hasNativePropertyLayout = (
  representation: Representation,
  deriver: Pick<RepresentationDeriver, 'layoutOf'> | null,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  visiting = new Set<string>(),
  completed = new Map<string, boolean>()
): boolean => {
  if (representation.kind === 'native-record-ref' && representation.recursive !== undefined) return false
  const identity = representationKey(representation)
  const cached = completed.get(identity)
  if (cached !== undefined) return cached
  if (visiting.has(identity)) return false
  visiting.add(identity)
  let complete = false
  if (representation.kind === 'record-with-index') {
    complete =
      representation.fields.every((field) => !field.key.startsWith('sym(') && field.value.kind !== 'unresolved') &&
      representation.indexes.every(
        (index) => (index.key === 'string' || index.key === 'number' || index.key === 'symbol') && index.value.kind !== 'unresolved'
      )
  } else if (representation.kind === 'native-record-ref' && representation.native === null && deriver !== null) {
    complete = hasNativePropertyLayout(deriver.layoutOf(representation.shapeId as StructuralTypeId), deriver, classes, visiting, completed)
  } else complete = hasClosedFixedLayout(representation, deriver, classes)
  visiting.delete(identity)
  completed.set(identity, complete)
  return complete
}
