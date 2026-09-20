import type { DeclarationId, FunctionId } from '../identity/ids.js'
import type { CallableAbi, Ownership, Representation, ScalarDomain, TaggedUnionArm } from '../representation/model.js'
import type { ClassifierContract, CoercionOperation, CollectionDomain, MaterializerContract } from './algebra.js'

export type { CoercionOperation } from './algebra.js'

/**
 * The runtime's installed conversion primitives.
 *
 * Derivation never invents a classifier or a materializer. It only asks this
 * registry whether one is installed for the exact identity a `Representation`
 * carries -- a scalar domain, a class declaration, a function/ABI pair -- and
 * reports `never` with a stated reason when the answer is no. Without this
 * boundary, "the runtime does not have this yet" would silently become a
 * fabricated `Atom` instead of an honest gap.
 *
 * Every lookup answers only "is one installed", never "would one be correct".
 * Domain-equality and disjointness are proved by the caller from what comes
 * back, not asserted by the registry.
 */

/** A classifier paired with the materializer whose acceptance domain it must equal. */
export interface ClassifierMaterializerPair {
  readonly classifier: ClassifierContract
  readonly materializer: MaterializerContract
}

export interface ConversionRuntimeRegistry {
  /**
   * The exact JS tag/range materializer for one scalar domain, or `null` if
   * none is installed. `boolean` and `number` must be backed only by an exact
   * `typeof` tag check, never a coercive cast; the registry, not this module,
   * owns that discipline -- derivation only ever forwards what comes back.
   */
  readonly scalarMaterializer: (domain: ScalarDomain) => ClassifierMaterializerPair | null

  /** The exact string-tag materializer. Never a `ToString` coercion. */
  readonly stringMaterializer: () => ClassifierMaterializerPair | null

  /**
   * The exact symbol-tag materializer.
   *
   * `typeof x === 'symbol'` is the only test there is: a symbol carries no
   * structure to inspect, so classifying one out of a box is a tag check and
   * nothing else. Installed only by a runtime whose box can report that tag.
   */
  readonly symbolMaterializer: () => ClassifierMaterializerPair | null

  /** The exact null-tag materializer, installed only when the runtime distinguishes `null` from `undefined`. */
  readonly nullMaterializer: () => ClassifierMaterializerPair | null

  /** The exact undefined-tag materializer, installed only when the runtime distinguishes `undefined` from `null`. */
  readonly undefinedMaterializer: () => ClassifierMaterializerPair | null

  /** The nominal-token materializer for one exact class and ownership. There is no structural fallback. */
  readonly classRefMaterializer: (declaration: DeclarationId, ownership: Ownership) => ClassifierMaterializerPair | null

  /**
   * A versioned host-protocol materializer -- the only admissible route for a
   * native handle. `native === null` means the compiler's opaque
   * `NativeHandle<protocol>` carrier; a native spelling is host-owned and
   * needs an explicit host identity contract rather than inference from text.
   */
  readonly nativeHandleMaterializer: (protocol: string, version: number, native: string | null) => ClassifierMaterializerPair | null

  /**
   * The materializer that allocates one exact frozen record shape. Required-
   * presence checking and per-field recursion are the materializer's recipe;
   * this registry only answers whether the shape and ownership are installed.
   */
  readonly recordMaterializer: (shapeId: string, ownership: Ownership) => MaterializerContract | null

  /**
   * The IDENTITY-token materializer for one exact record shape and ownership
   * -- reading back the very object a box already holds, rather than
   * reconstructing one field by field the way `recordMaterializer` above does.
   *
   * A distinct entry because it is a distinct claim. `recordMaterializer`
   * says "this runtime can BUILD a value of this shape from an arbitrary
   * dynamic object, checking every required field"; this one says "a value of
   * this shape that THIS program boxed can be recognized and handed back
   * unchanged". The second is what a program that boxes its own typed record
   * and reads it out again needs, it preserves identity where a rebuild would
   * not, and it is available for shapes the first will never be available for
   * -- so collapsing them into one entry would either over-claim the rebuild
   * or lose the round trip.
   *
   * Serves `native-record-ref`. Compiler-owned `record` values use the
   * distinct product materializer above: an exact boxed payload is only that
   * product's identity-preserving fast path, not its capability claim.
   */
  readonly recordRefMaterializer: (shapeId: string, ownership: Ownership) => ClassifierMaterializerPair | null

