import { createHash } from 'node:crypto'
import type { DeclarationId, FunctionId, StructuralTypeId } from '../identity/ids.js'

/**
 * Physical carriers.
 *
 * A representation answers "which physical thing holds this value", and it is
 * selected from an already-published semantic result. It is never a second
 * interpretation of the source: if choosing a carrier requires re-reading the
 * program, the semantic layer did not publish enough.
 *
 * `array-object` and `dense-buffer` are deliberately different kinds. A
 * JavaScript-observable Array is an exotic object with hole semantics, an
 * array-index key domain, and `length` define/delete/truncation rules; a dense
 * buffer is a compiler-private storage block with none of that. Letting one
 * kind mean both is what allows a single Array to be a tagged array object in
 * one endpoint and a bare vector in another.
 */

/** The only reasons a value may be carried dynamically. */
export const dynamicReasons = [
  /** Explicit compiler option permits C++ dynamic dispatch without a static specialization. */
  'opt-in-fallback',
  /** `ToString` of a value whose type the program never narrows. */
  'tostring-of-unknown',
  /** A thrown value, which JavaScript does not type. */
  'thrown-error-carrier',
  /** `JSON.parse` with no asserted result type. */
  'unasserted-json-parse',
  /** The program itself declared `any`/`unknown` and never narrowed it. */
  'declared-any-never-narrowed',
  /** A host-authenticated CommonJS module record is deliberately an `any` boundary. */
  'commonjs-module-boundary',
  // The bare `Function` interface (`lib.es5.d.ts`), which states a value is
  // callable and states nothing else: no parameter list, no arity, no result.
  // That is `unknown` for callables, and it is a genuinely dynamic boundary
  // rather than a lowering this compiler has not written yet -- a physical
  // frame cannot be chosen from a signature the program never gave. The
  // checker already reaches this same conclusion on the CALLEE side, where it
  // declines to check a call whose callee is `Function` and answers `any`
  // (see `resolvedCalleeSignatureType`, semantics/normalize/producers/
  // shared.ts); this is the same answer for a `Function`-typed VALUE, so the
  // two are one authority instead of two.
  //
  // Reached by more than an explicit `value: Function` annotation:
  // `typeof x === 'function'` narrows an `unknown` TO `Function`, and
  // `lib.es5.d.ts` types `Object.prototype.constructor` as `Function`. Before
  // this reason existed all three derived to `native-handle(Function@1)` --
  // a host protocol no target can ever register, since there is no C++ type
  // for "some callable" -- so the program refused with an obligation nothing
  // could satisfy instead of boxing the one thing that genuinely is dynamic.
  'untyped-callable',
  // A read of `call`/`apply`/`bind` off a Function object the program itself
  // installed an own property of that name onto. `lib.es5.d.ts` types such a
  // read as `Function.prototype`'s method, which is not what the program will
  // find there: the own property shadows it, and what the own-property table
  // holds is whatever was written, under no declared convention. The renderer
  // already agrees -- `ir/certify/property-access-keys.ts` gives exactly this
  // read the `(prototype-dynamic)` recipe, which emits `callableDynamicGet`
  // and yields a `gea::Value` -- so before this reason existed the carrier and
  // the code emitted for it disagreed about the same read.
  'shadowed-callable-builtin'
] as const

export type DynamicReason = (typeof dynamicReasons)[number]

/** Scalar domains with exact range semantics. */
export type ScalarDomain = 'boolean' | 'number' | 'bigint' | 'int32' | 'uint32' | 'float64'

/**
 * The eight standard TypedArray element widths (ECMA-262 23.2), one per
 * `Uint8Array`/`Int32Array`/... view. Deliberately not a widening of
 * `ScalarDomain`: a typed array element is never the generic `'number'` (or
 * `'boolean'`/`'bigint'`) domain that carrier models — every view is one
 * specific fixed width every write truncates to, which is a different
 * question than "what physical type holds a JS number". `int32`/`uint32`/
 * `float64` are the same three string tags `ScalarDomain` already carries as
 * unused storage-choice placeholders; the remaining five are new.
 */
/**
 * The element a typed array view stores, one entry per row of ECMA-262 23.2's
 * table of TypedArray constructors.
 *
 * `uint8-clamped` is `Uint8ClampedArray`, and it is a distinct domain rather
 * than a flag on `uint8` because its WRITE RULE is different: every other
 * integer view truncates modulo 2^N (ECMA-262 7.1.x `ToIntN`/`ToUintN`), while
 * `Uint8ClampedArray` clamps to [0, 255] and rounds halves to EVEN (7.1.11
 * `ToUint8Clamp`) -- so `a[0] = 1.5` stores 2, `a[0] = 2.5` stores 2, and
 * `a[0] = 300` stores 255. Carrying it as `uint8` would make those three
 * writes silently wrong. The C++ element type differs to match
 * (`gea::ClampedUint8`), so the rule is chosen by overload resolution at
 * compile time and there is no runtime kind flag to consult.
 *
 * `bigint64`/`biguint64` are absent: their elements are BigInts, which no
 * `ScalarDomain` models and this backend has no carrier for at all. A program
 * naming `BigInt64Array` therefore gets no typed-array carrier and refuses by
 * name upstream, rather than being quietly given a 64-bit integer view whose
 * reads would have to lie about their type.
 */
export type TypedArrayElementDomain = 'int8' | 'uint8' | 'uint8-clamped' | 'int16' | 'uint16' | 'int32' | 'uint32' | 'float32' | 'float64'

/** How long a reference is valid and who may keep it. */
export type Ownership = 'owned' | 'shared-refcount' | 'borrowed'

/** One field of a closed record shape. */
export interface RecordField {
  readonly key: string
  readonly value: Representation
  /** A field that may be absent is not the same as a field holding `undefined`. */
  readonly required: boolean
}

/**
 * One accessor-backed member of a record: a property with no storage, read and
 * written by calling a body.
 *
 * Kept out of `fields` because the two are different physical things. A field
 * occupies a struct member; an accessor occupies none, and laying one out
 * would reserve space for a value that is never stored there and would let a
 * read find that space instead of running the getter.
 */
export interface RecordAccessor {
  readonly key: string
  readonly getter: FunctionId | null
  readonly setter: FunctionId | null
  /**
   * The carrier the member's VALUE has -- what the getter returns and the
   * setter takes.
   *
   * Derived by the same `deriveStored` call a data field's carrier is, off the
   * same member's type, so the two halves of one shape never answer "what does
   * this member hold" differently. It is not part of `representationKey`: two
   * shapes agreeing on key, getter and setter cannot disagree here, because
   * the bodies those ids name are the ones that produce and consume it.
   *
   * A boxed read (`records.ts`'s field dispatcher) needs it. The native read
   * (`emit-properties.ts`) does not -- there the call's own result operand
   * carries the carrier -- which is exactly why this must come from the same
   * derivation rather than a second opinion formed at emission.
   */
  readonly value: Representation
}

export type RecordIndexKey = 'string' | 'number' | 'symbol'

/**
 * A whole numeric property table stores text keys after ToPropertyKey, unlike
 * a numeric sidecar selected from a record's disjoint index signatures. Keep
 * the numeric fast path, but carry other non-Symbol primitives through the
 * table's text protocol. In particular absence names "undefined"/"null";
 * recovering a number would either refuse it or alias a different property.
 */
export const dictionaryKeyDomainOf = (declared: RecordIndexKey, key: Representation): RecordIndexKey => {
  if (declared !== 'number' || (key.kind === 'scalar' && key.domain === 'number')) return declared
  const primitiveText = (value: Representation): boolean => {
    if (value.kind === 'scalar' || value.kind === 'string' || value.kind === 'null' || value.kind === 'undefined' || value.kind === 'void')
      return true
    if (value.kind === 'optional') return primitiveText(value.payload)
    return value.kind === 'tagged-union' && value.arms.length > 0 && value.arms.every((arm) => primitiveText(arm.value))
  }
  return primitiveText(key) ? 'string' : declared
}

/** One native dynamic-property table carried alongside a record's fixed fields. */
export interface RecordIndexSidecar {
  readonly key: RecordIndexKey
  readonly value: Representation
}

/** Exact ECMAScript Number::toString spelling accepted by a number index signature. */
export const isCanonicalNumberPropertyKeyText = (text: string): boolean => {
  const numeric = Number(text)
  return Number.isNaN(numeric) ? text === 'NaN' : String(numeric) === text
}

/** Select the disjoint sidecar addressed by a statically carried property key. */
export const recordIndexForKeyCarrier = (
  indexes: readonly RecordIndexSidecar[],
  key: Representation,
  constantText?: string
): RecordIndexSidecar | null => {
  if (key.kind === 'symbol') return indexes.find((index) => index.key === 'symbol') ?? null
  if (key.kind === 'scalar' && key.domain === 'number')
    return indexes.find((index) => index.key === 'string') ?? indexes.find((index) => index.key === 'number') ?? null
  if (key.kind === 'string') {
    const stringIndex = indexes.find((index) => index.key === 'string')
    if (stringIndex) return stringIndex
    // A number index is a set of PROPERTY KEYS, not a set of finite doubles.
    // Number::toString is the canonicalizer: in particular NaN and both
    // infinities are valid keys, while -0 aliases "0" and "01" is not the
    // canonical spelling of 1.
    const canonical = constantText !== undefined && isCanonicalNumberPropertyKeyText(constantText)
    return canonical ? (indexes.find((index) => index.key === 'number') ?? null) : null
  }
  if (
    key.kind === 'tagged-union' &&
    key.arms.every((arm) => arm.value.kind === 'string' || (arm.value.kind === 'scalar' && arm.value.domain === 'number'))
  )
    return indexes.find((index) => index.key === 'string') ?? null
  return null
}

/**
 * Whether a C++ formal for this carrier is worth spelling `const&` instead of
 * copying it -- the carrier-level ELIGIBILITY the target used to re-derive by
 * testing `cppTypeOf`'s rendered text (`type === 'std::string'`,
 * `type.startsWith('gea::Ref<')`) at up to four separate answerers
 * (a program fact, so it belongs to the IR). A `const-ref` parameter is not
 * necessarily EMITTED as one: per-body safety analysis
 * (`targets/cpp/translation-unit.ts`'s `borrowedFormalsOf`,
 * `targets/cpp/borrowed-call-entry.ts`'s `stableBorrowEntryOf`) still decides
 * whether narrowing to a reference is safe for one specific body's uses --
 * this field is the eligibility gate every one of those checks used a
 * spelling test to answer, not the final declared convention.
 */
export type AbiParameterPassing = 'by-value' | 'const-ref'

