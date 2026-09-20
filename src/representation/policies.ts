import type { DeclarationId, FunctionId, StructuralTypeId } from '../identity/ids.js'
import type { Ownership, RecordField, Representation, TypedArrayElementDomain, RecordAccessor } from './model.js'
import type { StructuralShape } from '../semantics/model/structural-types.js'

/**
 * The policies a representation deriver consults, and the neutral default of
 * each.
 *
 * They live apart from the derivation itself because that is precisely what
 * they are: decisions the deriver is *handed*, not answers it computes. A
 * policy that the deriver could reach in and change -- or that changed to suit
 * one call site -- would make the same `StructuralTypeId` derive two different
 * carriers, which is the drift `representation/publish.ts` seals against by
 * deriving every carrier exactly once.
 */

/**
 * Who owns a reference and for how long.
 *
 * Ownership is a decision, not a property of the shape, so it is injected. A
 * deriver that picked ownership itself would be a second authority competing
 * with the target's own lifetime rules.
 */
export interface OwnershipPolicy {
  /**
   * Ownership for a value of this shape held in an ordinary position.
   *
   * The interned identity comes with the shape because the question is not
   * always answerable from the layout alone: whether a record may be carried
   * by value is a fact about how the whole PROGRAM uses that one type
   * (`representation/value-records.ts`), and the type id is what the proof is
   * keyed by. A policy with no use for it ignores it, as the default does.
   */
  readonly forShape: (shape: StructuralShape, id: StructuralTypeId) => Ownership
  /** Ownership for a value passed as a physical parameter. */
  readonly forParameter: (value: Representation) => Ownership
}

/** The ownership a carrier states about itself, or `null` for one that states none. */
const ownershipOf = (value: Representation): Ownership | null => {
  switch (value.kind) {
    case 'class-ref':
    case 'record':
    case 'record-with-index':
    case 'native-record-ref':
    case 'array-object':
    case 'dictionary':
    case 'typed-array':
    // A keyed collection states its own ownership like every other reference
    // carrier above, and omitting it here was not neutral: `forParameter` then
    // fell through to `'owned'`, so a `Set<number>` PARAMETER was spelled
    // `gea::Set<double>` by value while every binding of one inside the body
    // stayed `std::shared_ptr<gea::Set<double>>` -- the exact "parameter's
    // carrier and its passing mode are two different answers to one question"
    // failure this policy's own comment below describes, and it did not
    // compile. Passing as held is also the only reading that preserves the
    // reference semantics a JavaScript Map/Set has: a callee that adds an
    // entry must be adding it to the caller's collection, not to a copy.
    case 'keyed-collection':
      return value.ownership
    default:
      return null
  }
}

/**
 * Shared ownership for references, by-value for everything else, and a
 * parameter passed exactly as its carrier is held.
 *
 * Borrowing at parameter positions is an optimization, and it was one this
 * layer had not earned: nothing here proves a callee does not retain what it
 * was handed. Worse, it made a parameter's carrier and its passing mode two
 * different answers to one question -- the value inside the body was a shared
 * reference while the formal declaring it was a borrowed one -- so the body
 * initialized a `shared_ptr` from a reference and the emitted C++ did not
 * compile. Passing as held keeps one answer; a proven non-escaping parameter
 * may be narrowed to `borrowed` later, on top of this, not instead of it.
 */
export const defaultOwnershipPolicy: OwnershipPolicy = {
  forShape: () => 'shared-refcount',
  forParameter: (value) => ownershipOf(value) ?? 'owned'
}

/**
 * Which object types this program may carry BY VALUE -- see
 * `representation/value-records.ts` for the proof, and `derive.ts`'s
 * `'declared'` case for the one place a NAME for one is expanded rather than
 * carried nominally.
 *
 * A policy rather than a table the deriver computes, for the reason every
 * policy here is one: the answer is a whole-program fact about how a type is
 * USED, and the deriver sees one type at a time.
 */
export interface ValueRecordPolicy {
  /** Whether a value of this object type may be held by value. */
  readonly forType: (id: StructuralTypeId) => boolean
}

/** No value records: every record is a shared handle, exactly as before. */
export const defaultValueRecordPolicy: ValueRecordPolicy = {
  forType: () => false
}