  /**
   * The installed materializable-ordinary-Array domain, narrower than a bare
   * `IsArray` test. `null` when no such domain is installed for this ownership,
   * for instance because materializing a fresh value as `borrowed` is
   * incoherent -- a materialized value cannot borrow lifetime it never had.
   */
  readonly arrayObjectDomain: (ownership: Ownership) => CollectionDomain | null

  /** The authenticated callable-identity materializer for one exact function and ABI. Category-only checks do not qualify. */
  readonly functionMaterializer: (functionId: FunctionId, abi: CallableAbi) => ClassifierMaterializerPair | null

  /**
   * A checked adapter from a dynamic Function value to one evaluated callable
   * ABI. Unlike `functionMaterializer`, this does not claim a declaration's
   * identity: the Function tag authenticates only callability, and the
   * materializer must perform the target ABI's argument/result conversions at
   * each call.
   */
  readonly functionValueDispatchMaterializer: (abi: CallableAbi) => ClassifierMaterializerPair | null

  /**
   * The exact runtime tag that marks an `Optional`'s absent case as `absence`,
   * or `null` if none is installed.
   *
   * Takes the absence spelling rather than answering one fixed tag for both:
   * `gea::Optional<T>` records ONLY presence/absence, not which of JavaScript's
   * two absent values a caller meant, so a single program-wide tag would have
   * to pick one spelling and would silently take the wrong branch reading the
   * other -- `string | null` and `string | undefined` would become
   * indistinguishable the moment either one round-trips through a dynamic
   * value.
   */
  readonly optionalAbsenceTag: (absence: 'null' | 'undefined') => string | null
  /**
   * Reading a carrier THIS PROGRAM BOXED back out of the box by identity, for
   * a carrier whose whole value is one C++ object.
   *
   * A different claim from `recordMaterializer`'s: that one RECONSTRUCTS a
   * value field by field from an arbitrary dynamic value, which for an open
   * shape (a `dictionary`'s string keys, a `record-with-index`'s sidecar) has
   * no semantics-preserving answer and is correctly refused. This one performs
   * no walk at all -- `Value::box` recorded the payload's exact C++ type, so
   * the round trip is a tag check plus an address check plus a handle copy,
   * the identical primitive `recordRefMaterializer` already installs for a
   * named record shape.
   *
   * Keyed on the whole `Representation` because these carriers have no shape
   * id to key on: `gea::Dictionary<V>` and `gea::TypedArray<T>` are named by
   * their element/value carrier, not by a layout in the sealed table.
   */
  readonly boxedIdentityMaterializer: (target: Representation) => ClassifierMaterializerPair | null

  /**
   * The executable discriminator that selects one dynamic tagged-union arm.
   * Its domain must name the same tag, payload type, or class-family test the
   * emitter will execute; checker-only identities are not runtime evidence.
   */
  readonly taggedUnionArmClassifier: (arm: TaggedUnionArm) => ClassifierContract | null