/**
 * `passingOf`'s answer for `value` under `ownership` (the ABI's own override
 * for this position, or `null` to ask the carrier's own tier -- mirroring
 * `cppTypeOf`'s optional second argument).
 *
 * `string` and `callable-identity` carry no `ownership` field at all -- a
 * `std::string` always owns its buffer and `gea::Ref<gea::FunctionObjectIdentity>`
 * is `cppTypeOf`'s one hardcoded reference spelling -- so both are named
 * directly rather than falling out of the ownership-tier check below. Every
 * other reference-shaped carrier (`class-ref`, `record`, `record-with-index`,
 * `native-record-ref`, `array-object`, `typed-array`, `array-buffer`,
 * `shared-array-buffer`, `data-view`, `keyed-collection`, `dictionary`) is
 * spelled `gea::Ref<...>` by `cppTypeOf`'s `cppOwnershipWrap` exactly when its
 * effective ownership is `shared-refcount`, which is what `'ownership' in
 * value` plus the tier check reproduces without spelling anything.
 *
 * The one exception this function and `targets/cpp/types.ts`'s
 * `cppAbiParameterType` still apply identically: an ArrayBuffer-family view
 * keeps ITS OWN shared-refcount tier even when a function-value signature
 * stamps the parameter `owned` after publication settled on the standard
 * buffer carrier as shared, because the bytes still have observable reference
 * identity a by-value copy would silently break.
 */
export const passingOf = (value: Representation, ownership: Ownership | null = null): AbiParameterPassing => {
  const aliasing =
    value.kind === 'array-buffer' || value.kind === 'shared-array-buffer' || value.kind === 'data-view' || value.kind === 'typed-array'
  const effective =
    aliasing && value.ownership === 'shared-refcount' && ownership === 'owned'
      ? value.ownership
      : (ownership ?? ('ownership' in value ? value.ownership : null))
  return value.kind === 'string' || value.kind === 'callable-identity' || effective === 'shared-refcount' ? 'const-ref' : 'by-value'
}

/** One physical parameter of a callable ABI. */
export interface AbiParameter {
  readonly value: Representation
  readonly ownership: Ownership
  readonly passing: AbiParameterPassing
}

/** The physical calling convention of one callable. */
export interface CallableAbi {
  readonly parameters: readonly AbiParameter[]
  readonly result: Representation
  /** The receiver carrier, or `null` for a callable that takes no receiver. */
  readonly receiver: Representation | null
  /**
   * The parameter index the trailing arguments are packed into, or `null` for a
   * fixed-arity convention.
   *
   * A rest parameter has no fixed *argument* count, but it does have a fixed
   * *frame*: the language binds it to one Array holding whatever was passed
   * beyond the named parameters. So the slot is ordinary -- an `array-object`
   * like any other -- and what varies is only who builds the array, which is
   * the caller. Saying "no primitive" for that would refuse a convention the
   * language itself defines exactly.
   */
  readonly restFrom: number | null
}

/**
 * The declaration/type identity which closes a native container back onto
 * itself.
 *
 * A recursive record has a natural C++ name already: `native-record-ref`
 * names its structural layout, and a `Ref<Record>` can point at an incomplete
 * forward declaration. A recursive Array, Map, Set, or dictionary does not
 * have such a name: spelling the container inline asks C++ to instantiate
 * `Map<K, Ref<Map<K, ...>>>` forever. The identity here names the one wrapper
 * struct that closes that equation. The outer container carries it as its
 * definition; a marked `native-record-ref` is an explicit back edge. They
 * deliberately have the same representation key and C++ type -- they are two
 * paths to the same native object type, not a widening at the cycle.
 */
export interface RecursiveCarrier {
  readonly type: StructuralTypeId
  /**
   * The native carrier whose wrapper this fixpoint names. `'callable'` is not
   * a container: a signature that mentions itself has no by-reference form to
   * fall back on, so the wrapper struct IS the indirection and it is held by
   * value -- `gea::CallableObject` stores a pointer and a capture, never the
   * parameter types, so naming an incomplete self in its own base is legal.
   */
  readonly container: 'array-object' | 'keyed-collection' | 'dictionary' | 'callable'
  readonly role: 'definition' | 'reference'
}