/**
 * One version of one host protocol a declared type is bound to.
 *
 * Structurally the same interface `semantics/frontend.ts` declares, and
 * deliberately a second declaration of it rather than an import: this layer may
 * not depend on the frontend. Structural typing at `compiler.ts`'s
 * `publishRepresentations` call is the whole of the join, so the two move
 * together and the typechecker is what enforces it.
 */
export interface HostProtocolBinding {
  readonly protocol: string
  readonly version: number
  /**
   * The type the host's own runtime carries values of this protocol in, when
   * the plugin that installs it stated one; `null` when it did not. See
   * `semantics/frontend.ts`'s copy for what states it, and
   * `Representation`'s `native-handle` arm for what reads it.
   */
  readonly native: string | null
  /**
   * True when the host builds values of this protocol, so its declared body is
   * not a layout. See `semantics/frontend.ts`'s copy; `derive.ts`'s data-only
   * record exception is what reads it.
   */
  readonly opaque: boolean
}

/**
 * Which declared types this program's declarations are bound to a host
 * protocol for, keyed by declaration identity.
 *
 * A declared type with a binding is not a layout this compiler owns or should
 * ever expand: `Element`, `Map`, and every other host-implemented type are
 * defined by whatever installs the protocol, not by the members its ambient
 * (or even non-ambient, structurally-empty) TypeScript declaration happens to
 * spell. Keying by `DeclarationId` rather than a name or a source location is
 * the same rule every other identity in this compiler runs on -- and a host
 * binding, resolved by whichever declaration the checker says a value's type
 * actually names, is exactly the place a name match would silently bind the
 * wrong symbol.
 */
export interface HostBindingPolicy {
  /** The protocol a declared type is bound to, or `null` for an ordinary declared type. */
  readonly forDeclaration: (declaration: DeclarationId) => HostProtocolBinding | null
  /**
   * Every host carrier the given one derives from, transitively, nearest base
   * first -- what the host stated about its own inheritance
   * (`PluginCapabilities.nativeBases`), read by the one site that derives a
   * `native-handle` at all and stated on the carrier it builds (see
   * `Representation`'s `native-handle` arm for why the fact has to travel on
   * the carrier).
   *
   * Keyed by the CARRIER rather than by declaration, unlike `forDeclaration`
   * above, because that is the shape of the fact: thirteen declared names can
   * share one runtime type, and what derives from what is a statement about
   * the type, not about any one name for it. A handle whose host stated no
   * carrier (`null`) derives from nothing -- a host that named no type for a
   * protocol has said nothing about that protocol's place in a hierarchy
   * either, and treating the protocol name as a carrier would compare two
   * different key spaces.
   */
  readonly basesOf: (native: string | null) => readonly string[]
}

/** No bindings installed: every declared type falls through to its structural answer, unchanged. */
export const defaultHostBindingPolicy: HostBindingPolicy = {
  forDeclaration: () => null,
  basesOf: () => []
}

/**
 * Which declared types this program's declarations resolve to a typed-array
 * element width for, keyed by declaration identity -- the same identity
 * `HostBindingPolicy` reads, and for the same reason: matching by the
 * checker's own declaration rather than by name text or file path is what
 * keeps this a checker-driven policy and not a second, source-shaped
 * authority. Unlike a host protocol, a typed array is not something any host
 * installs; it is core ECMAScript with a compiler-owned native layout, so it
 * gets its own policy type rather than a case of `HostBindingPolicy`.
 */
export interface TypedArrayElementPolicy {
  /** The element width a declared type is a typed-array view over, or `null` for an ordinary declared type. */
  readonly forDeclaration: (declaration: DeclarationId) => TypedArrayElementDomain | null
}

/** No typed-array declarations installed: every declared type falls through to its ordinary answer, unchanged. */
export const defaultTypedArrayElementPolicy: TypedArrayElementPolicy = {
  forDeclaration: () => null
}

