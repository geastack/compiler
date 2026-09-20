import { cppDynamicArgumentHostParameters } from '../host/dynamic-argument-members.js'
import { cppNativeProtocolsOf } from '../host/native-protocols.js'
import { coreHostMembers } from '../host/host-members.js'
import { hasPropertyHelperClaims } from '../emit-in.js'
import { dynamicIteratorHelperClaims, enumerateHelperClaims, staticTupleIteratorHelperClaims } from '../emit-iterator.js'
import { cppInstanceofHelperKeys } from '../emit-instanceof.js'
import { completeTemplateObjectCapabilityKey } from '../../../representation/template-object.js'

/**
 * What the C++ backend has been WRITTEN to do, as opposed to what a given
 * program's plan happens to need -- the declared half of the target manifest.
 *
 * Split out of `manifest.ts` when that file crossed the architecture gate's
 * 800-line ceiling, and split here rather than at an arbitrary line because
 * the two halves answer different questions and change for different reasons.
 * This one grows every time the emitter learns an operation; `manifest.ts`
 * computes the per-plan half -- which of the carriers a plan actually selected
 * this backend can spell -- and does not change when a row is added here.
 */

/** Capabilities that exist because runtime support was written for them. */
export interface CppRuntimeCapabilities {
  readonly hasGenericCallPath: boolean
  readonly hasDynamicCallPath: boolean
  readonly propertyRecipes: ReadonlySet<string>
  readonly captureOwnershipSupport: ReadonlySet<string>
  readonly nativeProtocols: ReadonlySet<string>
  readonly dynamicArgumentHostParameters: ReadonlySet<string>
  readonly runtimeHelpers: ReadonlySet<string>
  readonly unsupportedRuntimeHelpers: ReadonlySet<string>
  readonly abruptEdgeHandlers: ReadonlySet<string>
}

/**
 * The capabilities of the backend as it stands.
 *
 * Each row here corresponds to something `emit.ts` actually renders, and to
 * nothing else. The order matters and is not a formality: a capability claimed
 * before it is implemented turns a preflight pass into a crash during
 * rendering, which is the exact failure preflight exists to prevent. So a row
 * is added only after the emitter refuses to throw for it.
 *
 * A recipe key names the carrier as well as the operation, because the two
 * together are what decides whether a recipe exists. `native-record-ref` field
 * access is a `->` member load and needs no runtime at all; the same `[[Get]]`
 * on an ordinary object needs machinery nothing has written. Claiming
 * `get:false` without the carrier would assert both.
 */