export type Representation =
  /**
   * Lattice bottom. Not a carrier: it records that selection did not happen.
   * It must fail closed before materialization rather than defaulting.
   */
  | { readonly kind: 'unresolved'; readonly reason: string }
  /**
   * Not a value carrier at all.
   *
   * `never` shares this carrier with `void` because both occupy no storage
   * (`representation/primitives.ts` says why), but they are not the same fact
   * about the FULFILLMENT of a value: `void` is an evaluation that completed
   * with nothing, and `never` is an evaluation that never completes at all.
   * Every carrier decision in the compiler cares only about the storage half
   * and reads `kind === 'void'`; `bottom` is for the handful that must know
   * whether a value can arrive here. `Promise<never> -> Promise<T>` is the
   * standing case: TypeScript admits it at every `T` because the fulfillment
   * channel is never written, while `Promise<void> -> Promise<string>` is a
   * real hole the backend must keep refusing.
   *
   * Deliberately NOT part of `representationKey`, for the same reason
   * `class-ref`'s declaration-local facts are not: the key names the PHYSICAL
   * carrier, and `never` and `void` are the identical nothing. Folding it in
   * would give every program that mentions `never` anywhere a second spelling
   * of one carrier -- the "one value, two carriers" case the key exists to
   * catch -- and would move census node ids for programs whose emitted code
   * is byte-identical.
   */
  | { readonly kind: 'void'; readonly bottom?: true }
  | { readonly kind: 'scalar'; readonly domain: ScalarDomain }
  | { readonly kind: 'string' }
  /**
   * A symbol: a value the language mints, compares only by identity, and uses
   * as a property key no string can collide with.
   *
   * Physically one interned id, because that is all the language lets a
   * program observe of one. `Symbol()` mints a fresh id; `Symbol.for(k)` looks
   * one up in a registry keyed by string, so two calls with the same key are
   * the same symbol and `Symbol('x') !== Symbol('x')` stays true; a well-known
   * symbol is a fixed id. `description` rides along for `toString`, and is not
   * part of identity.
   *
   * There is no separate carrier for a `unique symbol` type. `const GEA_DIRTY
   * = Symbol()` gives that constant its own TYPE -- which is what stops a
   * program from passing one framework key where another is declared -- but a
   * type is not storage, and every one of them holds exactly one id. Deriving
   * them to one carrier is what lets a record field declared `unique symbol`
   * be stored at all.
   */
  | { readonly kind: 'symbol' }
  | { readonly kind: 'null' }
  | { readonly kind: 'undefined' }
  /**
   * A nominal class reference with exact class and ownership authority.
   *
   * `shapeId` names the instance's structure in the sealed structural table,
   * the same way `native-record-ref` does: the class stays the carrier so a
   * field typed as its own class has a finite carrier, and the layout is read
   * back from the table at emission rather than expanded here.
   *
   * Deliberately NOT part of `representationKey`, for the same reason
   * `ancestors` below is not: a class is NOMINAL, `projection/classes.ts` gives
   * each class DECLARATION exactly one `ClassLayout`, and `cppTypeOf` spells a
   * `class-ref` as `cppClassName(declaration)` with the shape playing no part.
   * Two instantiations of one generic class therefore have one physical
   * carrier, and folding the shape in gave that carrier two spellings -- the
   * "one value, two carriers" case this key exists to CATCH, arrived at from
   * the other side. hono is the measured case: `Context.notFound` reads
   * `#notFoundHandler: NotFoundHandler<E>` -- a callable over `Context<E>`,
   * which is `Context<E, any, BlankInput>` once the class's later parameters
   * take their defaults -- and the narrowed read in a monomorphized copy
   * spells the same class through its own instantiation. Identical carriers
   * apart from the shape, so the `optional(F) -> F` narrowing every other
   * defaulted field gets had no recipe and certification refused the read.
   *
   * `ancestors` is every class this one inherits from, transitively
   * (`semantics/class-heritage.ts`), carried ON the carrier rather than looked
   * up through a policy. Two questions need it and neither has anywhere else
   * to ask: whether a handle declared at a base may be READ at a descendant
   * (`instanceof` narrowing, `emit-narrowing.ts`) and whether one may be
   * STORED as a base (an upcast). Both are asked from pure carrier-to-carrier
   * functions with no compilation context to thread a policy through, and the
   * answer is a fact about the class itself, not about the target -- so it
   * belongs here, stated once by the one site that derives a `class-ref` at
   * all. Deliberately NOT part of `representationKey`: the declaration
   * already identifies the class, so two carriers agreeing on it agree on
   * this too.
   */
  | {
      readonly kind: 'class-ref'
      readonly declaration: DeclarationId
      readonly shapeId: string
      readonly ownership: Ownership
      readonly ancestors: readonly DeclarationId[]
    }
  /**
   * A host handle admitted only by a versioned host protocol.
   *
   * `call`/`construct` are the handle's own `[[Call]]`/`[[Construct]]`
   * conventions when the checker gave its type one -- `null` for a handle
   * that has neither (`Math`), or whose overload set has no single physical
   * frame to join (`DateConstructor`'s four `new` overloads: no primitive
   * unifies "no args", "a timestamp", and "year, month, date, ..." into one
   * ABI, so `construct` is `null` there even though the checker's type does
   * declare construct signatures). This is deliberately the SAME carrier a
   * data-only handle gets, not a second kind: a host protocol's members and
   * its own call/construct convention are two facts about one handle, and a
   * type can have either, both, or neither -- `Math` has neither, `Date`
   * has member methods (`now`) plus an unjoinable construct set, and `Error`
   * has both a joinable construct signature and no interesting members.
   * Property access (`emit-properties.ts`'s `nativeHandleMemberText`) reads
   * only `protocol`/`kind`, never `call`/`construct`, so a handle whose
   * checker type merges call/construct signatures with named members --
   * `DateConstructor` also declares `now`/`parse`/`UTC` -- keeps exactly the
   * member access it already had; nothing here can take that away, because
   * `targets/cpp/types.ts`'s `native-handle` spelling never reads these two
   * fields either. Only `emitCall`/`emitConstruct` in `targets/cpp/emit.ts`
   * read them, to invoke the handle itself rather than one of its members.
   */
  | {
      readonly kind: 'native-handle'
      readonly protocol: string
      readonly version: number
      /**
       * The host's own name for the type it carries this protocol's values in,
       * when the plugin that installs the protocol stated one
       * (`PluginCapabilities.nativeTypes`); `null` when it did not.
       *
       * A host's name for its own type, not a target spelling invented here --
       * which is why it belongs on a target-neutral carrier: a backend spells it
       * verbatim (`targets/cpp/types.ts`) rather than deriving one from
       * `protocol`, and a protocol with no stated carrier keeps the opaque
       * tagged handle. It is also the join key `preflight/run.ts` claims against
       * and `emit-properties.ts` looks members up by, so the many declared names
       * that share one runtime type share one claim and one member table.
       */
      readonly native: string | null
      /**
       * Every host carrier this one derives from, transitively, as the host
       * states it (`PluginCapabilities.nativeBases`) -- nearest base first,
       * empty for a handle whose host stated no inheritance and for one with
       * no carrier at all.
       *
       * `class-ref`'s `ancestors` one carrier kind over, for the identical
       * reason. An `NSStackView` IS an `NSView`: the generated bridge gives
       * the wrapper structs that same inheritance, so storing one where the
       * other is declared is the language's own derived-to-base rule with no
       * text of its own. Nothing in TypeScript's structural view says so --
       * two opaque handles are unrelated to the checker whatever the host's
       * hierarchy says -- so the fact has to be carried, and it has to be
       * carried HERE: the question "may this be STORED as that" is asked by
       * pure carrier-to-carrier functions (the conversion chain, and through
       * it the census that mints the node the certificate names) which have
       * no compilation context to thread a host table through. Before this,
       * the host table reached only the emitter, so the printer rendered an
       * upcast the census had already refused by name and no program using
       * one ever got that far.
       *
       * Keyed by the host's own carrier name, the same join key `native` is,
       * so the many declared names that share one runtime type share one
       * chain. A handle with no stated carrier is related to nothing: a host
       * that named no C++ type for a protocol has said nothing about that
       * protocol's place in a hierarchy either. Deliberately NOT part of
       * `representationKey`: the carrier already identifies the host type, so
       * two carriers agreeing on it agree on this too.
       */
      readonly bases: readonly string[]
      readonly call: CallableAbi | null
      readonly construct: CallableAbi | null
    }
  | {
      readonly kind: 'record'
      readonly shapeId: string
      readonly fields: readonly RecordField[]
      /** Members read and written by calling a body rather than by touching storage. */
      readonly accessors: readonly RecordAccessor[]
      readonly ownership: Ownership
    }
  /**
   * A record whose declared shape has named members *and* an index signature
   * over string, number, or symbol keys -- `interface Style { width?: number;
   * [key: string]: unknown }`, `interface Sparse { count: number; [index:
   * number]: string }`, or `interface States { name: string; [key: symbol]:
   * State }`.
   *
   * The named members are a struct layout; each disjoint index domain is a
   * dictionary over everything else. Neither half may stand in for the other: collapsing
   * the whole carrier to `dictionary` would turn `style.width` into a hash
   * lookup for a field that has a fixed offset, and refusing the shape outright
   * (the previous answer) throws away the struct half over a dictionary half
   * that is genuinely open. `indexes` states what every dynamic-keyed property
   * beyond `fields` carries and which key domain addresses it; the emitted
   * layout (`targets/cpp/records.ts`) is the named fields plus native sidecar
   * members -- `gea::Dictionary<V>` for string keys,
   * `gea::NumericDictionary<V>` for number keys, and
   * `gea::SymbolDictionary<V>` for symbol keys -- the
   * same shape `gea::runtime::regex::Pattern`'s
   * dynamic-property sidecar gives a native type that also needs arbitrary
   * properties -- this is that idea at the carrier level, for an ordinary
   * struct instead of a native handle.
   */
  | {
      readonly kind: 'record-with-index'
      readonly shapeId: string
      readonly fields: readonly RecordField[]
      /**
       * Canonical, disjoint JS property-key domains. String and number may be
       * represented by one string-keyed table when their value carriers agree;
       * symbols always retain their own identity-keyed table.
       */
      readonly indexes: readonly RecordIndexSidecar[]
      readonly ownership: Ownership
    }
  /** A Proxy carries target, handler, and revoked state -- not the target alone. */
  | { readonly kind: 'proxy-object'; readonly target: Representation; readonly handler: Representation }
  /**
   * A reference to a natively laid-out record, named by shape rather than
   * expanded. This is what carries a declared type: expanding a name whose body
   * refers back to itself has no finite carrier, so the name stays the carrier
   * and the layout is resolved from the sealed structural table at emission.
   * `ownership` states the lifetime; `borrowed` means an external owner.
   */
  | {
      readonly kind: 'native-record-ref'
      readonly shapeId: string
      readonly ownership: Ownership
      /**
       * The C++ struct this record IS, when a host declared it, or `null`
       * for one this compiler lays out itself. A stated name means the
       * definition is the host's -- `records.ts` emits no struct for it --
       * while the layout still derives, so a field this compiler cannot
       * carry refuses instead of reaching C++ as a member that is not there.
       */
      readonly native: string | null
      /**
       * An indirection to a compiler-minted recursive container wrapper.
       * `native` is a non-null private marker in this case so record emission
       * never tries to lay this container out as a record; C++ spelling reads
       * this identity rather than that marker text.
       */
      readonly recursive?: RecursiveCarrier
    }
  | { readonly kind: 'borrowed-ref'; readonly referent: Representation }
  /** A JavaScript-observable Array: holes, index keys, `length` semantics. */
  | {
      readonly kind: 'array-object'
      readonly element: Representation
      readonly ownership: Ownership
      /** Present only where this Array is the body of a recursive type equation. */
      readonly recursive?: RecursiveCarrier
      /**
       * The typed fields an interface ADDS to the Array it extends --
       * TypeScript's `NodeArray<T> extends ReadonlyArray<T>, ReadonlyTextRange`
       * puts `pos`, `end`, `hasTrailingComma` on every node list -- or `null`
       * for a plain array. The C++ type is the same `gea::ArrayObject<E>`
       * either way: the fields live in the array's own extension sidecar
       * (`ArrayObject::extensionFields`), typed by a generated struct
       * (`records.ts`'s `arrayExtensionDeclarations`), so a plain array cast
       * to the interface (`elements.slice() as MutableNodeArray<T>`) is the
       * SAME object and converts by identity (`conversions.ts`). Part of the
       * carrier's identity because a property read has to know the layout;
       * keyed by the FIELDS, not the interface, so `MutableNodeArray<T>` and
       * `NodeArray<T>` -- one object under two spellings -- are one carrier.
       */
      readonly extension: readonly RecordField[] | null
    }
  /** Compiler/runtime-private dense storage. Never a JavaScript-observable Array. */
  | { readonly kind: 'dense-buffer'; readonly element: Representation }
  /**
   * A flat, fixed-element-width numeric buffer -- `Uint8Array`, `Int32Array`,
   * `Float64Array` and the rest of the eight standard TypedArray views. Not
   * `dense-buffer`: that kind is compiler-private storage with no JavaScript
   * identity and no producer anywhere in `derive.ts`; a typed array IS a
   * JavaScript-observable value with its own indexed get/set truncation
   * rules (ECMA-262 23.2), so it is a third, distinct kind rather than a
   * spelling of either `array-object` (which has holes and an
   * ordinary-property domain a typed array does not have) or `dense-buffer`.
   */
  | {
      readonly kind: 'typed-array'
      readonly element: TypedArrayElementDomain
      /** The checker-resolved ArrayBufferLike parameter; Atomics needs this distinction. */
      readonly buffer: 'array-buffer' | 'shared-array-buffer'
      readonly ownership: Ownership
    }
  /**
   * ECMA-262 25.1's `ArrayBuffer`: a fixed-length block of BYTES with no
   * element type of its own, which every typed array and every `DataView` is a
   * VIEW over.
   *
   * Its own kind rather than `typed-array(uint8)`, for the reason those two
   * differ observably: an ArrayBuffer has no indexed access at all (`b[0]` is
   * `undefined`, not a byte), no `length`, and no element width -- while
   * `new Uint8Array(b)` and `new Uint8Array(u8)` are two DIFFERENT constructor
   * overloads whose results share bytes in the first case and copy in the
   * second. Collapsing the two onto one carrier would make the emitter unable
   * to tell those overloads apart, which is the silent-wrong-answer shape the
   * whole typed-array family is about.
   *
   * Not `dense-buffer` either, and for exactly the reason `typed-array`'s own
   * comment above gives: `dense-buffer` is compiler-private storage that
   * `representation/verify.ts` refuses in any observable position, and an
   * ArrayBuffer is a JavaScript value a program holds, passes and reads
   * `byteLength` off.
   *
   * The physical carrier is the SAME `std::shared_ptr<std::vector<uint8_t>>`
   * `gea::TypedArray` already stores its bytes behind (`gea::ArrayBuffer` is
   * an alias of that vector), which is what makes aliasing real rather than
   * simulated: `view.buffer` hands back the very block the view reads, and a
   * write through either is seen by the other.
   */
  | { readonly kind: 'array-buffer'; readonly ownership: Ownership }
  /** A fixed-length concurrent byte block, distinct from ArrayBuffer. */
  | { readonly kind: 'shared-array-buffer'; readonly ownership: Ownership }
  /**
   * ECMA-262 25.3's `DataView`: a VIEW over an `ArrayBuffer` whose element
   * width and BYTE ORDER are chosen per access rather than fixed by the view's
   * own type.
   *
   * That is exactly what makes it a separate kind from `typed-array` rather
   * than a spelling of it. A typed array's element type IS the view's type --
   * `Int32Array` reads `int32` at native byte order, always -- while
   * `view.getInt32(0)` and `view.getInt32(0, true)` read the SAME bytes as two
   * different numbers, and `getFloat64`/`getUint8` read them as two more. A
   * carrier parameterized by one element could not state that; there is no
   * element to parameterize on.
   */
  | { readonly kind: 'data-view'; readonly ownership: Ownership }
  /** A storage snapshot, which is not an ECMAScript Array identity. */
  | { readonly kind: 'native-sequence'; readonly element: Representation }
  /**
   * The iteration cursor `gea::Iterator<E, TReturn, TNext>` (`runtime/gea_runtime.h`).
   *
   * `source` says which of the two things that can build one built THIS one --
   * `'generator'` for a `function*`'s own `Generator<T, TReturn, TNext>`
   * (`representation/derive.ts`'s `GeneratorDeclarationPolicy`), `'sequence'`
   * for the four fixed-storage walks (`Array`/`Set`/`string`/`Map`, plus the
   * `for`-`in` enumerator and static-tuple walk) that need no `[Symbol.
   * iterator]` lookup at all (`publish.ts`'s `nativeCursorIteratorOf`). The
   * distinction is not cosmetic: only a generator's own cursor has a
   * `%GeneratorPrototype%.return`/`.throw` to call (ECMA-262 27.5.1) --
   * `%ArrayIteratorPrototype%` and its three siblings define neither -- so
   * `manifest/capabilities.ts` and `prototype/emit-prototype-iterator.ts`
   * gate those two members on `source === 'generator'` rather than certifying
   * them for a receiver that carries this same physical cursor type but was
   * never actually a generator.
   *
   * `resume`/`completion` are what `next(v)`/a `return v` inside the body
   * actually store -- the resume channel (`TNext`) and the completion value
   * (`TReturn`) of `Generator<T, TReturn, TNext>`. Both default to
   * `{ kind: 'undefined' }` for every `'sequence'` source (none of the four
   * fixed walks, nor `for`-`in`, ever resumes with a value or completes with
   * one) and for a generator whose own `TReturn`/`TNext` did not derive to a
   * concrete native carrier -- collapsed there rather than left as whatever
   * `deriveStored` answered, because this cursor has no boxed slot to store a
   * `dynamic`/`unresolved` value in (the "never box a typed value" rule cuts
   * the same way here as everywhere else): a generator whose `next(v)`/
   * completion value is read anyway is refused downstream, by name, exactly
   * as reading `undefined`'s own (nonexistent) members already is.
   */
  | {
      readonly kind: 'iterator'
      readonly element: Representation
      readonly resume: Representation
      readonly completion: Representation
      readonly source: 'generator' | 'sequence'
    }
  | { readonly kind: 'promise'; readonly value: Representation }
  /**
   * One of the language's four keyed collections -- `Map<K, V>`, `Set<T>`,
   * `WeakMap<K, V>`, `WeakSet<T>` -- carried over the CONCRETE key and value
   * carriers the checker proved, never over a boxed element.
   *
   * This is the port of v1's `gea_cpp_typed_js_map<Key, Value>` /
   * `gea_cpp_typed_js_set<Key>` (`targets/cpp/runtime/value_11_collections.h`
   * there): a keyed collection is a distinct physical thing from every kind
   * already here, and none of them can stand in for it. `dictionary` is a
   * string- or number-keyed table with no insertion order, no identity of its
   * own, and no key domain beyond those two -- a `Map<Store, Observer>` has
   * none of that. `record` is a fixed field set. `array-object` is
   * index-keyed with holes. Collapsing a Map onto any of them would be the
   * same silent widening the no-boxing rule forbids, one level up.
   *
   * `value` is `null` for the two set families and never for the two map
   * families: a Set stores keys only, and giving it a payload slot that is
   * never read would be a carrier claiming storage that does not exist.
   *
   * `family` distinguishes strong from weak because the C++ type differs, not
   * because the weakness is observable: this runtime has no garbage collector
   * to collect a weakly-held key, so `gea::WeakMap`/`gea::WeakSet` are
   * pointer-keyed maps that hold their keys ALIVE. See their doc comments in
   * `runtime/gea_runtime.h` -- the difference from the strong families is the
   * key EQUALITY rule (reference identity, so only a carrier with pointer
   * identity may be a weak key), not the lifetime.
   *
   * Neither `key` nor `value` may be `unresolved`: that is lattice bottom, so
   * a collection over it could not state what it stores. Both MAY be
   * `dynamic`, and the distinction is the whole point -- a position the
   * program itself declared `any`/`unknown` and never narrowed is a genuine
   * dynamic boundary with a real carrier, not an unknown shape, and
   * `Map<string, any>` gets that carrier rather than a refusal. What is
   * forbidden is the widening: a key or value the checker DID type stays that
   * type, so `Map<string, Effect>` is never a map of boxes. See
   * `collections.ts` for the derivation and `runtime/gea_runtime.h`'s
   * `sameValueZero<Value>` / `canonicalKey<Value>` / `weakKeySame<Value>` for
   * how a dynamic key still gets the exact ECMA-262 comparisons.
   */
  | {
      readonly kind: 'keyed-collection'
      readonly family: 'map' | 'set' | 'weak-map' | 'weak-set'
      readonly key: Representation
      /** The payload carrier for the two map families; `null` for the two set families, which store keys only. */
      readonly value: Representation | null
      readonly ownership: Ownership
      /** Present only where this collection is the body of a recursive type equation. */
      readonly recursive?: RecursiveCarrier
    }
  /**
   * An object shape with no named members, carried entirely by its own index
   * signature -- `interface StringCounts { [key: string]: number }` or the
   * number-keyed `interface Sparse { [index: number]: string }`. `key` states
   * the domain the lookup is keyed by, and `targets/cpp/types.ts` spells the
   * two domains as two distinct runtime containers (`gea::Dictionary<V>` /
   * `gea::NumericDictionary<V>`) rather than coercing one key domain into the
   * other's storage.
   */
  | {
      readonly kind: 'dictionary'
      readonly key: 'string' | 'number' | 'symbol'
      readonly value: Representation
      readonly ownership: Ownership
      /** Present only where this dictionary is the body of a recursive type equation. */
      readonly recursive?: RecursiveCarrier
    }
  | { readonly kind: 'function'; readonly functionId: FunctionId; readonly abi: CallableAbi }
  /** A closed, authenticated family of callables sharing one joined ABI. */
  | { readonly kind: 'function-family'; readonly members: readonly FunctionId[]; readonly abi: CallableAbi }
  | { readonly kind: 'constructor-family'; readonly members: readonly DeclarationId[]; readonly abi: CallableAbi }
  /**
   * A constructor whose class is not proven, carried by its convention.
   *
   * The exact counterpart of `function-value-dispatch`: `new () => Component`
   * states what `[[Construct]]` takes and returns without naming which class
   * implements it, so the carrier is the construct pointer, not a member set.
   * Collapsing it into `constructor-family` with an empty member list would
   * claim a closed family of nothing.
   */
  | { readonly kind: 'constructor-value-dispatch'; readonly abi: CallableAbi }
  /**
   * A function object with both `[[Call]]` and `[[Construct]]`.
   *
   * `Number`, `Date`, and every other built-in constructor really are both, and
   * the two conventions differ: `Number(x)` returns a number, `new Number(x)`
   * returns an object. One carrier holding one ABI cannot say which a site
   * selected, and picking either would make the other silently wrong.
   */
  | { readonly kind: 'function-and-constructor'; readonly call: CallableAbi; readonly construct: CallableAbi }
  | {
      readonly kind: 'function-value-family'
      readonly members: readonly FunctionId[]
      readonly abi: CallableAbi
      readonly optional: boolean
    }
  | {
      readonly kind: 'function-value-dispatch'
      readonly abi: CallableAbi
      /** Present only where this signature is the body of a recursive type equation. */
      readonly recursive?: RecursiveCarrier
    }
  /**
   * Which of a closed set of GENERIC source functions a cell holds.
   *
   * `const setOriginal = flags & NoOriginalNode ? identity : setOriginalNode`
   * holds one of two generic functions; neither has a frame until a call
   * instantiates it, so no `CallableObject` can carry the choice. The tag
   * can: a `std::uint8_t` indexing `members` (sorted declaration ids, the
   * order `genericFunctionSetMembersOf` states). A reference to a member is
   * the constant index; a call through the cell is a `closed-family`
   * invocation whose targets are the copies that call instantiates, one per
   * member, dispatched on the tag (`ir/lower-invocation.ts`,
   * `emit-callable.ts`). Widening into a superset remaps the index.
   */
  /**
   * A function VALUE with no calling convention: storable, passable and
   * comparable, but not callable.
   *
   * `(...args: never[]) => void` -- TypeScript's `AnyFunction`, and tsc's own
   * (`core.ts`) -- is not a convention at all. `never` is uninhabited, so no
   * call through such a slot can supply an argument, and the type exists to say
   * "some function, which nobody here calls": tsc passes it straight to
   * `Error.captureStackTrace`. Giving it a frame is where the silent miscompile
   * lives -- a concrete `f(a, b, c)` converted into a zero-argument frame
   * compiles and then runs with garbage the first time anyone calls it.
   *
   * The carrier is the identity half every callable already owns:
   * `gea::CallableObject` holds a `Ref<FunctionObjectIdentity>` alongside its
   * thunk, so converting any callable into this is a field read, not a
   * fabrication. A CALL through it has no convention to use and is refused --
   * loudly, at emission, which is the correct answer for a program that calls
   * a value whose own type says it takes no arguments.
   */
  | { readonly kind: 'callable-identity' }
  | { readonly kind: 'generic-function-set'; readonly members: readonly DeclarationId[] }
  /**
   * An optional payload with an exact absence tag.
   *
   * `absence` names *which* of the language's two absent values the flag stands
   * for. It has to: `x === null` and `x === undefined` are different questions
   * with different answers over the same `gea::Optional<T>`, and a carrier that
   * only said "absent" would leave a backend guessing which one -- a silently
   * wrong branch rather than a refusal. A union carrying *both* absent values
   * is not an optional at all (`derive.ts`'s `deriveUnion` builds a tagged
   * union for it), so one tag is always enough.
   */
  | { readonly kind: 'optional'; readonly payload: Representation; readonly absence: 'null' | 'undefined' }
  /** A sum whose arms are proven pairwise disjoint at runtime. */
  | { readonly kind: 'tagged-union'; readonly arms: readonly TaggedUnionArm[] }
  /** The boxed carrier. Admissible only for one of the four reasons above. */
  | { readonly kind: 'dynamic'; readonly reason: DynamicReason }