/**
 * Whether a declared type is *the* standard library `Promise<T>` interface --
 * a narrower question than its two siblings above answer. There are eight
 * TypedArray interfaces and an open set of host protocols, each needing a
 * "which one" answer; there is exactly one `Promise<T>` declaration per
 * compilation, so a boolean is the honest shape for the answer, not a richer
 * lookup result with nothing to look up.
 *
 * Checked ahead of `HostBindingPolicy`/the ambient-no-protocol refusal in
 * `representation/derive.ts`'s `'declared'` case, for the identical reason
 * `TypedArrayElementPolicy` is: `Promise<T>`'s ambient interface body, run
 * through `declaredBodyOf`'s data-only member stripping, is not empty the
 * way a JSX `Element` interface is -- it has real (method) members that get
 * stripped, landing on a non-empty but WRONG structural body if this policy
 * is not consulted first. `Promise` is not a host protocol either: nothing
 * installs it, it is core ECMAScript with a compiler-owned native layout
 * (`gea::Promise<T>`), the same category `Uint8Array` and friends are in.
 */
export interface PromiseDeclarationPolicy {
  /** Whether this declaration is the standard library's own `Promise<T>` interface. */
  readonly forDeclaration: (declaration: DeclarationId) => boolean
}

/** No `Promise` declaration installed: every declared type falls through to its ordinary answer, unchanged. */
export const defaultPromiseDeclarationPolicy: PromiseDeclarationPolicy = {
  forDeclaration: () => false
}

/**
 * Whether a declared type is *the* standard library `Date` interface, and the
 * C++ type the target carries one in.
 *
 * The same one-declaration-per-compilation question `PromiseDeclarationPolicy`
 * answers, and checked in `derive.ts` immediately beside it for the same
 * reason: `Date`'s ambient body, run through `declaredBodyOf`'s data-only
 * stripping, is an EMPTY object shape (every member of `interface Date` is a
 * method), so without this policy a Date carries a `native-record-ref` whose
 * layout is a struct with no members -- and `d.getFullYear()` then emits as a
 * read of a field that does not exist.
 *
 * It answers a STRING rather than a boolean, which is the one shape difference
 * from its sibling. A Date is not laid out by this compiler; it IS the
 * runtime's own `gea::runtime::Date`, so what the policy carries is that
 * type's spelling -- exactly what `HostProtocolBinding.native` carries for a
 * host-implemented type, and the field `native-record-ref` already has for
 * "the definition is not mine". Keeping the spelling on the policy is what
 * keeps a C++ name out of this layer: `compiler.ts` joins the declaration
 * (semantics) to the spelling (`targets/cpp/prototype/emit-prototype-date.ts`), and
 * `derive.ts` only carries what it is given.
 *
 * Date is core ECMAScript, not a host protocol -- nothing installs it, the
 * standard library declares it -- so it is its own policy rather than a case
 * of `HostBindingPolicy`, on the same footing as `Promise` and the typed
 * arrays.
 */
export interface DateDeclarationPolicy {
  /** The C++ type a Date is carried in when this declaration is the standard `Date`, or `null` for any other declaration. */
  readonly forDeclaration: (declaration: DeclarationId) => string | null
}

/** No `Date` declaration installed: every declared type falls through to its ordinary answer, unchanged. */
export const defaultDateDeclarationPolicy: DateDeclarationPolicy = {
  forDeclaration: () => null
}

/**
 * Which declared type is the standard library's own `Generator<T, TReturn,
 * TNext>` -- the type a `function*` returns.
 *
 * Its own parameter for the same reasons `PromiseDeclarationPolicy` is one: it
 * is core ECMAScript rather than a host protocol (nothing installs it), it is
 * ONE declaration rather than a family, and the question it answers is "is
 * this THE ambient `Generator`", which no other policy asks.
 *
 * It has to be asked before the ambient-body walk for the same concrete reason
 * `Promise<T>` does: run through `declaredBodyOf`'s data-only member
 * stripping, `Generator`'s body loses `next`/`return`/`throw` and keeps
 * whatever else survives, so without this check every generator value would
 * silently derive as a `native-record-ref` to a struct with no members -- a
 * carrier that compiles and answers nothing. `IterableIterator` and the bare
 * `Iterator` are deliberately NOT included: a program can and does hand-write
 * a plain object typed `Iterator<T>` (a class's own `[Symbol.iterator]()`
 * routinely returns one), and claiming those objects are coroutine frames
 * would be exactly the silent wrong answer this policy exists to prevent.
 */
export interface GeneratorDeclarationPolicy {
  readonly forDeclaration: (declaration: DeclarationId) => boolean
}