  /**
   * The test and load a *narrowing* read needs, for one exact source and target
   * carrier -- or `null` when the runtime installs none.
   *
   * This is the one entry that does not start from the dynamic carrier, and it
   * is here because the same discipline applies. `if (tag)` narrows a cell
   * holding `Optional<string>` to a read typed `string`; `if (typeof x ===
   * 'string')` narrows one holding a tagged union to a single arm. Both are
   * real loads with real recipes -- a presence flag and a payload, a
   * discriminant and an arm -- and neither is a cast. Without an installed pair
   * the load has no meaning and preflight says so, which is why this asks the
   * runtime instead of assuming every backend can do it.
   *
   * Both carriers are the key because a runtime may manage some pairs and not
   * others: a `borrowed` payload has no lifetime an unwrap could hand back, and
   * a target that matches no arm of the source union is not a narrowing at all.
   * Answering `null` is the honest refusal in each case.
   */
  readonly narrowing: (source: Representation, target: Representation) => ClassifierMaterializerPair | null

  /**
   * The construction a *widening* store needs, for one exact source and target
   * carrier -- or `null` when the runtime installs none.
   *
   * This is `narrowing`'s mirror image, and it exists for the identical reason:
   * `const x: boolean | number = someBoolean` puts a plain value where a
   * `TaggedUnion` is declared, and the language really does widen there. A
   * control-flow merge does the same thing when its branches carry different
   * concrete carriers and the plan gives the merge itself a union -- neither
   * branch's value ever passed through the dynamic carrier, so `narrowing`'s
   * sibling in the dynamic-conversion algebra (`derive.ts`) has nothing to say
   * about it; this is the entry that does.
   *
   * There is no membership test to make -- which arm is being constructed is
   * already known statically, from the source's own carrier -- but the pair
   * shape is kept the same as `narrowing`'s so both live in one conversion
   * graph under one capability shape, and a `null` here refuses the same way
   * `narrowing`'s does: cleanly, with the gap enumerated rather than papered
   * over with an invented recipe.
   */
  readonly widening: (source: Representation, target: Representation) => ClassifierMaterializerPair | null

  /**
   * Rebuilding one tagged union as another, for one exact source and target
   * union -- or `null` when the runtime installs none.
   *
   * Two declared unions with the same member set do not have to agree on tag
   * order -- `boolean | number` and `number | boolean` are two unrelated C++
   * template instantiations -- which is exactly what a merge produces when its
   * two branches arrive through independently-declared unions. Neither
   * `narrowing` nor `widening` covers it: the target is not one arm of the
   * source, and the source is not one arm of the target. Every value the
   * source can hold must have a same-typed home among the target's arms, or
   * the target is missing a member the source can actually carry -- a real
   * hole, refused rather than dropped.
   */
  readonly recasting: (source: Representation, target: Representation) => ClassifierMaterializerPair | null

  /**
   * The recipe for a pair none of the three above admit, decided from the
   * two carriers alone: an upcast, a callable prefix drop, a record or union
   * recast, a promise whose payload converts, an optional wrapped around a
   * converting payload. No classifier, because no value can fail it. This is
   * the whole of what the printer's ordered conversion chain answers beyond
   * the three registered pairs, exposed so the conversion census
   * (`conversion/nodes.ts`) can mint one node per pair from the same table
   * the printer renders from, instead of a second predicate list that has to
   * be kept in step with it by hand.
   */
  readonly staticRecipe: (source: Representation, target: Representation) => MaterializerContract | null

  /**
   * An ECMAScript abstract operation over one exact source carrier --
   * `ToNumber` for ApplyStringOrNumericBinaryOperator's ToNumeric and
   * IsLessThan's numeric branch, `ToString` for concatenation and the
   * string branch -- or `null` when the runtime installs none (a BigInt into
   * a Number, a Date's `valueOf`-first ToPrimitive, an object whose own
   * `toString` would have to be called). Distinct from the three pair tables
   * above and from `staticRecipe`: those answer "how does a value of X get
   * STORED as Y", which for a `string` into a `number` is an exact tag read
   * that refuses `"3"`; a coercion answers "what is ToNumber of this value",
   * which accepts it and yields `3`. One (source, target) pair, two different
   * conversions -- so the slot census names the operation, never just the
   * target, and the census node carries it in its id.
   */
  readonly coercion: (source: Representation, operation: CoercionOperation) => MaterializerContract | null
}