/** One arm of a tagged union, with the discriminator that selects it. */
export interface TaggedUnionArm {
  readonly tag: string
  readonly value: Representation
  /** The semantic type this arm covers, so member census can be checked complete. */
  readonly semanticType: StructuralTypeId
  /**
   * The runtime fact that separates this arm from another arm with the same
   * JavaScript tag and physical C++ payload.
   *
   * A closed callable family is authenticated by source FunctionId.  An
   * evaluated callable ABI without a closed family is explicitly
   * unverifiable: payload type equality proves only a calling convention, not
   * which function the checker admitted.  Keeping that refusal on the arm --
   * and therefore in `representationKey` -- prevents a union from silently
   * changing identity when two declarations happen to share one ABI.
   * A broad, already-dynamic `Function` arm is different: it claims every
   * callable and retains the boxed Value without inventing an ABI.  Its
   * `callable-tag` discriminator is therefore sufficient only when no other
   * arm also answers to the Function tag; the shared union classifier rejects
   * such an overlap.
   */
  readonly runtimeDiscriminator:
    | { readonly kind: 'carrier' }
    | { readonly kind: 'callable-tag' }
    | { readonly kind: 'callable-membership'; readonly members: readonly FunctionId[] }
    | { readonly kind: 'unverifiable-callable' }
}