/** No `Generator` declaration installed: every declared type falls through to its ordinary answer, unchanged. */
export const defaultGeneratorDeclarationPolicy: GeneratorDeclarationPolicy = {
  forDeclaration: () => false
}

/** The four keyed-collection families the language declares -- see `Representation`'s `keyed-collection` arm. */
export type KeyedCollectionFamily = 'map' | 'set' | 'weak-map' | 'weak-set'

/**
 * Which declared types are the standard library's own `Map`/`Set`/`WeakMap`/
 * `WeakSet` interfaces -- the same shape of policy `TypedArrayElementPolicy`
 * is, and installed for the same reason.
 *
 * These four are core ECMAScript, not a host protocol: nothing installs them,
 * and the runtime's own `gea::Map`/`gea::Set`/`gea::WeakMap`/`gea::WeakSet`
 * are compiler-owned native layouts exactly as `gea::TypedArray` and
 * `gea::Promise` are. Consulted ahead of `HostBindingPolicy` in `derive.ts`'s
 * `'declared'` case, and that ordering is load-bearing rather than cosmetic:
 * `lib.es5.d.ts` declares `var Map: MapConstructor`, so the ambient-value
 * census (`semantics/host-protocols.ts`) reaches the `Map` INTERFACE through
 * `MapConstructor.groupBy`'s return type and binds it as a host protocol
 * named `Map`. That binding is a real fact about the constructor's own
 * handle, and a wrong one about instances: it turns every `Map<K, V>` in the
 * program into an OPAQUE `native-handle` with no key or value carrier at all
 * -- exactly the untyped answer this policy exists to displace.
 */
export interface KeyedCollectionPolicy {
  /** The collection family a declared type names, or `null` for an ordinary declared type. */
  readonly forDeclaration: (declaration: DeclarationId) => KeyedCollectionFamily | null
}

/** No keyed-collection declarations installed: every declared type falls through to its ordinary answer, unchanged. */
export const defaultKeyedCollectionPolicy: KeyedCollectionPolicy = {
  forDeclaration: () => null
}

/** The two standard ArrayBuffer-family object types -- see `Representation`'s `array-buffer` and `data-view` arms. */
export type StandardBufferKind = 'array-buffer' | 'shared-array-buffer' | 'data-view'

/**
 * Which declared types are the standard library's own `ArrayBuffer` and
 * `DataView` interfaces -- the same shape of policy, checked at the same point
 * in `derive.ts`'s `'declared'` case, and installed for the same reason as
 * `TypedArrayElementPolicy` and `KeyedCollectionPolicy` above.
 *
 * The reason, concretely: the ambient-value census binds `ArrayBuffer` as a
 * host protocol -- it is reachable as `Uint8ArrayConstructor`'s own return type
 * `Uint8Array<ArrayBuffer>`, among several other routes -- so without this
 * policy every `ArrayBuffer` in the program carries an OPAQUE `native-handle`
 * with no bytes behind it, and every program that names one is refused for a
 * `native-boundary:ArrayBufferConstructor@1` nothing could honestly claim. The
 * CONSTRUCTOR keeps its handle, which is right: `ArrayBuffer` the value really
 * is a host-supplied constructor object.
 */
export interface StandardBufferPolicy {
  /** Which standard buffer type a declared type is, or `null` for an ordinary declared type. */
  readonly forDeclaration: (declaration: DeclarationId) => StandardBufferKind | null
}

/** No buffer declarations installed: every declared type falls through to its ordinary answer, unchanged. */
export const defaultStandardBufferPolicy: StandardBufferPolicy = {
  forDeclaration: () => null
}

/**
 * The three standard regular-expression declarations that have a compiler-owned
 * native layout: the pattern object itself, and the two shapes a match answers
 * in.
 *
 * `pattern` is `lib.es5.d.ts`'s `RegExp` interface; `exec-result` is
 * `RegExpExecArray`; `match-result` is `RegExpMatchArray`. The two results are
 * kept apart rather than folded into one kind because `lib.es5.d.ts` itself
 * keeps them apart, and the difference is physical, not cosmetic:
 * `RegExpExecArray` declares `index: number` and `input: string` REQUIRED,
 * while `RegExpMatchArray` declares both OPTIONAL -- because `'s'.match(re)`
 * with a `g` flag answers a plain list of matched substrings with neither
 * field. One native struct for both would have to widen the required pair to
 * optional and force every `exec` reader through an unwrap the program never
 * wrote.
 */