export const currentCppRuntimeCapabilities: CppRuntimeCapabilities = Object.freeze({
  // `emit.ts` renders every call through the callable carrier's own invoke
  // pointer, which is the generic path: it needs no proof about the target, and
  // the ABI it calls through is the one the plan published. A direct call to a
  // known symbol would be a devirtualization on top of this, not a substitute
  // for it, so it stays unclaimed until it is written.
  hasGenericCallPath: true,
  // `gea::Value::callAsFunction` (gea_runtime.h): a thunk recorded at
  // `Value::box`, where the payload's signature is still a C++ type, adapting
  // boxed arguments to the callable's own declared parameters and boxing its
  // result back. Arity is the language's -- an omitted argument is
  // `undefined`, an extra one is dropped -- and a payload that is not a
  // callable, or whose parameter types the header states no rule for, refuses
  // by name instead of answering. `emit-callable.ts`'s `dynamicCallText`
  // renders it.
  hasDynamicCallPath: true,
  propertyRecipes: new Set<string>([
    // GetV throws for either nullish receiver after the computed key has
    // evaluated. emitGet installs that path without object materialization.
    'undefined:get:false',
    'undefined:get:true',
    'null:get:false',
    'null:get:true',
    'void:get:false',
    'void:get:true',
    // A receiver carried as an optional, accessed on a branch that proved it
    // present -- see `unwrapPresentValue` (emit-context.ts) for why the
    // language admits no other kind of access through one, on either the read
    // or the write side. The payload's own recipe still has to be claimed
    // separately; this row only says the dereference is renderable.
    //
    // `emitFieldStoreLines` (emit-properties.ts) unwraps the receiver the
    // identical way `emitGet` already did -- both a constant and a computed
    // key reach the SAME unwrap, so both `:set:false` and `:set:true` are one
    // capability, not two, exactly as the two `:get:*` rows above already are.
    'optional:get:false',
    'optional:get:true',
    'optional:set:false',
    'optional:set:true',
    'record:get:false',
    'record:set:false',
    'record:define-own-property:false',
    // `g.next()`/`.return()`/`.throw()` on an iterator, carried as the cursor
    // `iterator(T)` (`representation/model.ts`). Each member is claimed BY
    // NAME, the way `function-value-dispatch(call)` is:
    // `preflight/property-access.ts` refines the receiver key with the
    // constant member it reads, so these three rows certify exactly those
    // three members and nothing else -- a flat `iterator:get:false` would
    // have certified `[Symbol.iterator]` and any other member too.
    // `emit-carrier-members.ts`'s `iteratorMemberText` defers the read and
    // `prototype/emit-prototype-iterator.ts` renders the fused call --
    // `return`/`throw` further refined there, by the receiver's own
    // `source` tag, to a real generator's cursor: the four fixed-storage
    // walks publish this same carrier but their actual
    // `%ArrayIteratorPrototype%`-and-siblings define neither method
    // (ECMA-262 27.1.2), so a claim here is necessary but not sufficient for
    // them, exactly like `record-with-index`'s per-site refinement below.
    'iterator(next):get:false',
    'iterator(return):get:false',
    'iterator(throw):get:false',
    'native-record-ref:get:false',
    // `emit-properties.ts`'s `emitGet` fallback (the same one `:get:false`
    // above claims) resolves its key through `staticKeyTextOf`, which reads
    // `ctx.constantTexts` and does not consult `operation.keyIsComputed` at
    // all: `mesh['position']` and `mesh.position` reach the identical struct
    // member load once the key is a literal, because the census already
    // records both spellings as the same `constant` key operand. So a
    // computed get needs nothing this backend has not already written --
    // unlike `record-with-index`, whose computed form would have to route
    // into a dictionary sidecar this codebase has twice refused to build
    // (see that recipe's own comment below), a `native-record-ref` receiver
    // has no such second path to reopen: field access is field access
    // either way. A key that is genuinely dynamic (no recorded constant
    // text) still fails closed exactly as it already does for `:get:false`
    // -- `staticKeyTextOf` throws its own "dynamic-property-key" refusal at
    // emission, unconditionally on `computed` -- so claiming this recipe
    // widens what preflight admits without widening what the emitter
    // actually renders.
    'native-record-ref:get:true',
    'native-record-ref:set:false',
    'native-record-ref:define-own-property:false',
    // `record-with-index`'s named half is exactly a `record` field -- a fixed
    // struct member with its own static offset -- so a constant key that
    // spells one of the carrier's own fields renders through the identical
    // struct-access fallback `record`/`native-record-ref` use above (see
    // `emit-properties.ts`'s `recordWithIndexFieldText`).
    // `preflight/property-access.ts`'s `recordWithIndexKeyNamesAField` checks
    // the match per site, because this flat claim cannot see which key a
    // given operation reads.
    'record-with-index:get:false',
    // A constant key that names NO field routes into the index-signature
    // sidecar instead -- `emit-carrier-members.ts`'s
    // `recordIndexSidecarReadText`/`recordIndexSidecarTableOf`, over the
    // identical `gea::Dictionary`/`gea::NumericDictionary` machinery
    // `dictionary:get:true` below already renders, reached through one more
    // member access. Claimed under its own, deliberately DIFFERENT receiver
    // spelling (`property-access.ts`'s `buildPropertyAccessObligation` gives
    // this exact case the refined key `record-with-index(unmatched-key)`)
    // rather than folding it into the bare `record-with-index:get:false`
    // claim above: the two are different capabilities that happen to share a
    // carrier and a `computed` flag, and only THIS one needs
    // `recordWithIndexKeyNamesAField` to have already said "no" before the
    // claim is honest -- the bare claim above is asked (and honoured) only
    // when it says "yes".
    'record-with-index(unmatched-key):get:false',
    // A COMPUTED key, by contrast, never spells a specific field by
    // construction -- the checker itself answers a computed numeric/string
    // read of an interface with both named members and an index signature
    // (`ArrayLike<number>`, `{ length: number; [i: number]: number }`)
    // through the index signature, never through a named field, because it
    // cannot know at compile time which field a runtime key names. So every
    // computed `get` on a `record-with-index` receiver routes into its
    // `gea_dynamic` sidecar (`records.ts`'s `renderStructDefinition` gives
    // every such struct one), rendered by `emit-carrier-members.ts`'s
    // `recordIndexSidecarReadText` -- the same `gea::Dictionary`/
    // `gea::NumericDictionary` machinery `dictionary:get:true` below already
    // renders, reached through one more member access. Unconditional,
    // unlike `record-with-index:get:false` above: `record-with-index`'s
    // every instance *by construction* has an index signature (that is what
    // distinguishes it from a plain `record`), so there is no per-site
    // "does this one actually have a sidecar" question to ask.
    'record-with-index:get:true',
    // The store side of the identical split, over the identical machinery,
    // now that `emit-properties.ts`'s `recordOwnershipOf`/
    // `declaredFieldRepresentationOf` (`records.ts`) spell the struct half
    // and `emit-carrier-members.ts`'s `emitRecordIndexSidecarStore` spells
    // the sidecar half for BOTH a constant key naming no field and a computed
    // key (which, exactly as the read side's comment above states, can never
    // name one). `property-access.ts` raises one bare `record-with-index:
    // set:*` obligation per site regardless of which half a key resolves to
    // -- unlike `get`, `buildPropertyAccessObligation` gives `set` no
    // "(unmatched-key)" refinement, because a STORE has no second, narrower
    // capability to tell apart: whichever half a key's own `recordOwnershipOf`
    // and `emitRecordIndexSidecarStore` route it to, the site is answered.
    // So claiming this honestly requires both halves to already render,
    // which is why this sits after the struct-member write (above, shared
    // with `record`/`native-record-ref`) and the sidecar store both exist.
    'record-with-index:set:false',
    'record-with-index:set:true',
    // Object-literal definitions use a fully permissive data descriptor.
    // The named half reaches the ordinary struct store, while an unmatched or
    // computed key reaches `emitRecordIndexSidecarStore`; both preserve the
    // typed index value rather than widening the record to `gea::Value`.
    'record-with-index:define-own-property:false',
    'record-with-index:define-own-property:true',
    // `native-record-ref` names a shape by id rather than carrying its own
    // layout (model.ts); the identical `ArrayLike<number>`-shaped interface
    // derives this carrier instead of `record-with-index` when it reaches
    // representation selection through a *named* declaration
    // (`representation/derive.ts`'s `declared` case) rather than an inline
    // object type. A computed `get` needs the identical sidecar read, once
    // the shape it names is resolved (`emit-carrier-members.ts`'s
    // `recordIndexSidecarTableOf`) -- but unlike `record-with-index`, not
    // every `native-record-ref` names a shape with an index signature at all
    // (an ordinary interface has none), so this is NOT claimed
    // unconditionally: `preflight/property-access.ts`'s
    // `nativeRecordRefHasIndexSidecar` checks the named shape per site, the
    // same way `constructorFamilyIsCensused` checks a `constructor-family`
    // receiver's class per site above.
    'native-record-ref:get:true',
    // A class instance is a struct of its own fields, so a field load and store
    // are the same `->` member access a record uses. Method and accessor keys
    // are deliberately absent: neither is instance storage, and the emitter
    // refuses a key it finds no field for rather than loading a member that
    // does not exist.
    'class-ref:get:false',
    'class-ref:set:false',
    'class-ref:define-own-property:false',
    // The constructor side of a class -- a static method or get-only
    // accessor read off the class value itself (`Quaternion.fromEuler`), and
    // the assignment-only static field three.js spells as a bare
    // `Object3D.DEFAULT_UP = new Vector3(0, 1, 0)`. That second kind is real
    // emitted storage: `class-layout.ts`'s `censusClassStaticFieldStorage`
    // claims one global per (class, key) the whole program writes,
    // `records.ts` defines them ahead of every body, and both directions
    // resolve one through the single `classConstructorStaticFieldName`. A key
    // a `static` member DECLARES is still absent -- the census skips those,
    // so no storage exists to read or write -- and so is a computed key,
    // which is why only the `false` rows are claimed. This recipe resolves a
    // specific site only when
    // `projectClasses` actually published the receiver's class -- an ambient
    // `declare class` never is (`semantics/program.ts` excludes declaration
    // files from the census), so `preflight/run.ts` additionally verifies
    // that per declaration before calling this obligation satisfied; see its
    // own comment for why the flat claim below is not enough by itself.
    'constructor-family:get:false',
    // A computed key on the constructor is a dispatch over that same finite
    // member set (`emit-dynamic-properties.ts`'s
    // `constructorFamilyComputedGetText`): `C[String(1)]` after
    // `static [1] = 2`. Reads only -- a computed WRITE would need storage for
    // a key nothing declared, which the constructor object does not have.
    'constructor-family:get:true',
    'constructor-family:set:false',
    'constructor-family:define-own-property:false',
    // An Array's `length` get/set, its element get/set by a numeric key
    // (computed or a constant that spells a canonical index -- `a[0]` and
    // `a[i]` are the same rule, just with the index known at different
    // times), and `length`'s own truncate/extend write. The ordinary-property
    // half of an Array object is deliberately absent, with one exception: a
    // constant key naming an `Array.prototype` METHOD this backend renders
    // (`emit-prototype-array.ts`'s `arrayMethods` is the one authority for
    // which) defers instead of refusing, and fuses with the call that follows.
    // Every other non-index, non-`length` constant key still needs a property
    // table this carrier does not have, and the emitter refuses those by name
    // -- with a stated reason where there is one (`arrayMemberRefusals`).
    // A dictionary is a `std::map`-backed table, so every key reaches it the
    // same way whether the source spelled a computed one (`counts[k]`) or a
    // constant (`counts.total`): both are one lookup in one container, which
    // is why both the computed and the static row are claimed. The read is
    // `Dictionary::read`, which does not insert; the store is `operator[]`,
    // which does. `record-with-index`'s index sidecar is this identical
    // container (see `records.ts`'s `renderStructDefinition`), but nothing
    // claimed above reaches it: that claim is scoped to a key naming one of
    // the carrier's own named fields, and a key that would have to land here
    // instead -- computed, or a constant naming no field -- stays refused by
    // name, deliberately (see that claim's own comment for why).
    'dictionary:get:false',
    'dictionary:get:true',
    'dictionary:set:false',
    'dictionary:set:true',
    'dictionary:define-own-property:false',
    'dictionary:define-own-property:true',
    'array-object:get:false',
    'array-object:get:true',
    'array-object:set:false',
    'array-object:set:true',
    // A typed array's element get/set (constant canonical index, computed
    // scalar index, and `length`) -- the same computed/constant/`length`
    // shape `array-object` claims above. Its ordinary-property half is
    // absent for the same reason: ECMA-262 23.2's integer-indexed exotic
    // object has no ordinary-property table this carrier keeps, and the
    // emitter refuses those by name -- see `typedArrayAccessText`/
    // `emitFieldStore` in emit-properties.ts.
    'typed-array:get:false',
    'typed-array:get:true',
    'typed-array:set:false',
    'typed-array:set:true',
    // An ArrayBuffer's own reads: `byteLength`, and the `slice` method that
    // defers and fuses with its call. It has no indexed access at all --
    // ECMA-262 25.1 gives it no exotic `[[Get]]`, so `b[0]` really is
    // `undefined` -- which is why only the constant-key half is claimed here,
    // and why a computed key on one is refused by name at emission rather
    // than answering a byte.
    'array-buffer:get:false',
    'shared-array-buffer:get:false',
    // A DataView's `getInt8`/`setFloat64`/... plus its three geometry
    // accessors, all constant keys. Same reasoning: no indexed access exists
    // on a DataView either.
    'data-view:get:false',
    // A string's `length` read -- its count of UTF-16 CODE UNITS, ECMA-262
    // 6.1.4, not of the UTF-8 bytes this backend stores it in -- plus every
    // `String.prototype` method `emit-prototype-string.ts`'s `stringMethods`
    // renders, which defers at the access and fuses with the call that
    // follows. Every other static key is still a method refused by name in
    // the emitter, because the checker gives an ambient interface method no
    // `this` parameter and the resulting calling convention has nowhere to
    // carry the receiver -- see `stringMemberText` in emit-carrier-members.ts,
    // and `stringMemberRefusals` for the members that state a reason.
    'string:get:false',
    // A symbol's `description` (ECMA-262 20.4.3.2), `symbolMemberText` in
    // emit-carrier-members.ts; every other constant key refuses by name there.
    'symbol:get:false',
    // A string INDEX read, `s[i]` -- ECMA-262 10.4.3's String exotic `[[Get]]`,
    // which is the only thing a computed key on a string can be: `ToPropertyKey`
    // of a number is its String, and no `String.prototype` member has a name a
    // number spells. Rendered by `stringIndexText` (emit-carrier-members.ts)
    // through `gea::runtime::string::charAt`, which already owns the UTF-16
    // code-unit projection over this backend's UTF-8 storage. Claimed
    // unconditionally, because the one case it does not cover -- a result
    // carried as `string | undefined`, the shape `noUncheckedIndexedAccess`
    // gives every indexed read -- is refused by name at emission rather than
    // rendered wrong.
    'string:get:true',
    // A `scalar` (`number`, `boolean`, ...) has no own data property at all --
    // every static key is a `Number.prototype`/`Boolean.prototype` method. The
    // three `Number.prototype` formatters (`toFixed`/`toExponential`/
    // `toPrecision`) defer and fuse with their call, exactly as `substring`
    // does off a string; every other key is still refused for the same
    // missing-receiver reason `string:get:false` refuses every key but
    // `length`. See `scalarMemberText` in emit-carrier-members.ts.
    'scalar:get:false',
    // A promise has no own data property either: `then`/`catch`/`finally` are
    // `Promise.prototype` methods, and `then` is the one this backend renders
    // -- deferred and fused with its call exactly as `substring` is off a
    // string (`promiseMemberText`, emit-carrier-members.ts). `catch`/`finally`
    // stay refused by name and not for lack of syntax: this runtime's promise
    // carries a fulfilled value and no rejection state, so a rejection handler
    // would be a handler that can never run.
    'promise:get:false',
    // A `Map`/`Set`/`WeakMap`/`WeakSet` receiver. `size` renders directly (it
    // is an accessor over the collection's own storage, ECMA-262 23.1.3.14 /
    // 24.2.3.9, not a method); every claimed METHOD defers and fuses with its
    // call exactly as `then` does off a promise -- see
    // `keyedCollectionMemberText` (emit-carrier-members.ts) and
    // `keyedCollectionPrototypeMethods` (emit-prototype-invoke.ts), which is
    // the one authority for which members exist per family. Everything else on
    // these four interfaces -- `forEach`, `keys`/`values`/`entries`, the
    // ES2025 set-algebra family, `getOrInsert` -- is still refused by name at
    // the access, and `size`/`clear` are refused on the two WEAK families
    // specifically, because ECMA-262 gives them neither.
    //
    // A computed key ("get:true") is absent for the same reason
    // `array-object`'s ordinary half is: there is no runtime member table on
    // these carriers to dispatch a computed name against.
    'keyed-collection:get:false',
    // A host singleton (`Math`, `Date`, `String`, ...) has no runtime member
    // table at all -- every key is a qualified `gea::host::<protocol>::<key>`
    // symbol resolved at compile time, so a computed key has nothing to
    // dispatch against. See `nativeHandleMemberText` in emit-host-properties.ts.
    'native-handle:get:false',
    // The write half of the same member table (`nativeHandleStore`, same
    // file). A host property is written through the host's own store spelling
    // with `{value}` filled in, never through a field offset this compiler does
    // not own -- and a member no table claims as settable is refused by name at
    // the site, exactly as an unclaimed read is. Claimed only now that the
    // renderer exists: this set is added to after the emitter stops throwing,
    // never before.
    'native-handle:set:false',
    // `delete Math.SQRT2` and its siblings -- the ANSWER `[[Delete]]` gives
    // for a host intrinsic's own member, read from the same static host
    // member table `native-handle:get:false` already consults, never a real
    // removal (a native-handle carries no per-instance storage to remove
    // from). See `emitNativeHandleDelete` in emit-dynamic-properties.ts.
    'native-handle:delete:false',
    // The computed-key half of all three, for a namespace-shaped intrinsic
    // (`Math[name]`, `Math[name] = v`, `delete Math[name]` with a runtime
    // `name`): a static name-comparison chain over the protocol's classified
    // member table in front of a per-protocol runtime sidecar
    // (`gea::detail::hostIntrinsicSidecar`). See `computedNativeHandleGetText`
    // in emit-host-properties.ts for the design and its one stated limit.
    // test262's `verifyProperty` reaches all three on every host-intrinsic
    // `prop-desc` case.
    'native-handle:get:true',
    'native-handle:set:true',
    'native-handle:delete:true',
    // The `dynamic` carrier's own property table -- `gea::Value`'s
    // `DynamicObject`, rendered by `emit-dynamic-properties.ts`.
    //
    // This is the one carrier for which a *dynamic* property operation is the
    // correct lowering rather than a defect. A value the program itself
    // declared `any`/`unknown` and never narrowed is one of the four boundaries
    // `representation/model.ts` admits, and `obj[k] = v` over one is ordinary
    // TypeScript that a compiler which refuses it simply cannot compile. What
    // is NOT here is any suggestion that a statically typed receiver may reach
    // this row: a class instance used dynamically keeps its `class-ref`
    // carrier and answers through its own sidecar (`class-ref:get:true`
    // below), because boxing it to get here is exactly the shortcut this
    // compiler refuses.
    //
    // Computed and static are both claimed, and for the reason
    // `dictionary`'s two rows above are: one table, one lookup, and the key's
    // spelling is the only difference -- a constant renders as a
    // `gea::PropertyKey::string` literal, a computed one converts through
    // `propertyKeyText`. A key carrier that has no ToPropertyKey (an object,
    // whose conversion runs user code) is still refused by name at the site.
    // The one `set` recipe covers both Reference strictness modes because the
    // semantic operation carries `strict` through typed IR: emission calls
    // `Value::reflectSet`, throws on its false result only for strict code,
    // and explicitly discards that same false result for sloppy code.
    'dynamic:get:false',
    'dynamic:get:true',
    'dynamic:set:false',
    'dynamic:set:true',
    'dynamic:delete:false',
    'dynamic:delete:true',
    'dynamic:has-property:false',
    'dynamic:has-property:true',
    // `[[DefineOwnProperty]]` with the default attributes IS `[[Set]]` on a
    // key the object does not hold (ECMA-262 10.1.9.2 step 1.d.iii creates a
    // writable, enumerable, configurable data property), which is exactly what
    // `DynamicObject::set` installs -- so the same renderer answers both
    // rather than a second one that could disagree about the attribute
    // defaults.
    'dynamic:define-own-property:false',
    'dynamic:define-own-property:true',
    // The dynamic-property SIDECAR on a statically typed receiver: a class
    // instance or a record reached through a key only known at runtime.
    //
    // `(this as any)[key] = v` and `(raw as any)[prop]` are ordinary
    // TypeScript, and the receiver of both keeps its native C++ type all the
    // way through. Its declared members are reached by the field dispatcher
    // `records.ts` renders on the struct -- so a dynamic write to a declared
    // field is seen by every native read of that same field -- and the keys
    // the struct does not declare live in a `gea::DynamicObject` keyed on the
    // object's own ownership, shared with any box of the same object.
    //
    // Computed only. A constant key names a declared member and is reached as
    // one, by the branches above these in `emitGet`/`emitFieldStore`; routing
    // it through a runtime lookup instead would be slower and no more correct.
    'class-ref:get:true',
    'class-ref:set:true',
    'record:get:true',
    'record:set:true',
    'native-record-ref:get:true',
    'native-record-ref:set:true',
    // The same claim under the more specific name `preflight/property-access.ts`
    // gives a `native-record-ref` computed read whose named shape derives NO
    // index sidecar. That specialization exists because routing such a read
    // into a sidecar member the struct does not declare would be a claim about
    // storage that is not there -- and the sidecar path claimed here is a
    // different answer to the same question: the struct's field dispatcher
    // answers its declared members, and the expando answers the rest, neither
    // of which needs an index signature to exist.
    'native-record-ref(no-index-sidecar):get:true',
    // A `[[DefineOwnProperty]]` with a COMPUTED key on a `native-record-ref`
    // receiver -- `Object.defineProperty(shape, key, {value, ...})` or a
    // dynamic class-field-like install where the key is not a source
    // literal. `emit-properties.ts`'s `emitFieldStoreLines` guards every
    // `define-own-property` (this receiver included) on the descriptor
    // actually being the default writable/enumerable/configurable data
    // triple before reaching here, and once past that guard a
    // `define-own-property` and a `set` render through the identical
    // sidecar (`emitNativeSidecarSet`, `emit-dynamic-properties.ts`) this
    // receiver's `set:true` row above already claims -- so this is that
    // same primitive, claimed under `define-own-property`'s own name rather
    // than assumed to fall out of the `set` claim.
    'native-record-ref:define-own-property:true',
    // A runtime-only delete key is deliberately unclaimed for record-shaped
    // receivers. It can name either an expando or an optional declared field,
    // and the runtime dispatcher does not yet carry the field-specific clear
    // operation needed for the latter. Returning `false` there would silently
    // treat a configurable generated field as non-configurable.
    // A compiler-emitted optional field has a value member plus an independent
    // presence bit. A constant delete clears both and therefore preserves the
    // distinction between a missing key and a present `undefined` value.
    // Preflight refines only a key proven to name such a field to this row;
    // required fields and host-native layouts remain refused.
    'record(optional-field):delete:false',
    'record(optional-field):delete:true',
    // A constant delete key naming NO declared field at all -- neither
    // required nor optional -- names a key the sidecar itself owns (one
    // `Object.defineProperty` added after the fact, since the checker's own
    // ambient signature does not widen the receiver's declared shape). That
    // is a DIFFERENT case from the one the comment above refuses: there is no
    // struct member here to mis-clear, only the same `gea::DynamicObject`
    // expando table `record:get:true`/`record:set:true` above already claim,
    // and `deleteOwnProperty` (gea_runtime.h, 10.1.10.1) refuses a
    // non-configurable entry there exactly as it does for every other
    // carrier reaching it -- see `emitNativeSidecarDelete`
    // (emit-dynamic-properties.ts). Certification names that case
    // (`deleteNamesRecordExpandoKey`, ir/certify/property-access.ts), so the
    // plain `record:delete:false` left over is a constant key naming a
    // REQUIRED field, which stays unclaimed: the field's presence bit exists
    // but no typed read consults it, and this row claimed for ten days what
    // the emitter refused by the same name.
    'record(expando-key):delete:false',
    // Generated class instances dispatch deletion through their concrete
    // own-field table and identity sidecar, including base-typed receivers.
    'class-ref:delete:false',
    // A native-record-ref whose resolved generated shape has an index
    // sidecar, with a constant key proven not to name a fixed field. The
    // generated sidecar owns this entry's configurable state, and
    // `nativeDynamicDelete` dispatches to that exact table. This stays a
    // refined row: a computed key could name an optional generated field,
    // whose clear protocol is different, and must not be certified here.
    'native-record-ref(index-sidecar):delete:false',
    // Shared disjoint index authority proves the key cannot name a fixed slot.
    // The native delete recipe consults the typed index's configurable state.
    'record(disjoint-index):delete:false',
    'record(disjoint-index):delete:true',
    // A `dictionary`'s own `std::map`-backed table (`emitDictionaryDelete`).
    // Both computed and constant keys reach the identical `erase`, for the
    // same reason `dictionary:get:false`/`:get:true` above are both
    // claimed: one table, one lookup, and the key's spelling is the only
    // difference.
    'dictionary:delete:true',
    'dictionary:delete:false',
    // Reading/writing a STATIC key through a `tagged-union` receiver, over
    // the arms that all declare the field named
    // (`emit-union-properties.ts`'s `taggedUnionGetText`/
    // `emitTaggedUnionSet`). A union with even one arm that does not
    // declare the field refuses by name at emission instead: this is a
    // per-site fact the flat claim below cannot see, exactly the same
    // asymmetry `class-ref:get:false`'s per-key refusal already lives with.
    // A COMPUTED key over a MIXED-kind union (an `array-object` arm beside a
    // `dictionary` arm, say) is deliberately absent -- a per-arm dispatch of
    // a runtime-only key over arms of different KINDS would additionally
    // have to reconcile their different read primitives, which is not
    // written. The two shapes that owe no such reconciliation are claimed
    // below under their own refined keys instead of widening this one.
    'tagged-union:get:false',
    'tagged-union:set:false',
    // The computed key IS written for the two union shapes that owe no
    // ARM-KIND reconciliation: every arm a `typed-array`
    // (`emit-union-properties.ts`'s `taggedUnionElementText` /
    // `emitTaggedUnionElementSet`). `TypedArray` is nine views differing only
    // in element WIDTH, and `TypedArray::elementAt` returns `double` for all
    // of them, so the per-arm dispatch produces one C++ type on every arm.
    // Refined into its own key by `preflight/property-access.ts` rather than
    // widening the flat claim above, which would over-claim for the
    // `array-object`- and `dictionary`-shaped arms that reconciliation is
    // about.
    'tagged-union(typed-array-arms):get:true',
    'tagged-union(typed-array-arms):set:true',
    // ...and every arm a `dictionary` (`emit-union-properties.ts`'s
    // `taggedUnionDictionaryGetText`/`taggedUnionHasOnlyDictionaryArms`,
    // refined by `preflight/property-access.ts`'s
    // `taggedUnionArmsAreAllDictionaries`). Every `dictionary` renders a
    // computed read through the identical `member.read(key)`/`.has(key)`
    // pair regardless of its value type, so only each arm's own VALUE needs
    // reconciling to what the union's `get` publishes
    // (`dictionaryArmReadText`'s `widenedStoreText` call) -- hono's
    // `ParamIndexMap | Params` route table and `Record<string, string> |
    // Record<string, string[]>` query-string result are both this shape.
    // `:set:true` is deliberately absent: a computed WRITE into one of these
    // arms is not a per-arm dispatch at all -- hono's own
    // `results[name] = []` writes through the SAME live dictionary whichever
    // arm it is, other keys included, so "switch the union's tag to answer
    // this one write" would silently reinterpret every other entry already
    // stored under the other arm's value type. That is a real gap in how
    // this receiver shape is derived (a single dictionary of a per-entry
    // union value, not a union of two whole dictionaries), not an emitter
    // gap this file's evidence justified papering over.
    'tagged-union(dictionary-arms):get:true',
    // ...and every arm an `array-object` (`emit-union-properties.ts`'s
    // `taggedUnionArrayGetText`/`taggedUnionHasOnlyArrayObjectArms`, refined
    // by `preflight/property-access.ts`'s `taggedUnionArmsAreAllArrayObjects`).
    // Every `array-object` renders a computed read through the identical
    // `elementAt`/`hasElement` pair regardless of its own element type, so
    // only each arm's own ELEMENT needs reconciling to what the union's
    // `get` publishes (`arrayArmReadText`'s `widenedStoreText` call) --
    // hono's `[T, ParamIndexMap][] | [T, Params][]` router match result
    // (indexed by `routeIndex`) is this shape. `:set:true` stays unclaimed
    // for the same reason the dictionary-arms case above declines it.
    'tagged-union(array-arms):get:true',
    // A runtime key over a tagged union of generated shared records/classes
    // (and genuine dynamic/nullish alternatives) dispatches per live arm to
    // `nativeDynamicGet`/`Value::getProperty`.  The native helper checks
    // fixed fields and typed index entries before the identity-keyed expando;
    // `emit-union-properties.ts` decodes the resulting value into the
    // already-selected result carrier.  Host-native and by-value arms stay
    // absent: neither has this generated sidecar contract.
    'tagged-union(native-sidecar-arms):get:true',
    // Its store twin (`emitTaggedUnionNativeSidecarSet`): `nativeDynamicSet`
    // per live arm, the value boxed only for the sidecar.
    'tagged-union(native-sidecar-arms):set:true',
    // Each alternative retains its own native array/table storage. Numeric
    // named record fields are excluded by the shared indexing predicate.
    'tagged-union(numeric-index-arms):get:true',
    'tagged-union(numeric-index-arms):set:true',
    // `Function.prototype.call` read off a genuinely callable value --
    // `add.call(x, 3, 4)`. There is no C++ object anywhere that implements
    // `Function.prototype.call` itself (`lib.es5.d.ts`'s `strictBindCallApply`
    // overload is a checker-only convention, not a physical one this or any
    // backend could render a member for), so this is not a member LOAD the
    // way `record:get:false` above is: `ir/lower-invocation.ts`'s
    // `deferredFunctionCallCalleeOf` rewrites the *invocation* that reads this
    // member to call the underlying receiver directly, with the read's own
    // value never materialized -- which is why this claim has no emitter
    // counterpart in `emit-properties.ts` to point at, unlike every other row
    // in this set. Refined by `preflight/property-access.ts`'s
    // `deferredFunctionPrototypeMember`, the same per-site technique
    // `constructorFamilyIsCensused` and its siblings already use: the flat
    // manifest can only say "a `.call` read off a callable value has
    // somewhere to go", never which literal member name a given site actually
    // reads, so a `.foo` read off the same receiver kind that is not
    // `call` stays correctly unclaimed rather than silently over-claimed.
    'function-value-dispatch(call):get:false',
    'function(call):get:false',
    'function-family(call):get:false',
    'function-value-family(call):get:false',
    // `Function.prototype.apply` read off a callable value --
    // `Math.max.apply(null, [1, 5, 3])`. Identical shape to `.call` above,
    // and the same reasoning: no C++ object implements `.apply` itself, so
    // `ir/lower-invocation.ts`'s `deferredFunctionApplyCalleeOf` rewrites the
    // invocation to call the underlying receiver directly -- the read's own
    // value is never materialized -- which is why this claim has no emitter
    // counterpart either. Refined per-site by `functionValueMemberIs`, so a
    // `.foo` read off the same receiver kind that is not `apply` stays
    // correctly unclaimed.
    'function-value-dispatch(apply):get:false',
    'function(apply):get:false',
    'function-family(apply):get:false',
    'function-value-family(apply):get:false',
    // Only an immediately invoked bind read is admitted. It creates one new
    // native callable with a captured receiver/prefix; extracting `.bind`
    // itself remains unclaimed.
    'function-value-dispatch(bind-direct):get:false',
    'function(bind-direct):get:false',
    'function-family(bind-direct):get:false',
    'function-value-family(bind-direct):get:false',
    // When an own write may shadow call/apply/bind, preserve the ordinary
    // [[Get]] and invoke the Value returned by the callable's identity-owned
    // property table. Function.prototype mutation itself remains unclaimed:
    // the current runtime prototype object is immutable and cannot truthfully
    // observe that write.
    'function(prototype-dynamic):get:false',
    'function-family(prototype-dynamic):get:false',
    'function-value-family(prototype-dynamic):get:false',
    'function-value-dispatch(prototype-dynamic):get:false',
    'function-and-constructor(prototype-dynamic):get:false',
    'function-value-dispatch(toString-direct):get:false',
    // `.name`/`.length`: both `gea::CallableObject` facts decided once at the
    // allocation site (a callable's own declared name, or the `NamedEvaluation`
    // name from where an anonymous function/arrow literal was defined; the
    // written parameters before the first default/rest one) and read back
    // through `emit-properties.ts`'s matching arms. Refined the identical way
    // `function-value-dispatch(call)` is, by the exact constant key a given
    // site reads -- `.prototype`/`.bind` and any other `Function.prototype`
    // member off the same receiver kind stay correctly unclaimed.
    'function-value-dispatch(name):get:false',
    'function-value-dispatch(length):get:false',
    // The same two rows for a callable with no calling convention. Nothing
    // else is claimed off `callable-identity`: it has no `.call`/`.apply`/
    // `.bind` ladder, no expando arm and no computed-key arm, because the
    // value is a builtin this backend renders for reflection only.
    'callable-identity(name):get:false',
    'callable-identity(length):get:false',
    // An ordinary function's own `prototype`, materialized by
    // `gea::installCallableOrdinaryPrototype` (gea_runtime.h) exactly as a
    // `function-and-constructor`'s is -- one routine, because ECMA-262 10.2.5
    // `MakeConstructor` is one step and the two carriers differ only in
    // whether the checker also gave the value a construct signature. Refined
    // BY THE DECLARATION, not by this key alone: `ir/certify/property-access.
    // ts` admits the recipe only where the census proved the function makes a
    // constructor -- or proved it does not, which is the same read landing on
    // `Function.prototype`'s own (absent) `prototype` and answering
    // `undefined`. A generator, whose `prototype` exists but inherits an
    // intrinsic this runtime has no object for, states nothing and falls
    // through to the unrefined `function-value-dispatch:get:false`, which is
    // registered nowhere and refuses.
    'function-value-dispatch(prototype):get:false',
    // A function value is not widened merely because it receives an own
    // property. `CallableObject` keeps the call ABI and identity, while its
    // identity-owned dynamic-property table receives ordinary assignments.
    // This row deliberately covers writes only: reads still need a result
    // carrier and prototype-chain rule that the emitter has not installed.
    'function-value-dispatch:set:false',
    // Static deletion uses the same native Function-object property table as
    // computed deletion; a literal key does not require a different carrier.
    'function-value-dispatch:delete:false',
    // Fixed Function own properties and static expandos are separately
    // certified: preflight rejects Function.prototype members not named here,
    // and `callableDynamicGet` reads the one shared function-object table.
    'function-value-dispatch(expando):get:false',
    'function-value-dispatch(own-symbol):get:true',
    'function-value-dispatch(own-symbol):set:true',
    // A RUNTIME string key on a callable -- test262's property helper reads,
    // writes and deletes `obj[name]` on a builtin function to verify its own
    // `name`/`length`. The one shared function-object table answers all three
    // (`callableDynamicGet`/`callableDynamicSet`/`deleteOwnProperty`, facts
    // installed first). The prototype-chain rule this row states is the
    // narrow one the emitter renders: a key naming a `Function.prototype`
    // member this backend does not model (`call`, `apply`, `bind`, ...)
    // throws a TypeError at the read rather than answering `undefined` --
    // see `callableSidecarGetText`'s computed arm.
    'function-value-dispatch:get:true',
    'function-value-dispatch:set:true',
    'function-value-dispatch:delete:true',
    // A callable constructor retains both its call and construct entries. The
    // property rows below therefore never coerce it to a plain callable view.
    'function-and-constructor(call):get:false',
    'function-and-constructor(apply):get:false',
    'function-and-constructor(toString-direct):get:false',
    'function-and-constructor(name):get:false',
    'function-and-constructor(length):get:false',
    // `prototype` is a fixed own data property only on values proven to carry
    // [[Construct]]. The callable keeps both ABI entries while its shared
    // Function-object table performs ordinary Set/Delete, materializing that
    // fixed descriptor before either operation reaches it.
    'function-and-constructor(prototype):get:false',
    'function-and-constructor(expando):get:false',
    'function-and-constructor(own-symbol):get:true',
    'function-and-constructor(own-symbol):set:true',
    'function-and-constructor:set:false',
    'function-and-constructor:delete:false',
    'function-and-constructor:get:true',
    'function-and-constructor:set:true',
    'function-and-constructor:delete:true'
  ]),
  // `'value'`: a scalar, string, or callable carrier -- nothing else aliases
  // it, and a callable's own environment pointer is a deliberate, permanent
  // leak (see `emitAllocateCallable`), so a copy of the pair is exactly as
  // safe as the original. `'shared-refcount'`: a `shared_ptr`-backed carrier
  // (class-ref/record/native-record-ref/array-object/dictionary) whose copy
  // keeps the pointee alive as long as either copy survives, so the
  // environment's copy is never left dangling by the frame that allocated it
  // returning. `'owned'`: a by-value aggregate -- `cppOwnershipWrap` spells it
  // as the bare struct, so a copy into an environment copies the storage
  // itself, exactly as `'value'` does for a scalar, and any handle INSIDE it
  // copies by its own rule. It used to be listed with `'borrowed'` as "not
  // provably tied to the copy", which is true of a reference and not of a
  // value: the two tiers were being refused for one tier's reason. It refused
  // every closure capturing a host facade (`derive.ts` gives a namespace root
  // and a host-bound record `'owned'` outright) and every closure capturing a
  // value record. `'borrowed'` stays absent, and now for its own reason: it
  // is spelled `T&`, so the environment would transport a reference that can
  // outlive what it names.
  captureOwnershipSupport: new Set<string>(['value', 'shared-refcount', 'owned']),
  // "jsx-element"@1: the JSX intrinsic element's `native-handle` protocol.
  // `gea::NativeHandle<gea_native_protocol_jsx_element_v1>` and the
  // `gea::jsx::create`/`prop`/`child` operations it is built with live in
  // gea_runtime.h. Registered here, not guessed: `buildNativeBoundaryObligation`
  // in preflight/run.ts checks this exact `protocol@version` key before any
  // native-handle result is allowed to carry one.
  // "Math"@1 / "DateConstructor"@1 / "StringConstructor"@1: the three ambient
  // host-object protocols `gea_runtime.h`'s `gea::host` namespace actually
  // implements, member by member (see that header's comments for exactly
  // which members). These are genuine host boundaries: real ECMAScript
  // ambient globals with no TypeScript source anywhere to compile. A
  // `@geastack/core` export (`Display`, `WiFi`, `window`, `mount`, ...) is
  // NOT one of these -- it is ordinary TypeScript, compiled from
  // `runtime.ts` like any other module, and was only ever misclassified as
  // ambient by a stale project mapping that pointed the package's import at
  // its declaration file instead of its source. A per-framework registry of
  // such names is exactly the source-specific hack this manifest exists to
  // avoid: nothing framework-shaped is registered here, or ever should be.
  // "ErrorConstructor"@1 is the same kind of row, but for the *invocation*
  // half a `native-handle` can carry (`emit-host-invoke.ts`): `new Error(x)`
  // now has a real `gea::host::ErrorConstructor::create` behind it, message
  // only -- `ErrorOptions.cause` is accepted by the checker's overload set
  // and silently unread, exactly as that file's own comment states.
  // "Console"@1: `console.log`/`console.error` only, member by member, not
  // the full ~18-member `lib.dom.d.ts` interface -- no real corpus program
  // calls anything else (`citations.md` section 2a). A call to one of those
  // still refuses by name rather than emitting a call to a symbol
  // `gea_runtime.h` does not declare, same as any other unclaimed member.
  // Every other genuinely ambient interface (`ArrayBuffer`, ...) is real,
  // unclaimed ground: nothing here answers a read of one, so preflight
  // refuses those programs instead of emitting a call to a symbol this
  // header does not declare. `JSON`@1 (below) is claimed despite having no
  // `HostMember` template in this file's own table: its two members render
  // through a dedicated, type-directed path instead (`emit-json.ts`'s
  // `jsonCallText`, wired into `emit-host-invoke.ts`'s `hostCallText`),
  // because a fixed template signature for `stringify(value: any) =>
  // string`/`parse(text: string) => any` is only reachable by boxing every
  // call through it -- see citations.md finding 1 for the certify-then-fail
  // this claim would otherwise cause without that rendering already landed.
  // The eight typed-array constructors ARE claimed below, but not through
  // this call/construct-ABI mechanism the way Math/Date/String/Error/Number
  // are: their checker overload set has no single physical frame (`new
  // (length: number)` and `new (array: ArrayLike<number>)` are genuinely
  // different parameter-0 shapes; ECMA-262 23.2.5.1's buffer/iterable/copy
  // overloads are refused by name at emission), so `derive.ts` correctly
  // leaves `.construct` `null` for them and `emit-callable.ts`'s
  // `emitTypedArrayConstruct` renders directly off each construct operation's
  // own, already-resolved argument representation instead of the whole-type
  // ABI every other native-handle construct uses.
  // Every entry needs a matching `gea_native_protocol_<name>_v1` tag struct in
  // `runtime/gea_runtime.h`, and a real implementation behind it. A claim with
  // no tag certifies and then fails in clang, which is the one ordering this
  // manifest exists to prevent.
  //
  // Only the language's own. `Math`, `Date`, `String`, `Error`, `Number`,
  // `Promise` and the typed arrays are `lib.es5.d.ts`/`lib.es2015.*` -- the
  // ECMAScript standard library, which a TypeScript compiler must render to
  // compile TypeScript. `Console` and `Storage` are the two `lib.dom.d.ts`
  // names kept here deliberately: neither has a document or a node tree behind
  // it, and every JavaScript host in existence provides them.
  //
  // The document, the element tree, JSX and the audio graph are NOT here. They
  // are a host's model of itself, not the language's, so the plugin that
  // installs that host claims them alongside the templates that render them
  // (`plugins/gea/host.ts`), and `compiler.ts` unions the two sets in one step.
  // The authenticated host protocols, COMPUTED from `coreHostMembers` and the
  // emitter's own dispatch tables by `host/native-protocols.ts`'s
  // `cppNativeProtocolsOf` -- not a hand list, so a row here can no longer
  // drift from the renderer it claims to speak for. `createCppTargetManifest`
  // (manifest.ts) recomputes the same call for the specific host tables a
  // compilation actually built; this is the plugin-independent default for a
  // caller that supplies none.
  nativeProtocols: cppNativeProtocolsOf(coreHostMembers),
  // The member/role/positions whose call-site renderer takes a `dynamic`
  // argument straight through; `host/dynamic-argument-members.ts` owns the
  // list and states why each position needs the waiver while its siblings do
  // not.
  dynamicArgumentHostParameters: cppDynamicArgumentHostParameters,
  runtimeHelpers: new Set<string>([
    'computation:strict-equality:dynamic-number',
    'computation:strict-equality:dynamic-boolean',
    'computation:strict-equality:dynamic-string',
    'computation:strict-equality:dynamic-symbol',
    'computation:strict-equality:dynamic-bigint',
    'invocation:call:nullish',
    'invocation:construct:nullish',
    // `emitRegExpConstruct` preserves the typed Pattern path and sends only a
    // genuinely dynamic pattern/flags argument through the runtime brand +
    // ToString helper. The key is intentionally narrower than the protocol:
    // it does not claim arbitrary RegExp static members or calls.
    'invocation:construct:regexp-dynamic',
    // `v instanceof <error constructor>`: the seven rows `emit-instanceof.ts`
    // renders, derived from that file's own table so the claim and the
    // rendering are one list. Every other `instanceof` -- a program's own
    // class, another host protocol, a statically typed left operand -- has no
    // row and refuses by name there.
    ...cppInstanceofHelperKeys,
    // The control forms `ir/lower.ts`'s `lowerControl` actually renders, and
    // only those. `debugger` and `branch` are markers it deliberately drops
    // (a `branch`'s transfer is already built from `ConditionalEdge`
    // membership); `return` and `throw` render terminators; `loop` is a
    // head-tested loop whose blocks are the guard's own.
    //
    // Deliberately absent, each refused by name in `lowerControl` and now
    // refused earlier, here: `switch` (needs case dispatch), `label` (its
    // `label-target` boundary operation publishes no result, so nothing can
    // anchor an obligation for it -- a labelled `break`/`continue` therefore
    // stays certify-then-crash even though the loop/continue targets below
    // are real), `yield` (needs a real generator frame), and
    // `control:loop:iteration` -- a loop not driven by a boolean condition,
    // which is what a `for...of` is.
    //
    // `break` and `continue` render as an ordinary `goto` out of (`break`) or
    // back into (`continue`) the enclosing loop's own blocks -- `loopExitOf`
    // and the loop's header/latch, both already built for the loop's own test
    // -- so they are claimed here now that the census mints a `completion`
    // result for them to anchor this obligation on (`producers/control.ts`,
    // `contributeBreakOrContinue`).
    //
    // `await` is claimed too, as of `ir/lower.ts`'s `lowerControl` `'await'`
    // case and `emit.ts`'s `emitAwait`: not a real suspension (this substrate
    // has no coroutine primitive), but the honest, narrower answer this
    // runtime's settled-value-only `gea::Promise` supports -- see
    // `AwaitOperation`'s doc comment (`ir/model.ts`) and `gea::Promise::
    // awaited()` (`runtime/gea_runtime.h`) for why reading the value
    // immediately is complete for every promise this backend can construct.
    'control:debugger',
    'control:branch',
    'control:return',
    'control:throw',
    'control:loop',
    // `do`/`while`: the head-tested loop's own blocks in the other order --
    // body in the header, condition in the latch, and the latch's terminator
    // is the conditional back edge (`ir/lower-flow.ts`'s `closeBackEdge`).
    'control:loop-tail',
    'control:break',
    'control:continue',
    'control:await',
    // The `await` resume boundary (`producers/control.ts`'s `contributeAwait`
    // mints one alongside every `control:await`). Claimed for the same reason
    // `control:await` is: `ir/lower.ts`'s `lowerBoundary` renders it as
    // nothing, honestly, because this backend's `await` never suspends -- see
    // that function's own comment.
    'boundary:async-resume',
    // Real native C++ `try`/`catch`, over a straight-line try/catch body only
    // (`targets/cpp/emit-exceptions.ts`'s `straightLineChain` refuses a
    // branch or a loop inside one by name at emission, since
    // `ir/lower-flow.ts`'s region bookkeeping does not yet track the extra
    // blocks either would need). A `finally` clause is refused earlier still,
    // the moment the try marker itself lowers (`ir/lower.ts`'s `'try'` case).
    'control:try',
    // The caught value, only reached at all for a *bound* `catch (e)`
    // (`preflight/run.ts`'s `buildRuntimeHelperObligation` anchors on the
    // exception region's own published result, and a bindingless `catch {}`
    // publishes none). `e`'s checker type is `unknown` -- one of the four
    // legitimate dynamic boundaries -- and it materializes as the native
    // `catch (const gea::Value& e)` parameter itself
    // (`CatchBindingOperation`), not a second, redundant declaration.
    'boundary:exception-region',
    // Postfix `x++`/`x--`'s own coercion half (`computations.ts`'s
    // `contributeUpdate`): `ToNumeric` over a `dynamic` operand landing on
    // `scalar(number)`, the only pair this obligation's key
    // (`runtime-helper-key.ts`, unkeyed by carrier -- every non-identity
    // `ToNumeric` shares this one string) is ever raised for in practice.
    // `emit-tonumber.ts`'s `dynamicToNumericText` renders it: switch on the
    // box's own runtime tag, ECMAScript's per-tag ToNumber for the four tags
    // that have one (Number identity, Boolean 1/0, String parse, Null 0,
    // Undefined NaN), and a loud runtime refusal -- never a silent NaN -- for
    // Object/Function/Symbol/BigInt, none of which this backend's ToNumeric
    // can convert (Object needs ToPrimitive, which can run arbitrary user
    // code; BigInt is a lossy conversion the language defines separately).
    'computation:coercion:ToNumeric',
    'allocation:object-literal:dynamic',
    'allocation:object-literal:record',
    // An object literal whose selected carrier is `record-with-index` -- the
    // struct half of a "no writes yet, but a computed-key write reaches this
    // storage somewhere in the program" shape, e.g. `this.morphAttributes =
    // {}` later filled by `container.morphAttributes[ name ] = value`
    // elsewhere. `emit-allocation.ts`'s `emitAllocateRecord` allocates it
    // through the identical `cppRecordStructName`/`cppTypeOf` spelling a
    // `record` allocation uses just above -- `types.ts`'s `cppTypeOf` already
    // spells the two through the same `case 'record': case
    // 'record-with-index':` fallthrough, because the index-signature half is
    // a MEMBER of the one struct (`records.ts`'s `renderStructDefinition`),
    // never a second allocation. Every member this obligation's own literal
    // installs inline resolves through `emitFieldInits`, the same as a
    // `record`'s; a member the literal does not install inline (the common
    // case for this carrier -- see `AllocateRecordOperation`'s own comment)
    // is written afterward as an ordinary `define-own-property`/`set`, which
    // `record-with-index:set:false`/`record-with-index:set:true` above claim.
    'allocation:object-literal:record-with-index',
    // An object literal whose DECLARED type has an index signature
    // (`{ [key: string]: T }`, a `Record<K, V>`) derives a `dictionary`
    // carrier, not a record, so the literal's members are keyed stores rather
    // than struct field assignments. `emit-properties.ts`'s
    // `emitAllocateDictionary` renders them through the container's own
    // `operator[]`, the store path `gea::Dictionary` documents.
    'allocation:object-literal:dictionary',
    'allocation:object-literal:native-record-ref',
    // A tagged template's template object. The usual TypeScript
    // `TemplateStringsArray` shape is one exact `array-object`: indexed cooked
    // strings are the Array's own slots and its required `raw` Array is a
    // typed extension field on that same identity. This is deliberately the
    // only certified carrier: record-with-index and native-record-ref cannot
    // implement Array exotic index/length descriptors, frozen integrity, or
    // a present cooked `undefined` for an invalid escape. Legitimate
    // TemplateStringsArray declarations derive through the general
    // interface-extends-ReadonlyArray rule to this array-object shape.
    // `emitAllocateTemplateObject` builds it once per parse site behind a
    // function `static`; every other carrier refuses by name.
    completeTemplateObjectCapabilityKey,
    // A regular-expression literal. The native carrier receives the Pattern
    // directly; an authorized dynamic boundary receives that same fresh
    // Pattern boxed as an Object. `emitAllocateRegExp` writes both forms, and
    // refuses every other carrier rather than constructing a pattern into a
    // layout it cannot name.
    'allocation:regexp-object:native-record-ref(supported-flags)',
    'allocation:regexp-object:dynamic(supported-flags)',
    'allocation:regexp-object:native-record-ref(unicode-flags)',
    'allocation:regexp-object:dynamic(unicode-flags)',
    // The plainest carrier there is: an ordinary `gea::CallableObject<S>`,
    // written by `emitAllocateCallable`'s generic tail as `{invoke,
    // environment}` (or `{invoke, nullptr}` when nothing is captured).
    //
    // This row was MISSING while the printer rendered it unconditionally --
    // the same certify/print disagreement 2.3 fixed four of, and it stayed
    // invisible for a structural reason worth remembering: the demand only
    // arises in a body `ir/generator-split.ts` MINTS, and certification used
    // to run on the pre-split, pre-shake body list, so nothing ever asked.
    // Certifying the shaken program is what surfaced it, on
    // `generator-parameter-binding-at-call` and
    // `generator-bridged-parameter-ownership` -- two programs that emitted
    // correctly and passed the runtime suite the whole time.
    'allocation:function-object:function',
    // A capture-free callable is a pointer pair the emitter writes inline; a
    // capturing one needs an environment layout that is not written, and
    // `emitAllocateCallable` refuses it by name rather than allocating nothing.
    'allocation:function-object:function-value-dispatch',
    // The identical allocation for a class method the checker marked OPTIONAL
    // (`?`) for structural-compatibility reasons alone (`bodyString?(): string`
    // in node-compat's `globals.ts`, matching `ClientResponse`'s narrower
    // shape) -- the payload built is the same `CallableObject`, wrapped in
    // `gea::Optional<T>` because the FIELD's type admits absence, not because
    // this allocation ever produces one. `emitAllocateCallable`'s `payloadCarrier`/
    // `wrap` render it by building the payload at its own type and handing it
    // to `Optional` as the one value its constructor takes.
    'allocation:function-object:optional',
    // A pre-`class` JavaScript constructor function -- one `function
    // WebGLClipping( properties ) { this.uniform = uniform; ... }` that is
    // both called and `new`ed, which is how three.js writes its whole
    // renderer. The carrier is `gea::CallableConstructorObject`, holding two
    // function pointers because `[[Call]]` and `[[Construct]]` differ at both
    // ends: one is handed a receiver and returns what the body returns, the
    // other manufactures the receiver (ECMA-262 10.2.2) and evaluates to it.
    // `emitAllocateCallable` writes both, and `translation-unit.ts`'s
    // `constructThunkOf` renders the second -- allocate the instance, enter
    // the body with it, return it -- over the SAME body the invoke thunk
    // adapts, so nothing here is a second lowering of the function.
    'allocation:function-object:function-and-constructor',
    // A plain JS constructor function whose own `.prototype` is read or
    // written (`prototypeMutatedConstructorTypes`, dynamic-fallback.ts) --
    // boxed to `gea::Value` because it needs a real, mutable "prototype" own
    // property no native callable carrier has (ECMA-262 10.2.5
    // MakeConstructor). `emitAllocateCallable`'s `payloadCarrier.kind ===
    // 'dynamic'` branch recovers the lost call ABI through `ctx.abiOfCallable`,
    // boxes the same thunk pointer every other carrier here would have used,
    // and installs the default "prototype" object through
    // `gea::host::installOrdinaryConstructorPrototype`.
    'allocation:function-object:dynamic',
    'allocation:array-literal:dynamic',
    // A dynamic-fallback array literal still keeps its fresh Array exotic
    // allocation native. When one spread source is dynamic,
    // `emitAllocateArrayObject` drains the acquired iterator record through
    // `runtime::iterator::appendGather`; this is distinct from an ordinary
    // dynamic array literal so a target cannot certify that runtime loop
    // without spelling it.
    'allocation:array-literal:dynamic(dynamic-gather)',
    'allocation:array-literal:array-object',
    'allocation:array-literal:array-object(dynamic-gather)',
    // A tuple literal (`[a, b]` typed `[number, string]`, `readonly [x, y]`,
    // or any other array literal whose own type derives to `record` --
    // `representation/derive.ts`'s `deriveTuple` states there is deliberately
    // no separate tuple carrier: a tuple *is* a record whose keys are its
    // positions). `ir/lower-allocation.ts`'s `lowerTupleLiteral` already
    // renders this through the identical `ctx.builder.allocateRecord` an
    // object literal with a record carrier uses -- the same IR node, the same
    // `emitAllocateRecord` -- so this is not new machinery, only the claim
    // `object-literal:record` above already states for the identical builder
    // call, restated for the literal syntax that also reaches it. Leaving it
    // unclaimed blocked every tuple-typed array literal at preflight even
    // though lowering already handled it cleanly.
    //
    // `native-record-ref` is deliberately NOT claimed alongside it, and not
    // for lack of matching machinery: `structural.ts`'s `layoutTypeAt` gives
    // an array literal's OWN type only when the checker's contextual type is
    // itself array- or tuple-shaped (`checker.isArrayType`/`isTupleType`), and
    // `checker.isTupleType` is decided before a declared/named-alias anchor is
    // ever consulted (`structural.ts`'s own type walk), so a tuple can never
    // reach a `declared`/`object-anchor` shape and therefore never derives to
    // `native-record-ref`. There is consequently no TypeScript program for
    // which an array literal's shape resolves to `native-record-ref` at all --
    // before `layoutTypeAt` was narrowed, one DID reach it, but only by a
    // defect: an array literal being contextually typed against an unrelated
    // Object-flagged interface an overloaded call's parameter happened to name
    // (`new Uint8Array([68, 73, 65, 71])` against `Iterable<number>`, a
    // symbol-keyed protocol with zero data fields) -- `lowerTupleLiteral`'s own
    // arity check ("4 elements into a layout of 0 fields") is what caught it
    // once claimed, exactly the crash-during-rendering a certified program is
    // supposed to never reach. Fixed at the source in `layoutTypeAt`; nothing
    // is left here to claim.
    'allocation:array-literal:record',
    // Fixed-arity array-destructuring and its rest element, over a provably
    // plain Array source only -- `ir/lower-destructuring.ts`'s fast path
    // reads the source by constant index / range-copies it, the same
    // machinery `allocation:array-literal:array-object` and array spread
    // already use. `preflight/run.ts`'s obligation key carries the source's
    // own carrier for exactly this claim to stay narrow: every other carrier
    // (a Map, a Set, a user-defined iterable) is left correctly unclaimed and
    // refuses at preflight, not mid-lowering. An object-pattern rest
    // ("{...rest}") is kept structurally unclaimable even over an
    // array-typed source -- see the "object-pattern" key segment in
    // `preflight/run.ts`'s 'rest-element' case.
    'destructuring:array-pattern:array-object',
    // A source declared `any`/`unknown`, including the true arm of
    // `Array.isArray(source)`, keeps its `Value` identity and is stepped via
    // `runtime::iterator`; array rest drains the same record through a fresh
    // dynamic-element array rather than projecting the source as an array.
    'destructuring:array-pattern:dynamic',
    'destructuring:array-pattern-close:dynamic',
    'destructuring:array-pattern-close:iterator',
    'destructuring:rest-element:dynamic',
    // A presence test followed by TypeError on absence; the source stays in
    // its selected carrier, including primitive and native object sources.
    'destructuring:RequireObjectCoercible',
    // A tuple's element, read back by position -- `const [a, b] = pair` over a
    // `record`-carried tuple. This is a record field get keyed by the
    // position's own string ("0", "1", ...), exactly the field
    // `lowerTupleLiteral` (above) wrote it under -- never the iterator
    // protocol: a statically-typed tuple's shape is closed and known at
    // compile time, so there is nothing for GetIterator/next() to resolve
    // that a plain field read does not already answer. `rest-element` over a
    // tuple source is deliberately NOT claimed alongside this: a tuple's
    // remaining positions have no common carrier to range-copy into the way
    // a plain Array's do, and `destructuring:rest-element:record` stays
    // correctly unclaimed for that reason.
    //
    // Unlike the allocation claim above, this one is genuinely narrower than
    // "every `record` source": a destructuring source's type is the value's
    // own declared/inferred type, never routed through `layoutTypeAt`'s
    // array-literal guard, so an ordinary named-field object that also
    // declares `[Symbol.iterator]` (`const [a, b] = value` over a `{ first,
    // second, [Symbol.iterator]() {...} }`-shaped value) derives to the
    // identical `record` carrier without being a tuple at all.
    // `preflight/run.ts`'s `sourceIsPositionalTupleRecord` narrows the
    // obligation key to "record(non-tuple)" -- which this manifest does not
    // claim -- whenever the record's own fields are not exactly "0".."n-1" in
    // order, so that shape still refuses at preflight rather than certifying
    // and then throwing out of `lowerTuplePatternRead`'s own field-key check.
    // `native-record-ref` gets no claim at all for the identical reason
    // `sourceIsPositionalTupleRecord`'s own comment states: preflight has no
    // deriver to resolve its shape id back to fields, so the positional check
    // this claim depends on cannot be run for it, and claiming it unchecked
    // would reopen the exact false-certification risk this narrowing exists
    // to close.
    'destructuring:array-pattern:record',
    // A tuple's element, read back by position, when the source is a
    // `tagged-union` all of whose arms are themselves tuples --
    // `[T, ParamIndexMap][] | [T, Params][]`'s own per-entry type
    // (`[T, ParamIndexMap] | [T, Params]`), hono's own router match result:
    // fixed arity at fixed positions in EVERY arm, so `.map(([[, route]]) =>
    // route)`'s pattern reads position 0 the same closed-shape way a lone
    // tuple's positional field get already does. `ir/lower-destructuring.ts`'s
    // `isTupleUnionCarrier` is what recognizes the shape (the shared source
    // step aliases straight to the base value, same as the lone-tuple case
    // just above), and `lowerTaggedUnionTuplePatternRead` renders each
    // element as an ordinary record field get keyed by the position's own
    // string -- the identical `ctx.builder.get` the lone-tuple path already
    // uses, just against a `tagged-union` receiver instead of a `record` one.
    // That receiver kind is nothing new to the C++ backend: a `get` whose
    // receiver is a `tagged-union` already renders through
    // `emit-properties.ts`'s existing dispatch to `emit-union-properties.ts`'s
    // `taggedUnionGetText`, which was already claiming per-arm STATIC-key
    // field dispatch (`armFieldSite`) for exactly this receiver kind before
    // this task -- so no emitter code was added for this claim, only the
    // preflight/lowering acceptance that a tagged union of tuples is as
    // closed-shape as a lone tuple already was.
    'destructuring:array-pattern:tagged-union',
    // A general iterable source -- a `Generator<T>` reached directly (`var
    // [a, b] = g()`), or one whose `[Symbol.iterator]()` itself returns one
    // (a class/record method written as a generator, `generatorRecordTypeOf`
    // in `producers/protocol.ts`): `representation/publish.ts` derives the
    // shared source step's own `iterator-record` result straight off the
    // base's structural type with no override needed, because
    // `GeneratorDeclarationPolicy` (`representation/derive.ts`) already
    // carries a `Generator<T>` as the native `iterator(T)` cursor --
    // `%GeneratorPrototype%[@@iterator]` returns `this` (ECMA-262 27.5.1.2),
    // so the pattern's own "get iterator" step is an ALIAS of the base value,
    // never a construction, exactly as the tuple/array-object fast paths
    // above alias rather than build. `ir/lower-destructuring.ts`'s
    // `lowerArrayPatternSource` registers that alias, and each bound
    // element's own step advances the SAME cursor with `arrayNext()`/`done()`
    // -- the identical primitives a `for`-`of` over the same generator already
    // uses (`emit-iterator.ts`'s `emitIteratorNext`/`emitIteratorDone`), so no
    // new emission is needed, only the acceptance that a pattern may read
    // them one call per bound position instead of one call per loop
    // iteration.
    //
    // Scoped to a source that is ALREADY a cursor. A receiver whose
    // `[Symbol.iterator]()` is an ordinary method returning a hand-built
    // `{next, return}` record (the fully dynamic protocol
    // `mintIteratorSteps`/`emitDynamicGetIterator` render for `for`-`of`) is
    // a DIFFERENT shape -- a `record`/`class-ref`/`native-record-ref`
    // `iterator-record`, never this `iterator` one -- and this claim says
    // nothing about it; that shape stays correctly unclaimed for the
    // array-pattern form until this producer also mints the get-method/
    // get-iterator call the loop's own `mintIteratorSteps` already does.
    //
    // A REST element over the same cursor source (`[...xs] = g()`) is
    // deliberately NOT claimed alongside it: draining an unbounded cursor into
    // a fresh array needs an actual gathering LOOP, and every loop this IR
    // builds today lowers a real source-level `for`/`while`/`for`-`of`
    // construct through `control.ts`'s own census/gating wiring -- there is no
    // synthetic-loop desugaring an array-pattern's rest element could reach
    // for instead, so it stays refused at preflight rather than certifying a
    // shape nothing can lower.
    'destructuring:array-pattern:iterator',
    'destructuring:rest-element:array-object',
    // `const { strict, ...rest } = options` over a `record`/`native-record-ref`
    // source: the "object-pattern" segment in the obligation key
    // (`preflight/runtime-helper-key.ts`'s 'rest-element' case) keeps this
    // structurally distinct from `destructuring:rest-element:record` above,
    // which stays correctly unclaimed for the ARRAY-pattern tuple-rest case a
    // few lines up. This one is the opposite of that exclusion's reasoning:
    // an object-pattern rest's own type is `Omit<Source, K>`, a CLOSED field
    // set TypeScript already resolved at check time, not the general
    // `CopyDataProperties` over a key set computed at runtime -- so there is
    // no dynamic key enumeration to perform, only a field-by-field copy.
    // `ir/lower-destructuring.ts`'s `lowerObjectPatternRest` renders it: read
    // the rest binding's own required record layout, `[[Get]]` each field off
    // the source by name (the same primitive an object-pattern element read
    // already uses), and assemble the result with `allocateRecord` (the same
    // primitive an object literal's own allocation uses).
    'destructuring:rest-element:object-pattern:record',
    'destructuring:rest-element:object-pattern:native-record-ref',
    // An open dictionary's key set is runtime state. The lowering allocates a
    // fresh dictionary, uses the existing CopyDataProperties walk, and deletes
    // the pattern's excluded keys from that result; the source is unchanged.
    'destructuring:rest-element:object-pattern:dictionary',
    // A class's constructor object is a pointer to the construct function
    // `translation-unit.ts` emits for that class, with no environment: a class
    // declaration captures nothing. A class *expression* inside a closure would,
    // and `emitAllocateConstructor` refuses a capture-carrying one by name.
    'allocation:class-constructor-object:constructor-family',
    // An intrinsic JSX element (`<view>`, `<text>`, ...) allocates through
    // `gea::jsx::create`, with every prop and child threaded through
    // `gea::jsx::prop`/`gea::jsx::child`. `element:value` and
    // `element:fragment` are deliberately absent, and not for lack of effort:
    // an element whose tag names a value means whatever the library that
    // declared it says it means, so the recipe belongs to that library's
    // plugin and arrives with it. Claiming either here would assert this
    // backend can build something it has no definition of.
    'element:intrinsic',
    // `ToBoolean`, per carrier, because the rule differs per carrier and a
    // backend that can test a number has said nothing about testing a record.
    // `dynamic` is claimed too, as of `gea::host::detail::toBoolean`
    // (gea_runtime.h): ECMA-262 7.1.2 is a closed nine-tag table, so a boxed
    // value's truthiness is answerable from its own tag (and, for a boxed
    // boolean/number/string, its payload) without any open-ended dispatch.
    // `unresolved` stays absent -- lattice bottom names no runtime value to
    // test at all.
    'conversion:to-boolean:scalar',
    'conversion:to-boolean:string',
    'conversion:to-boolean:null',
    'conversion:to-boolean:undefined',
    'conversion:to-boolean:optional',
    'conversion:to-boolean:tagged-union',
    'conversion:to-boolean:class-ref',
    'conversion:to-boolean:record',
    'conversion:to-boolean:native-record-ref',
    'conversion:to-boolean:array-object',
    'conversion:to-boolean:dictionary',
    // Every Object is truthy: `new Map()` with zero entries is `true`, exactly
    // as `[]` is. `emit-presence.ts`'s always-truthy group renders it, and
    // `model.ts`'s `alwaysTruthyKinds` is what licenses a merge over one.
    'conversion:to-boolean:keyed-collection',
    'conversion:to-boolean:native-handle',
    'conversion:to-boolean:function',
    'conversion:to-boolean:function-family',
    'conversion:to-boolean:function-value-family',
    'conversion:to-boolean:function-value-dispatch',
    'conversion:to-boolean:constructor-family',
    'conversion:to-boolean:constructor-value-dispatch',
    'conversion:to-boolean:function-and-constructor',
    'conversion:to-boolean:dynamic',
    // `for`-`of`/argument-spread/`yield*` over a provably plain `T[]`: ECMA-262
    // 23.1.5's Array Iterator is a plain index/length walk over the exact
    // array, so `get-iterator` allocates a `gea::Iterator<T>` cursor directly
    // (no `[[Get]]` of `@@iterator`, no dynamic method call -- there is no
    // `protocol:iterator:get-method:*` claim anywhere in this manifest, and
    // there does not need to be one for this path) and `next` walks it
    // in-place (`targets/cpp/runtime/gea_runtime.h`'s `Iterator::arrayNext`,
    // `targets/cpp/emit-iterator.ts`). The carrier suffix is what keeps this
    // claim scoped to exactly that shape: `preflight/runtime-helper-key.ts`'s
    // `runtimeHelperKey` keys a protocol step by the operand carrier it reads,
    // so a for-of over any other iterable -- a `Map`, a `Set`, a genuinely
    // dynamic `Iterable<T>` -- resolves a different, unclaimed key
    // (`...:unresolved`, `...:dynamic`, ...) and is correctly refused here,
    // before lowering ever sees it. `next`'s own carrier is the iterator
    // *record* it advances, which by the time this step runs is the
    // `gea::Iterator<T>` the matching `get-iterator` already published
    // (`representation/publish.ts`'s `arrayFastPathIteratorCursorOf`) -- so
    // the claim reads `iterator`, the representation kind, not `array-object`.
    // `k in o`, stated by the file that renders it so the claim and the
    // rendering cannot drift: `emit-in.ts`'s `hasPropertyHelperClaims`.
    ...hasPropertyHelperClaims,
    'protocol:iterator:get-iterator:array-object',
    // The same cursor over a `Set<T>` (ECMA-262 24.2.3.10): a fixed walk of
    // the collection's own insertion-ordered entries with no `@@iterator`
    // lookup, so `gea::Iterator<T>`'s Set constructor serves it and
    // `producers/shared.ts`'s `isNativeIterableSetType` is what keeps a
    // `get-method` step from being minted for one. `Map` is deliberately not
    // claimed -- its iterator yields a `[K, V]` pair with no cursor carrier --
    // and neither weak family iterates at all, so both still refuse by name.
    'protocol:iterator:get-iterator:keyed-collection',
    // The same cursor over a `string` (ECMA-262 22.1.3.36
    // `String.prototype[@@iterator]`): one CODE POINT per step over immutable
    // storage, so there is nothing for `GetIterator` to resolve that the value
    // itself does not already answer, and `gea::Iterator<std::string>`'s
    // string constructor serves it. `producers/shared.ts`'s
    // `isNativeIterableStringType` is what keeps a `get-method` step from
    // being minted for one; a shape that CARRIES as `string` without matching
    // that predicate (a union of string literals) still mints one and refuses
    // on the unclaimed `protocol:iterator:get-method:string` instead, which is
    // the fail-closed direction.
    'protocol:iterator:get-iterator:string',
    // A `Generator<T, TReturn, TNext>` (ECMA-262 27.5), carried as the same
    // `iterator(T)` cursor because a generator IS its own iterator:
    // `%GeneratorPrototype%[@@iterator]` returns `this`, so `get-iterator` over
    // one is an assignment (`emit-iterator.ts`) rather than a construction, and
    // `next` walks the coroutine frame `gea::Iterator<E>::promise_type` owns.
    'protocol:iterator:get-iterator:iterator',
    // The four native cursors again, this time over a POSSIBLY-ABSENT source
    // (`T[] | undefined`, `Set<T> | null`, ...). Iterating an absent value is
    // a runtime `TypeError` in the language itself -- ECMA-262 7.4.2
    // `GetIterator` performs `GetMethod(obj, @@iterator)`, which throws on
    // `undefined`/`null` -- never a static impossibility, so the walk over a
    // present payload is byte-for-byte the walk over a bare one and the
    // absence is ONE extra fact: whether the walk starts.
    // `targets/cpp/emit-iterator.ts` spells that as
    // `gea::detail::requireIterablePresent` in front of the same cursor
    // constructor, and `producers/shared.ts`'s `presentIterationArm` is what
    // routes such a source onto this path at all rather than demanding an
    // `@@iterator` lookup this backend has no representation for. Measured on
    // three.js: `this.materialCache.get( material )` is `Set<T> | undefined`
    // from the collection census, and every `for`-`of` over one refused with
    // an unclaimed `protocol:iterator:get-method:optional`.
    //
    // Claimed under their OWN keys rather than folded into the four above --
    // `preflight/runtime-helper-key.ts`'s `optionalIterationSourceKind`
    // reports `optional(<payload kind>)`, the same spelling
    // `spreadSourceCarrierKind` uses -- so a payload this emitter cannot
    // unwrap (a fixed-arity tuple, whose positions are read through a lambda
    // capture instead of a cursor constructor) stays refused by name at
    // preflight instead of being certified and crashed at emission.
    //
    // `for`-`in`'s own absent claim sits beside its dictionary claims below,
    // and it is NOT one of these assertions: ECMA-262 14.7.5.5 evaluates an
    // `undefined`/`null` enumerate source to a BREAK completion and the loop
    // runs zero times, so it is spelled as an empty cursor instead.
    'protocol:iterator:get-iterator:optional(array-object)',
    'protocol:iterator:get-iterator:optional(keyed-collection)',
    'protocol:iterator:get-iterator:optional(string)',
    'protocol:iterator:get-iterator:optional(iterator)',
    'protocol:iterator:next:iterator',
    // The GENERAL protocol: a class instance or a plain object whose
    // `[Symbol.iterator]()` is a real, program-written method (`Headers`'s
    // own, in `runtime/node/globals.ts`), rather than one of the native
    // sources above. `get-method` resolves the member (a `[[Get]]`,
    // `ir/lower-protocol.ts`'s own `get-method` case), `get-iterator` calls
    // it, and `next` calls the returned record's own `next()` once per step
    // -- all three claimed and rendered together by the file whose own
    // `dynamicIteratorHelperClaims` this spreads in, for the one-authority
    // reason `enumerateHelperClaims` already states below. `class-ref` and
    // `record` only: `preflight/runtime-helper-key.ts`'s
    // `iteratorMethodCarrierKind` keeps a "record" receiver with no
    // discoverable `@@iterator` FIELD -- an open tuple, whose iterator is
    // `Array.prototype`'s own -- off this claim, on the deliberately
    // unclaimed `record(no-iterator-method)` sibling instead.
    ...dynamicIteratorHelperClaims,
    // `for (const name of ['a', 'b'] as const)` -- a fixed-arity tuple, which
    // has no method to fetch at all and unrolls to a positional read; stated
    // by the file that renders it, same as the two lists around it.
    ...staticTupleIteratorHelperClaims,
    // `for (const k in table)` over a string-keyed index signature -- ECMA-262
    // 14.7.5.9 `EnumerateObjectProperties` -- carried as the same
    // `gea::Iterator<std::string>` cursor every claim above uses, walking
    // `gea::Dictionary::propertyKeys` (whose order IS
    // `OrdinaryOwnPropertyKeys`, 10.1.11, which is why that container holds
    // its entries in creation order rather than sorted). The carrier suffix
    // scopes this exactly: a `for`-`in` over a RECORD -- a struct whose keys
    // are a compile-time list, not a runtime table -- resolves
    // `protocol:enumerate:get-iterator:record`, which nothing claims, and is
    // refused here before lowering, exactly as an unclaimed iterable is.
    'protocol:enumerate:get-iterator:dictionary(string)',
    'protocol:enumerate:get-iterator:dictionary(symbol)',
    // The same two tables behind a possibly-absent carrier. This is the one
    // absent claim that is not a presence assertion: ECMA-262 14.7.5.5 runs a
    // `for`-`in` over `undefined`/`null` zero times, so `emit-iterator.ts`
    // spells it as `gea::detail::enumerateIfPresent` -- the table's own key
    // cursor when present, a default-constructed, already-done cursor when
    // not. Three's `WebGLPrograms.getProgramCacheKey` walks
    // `parameters.defines`, which the base-class overlay states
    // `Record | undefined` on `Material`, through an untyped JS parameter the
    // checker cannot narrow at the site's own `!== undefined` guard. Only
    // the two table domains: an absent record/class/host struct stays refused
    // by name (`runtime-helper-key.ts`'s `enumerateGetIteratorCarrierKind`)
    // because the static-snapshot walks read fields off the receiver itself.
    'protocol:enumerate:get-iterator:optional(dictionary(string))',
    'protocol:enumerate:get-iterator:optional(dictionary(symbol))',
    'protocol:enumerate:next:iterator',
    // `for`-`in` over a statically shaped receiver (a record, a class
    // instance, a named interface/type-alias, ...) or a genuinely dynamic
    // one -- the two remaining enumeration sources, claimed by the file that
    // renders both (`emit-iterator.ts`'s own `enumerateHelperClaims`, spread
    // in here so the claim and the rendering stay one authority). This
    // claims the bare `native-record-ref` key only -- a data-only HOST-bound
    // declared type derives that identical `.kind` but is reported under the
    // refined, deliberately UNCLAIMED `native-record-ref(host-bound)` key
    // instead (`preflight/runtime-helper-key.ts`'s
    // `enumerateGetIteratorCarrierKind`), because `emitStaticEnumerateIterator`
    // throws for it: a host struct has no compiler-rendered field dispatcher.
    ...enumerateHelperClaims,
    // Object spread's `CopyDataProperties` (ECMA-262 7.3.25) when the
    // source's own-property set is not known until this runs -- a spread of
    // a union or an index-signature type into a literal whose own layout
    // resolves to a `dictionary` (`structural-layout-type.ts`'s
    // `layoutTypeAt`, "the one member of a union that can genuinely hold ANY
    // key the spread might copy"). `targets/cpp/emit-allocation.ts`'s
    // `emitSpreadCopy` renders it: a plain string/symbol `dictionary` source
    // walks its domain-matched `Dictionary::copyInto`/
    // `SymbolDictionary::copyInto` at runtime; the source->receiver suffix is
    // part of the certificate, so neither a numeric table nor a cross-domain
    // copy can borrow that claim. A `tagged-union`
    // source unrolls per arm, guarded by `armIs` -- claimed only under the
    // refined `tagged-union(record-or-dictionary)` key
    // (`preflight/runtime-helper-key.ts`'s `spreadSourceCarrierKind`), which
    // that same file computes as EXACTLY the union shapes `emitSpreadCopy`
    // can render (every arm a `dictionary`, or a `record` with no accessor
    // and no optional field) -- a union carrying any other arm kind keeps the
    // bare, deliberately unclaimed `tagged-union` key and refuses by name
    // before lowering ever reaches it.
    'protocol:spread:next:dictionary(string->string)',
    'protocol:spread:next:dictionary(symbol->symbol)',
    'protocol:spread:next:tagged-union(record-or-dictionary)',
    // An `optional` source -- `headers?: HeaderRecord` in hono's own
    // `setDefaultContentType` (`...headers,` inside an object literal) --
    // refines the identical way one layer out: `CopyDataProperties` copies
    // nothing for `null`/`undefined`, so `emitSpreadCopy`'s `optional`
    // branch renders that absent case as no write at all, and the present
    // case recurses into the SAME per-arm dispatch above. Claimed only under
    // the refined `optional(tagged-union(record-or-dictionary))` key
    // (`preflight/runtime-helper-key.ts`'s `spreadSourceCarrierKind`, which
    // computes it via the identical `isCopyableSpreadUnion` check as the
    // bare tagged-union claim) -- an optional payload of any other shape
    // keeps its own bare `optional(...)` key, deliberately unclaimed.
    'protocol:spread:next:optional(tagged-union(record-or-dictionary))',
    // A bare `dictionary` under `optional` -- `headers?: Record<string,
    // string>`, no union at all -- refines the identical one layer out too.
    // `emitSpreadSourceCopy`'s `optional` branch (`emit-allocation.ts`)
    // recurses on the present payload through its own generic `source.kind
    // !== 'tagged-union'` fallback, which reaches `emitSpreadArmCopy` and
    // then `emitSpreadDictionaryArmCopy` -- the identical `dictionary`-arm
    // render the matching domain-qualified bare dictionary claim above already
    // exercises for a non-optional source, just reached one payload-read
    // deeper. `spreadSourceCarrierKind` already computes this exact key
    // (`optional(dictionary(string->string))`, or its symbol sibling) and the
    // renderer already proven above is the only thing these claims add.
    'protocol:spread:next:optional(dictionary(string->string))',
    'protocol:spread:next:optional(dictionary(symbol->symbol))',
    // A source that simply IS a record `emitSpreadRecordArmCopy` can unroll --
    // no accessor member, every field required -- with no union and no
    // optional around it. `emitSpreadSourceCopy`'s own `source.kind !==
    // 'tagged-union'` fallback routes it to the identical `emitSpreadArmCopy`
    // dispatch a one-armed `tagged-union(record-or-dictionary)` already
    // reaches, so this claims a render already proven by the union claim
    // above, one arm-read shallower. Until now `spreadSourceCarrierKind`
    // returned the bare, unrefined `record` key for it, which meant `{ ...r }`
    // over a record refused while `{ ...(r as R | R2) }` over the same value
    // compiled -- the shape, not the union, is what the emitter reads.
    //
    // The refined key is what carries the proof. A field that may be absent is
    // copied under the independent presence bit generated beside its value --
    // `CopyDataProperties` copies the key only when the source has it, even
    // when the present value is `undefined`. A record with an accessor member
    // keeps the bare `record` key and stays deliberately unclaimed, exactly as
    // a union with an unrenderable arm does.
    'protocol:spread:next:record(copyable)',
    // A `class-ref` and a data-only `native-record-ref` name their field list
    // instead of carrying it, and that list IS the instance's own enumerable
    // key set: methods and accessors are on the prototype, never own
    // properties, so `{ ...instance }` copies exactly the fields. This is the
    // same list `host/object-protocol.ts` already enumerates for
    // `Object.keys`/`Object.assign` over a class, reached here through
    // `representation/record-fields.ts`'s `staticOwnFieldsOf` -- which is
    // also what the refined key above is computed from, so the render and its
    // licence read one list rather than two.
    //
    // A HOST-stated struct keeps the bare, unclaimed `native-record-ref` key:
    // its own enumerable properties are the host's to define and nothing here
    // can know whether the C++ members it was told about are the JavaScript
    // object's own keys.
    'protocol:spread:next:class-ref(copyable)',
    'protocol:spread:next:native-record-ref(copyable)',
    'protocol:spread:next:optional(class-ref(copyable))',
    'protocol:spread:next:optional(native-record-ref(copyable))',
    // The same record under `optional`, for the reason
    // `optional(dictionary)`'s claim gives: the absent case copies nothing by
    // `CopyDataProperties`'s own definition, and the present case recurses
    // into the dispatch this file's previous claim already proves.
    'protocol:spread:next:optional(record(copyable))',
    // `CopyDataProperties` over a genuinely dynamic source and a genuinely
    // dynamic fresh object. `emitSpreadCopy` walks the source's own keys,
    // filters its descriptors for enumerability, gets each value, then creates
    // a data property on the receiver. The `dynamic->dynamic` suffix is
    // mandatory: a dictionary receiver requires a different key-domain
    // contract and remains deliberately unclaimed.
    'protocol:spread:next:dynamic->dynamic',
    // `yield x` inside a `function*`, and the resume point paired with it.
    //
    // The body is emitted as a C++20 coroutine returning `gea::Iterator<T>`
    // (`targets/cpp/emit.ts`'s `emitYield`, and its `return` terminator's
    // `co_return` arm); the resume boundary is a no-op because the coroutine
    // transform owns the resume point itself (`ir/lower-exceptions.ts`).
    //
    // Both are claimed for the WHOLE forms, not a narrowed slice, because
    // everything this backend cannot do about a generator is refused EARLIER,
    // by name, at the census: `producers/control.ts` refuses `yield*` (a
    // delegation loop in an expression position) and refuses a `yield` whose
    // own value is read (there is no resume channel to carry what `next(v)`
    // sends). What is left reaching these keys is exactly what the coroutine
    // renders.
    'control:yield',
    'boundary:generator-resume'
  ]),
  unsupportedRuntimeHelpers: new Set<string>(),
  // `throw`, `break` and `continue`. `emit.ts`'s terminator renders a C++
  // `throw` of the thrown value's own carrier, and an uncaught one
  // terminating the process is what an uncaught ECMAScript exception already
  // does -- so that edge is genuinely handled, not half-handled. `break` and
  // `continue` are handled too, as of this patch: `ir/lower.ts`'s
  // `break`/`continue` case renders an ordinary `goto` to the loop's exit or
  // header/latch block, built from the same guard/loop machinery a plain loop
  // already uses.
  //
  // `suspend` is claimed too, now that `ir/lower.ts`'s `lowerBoundary` gives
  // it a real, honest handling: the edge between an `await` and its
  // `async-resume` boundary never becomes a runtime transfer at all, because
  // this backend's `await` completes synchronously (see `AwaitOperation`'s
  // doc comment, `ir/model.ts`) -- there is no queue to park a continuation
  // in, so "handled" here means "provably a no-op", not "renders a jump".
  //
  // `return` is the edge `producers/control.ts` mints ONLY when a `finally`
  // intercepts the completion, so claiming it is a claim about `finally` and
  // nothing else. What handles it is `gea::ScopeExit` (`runtime/
  // gea_runtime.h`), the object `emit-exceptions.ts` wraps the whole region in:
  // C++ destroys a scoped object on `return` exactly as ECMAScript runs a
  // finally clause on one, so the return stays an ordinary `return` terminator
  // and the interception is the destructor. The same object is what handles
  // this set's `break`/`continue` and `throw` edges when they cross a finally,
  // for the identical reason -- one mechanism, four completions, which is why
  // there is no completion record anywhere in the emit.
  abruptEdgeHandlers: new Set<string>(['throw', 'break', 'continue', 'suspend', 'return'])
})