/** The container variants which can name a recursive native wrapper. */
export type RecursiveContainerRepresentation = Extract<
  Representation,
  { readonly kind: 'array-object' | 'keyed-collection' | 'dictionary' | 'function-value-dispatch' }
>

/**
 * The fixpoint identity a carrier participates in, or `null` for an ordinary
 * acyclic container. Kept in the model so derivation, verification, and the
 * C++ spelling read the same fact instead of each inferring recursion from a
 * traversal of their own.
 */
export const recursiveCarrierOf = (representation: Representation): RecursiveCarrier | null => {
  switch (representation.kind) {
    case 'array-object':
    case 'keyed-collection':
    case 'dictionary':
    case 'function-value-dispatch':
      return representation.recursive ?? null
    case 'native-record-ref':
      return representation.recursive ?? null
    default:
      return null
  }
}

/**
 * A stable key for a representation.
 *
 * Two carriers are the same carrier exactly when their keys match. This is used
 * to detect the case the architecture forbids outright: one value published
 * with two different carriers in two endpoints.
 */
/**
 * Keys already built, by the carrier object that produced them.
 *
 * A carrier is immutable -- every field of every variant is `readonly`, and
 * nothing in this compiler writes one after it is constructed -- so a key is a
 * function of the object's identity and may be remembered by it. That is worth
 * remembering because the key is recursive and inlines its whole subject: the
 * deepest one a measured application produced was 26,467 characters, a
 * `record-with-index` carrying an entire host object's shape, and it was rebuilt
 * from nothing on every call. The same measurement found 112,276 selected
 * results resolving to 2,660 distinct carrier objects, so all but ~2% of the
 * calls ask for a key that already exists.
 *
 * A `WeakMap` rather than a `Map` because the carriers outlive nothing: they
 * belong to the plan, and a strong table here would keep every carrier of every
 * compilation alive for the life of the process.
 */
const keysByRepresentation = new WeakMap<Representation, string>()
const abiKeys = new WeakMap<CallableAbi, string>()

/**
 * How a nested carrier contributes to its parent's key.
 *
 * ⛔ This used to be the child's WHOLE key, spliced in as text -- which makes a
 * key a tree serialization of a graph, and that is not merely wasteful, it does
 * not terminate at any useful size. mongodb's `Filter` carrier has three fields
 * that each contain the next level, so every level TRIPLED its parent's key:
 * measured at 1,191 characters at the innermost level, 11 MB eight levels up,
 * 299 MB three levels above that, and then `Array.join` threw
 * `RangeError: Invalid string length` -- V8 caps a string at 536,870,888
 * characters and the full key would have been ~17 GB. The compile died with a
 * stack trace naming a template literal, in a compiler whose whole discipline
 * is to refuse with a reason.
 *
 * `structural-self-reference.ts` closes that particular cycle, so no carrier
 * SHOULD be that deep any more. This is the other half, and it is the half that
 * holds for every future target and every future program: a key is now bounded
 * by the carrier's OWN field count, never by the size of the graph beneath it.
 * Any two distinct sub-carriers still give distinct parent keys -- the digest is
 * over the child's own full key, so a difference anywhere below propagates up
 * through every enclosing digest, exactly as a Merkle chain does.
 *
 * The digest is prefixed with what it stands for (`record#type|1041@a3f9...`)
 * rather than left opaque. A key is read by people: it names the missing
 * primitive in every unmet-obligation row the compass prints, and an obligation
 * that says only `k9f2c...` would trade one unreadable report (8 KB of inlined
 * header fields on ONE line, which is what this produced for hono's `Context`)
 * for another.
 */
// `GEA_FULL_KEYS` prints every nested key in full: a digest names WHICH union a
// refusal is about, never what its arms are, and finding the arm a merge could
// not reach needs the arms. Read once at load, so the keys are the same
// everywhere in one run.
const nestedKeyLimit = process.env['GEA_FULL_KEYS'] ? Number.POSITIVE_INFINITY : 80

// Memoized beside `keysByRepresentation`, and for the same reason: the digest
// is a pure function of the carrier, and a parent key asks for it once per
// field on every rebuild of a parent that is not itself remembered yet. On
// TypeScript's own compiler the digest, not the walk, was half the cost of
// keying a union's arms.
const nestedKeys = new WeakMap<Representation, string>()

const nestedKey = (representation: Representation): string => {
  const remembered = nestedKeys.get(representation)
  if (remembered !== undefined) return remembered
  const own = representationKey(representation)
  const built = own.length <= nestedKeyLimit ? own : digestedKey(representation, own)
  nestedKeys.set(representation, built)
  return built
}

const digestedKey = (representation: Representation, own: string): string => {
  const shaped = 'shapeId' in representation ? representation.shapeId : undefined
  const label = shaped === undefined ? representation.kind : `${representation.kind}#${shaped}`
  return `${label}@${createHash('sha256').update(own).digest('hex').slice(0, 16)}`
}

/**
 * The extension half of an `array-object` key: empty for a plain array, so
 * every key written before extensions existed is unchanged, and the field
 * list -- name, requiredness, carrier -- for an extended one. Exported so the
 * emitter names the generated struct by the same identity the carrier has.
 */
export const arrayExtensionKey = (extension: readonly RecordField[] | null): string =>
  extension === null
    ? ''
    : `,{${extension.map((field) => `${field.key}${field.required ? '' : '?'}:${representationKey(field.value)}`).join(',')}}`

export const representationKey = (representation: Representation): string => {
  const remembered = keysByRepresentation.get(representation)
  if (remembered !== undefined) return remembered
  const built = buildRepresentationKey(representation)
  keysByRepresentation.set(representation, built)
  return built
}

const buildRepresentationKey = (representation: Representation): string => {
  const recursive = recursiveCarrierOf(representation)
  // A recursive carrier is a graph node, not a tree. Its structural identity
  // is the full key: descending into its children would serialize the cycle
  // forever, while replacing it with a digest would hide the declaration/type
  // identity which proves the two paths carry the same native object.
  if (recursive) {
    switch (representation.kind) {
      case 'array-object':
      case 'keyed-collection':
      case 'dictionary':
        return `recursive(${recursive.type},${recursive.container},${representation.ownership})`
      case 'native-record-ref':
        return `recursive(${recursive.type},${recursive.container},${representation.ownership})`
      // A callable wrapper is one by-value struct, so its ownership is fixed
      // rather than carried. It is still spelled, because the back edge and
      // the definition must key IDENTICALLY -- that identity is what proves a
      // parameter bound from the reference and an ABI spelled from the
      // definition name the same physical object.
      case 'function-value-dispatch':
        return `recursive(${recursive.type},${recursive.container},owned)`
      default:
        throw new Error(`recursive marker appeared on non-container ${representation.kind}`)
    }
  }
  switch (representation.kind) {
    case 'unresolved':
      return `unresolved(${representation.reason})`
    case 'void':
    case 'string':
    case 'symbol':
    case 'null':
    case 'undefined':
      return representation.kind
    case 'scalar':
      return `scalar(${representation.domain})`
    case 'class-ref':
      return `class-ref(${representation.declaration},${representation.ownership})`
    case 'native-handle':
      // `call`/`construct` are folded into the key -- omitting them would let
      // two handles of the same protocol that disagree on invocability
      // collide under one key, which is exactly the "one value, two carriers"
      // case `representationKey` exists to catch.
      return (
        `native-handle(${representation.protocol}@${representation.version}` +
        `;call=${representation.call ? abiKey(representation.call) : '-'}` +
        `;construct=${representation.construct ? abiKey(representation.construct) : '-'})`
      )
    case 'record':
      return `record(${representation.shapeId},${representation.ownership},${representation.fields
        .map((field) => `${field.key}${field.required ? '' : '?'}:${nestedKey(field.value)}`)
        .join(
          ','
        )};${representation.accessors.map((accessor) => `${accessor.key}=${accessor.getter ?? '-'}/${accessor.setter ?? '-'}`).join(',')})`
    case 'record-with-index':
      return `record-with-index(${representation.shapeId},${representation.ownership},${representation.fields
        .map((field) => `${field.key}${field.required ? '' : '?'}:${nestedKey(field.value)}`)
        .join(',')};${representation.indexes.map((index) => `index[${index.key}]=${nestedKey(index.value)}`).join(';')})`
    case 'proxy-object':
      return `proxy-object(${nestedKey(representation.target)},${nestedKey(representation.handler)})`
    case 'native-record-ref':
      return `native-record-ref(${representation.shapeId},${representation.ownership},${representation.native ?? ''})`
    case 'borrowed-ref':
      return `borrowed-ref(${nestedKey(representation.referent)})`
    case 'array-object':
      return `array-object(${nestedKey(representation.element)},${representation.ownership}${arrayExtensionKey(representation.extension)})`
    case 'dense-buffer':
      return `dense-buffer(${nestedKey(representation.element)})`
    case 'typed-array':
      return `typed-array(${representation.element},${representation.buffer},${representation.ownership})`
    case 'array-buffer':
      return `array-buffer(${representation.ownership})`
    case 'shared-array-buffer':
      return `shared-array-buffer(${representation.ownership})`
    case 'data-view':
      return `data-view(${representation.ownership})`
    case 'native-sequence':
      return `native-sequence(${nestedKey(representation.element)})`
    case 'iterator':
      return `iterator(${nestedKey(representation.element)})`
    case 'promise':
      return `promise(${nestedKey(representation.value)})`
    case 'keyed-collection':
      return (
        `keyed-collection(${representation.family},${nestedKey(representation.key)},` +
        `${representation.value ? nestedKey(representation.value) : '-'},${representation.ownership})`
      )
    case 'dictionary':
      return `dictionary(${representation.key},${nestedKey(representation.value)},${representation.ownership})`
    case 'function':
      return `function(${representation.functionId},${abiKey(representation.abi)})`
    case 'function-family':
      return `function-family(${[...representation.members].sort().join('+')},${abiKey(representation.abi)})`
    case 'constructor-family':
      return `constructor-family(${[...representation.members].sort().join('+')},${abiKey(representation.abi)})`
    case 'constructor-value-dispatch':
      return `constructor-value-dispatch(${abiKey(representation.abi)})`
    case 'function-and-constructor':
      return `function-and-constructor(${abiKey(representation.call)},${abiKey(representation.construct)})`
    case 'function-value-family':
      return `function-value-family(${[...representation.members].sort().join('+')},${abiKey(representation.abi)},${representation.optional})`
    case 'function-value-dispatch':
      return `function-value-dispatch(${abiKey(representation.abi)})`
    case 'callable-identity':
      return 'callable-identity'
    case 'generic-function-set':
      return `generic-function-set(${representation.members.join('+')})`
    case 'optional':
      return `optional(${nestedKey(representation.payload)},${representation.absence})`
    case 'tagged-union':
      return `tagged-union(${representation.arms
        .map((arm) => {
          const discriminator =
            arm.runtimeDiscriminator.kind === 'callable-membership'
              ? `callable(${[...arm.runtimeDiscriminator.members].sort().join('+')})`
              : arm.runtimeDiscriminator.kind
          return `${arm.tag}:${discriminator}:${nestedKey(arm.value)}`
        })
        .join('|')})`
    case 'dynamic':
      return `dynamic(${representation.reason})`
  }
}