export type RegExpDeclarationKind = 'pattern' | 'exec-result' | 'match-result'

/**
 * Which declared types are the standard library's own `RegExp`,
 * `RegExpExecArray` and `RegExpMatchArray` -- the same shape of policy
 * `PromiseDeclarationPolicy` is, installed for the same reason and consulted
 * in the same place.
 *
 * A regular expression is core ECMAScript (`lib.es5.d.ts`), not a host
 * protocol: nothing installs it, and `gea::runtime::regex::Pattern` is a
 * compiler-owned native layout in exactly the category `gea::TypedArray`,
 * `gea::Promise` and `gea::Map` are in. So this is checked in `derive.ts`'s
 * `'declared'` case AHEAD of `HostBindingPolicy`, and the ordering is
 * load-bearing for the same measured reason `KeyedCollectionPolicy`'s is:
 * `lib.es5.d.ts` declares `var RegExp: RegExpConstructor`, so the ambient-value
 * census reaches the `RegExp` INTERFACE through the constructor's own
 * `new (...): RegExp` result and binds it as an opaque host protocol named
 * `RegExp`. That binding is right about the constructor object and wrong about
 * instances -- it turns every pattern in the program into a `native-handle`
 * with no layout, so `re.source` has nowhere to go.
 *
 * The three bodies are NOT empty after `declaredBodyOf`'s method stripping
 * either, which is the second half of why this cannot be left to fall through:
 * `RegExp` keeps exactly the ten data members `gea::runtime::regex::Pattern`
 * declares, and the two result interfaces keep `index`/`input`/`groups`/
 * `length` plus a number index signature. Falling through would seal a
 * plausible-looking struct for each and emit a program that compiles and is
 * not a regular expression.
 */
export interface RegExpDeclarationBinding {
  /** Which of the three standard regular-expression declarations this is. */
  readonly kind: RegExpDeclarationKind
  /**
   * The target's own spelling for the layout, supplied by whoever installs the
   * policy rather than named here -- for the same reason `HostBindingPolicy`
   * carries `native` instead of `derive.ts` guessing one. Nothing under
   * `src/representation/` may name a C++ type: the deriver selects carriers for
   * any backend, and the one that renders them is the authority on how they
   * are spelled. `compiler.ts` composes the two (it is already the place that
   * defaults the conversion registry to the C++ one).
   */
  readonly native: string
}

export interface RegExpDeclarationPolicy {
  /** Which regular-expression declaration this is, or `null` for an ordinary declared type. */
  readonly forDeclaration: (declaration: DeclarationId) => RegExpDeclarationBinding | null
}

/** No `RegExp` declarations installed: every declared type falls through to its ordinary answer, unchanged. */
export const defaultRegExpDeclarationPolicy: RegExpDeclarationPolicy = {
  forDeclaration: () => null
}

/**
 * Which declared type is the standard library's own `String` -- the WRAPPER
 * OBJECT interface (`lib.es5.d.ts`'s `interface String`), not the `string`
 * primitive every other value of that name carries. Same shape of policy as
 * `RegExpDeclarationPolicy` immediately above, installed for the same reason
 * and consulted in the same place, right after it.
 *
 * A `String` object is core ECMAScript (ECMA-262 22.1.5, `new String(x)`),
 * not a host protocol, so this is checked in `derive.ts`'s `'declared'` case
 * AHEAD of `HostBindingPolicy`, for the identical load-bearing reason
 * `RegExpDeclarationPolicy`'s ordering is: `lib.es5.d.ts` declares
 * `var String: StringConstructor`, so the ambient-value census reaches the
 * `String` INTERFACE through the constructor's own `new (...): String` result
 * and binds it as an opaque host protocol named `String`. That binding is
 * right about the constructor object and wrong about instances -- it would
 * turn every wrapper object in the program into a `native-handle` with no
 * layout, so a dynamic write like `escapedString.isEscaped = true` (hono's
 * `utils/html.ts`) has nowhere to land.
 *
 * `String`'s body is NOT empty after `declaredBodyOf`'s method stripping
 * either, the second half of why this cannot be left to fall through: it
 * keeps `length: number` and a number index signature (indexed character
 * access), which is the same "real data members plus an index signature"
 * shape `RegExpExecArray` has. Falling through would seal a plausible
 * `record-with-index` struct with a `length` FIELD, and a later `.length`
 * read would compile against a struct member that does not exist on the
 * hand-written `gea::runtime::StringObject` -- a `cert green / clang red`
 * outcome. `emit-prototype-string.ts`'s `stringObjectMemberText` renders
 * `.length` correctly instead, off the one real datum
 * (`StringObject::value`), which is why this policy names no fields at all:
 * unlike `RegExpDeclarationBinding`, there is exactly one shape here, so
 * there is nothing to distinguish by `kind`.
 */