/** A stable key for a calling convention. */
export const abiKey = (abi: CallableAbi): string => {
  const remembered = abiKeys.get(abi)
  if (remembered !== undefined) return remembered
  const built = buildAbiKey(abi)
  abiKeys.set(abi, built)
  return built
}

const buildAbiKey = (abi: CallableAbi): string =>
  `(${abi.parameters.map((parameter) => `${nestedKey(parameter.value)}/${parameter.ownership}`).join(',')}` +
  `${abi.restFrom === null ? '' : `|rest@${abi.restFrom}`})` +
  `->${nestedKey(abi.result)}` +
  `@${abi.receiver ? nestedKey(abi.receiver) : '-'}`

/**
 * Whether a carrier boxes a value that has a static type.
 *
 * Used by the no-boxing gate. `dynamic` is legitimate only for the four
 * declared reasons; every other appearance is a defect to fix at the producer.
 */
export const isBoxed = (representation: Representation): boolean => representation.kind === 'dynamic'

/**
 * Every carrier kind ECMAScript's `ToBoolean` can never answer `false` for.
 *
 * Each of these is, in every shape this compiler ever selects for it, a JS
 * Object or a callable -- and an Object is truthy regardless of its contents,
 * empty array, empty record and zero-argument callable included. `native-
 * handle` is deliberately absent even though it is also object-shaped: a host
 * handle self-encodes its own absence as an invalid state
 * (`representation/optional.ts`'s collapse of `T | null` onto one), which
 * *is* a falsy state this fact must not claim away. `tagged-union` is absent
 * from the set itself and handled by recursion in `isDeadMergeContribution`
 * below, because whether one can be falsy depends on its arms, not its kind.
 */
const alwaysTruthyKinds: ReadonlySet<Representation['kind']> = new Set([
  'record',
  'record-with-index',
  'native-record-ref',
  'array-object',
  'dictionary',
  'typed-array',
  'promise',
  // A Map/Set/WeakMap/WeakSet is an ordinary Object for ToBoolean: `new Map()`
  // is truthy with zero entries, exactly as `[]` is.
  'keyed-collection',
  'proxy-object',
  'function',
  'function-family',
  'function-value-family',
  'function-value-dispatch',
  // A function object is truthy whatever its convention -- and the identity
  // carrier is the SAME object, reached through the handle every callable
  // already owns. Its absence lives in the `optional` wrapper around it, as it
  // does for every other callable kind here.
  'callable-identity',
  'generic-function-set',
  'constructor-family',
  'constructor-value-dispatch',
  'function-and-constructor'
])

/**
 * Whether a carrier has no absent state at all -- so `a ?? b` over it never
 * evaluates `b`.
 *
 * Read straight off `alwaysTruthyKinds` because that set is already exactly
 * this fact plus more: every kind in it is an Object or a callable whose
 * absence, where it has one, lives in an `optional` WRAPPER rather than in the
 * carrier itself. The three carriers that self-encode absence are outside the
 * set for reasons its own comment states -- `native-handle` and a
 * shared-refcount `class-ref`, the two `representation/optional.ts` collapses
 * `T | null` onto -- and so are `optional`, `dynamic` and every sum, each of
 * which plainly has one.
 *
 * `constructor-family` is the measured case: node-server's `export const
 * CloseEvent: typeof globalThis.CloseEvent = globalThis.CloseEvent ?? class
 * extends Event {...}`. The plan gives the global read a bare constructor
 * family, which is the census's own statement that the value is there -- a host
 * that says otherwise says so through `semantics/normalize/absent-globals.ts`,
 * which turns the read's type into `undefined` and takes the carrier out of
 * this set. So the fallback class never runs, and asking for a conversion
 * between two unrelated program classes is asking for a value that arm never
 * produces.
 */
export const carriesNoAbsence = (representation: Representation): boolean => alwaysTruthyKinds.has(representation.kind)

/**
 * Whether `representation` -- unwrapped once if it is an `optional` -- can
 * only ever be absent, never a live, present-but-falsy value.
 *
 * This is the fact that licenses treating one arm of a merge as dead code
 * rather than a missing conversion: `a && a.b` keeps `a` on the branch where
 * `a` tested falsy, and an Object is never falsy, so when `a`'s own payload
 * is one, the present case cannot be the reason that branch runs -- only
 * `a`'s own absence can, and the checker's own type for the whole `&&`
 * already reflects that by excluding the payload from the join. A bare
 * (non-optional) representation with an always-truthy kind answers `true`
 * too: it has no absence at all, so if it reaches here as the falsy side of
 * an `&&`, the branch is not merely narrowed, it is wholly unreachable.
 *
 * One fact with one asker: `ir/lower-narrow.ts`'s `mergeIncoming` (what a
 * dead arm lowers to). Preflight's `buildMergeNarrowingObligations` asked it
 * too until Phase 1.6 deleted that second decision tree; the obligation ids
 * quoted below are its historical spelling of the same pairs.
 */
/**
 * Whether a merge's own carrier has an absent state a dead `&&` arm can be
 * materialized into.
 *
 * The companion fact to `isDeadMergeContribution`: that one says the kept arm
 * contributes nothing but absence, this one says the merge has somewhere to
 * put it. Both authorities need both halves, and both used to spell this one
 * as `kind === 'optional'`.
 *
 * That spelling was too narrow by exactly one carrier, and it is the carrier
 * this file's own `alwaysTruthyKinds` comment already names: `optional.ts`
 * COLLAPSES `T | null` onto a bare `native-handle`, because a host handle
 * self-encodes absence as an invalid state. So a merge whose checker type is
 * `WSInst | null` has carrier `native-handle`, not `optional` -- and the
 * `kind === 'optional'` test then refused a program the collapse itself
 * created.
 *
 * Measured on `examples/dialer`: `if (e.candidate && this.ws)`, with
 * `ws: WebSocketInstance | null`, raised
 * `merge-narrowing:optional(native-record-ref(...),null)->native-handle(...)`,
 * an obligation no conversion could ever satisfy, on a program with zero
 * violations. The C++ side already had the spelling all along --
 * `types.ts`'s `carriesAbsence` answers `true` for `native-handle`, so the
 * constant renders as an empty handle (`gea::host::WebSocket{}`), which is
 * exactly what `emit-narrowing.ts`'s `emptyHandleText` writes for the same
 * carrier on the store path.
 */
/**
 * Whether a carrier has an `undefined` state at all -- the question a
 * definedness test asks, asked of the carrier rather than of a value.
 *
 * `targets/cpp/emit-presence.ts`'s `definedTestText` is the same rule as a
 * spelling, and delegates here rather than restating it: a carrier this answers
 * `false` for renders the test as the constant `true`, which is honest -- such a
 * value genuinely cannot be `undefined` -- and is exactly why a lowering that
 * MERGES over a definedness guard has to ask this first. A merge over a
 * constant-true test is not a merge; its absent arm is dead, and building one
 * anyway hands the emitter a branch whose other side can never run.
 *
 * A host handle's own absence stands for `null`, never for `undefined` (see
 * `optionalOf`), so it is defined whatever it holds -- as is every carrier that
 * is simply a value that exists.
 */
export const carriesUndefined = (representation: Representation): boolean => {
  if (representation.kind === 'undefined' || representation.kind === 'void') return true
  if (representation.kind === 'borrowed-ref') return carriesUndefined(representation.referent)
  if (representation.kind === 'optional') return representation.absence === 'undefined'
  if (representation.kind === 'tagged-union') return representation.arms.some((arm) => carriesUndefined(arm.value))
  return representation.kind === 'dynamic'
}

/**
 * Whether `ir/lower-destructuring.ts`'s array-pattern fast path already reads
 * this carrier positionally, in place: a plain array, a positional tuple
 * record (`ir/lower-allocation.ts`'s `lowerTupleLiteral` names the same shape
 * "record" -- there is deliberately no separate tuple carrier), or a tagged
 * union every arm of which is itself one of these two --
 * `preflight/tuple-destructuring.ts`'s uniform tuple-union.
 */
export const isArrayPatternCapable = (representation: Representation): boolean => {
  if (representation.kind === 'array-object') return true
  if (representation.kind === 'record') return representation.fields.every((field, index) => field.key === String(index))
  if (representation.kind === 'tagged-union') return representation.arms.every((arm) => isArrayPatternCapable(arm.value))
  return false
}

/**
 * The one arm of a tagged union a nested array-pattern position can read
 * positionally, when every OTHER arm cannot -- `number | number[]`, the
 * per-position element of a plain (non-tuple) array whose own element is
 * itself a union: exactly one arm (the array) supports positional reads, and
 * the other (the number) is exactly the value ECMA-262 7.4.2 `GetIterator`
 * throws a `TypeError` over. `null` for a union with zero such arms, or with
 * MORE than one -- two capable arms (`number[] | string[]`) is a genuine
 * ambiguity this compiler does not resolve, and refusing it is the
 * fail-closed answer, not a guess.
 */
export const soleArrayPatternCapableArm = (
  representation: Representation
): { readonly index: number; readonly arm: Representation } | null => {
  if (representation.kind !== 'tagged-union') return null
  let sole: { readonly index: number; readonly arm: Representation } | null = null
  for (const [index, arm] of representation.arms.entries()) {
    if (!isArrayPatternCapable(arm.value)) continue
    if (sole) return null
    sole = { index, arm: arm.value }
  }
  return sole
}

/**
 * The payload under a field value's own `undefined`-optional carrier, or
 * `null` for every other field.
 *
 * Property presence no longer comes from this wrapper. Generated structs keep
 * an independent bit for every `!required` field, because a present property
 * whose value is `undefined` and a missing property are observably different.
 * This helper remains the value-carrier decomposition used where code needs
 * the payload of `T | undefined` itself.
 */
export const absentFieldPayload = (field: RecordField): Representation | null =>
  !field.required && field.value.kind === 'optional' && field.value.absence === 'undefined' ? field.value.payload : null

export const carriesMergeAbsence = (representation: Representation): boolean =>
  representation.kind === 'optional' ||
  representation.kind === 'native-handle' ||
  (representation.kind === 'class-ref' && representation.ownership === 'shared-refcount')

/**
 * Whether a tagged union tags absence in an arm of its own.
 *
 * The one fact an arm cannot see about itself, and the fact that decides
 * whether the arm beside it is the absence-collapsed form of its carrier --
 * see `isDeadMergeArm`.
 */
const unionTagsAbsence = (union: Extract<Representation, { kind: 'tagged-union' }>): boolean =>
  union.arms.some((arm) => arm.value.kind === 'null' || arm.value.kind === 'undefined' || arm.value.kind === 'void')

/**
 * `isDeadMergeContribution` over a carrier that may sit INSIDE another one,
 * carrying the single fact only that enclosing carrier knows: whether absence
 * is tagged in a place of its own out there.
 *
 * `class-ref(shared-refcount)` and `native-handle` are deliberately outside
 * `alwaysTruthyKinds` because `representation/optional.ts` COLLAPSES `T | null`
 * onto them, so a BARE one is genuinely nullable and that null is a falsy state
 * nothing may claim away. `absenceTaggedOutside` is precisely the proof that
 * the collapse did not happen here, and it arrives two ways:
 *
 * - a union carrying its own `null`/`undefined` arm. Arms are disjoint, so a
 *   `present:` arm sitting beside a `null:` arm carries a type null was already
 *   removed from. Without this, three's `this.environment &&
 *   this.environment.isTexture` over a `Texture | null` field raised
 *   `merge-narrowing:tagged-union(undefined|null|present:class-ref(...,shared-
 *   refcount))->tagged-union(undefined|null|present:scalar(boolean))` -- an
 *   obligation no conversion could satisfy, because all three arms read live
 *   and `partialDeadMergeArms` therefore reported no split to rebuild from.
 * - an `optional` WRAPPER around one of them. `optionalOf` collapses these two
 *   payloads for `absence === 'null'` and only then, so a surviving wrapper can
 *   only be tagged `'undefined'` -- and `union.ts` reaches that wrapper solely
 *   when the source union had exactly ONE absent member. Both facts together
 *   say `null` was never in the type, so the pointer inside is object-shaped
 *   and therefore always truthy. Without this, mongodb's `this.session &&
 *   this.session.inTransaction()` -- `session: ClientSession | undefined`, the
 *   guard-and-call idiom -- raised `merge-narrowing:optional(class-ref(...,
 *   shared-refcount),undefined)->optional(scalar(boolean),undefined)`, 39 rows
 *   over three classes, for a merge whose kept arm can only ever be absent.
 */
const isDeadMergePayload = (representation: Representation, absenceTaggedOutside: boolean): boolean => {
  if (representation.kind === 'optional') return isDeadMergePayload(representation.payload, true)
  if (representation.kind === 'tagged-union') {
    const tagsAbsence = unionTagsAbsence(representation)
    return representation.arms.every((arm) => isDeadMergePayload(arm.value, tagsAbsence || absenceTaggedOutside))
  }
  if (absenceTaggedOutside && (representation.kind === 'class-ref' || representation.kind === 'native-handle')) return true
  // A class instance is object-shaped and so always truthy -- unless it is the
  // one shape that self-encodes absence, exactly as `native-handle` does. A
  // REFCOUNTED instance is a `gea::Ref<T>` that `optional.ts` collapses
  // `T | null` onto, so a null one is a falsy state this must not claim away.
  if (representation.kind === 'class-ref') return representation.ownership !== 'shared-refcount'
  return alwaysTruthyKinds.has(representation.kind)
}

export const isDeadMergeContribution = (representation: Representation): boolean => isDeadMergePayload(representation, false)

/**
 * The `||` mirror of `isDeadMergeContribution`: a kept operand with NO truthy
 * state. `a || b` publishes `a` only when `ToBoolean(a)` is true, and a carrier
 * that is only ever `null`/`undefined` (propertyHelper's `verifyProp || name`,
 * where every caller passes `null` or nothing) has no such state, so the
 * kept branch never runs and the merge only ever publishes the evaluated
 * side. Nothing is converted because nothing arrives. Asked by
 * `ir/lower-narrow.ts`'s `mergeIncoming`. Deliberately not extended to an
 * `optional` or a union: those carry a payload that CAN be truthy.
 */
export const contributesNoTruthiness = (representation: Representation): boolean =>
  representation.kind === 'null' || representation.kind === 'undefined' || representation.kind === 'void'

/**
 * Whether every falsy state this carrier has is an ABSENCE -- the WHOLE-operand
 * question, as against `isDeadMergeContribution`'s per-arm one.
 *
 * The two differ over exactly the carriers `optional.ts` COLLAPSES `T | null`
 * onto: a bare `class-ref(shared-refcount)` (a `gea::Ref<T>`) and a bare
 * `native-handle`. `isDeadMergeContribution` must refuse those, and its own
 * comment says why -- a null `Ref` is a falsy state, and an ARM proven dead is
 * DROPPED from `partialDeadMergeArms`'s rebuild, so a null flowing through a
 * dropped arm would fall out of the chain into a neighbour's value.
 *
 * Asked of a whole `&&` operand into a merge that carries an absence, nothing
 * is dropped and the answer changes. ECMAScript's `ToBoolean` is `true` for
 * every object, so the only value such a carrier can hold on the branch where
 * it tested falsy is its own null -- and the merge's own absence is where that
 * null belongs. `crash.ts`'s `this.engine && this.endBuffer` (`AudioEngine |
 * null` guarding a `BufferLike | null`) is the shape: the kept operand
 * contributes nothing the merge does not already have a state for, yet
 * `merge-narrowing:class-ref(...)->optional(native-record-ref(...),null)`
 * asked for a conversion no registry could hold.
 *
 * Strictly wider than `isDeadMergeContribution` -- `absenceTaggedOutside` only
 * ever ENABLES the return above -- so every merge the narrower fact licensed
 * is licensed identically here. `ir/lower-narrow.ts`'s `mergeIncoming` asks
 * this one and does not re-derive it.
 */
export const contributesOnlyAbsence = (representation: Representation): boolean => isDeadMergePayload(representation, true)

/** The live/dead split of a tagged union merge arm, when the split is partial -- see `partialDeadMergeArms`. */
export interface PartialMergeArmSplit {
  readonly payload: Extract<Representation, { kind: 'tagged-union' }>
  /** Indices into `payload.arms` NOT proven dead by `isDeadMergeContribution`, in ascending order. Never empty, never `payload.arms.length`. */
  readonly liveIndices: readonly number[]
  /** Whether `representation` itself (before unwrapping) was `optional` -- the arm's own absence is then a second, independent reason this merge arm can run. */
  readonly keptIsOptional: boolean
}

/**
 * The per-arm decomposition of `isDeadMergeContribution`, asked only when the
 * WHOLE answer is neither wholly `true` nor wholly `false`.
 *
 * `isDeadMergeContribution` covers two ends: every arm dead (the kept operand
 * contributes nothing but its own absence -- `mergeIncoming`'s existing
 * bypass) and every arm live (an ordinary conversion, already the general
 * conversion graph's job). This is the middle: SOME arms dead, at least one
 * live -- `results[name]` typed `T[] | string`, where `T[]` can never be the
 * reason a `&&` fell through but `string` can (an empty one).
 *
 * Returns `null` for anything that is not that middle case: not a tagged
 * union at all (once unwrapped of one optional layer, matching
 * `isDeadMergeContribution`'s own unwrap), wholly dead, or wholly live. Each
 * `null` is a real "does not apply", not a missing answer -- the caller falls
 * through to whichever of the two existing paths does apply.
 *
 * One fact, asked from both authorities that must never disagree about it,
 * exactly as `isDeadMergeContribution` and `carriesMergeAbsence` already are:
 * `ir/lower-narrow.ts`'s `mergeIncoming`, which both decides to rebuild via
 * the live-arm proof instead of a general conversion and checks that the
 * rebuild is buildable at all -- every live arm must actually have somewhere
 * to convert to, and the source's own absence, if it has one, needs
 * `carriesMergeAbsence(merged)` to hold it -- blocking the body otherwise.
 */
/**
 * Whether `representation` is boolean-shaped: itself `scalar(boolean)`, or an
 * `optional` whose payload is.
 *
 * The signal `ir/lower-narrow.ts`'s `mergeIncoming` checks
 * before licensing `ToBoolean` (`targets/cpp/emit-presence.ts`'s
 * `booleanTestText`) as a live arm's conversion into a `&&` merge's own
 * carrier, rather than requiring a structural, value-preserving one.
 *
 * Sound only here, at a `&&` merge whose own published type already
 * collapsed to boolean-or-absent: ECMA-262's own definition of `&&` decides
 * which operand to keep by `ToBoolean`, so when the checker's inferred type
 * for the WHOLE expression is `boolean | undefined` rather than the kept
 * operand's own type, it has already proven the kept contribution is
 * meaningful only as its truthiness -- an object-shaped arm has no boolean
 * value of its own, but it does have a `ToBoolean` answer, and that answer is
 * exactly what the checker's type says this merge publishes. This is why
 * `partialDeadMergeArms`'s live/dead split still matters here rather than
 * making this a blanket "any carrier converts to boolean" capability: the
 * SAME renderer applies `ToBoolean` only to arms this merge's own narrowing
 * already proved live, one call site's condition and nowhere else -- not a
 * new entry in the general conversion registry, which would let it fire for
 * any unrelated occurrence of the same representation pair.
 */
/**
 * Whether a `&&` merge publishes its kept operand's TRUTHINESS rather than
 * its value.
 *
 * The same proof `isBooleanShapedMergeTarget` states for one live arm of a
 * partially-dead tagged union, asked of the kept operand as a WHOLE -- and
 * for the same reason. ECMA-262 decides which operand `&&` keeps by
 * `ToBoolean` in the first place, so when the checker's type for the whole
 * expression is a plain `boolean` while the kept operand's own carrier is
 * not, it has already proven the kept contribution meaningful only as its
 * truthiness. `object && object.isObject3D` over three's `Object3D` is the
 * shape: the merge publishes `boolean`, the kept side is a
 * `class-ref(shared-refcount)` -- nullable, because `optional.ts` collapses
 * `T | null` onto it -- and its `ToBoolean` (`emit-presence.ts`'s
 * `booleanTestText`, total over every carrier) IS the value this branch
 * yields.
 *
 * Deliberately EXACT, not `isBooleanShapedMergeTarget`'s optional-tolerant
 * test: `optional(scalar(boolean))` would need the boolean wrapped back into
 * an optional, a second step `ir/lower-narrow.ts` has no conversion use to
 * name here. A merge that publishes `boolean | undefined` keeps raising its
 * obligation, correctly, rather than being half-answered.
 *
 * Asked by `ir/lower-narrow.ts`'s `mergeIncoming`, the one authority on what
 * a merge arm builds.
 */