export interface StringObjectDeclarationPolicy {
  /** The target's spelling for the String-object layout, or `null` for an ordinary declared type. */
  readonly forDeclaration: (declaration: DeclarationId) => string | null
}

/** No `String` declaration installed: every declared type falls through to its ordinary answer, unchanged. */
export const defaultStringObjectDeclarationPolicy: StringObjectDeclarationPolicy = {
  forDeclaration: () => null
}

/** Built-in Error interfaces share the runtime's native error layout. */
export interface ErrorDeclarationPolicy {
  readonly forDeclaration: (declaration: DeclarationId) => string | null
}

export const defaultErrorDeclarationPolicy: ErrorDeclarationPolicy = { forDeclaration: () => null }

/**
 * Which declared type is the bare `Function` interface (`lib.es5.d.ts`'s
 * `interface Function`, not `FunctionConstructor` and not a signature type).
 *
 * Its own policy, on the same footing as `PromiseDeclarationPolicy` and
 * consulted in `derive.ts` AHEAD of `HostBindingPolicy`, for the identical
 * reason theirs are: the ambient-value census has ALREADY bound `Function` as
 * an opaque host protocol -- `lib.es5.d.ts` declares `var Function:
 * FunctionConstructor`, whose `new (...): Function` result carries the
 * INTERFACE into the closure -- so falling through to `binding` gives every
 * `Function`-typed value a `native-handle` and mints
 * `native-boundary:Function@1`, an obligation no target can ever satisfy
 * because there is no C++ type for "some callable, signature unknown".
 *
 * The carrier is `dynamic('untyped-callable')` rather than a layout, and that
 * is not a boxing shortcut: see that reason's own comment
 * (`representation/model.ts`) for why a bare `Function` genuinely states no
 * frame, and why the checker already answers `any` for the same type on the
 * callee side. Deriving the interface's BODY instead would seal a struct of
 * `name`/`length`/`arguments`/`caller`/`prototype` -- a plausible-looking
 * layout that is not a function.
 */
export interface FunctionDeclarationPolicy {
  /** True when this declaration is the standard bare `Function` interface. */
  readonly forDeclaration: (declaration: DeclarationId) => boolean
}

/** No `Function` declaration installed: every declared type falls through to its ordinary answer, unchanged. */
export const defaultFunctionDeclarationPolicy: FunctionDeclarationPolicy = {
  forDeclaration: () => false
}

/**
 * Which classes a class inherits from, transitively, nearest ancestor first.
 *
 * Its own policy rather than a field on `class-ref`, and deliberately so: a
 * carrier states what a cell HOLDS, and two cells holding the same class hold
 * the same thing whatever that class extends. Putting the chain in the carrier
 * would put it in `representationKey`, making a class's ancestry part of its
 * carrier identity -- and a key that states more than the identity is the
 * defect `interning-key` guidance already names, not a richer answer.
 *
 * Read by exactly two questions, both of which are unanswerable without it and
 * both of which are only ever sound in the ancestor direction:
 * `derive.ts`'s intersection reduction (`T & AggregateOperation` IS the
 * more-derived class when one member descends from the other), and
 * `conversion/build.ts`'s widening enumeration (a derived class-ref may be
 * stored into a base class-ref cell; the reverse may not).
 *
 * See `classHeritageOf` (semantics/class-heritage.ts) for why the checker
 * rather than the heritage syntax answers it, and why `implements` is absent.
 */
export interface ClassHeritagePolicy {
  /** The classes this declaration inherits from, nearest first; empty for a base class or a non-class. */
  readonly forDeclaration: (declaration: DeclarationId) => readonly DeclarationId[]
  /**
   * The derived classes the program stores into a slot typed as this class's
   * constructor, which that constructor family must therefore also name; see
   * `semantics/constructor-slot-subclasses.ts`.
   */
  readonly constructorSlotSubclassesOf: (declaration: DeclarationId) => readonly DeclarationId[]
}

/**
 * The one class a program declares as an interface's implementation, keyed by
 * the interface's declaration -- see `semantics/interface-implementors.ts` for
 * what "the one" means and for the three refusals that keep this off every
 * interface that is really a record.
 *
 * Read by the deriver in the `declared` case, ahead of the host-binding and
 * structural-body paths: the answer is not a layout for the interface, it is
 * that the interface has no inhabitant of its own and the class's carrier is
 * what a slot of it holds.
 */
export interface InterfaceImplementorPolicy {
  /** Every class the program declares as this interface's implementation, in source order; empty when none. */
  readonly forDeclaration: (declaration: DeclarationId) => readonly DeclarationId[]
}

/** No implementors installed: every interface derives its own structural body, exactly as before this policy existed. */
export const defaultInterfaceImplementorPolicy: InterfaceImplementorPolicy = {
  forDeclaration: () => []
}

/**
 * The copies of a generic class whose copies can differ in layout, by the
 * class's root declaration id -- `structural.ts`'s `classCopies`. The
 * deriver's `physicalClassDeclarationOf` groups them by the representation
 * of their layout-relevant fillings: one physical class per group, named by
 * the group's lowest copy ordinal (`decl|f0|36@1`) when there is more than
 * one group, and by the root alone when there is one.
 */
export interface ClassCopyPolicy {
  readonly copiesOf: (
    declaration: DeclarationId
  ) => readonly { readonly ordinal: number; readonly typeArguments: readonly StructuralTypeId[]; readonly constructor: StructuralTypeId }[]
}

/** No copies installed: every generic class is one physical class, named by its root. */
export const defaultClassCopyPolicy: ClassCopyPolicy = {
  copiesOf: () => []
}

/** No heritage installed: every class reads as a base class, and no upcast or intersection reduction is proposed. */
export const defaultClassHeritagePolicy: ClassHeritagePolicy = {
  forDeclaration: () => [],
  constructorSlotSubclassesOf: () => []
}

/**
 * The type a host carries the one object behind a namespace ROOT in, keyed by
 * the root value's own structural type -- `window`'s `Window & typeof
 * globalThis` to `gea::host::WindowFacade`.
 *
 * The one policy here NOT keyed by `DeclarationId`, and the difference is
 * forced rather than chosen. Its three siblings above all answer a question
 * about a declared TYPE, so the declaration the checker resolved is both
 * available and the right key. This one answers a question about a VALUE the
 * host owns, and a root's value type routinely has no declaration to key by:
 * `window`'s is an intersection, whose `getSymbol()` is `undefined`, and a
 * host may equally declare a root with an anonymous object type. A structural
 * type id is also the only key `derive.ts` could read here at all, because
 * this has to be consulted BEFORE the shape switch rather than inside its
 * `'declared'` case -- an intersection never reaches that case.
 *
 * Why a root needs a carrier when the emitter never materializes one: a root
 * is a path, so `window.innerWidth` renders `gea::host::window.innerWidth()`
 * and no cell named `window` exists (`projection/bindings.ts`'s
 * `host-namespace` storage). But the program still PUBLISHES a reference and a
 * binding read for the root, and every published result gets a carrier. With
 * no answer here the only one available is the root's ambient declaration, and
 * `deriveIntersection` flattens lib.dom's `Window` into a 26-field struct
 * naming protocol tags -- `gea_native_protocol_Window_v1`,
 * `..._ServiceWorker_v1` -- that no plugin declares and no header defines. That
 * struct is unreachable from any value in the program and still lands in the
 * translation unit, because `targets/cpp/records.ts` seeds from every selected
 * carrier; `examples/bouncing-balls` certified clean, emitted 6230 lines, and
 * was rejected by clang for exactly that.
 *
 * The answer is a `native-record-ref` with the stated `native` spelling, which
 * is the carrier that already means "the host defines this type, emit no
 * struct of your own for it". Never a `native-handle`: that would need a
 * protocol tag, and inventing `Window@1` is the regression
 * `semantics/host-protocols.ts` records having cost three apps their
 * certificate. Never `unresolved` either -- lattice bottom is the absence of an
 * answer, and there is a perfectly good one: `gea::host::window` is a real
 * `inline constexpr WindowFacade` in the engine's own `host/window.h`.
 *
 * A root the installed plugins state no type for answers `null` and derives
 * exactly as it did before. Nothing here invents a spelling.
 */