export const mergesAsTruthiness = (merged: Representation): boolean => merged.kind === 'scalar' && merged.domain === 'boolean'

export const isBooleanShapedMergeTarget = (representation: Representation): boolean => {
  const payload = representation.kind === 'optional' ? representation.payload : representation
  return payload.kind === 'scalar' && payload.domain === 'boolean'
}

export const partialDeadMergeArms = (representation: Representation): PartialMergeArmSplit | null => {
  const candidate = representation.kind === 'optional' ? representation.payload : representation
  const keptIsOptional = representation.kind === 'optional'
  if (candidate.kind !== 'tagged-union') return null
  const tagsAbsence = unionTagsAbsence(candidate)
  const liveIndices = candidate.arms
    .map((arm, index) => (isDeadMergePayload(arm.value, tagsAbsence || keptIsOptional) ? -1 : index))
    .filter((index): index is number => index >= 0)
  if (liveIndices.length === 0 || liveIndices.length === candidate.arms.length) return null
  return { payload: candidate, liveIndices, keptIsOptional }
}

/**
 * The ownership class a carrier crosses a body boundary under, or `null` when
 * it states none a copy can be proven safe under.
 *
 * One function, because everything that spells a `capture:` capability keys
 * the manifest's `captureOwnershipSupport` by this string: `ir/certify.ts`
 * demands it, `targets/cpp/captures.ts` admits it, and
 * `emit-binding-reference.ts` names it in the refusal when admission says no.
 *
 * It used to be two. This one answered `'value'` by `default` and the one in
 * `ir/captures.ts` answered `null` for `unresolved`, `proxy-object`,
 * `borrowed-ref`, `dense-buffer`, `native-sequence`, `iterator` and `promise`
 * -- so certification published `capture:value` for carriers whose admission
 * then refused them by name, the same certify/print disagreement 2.3 fixed
 * four of. The fail-CLOSED answer is the correct one and is what survives: a
 * carrier that names no copy-safe ownership must refuse where the certificate
 * is minted, not where the text is spelled. The hole was invisible only
 * because `AllocateCallableOperation.captures` is still unfilled, so
 * `ir/certify.ts`'s own demand list is empty today.
 */
export const ownershipOf = (representation: Representation): string | null => {
  switch (representation.kind) {
    case 'void':
    case 'scalar':
    case 'string':
    // `gea::Symbol` is an interned id and nothing aliases one, exactly as for
    // `string` above.
    case 'symbol':
    case 'null':
    case 'undefined':
    case 'function':
    case 'function-family':
    case 'function-value-family':
    case 'function-value-dispatch':
    case 'generic-function-set':
    case 'constructor-family':
    case 'constructor-value-dispatch':
    case 'function-and-constructor':
      // Nothing else aliases a plain value. A callable carrier's own
      // `environment` pointer is a deliberate, permanent leak (see
      // `emitAllocateCallable`), so copying the `{invoke, environment}` pair
      // into another environment is exactly as safe as the original copy.
      return 'value'
    case 'native-handle':
      // A host handle is copied by value and the HOST owns what it names:
      // every carrier a host states for one is a value type -- an id, a small
      // struct, or a standard container -- and none owns the object on the
      // other side of the boundary. A copy in an environment stays good for
      // exactly as long as the host keeps the thing it names.
      return 'value'
    case 'class-ref':
    case 'record':
    case 'record-with-index':
    case 'native-record-ref':
    case 'array-object':
    case 'dictionary':
    case 'typed-array':
    case 'array-buffer':
    case 'shared-array-buffer':
    case 'data-view':
    case 'keyed-collection':
      return representation.ownership
    case 'optional':
      // `gea::Optional<T>` copies its payload by the same rule `T` copies by;
      // an optional local is not a different capture question from a required
      // one, only a wrapped one.
      return ownershipOf(representation.payload)
    case 'dynamic':
      // The box copies by value and the copy is independent: `gea::Value`'s
      // payload is a `std::shared_ptr<void>`, so a copy is a refcount bump
      // over an immutable-by-construction cell.
      return 'value'
    case 'tagged-union': {
      // A sum is copy-safe only when every arm is: the live arm is a runtime
      // fact. Ask each arm's ownership rule instead of maintaining a second
      // table that could disagree with those same carriers outside a union.
      let weakest = 'value'
      for (const arm of representation.arms) {
        const ownership = ownershipOf(arm.value)
        if (ownership === null) return null
        if (ownership !== 'value') weakest = ownership
      }
      return weakest
    }
    default:
      // `unresolved`, `proxy-object`, `borrowed-ref`, `dense-buffer`,
      // `native-sequence`, `iterator`, `promise`: none states a copy-safe
      // ownership, either because the carrier has no ownership field to read
      // (a proxy's two-part identity) or because it is explicitly borrowed
      // from somewhere else. Refusing them is the fail-closed answer, not a
      // gap to route around with a box.
      return null
  }
}

/**
 * The `capture:` capability discriminator for a carrier -- what both the
 * demand and the refusal spell.
 *
 * A carrier with no copy-safe ownership still has to name SOMETHING, because
 * a demand keyed on a name the manifest cannot publish is precisely how the
 * refusal stays typed and attributable: `capture:unsupported-proxy-object`
 * says which carrier could not be transported, where a bare `capture:null`
 * would say only that one could not. `null` for the representation itself is
 * a placement that never stated one, which is a different unknown and spells
 * differently.
 */
export const captureCapabilityOf = (representation: Representation | null): string =>
  representation === null ? 'unstated' : (ownershipOf(representation) ?? `unsupported-${representation.kind}`)

/**
 * Every carrier reachable inside a representation, including the root.
 *
 * One walk, shared: `verify.ts`'s guards ask "is anything in here unresolved /
 * boxed / a dense buffer", and a probe in the emitter asks "is anything in here
 * unresolved" before it asks for a physical C++ type. Two copies of this switch
 * would answer those questions over different carrier sets, which is precisely
 * how a fail-closed guard silently stops covering a kind.
 *
 * ⛔ `record-with-index` was missing from this switch and fell through to
 * `default`, so nothing inside one was ever visited: mongodb's `Filter` -- a
 * record-with-index whose fields are the whole query -- was invisible to every
 * guard built on this walk.
 */
export function* walkRepresentation(representation: Representation, visited: Set<Representation> = new Set()): Generator<Representation> {
  // With `visited`, a carrier OBJECT is yielded once across every walk that
  // shares the set. The derive memo hands every reader of one structural
  // type the same object, so a record's field carriers, a union's arms and
  // the selections that embed them are one DAG, not a forest of trees --
  // and a per-node question asked of that DAG is answered once per node.
  if (visited.has(representation)) return
  visited.add(representation)
  yield representation
  const walk = (inner: Representation): Generator<Representation> => walkRepresentation(inner, visited)
  switch (representation.kind) {
    case 'record':
      for (const field of representation.fields) yield* walk(field.value)
      return
    case 'record-with-index':
      for (const field of representation.fields) yield* walk(field.value)
      for (const index of representation.indexes) yield* walk(index.value)
      return
    case 'proxy-object':
      yield* walk(representation.target)
      yield* walk(representation.handler)
      return
    case 'borrowed-ref':
      yield* walk(representation.referent)
      return
    case 'array-object':
      yield* walk(representation.element)
      for (const field of representation.extension ?? []) yield* walk(field.value)
      return
    case 'dense-buffer':
    case 'native-sequence':
      yield* walk(representation.element)
      return
    case 'iterator':
      yield* walk(representation.element)
      yield* walk(representation.resume)
      yield* walk(representation.completion)
      return
    case 'promise':
      yield* walk(representation.value)
      return
    case 'keyed-collection':
      yield* walk(representation.key)
      if (representation.value) yield* walk(representation.value)
      return
    case 'dictionary':
      yield* walk(representation.value)
      return
    case 'optional':
      yield* walk(representation.payload)
      return
    case 'tagged-union':
      for (const arm of representation.arms) yield* walk(arm.value)
      return
    case 'function':
    case 'function-family':
    case 'constructor-family':
    case 'constructor-value-dispatch':
    case 'function-value-family':
    case 'function-value-dispatch':
      for (const parameter of representation.abi.parameters) yield* walk(parameter.value)
      yield* walk(representation.abi.result)
      if (representation.abi.receiver) yield* walk(representation.abi.receiver)
      return
    case 'function-and-constructor':
      for (const abi of [representation.call, representation.construct]) {
        for (const parameter of abi.parameters) yield* walk(parameter.value)
        yield* walk(abi.result)
        if (abi.receiver) yield* walk(abi.receiver)
      }
      return
    case 'unresolved':
    case 'void':
    case 'scalar':
    case 'string':
    case 'symbol':
    case 'null':
    case 'undefined':
    case 'class-ref':
    case 'native-handle':
    case 'native-record-ref':
    case 'typed-array':
    case 'array-buffer':
    case 'shared-array-buffer':
    case 'data-view':
    case 'dynamic':
    case 'generic-function-set':
    case 'callable-identity':
      return
    default: {
      const unhandled: never = representation
      throw new Error(`unhandled representation in traversal: ${String(unhandled)}`)
    }
  }
}

/**
 * Whether a carrier holds lattice bottom anywhere inside it.
 *
 * `unresolved` has no physical type, and `targets/cpp/types.ts`'s `cppTypeOf`
 * throws on one rather than inventing a slot -- correctly, since a carrier that
 * was never selected must not materialize as a default-constructed value. That
 * makes it a hazard for the emitter's *probes*: a function asking "could this
 * record be recast to an array?" is asking a question with a legitimate `false`
 * answer, and it must not blow up the compile to find out. Asking this first is
 * how such a probe stays a probe.
 */
export const containsUnresolved = (representation: Representation): boolean => {
  for (const found of walkRepresentation(representation)) if (found.kind === 'unresolved') return true
  return false
}

/**
 * The carrier every `throw` converts its value into: ECMAScript does not
 * type a thrown value, so this is the one genuinely dynamic boundary the
 * language itself states. The catch side reads it back without conversion
 * (`ir/lower-exceptions.ts`).
 */
export const thrownValueCarrier: Representation = { kind: 'dynamic', reason: 'thrown-error-carrier' }