export interface HostNamespaceRootPolicy {
  /** The host's own type for this namespace root's object, or `null` for an ordinary value type. */
  readonly forType: (type: StructuralTypeId) => string | null
}

/** No namespace roots installed: every type falls through to its structural answer, unchanged. */
export const defaultHostNamespaceRootPolicy: HostNamespaceRootPolicy = {
  forType: () => null
}

/**
 * The field list a named record layout resolves to, or `null` for a shape that
 * carries none.
 *
 * `native-record-ref` names a shape and nothing else -- its layout lives in the
 * sealed table and is resolved at emission (`targets/cpp/records.ts`'s
 * `recordFieldsOfShape`), which is exactly what makes it finite for a recursive
 * interface. The conversion registry has to ask the same question earlier, to
 * decide whether a structural `record` satisfies that named shape, and a
 * policy is how it asks without the registry gaining a second opinion about
 * layout. A policy rather than a field on the carrier for the reason
 * `ClassHeritagePolicy` states: a layout is not carrier identity and would
 * wrongly enter `representationKey`.
 */
export interface RecordLayoutPolicy {
  readonly forShape: (shapeId: string) => readonly RecordField[] | null
  readonly indexesForShape?: (
    shapeId: string
  ) => readonly { readonly value: Representation; readonly key: 'string' | 'number' | 'symbol' }[]
  /** Data-only layouts, excluding accessors and open property sidecars. */
  readonly plainFieldsForShape?: (shapeId: string) => readonly RecordField[] | null
  /** The accessors a shape declares; `null` for a shape with no record layout. */
  readonly accessorsForShape?: (shapeId: string) => readonly RecordAccessor[] | null
  /** Whether a generated class provides a bindable instance method for this key. */
  readonly classMethodFor?: (declaration: DeclarationId, key: string) => boolean
  /**
   * The zero-argument instance method this key names when a call to it can be
   * spelled DIRECTLY from a bare receiver expression -- the body to call and
   * the carrier it answers -- or `null`.
   *
   * A fact about the projection, not a spelling: the caller composes the C++
   * name from the `FunctionId`, exactly as it does for every other body. What
   * this decides is the part only the class table can decide -- whether the
   * key is a method at all, whether its convention takes nothing but the
   * receiver, and whether any subclass overrides it. An overridden key
   * dispatches virtually, and a direct body call would run the BASE's
   * implementation against a derived instance, so such a key answers `null`
   * and its reader refuses rather than answering wrong.
   */
  readonly classDirectMethodFor?: (
    declaration: DeclarationId,
    key: string
  ) => { readonly callable: FunctionId; readonly result: Representation } | null
  /**
   * The carrier a class's GETTER publishes for this key, or `null` when the
   * key names no readable accessor on the class or its bases.
   *
   * A class's accessors are not in `forShape`: that list is physical storage,
   * and an accessor has none. So a record view of a class instance has to ask
   * for them separately, or a target field backed by a getter looks absent --
   * which is why `IncomingMessage` could not be viewed as
   * `{ rawHeaders: string[] }` at all, though every read of it answers.
   *
   * A carrier rather than a boolean because the view has to decide the pair:
   * the getter's own result is what the target field is built from, and the
   * two are not always the same carrier.
   */
  readonly classAccessorFor?: (declaration: DeclarationId, key: string) => Representation | null
  /** Whether no evaluation can instantiate this class (`semantics/uninstantiable-classes.ts`). */
  readonly classUninstantiable?: (declaration: DeclarationId) => boolean
}

export const defaultRecordLayoutPolicy: RecordLayoutPolicy = { forShape: () => null }
