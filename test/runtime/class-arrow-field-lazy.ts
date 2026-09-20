// A class field whose initializer is an arrow function capturing nothing but
// (at most) `this` is lazily materialized -- see `class-layout.ts`'s
// `censusLazyArrowFields`. `Widget.describe`/`Widget.greet` qualify; every
// direct call, value read, reassignment, dynamic read and property write below
// pins one requirement the design states for a qualifying field.
//
// `CounterWidget.bump` also reads `total`, a MODULE-level declaration outside
// its own scope -- included to pin that this is not treated as disqualifying:
// a module-level binding is addressed directly in this compiler, not
// transported through a closure environment, so `bump` still qualifies and
// still gets built lazily. A field arrow that captures a declaration owned by
// an enclosing FUNCTION frame instead does not presently emit at ALL, wholly
// independent of this feature: the field-initializer thunk is never itself
// allocated as a value, so it has no environment to relay such a capture
// through -- the same "capture path... not installed" gap `captures.ts`
// already documents for methods. That means there is currently no program
// where a class field arrow captures something other than `this` (or a
// module global) AND compiles AND is observably still eager -- the
// qualification check's "disqualify" branch has no reachable positive case to
// pin today; it stands as fail-closed defense for whenever field-initializer
// captures are extended to relay an outer function's declarations too.
//
//! emitted-has: .invoke == nullptr
class Widget {
  label = 'widget'

  // Qualifies: captures only `this`.
  describe = (suffix: string): string => `${this.label}:${suffix}`

  // Qualifies: captures nothing at all, not even `this`.
  greet = (name: string): string => `hello ${name}`
}

class SpecialWidget extends Widget {
  extra = 'special'
}

let total = 10

class CounterWidget {
  offset = 1
  // Qualifies (see above): `total` is a module global, not a capture.
  bump = (amount: number): number => {
    total = total + amount
    return total + this.offset
  }
}

const widget = new Widget()

// Direct call, with an argument and a return value.
//! expect: widget:one
console.log(widget.describe('one'))

// The same field read twice yields the same identity.
//! expect: identity-stable
console.log(widget.describe === widget.describe ? 'identity-stable' : 'identity-unstable')

// A value read, held in a binding, then called later.
const describeRef = widget.describe
//! expect: widget:two
console.log(describeRef('two'))

// Passed as a callback argument.
function callWith(fn: (value: string) => string, value: string): string {
  return fn(value)
}
//! expect: widget:three
console.log(callWith(widget.describe, 'three'))

// Reassignment, then a direct call must go through the NEW callable.
widget.describe = (suffix: string): string => `override:${suffix}`
//! expect: override:four
console.log(widget.describe('four'))

// A property set on the field's value survives a later read of the same field.
const another = new Widget()
;(another.describe as unknown as { tag?: string }).tag = 'tagged'
//! expect: tag=tagged
console.log(`tag=${(another.describe as unknown as { tag?: string }).tag}`)

// A subclass instance calls an inherited arrow field with the right `this`.
const special = new SpecialWidget()
//! expect: widget:sub
console.log(special.describe('sub'))

// A dynamic (`any`) read of the field, after an ordinary call already
// materialized it, sees the same callable.
const dyn = another as any
//! expect: widget:dyn
console.log(dyn.describe('dyn'))

// The "captures nothing at all" qualifying shape.
//! expect: hello world
console.log(widget.greet('world'))

// A field capturing a module-level declaration in addition to `this`.
const counterWidget = new CounterWidget()
//! expect: 15
console.log(counterWidget.bump(4))
//! expect: 19
console.log(counterWidget.bump(4))

// A dynamic read reaching a field NO static access has touched yet -- unlike
// `dyn` above (already materialized by the earlier `another.describe` reads),
// this instance's `describe` is still the empty sentinel when the FIRST touch
// arrives through `records.ts`'s `gea_readOwnField`, not through
// `emit-properties.ts`'s static choke point at all. That dispatcher recovers
// its own `this` handle (`gea::Ref<T>::adopt(const_cast<T*>(this), true)`,
// the same idiom its accessor arm already uses) to call the initializer
// before boxing -- see `renderFieldDispatcher`'s `materializeText`.
const untouched = new Widget()
const dynUntouched: any = untouched
//! expect: widget:first-touch
console.log(dynUntouched.describe('first-touch'))

// The dynamic path materializes the SAME storage a static read would have:
// calling through the statically-typed reference afterward sees the value the
// dynamic path already built, not a second one.
//! expect: widget:second-touch
console.log(untouched.describe('second-touch'))

// Two dynamic reads of a never-statically-touched field agree on identity,
// proving the dynamic path materializes ONCE rather than on every read.
const untouched2 = new Widget()
const dynUntouched2: any = untouched2
//! expect: identity-stable-dynamic
console.log(dynUntouched2.describe === dynUntouched2.describe ? 'identity-stable-dynamic' : 'identity-unstable-dynamic')

// Every OTHER reader of a lazy field's storage in `records.ts` (own-field
// descriptor, define, freeze, presence/enumerable, `in`, `hasOwnProperty`,
// delete) must see the same behavior a plain eager field already has -- most
// need no materialization at all (presence/attributes answer identically
// whether or not the sentinel has been replaced), but `gea_defineOwnField`'s
// SameValue merge against a non-configurable, non-writable field DOES read
// the current value, so it materializes first (`renderFieldDispatcher`'s
// `defines` arm) exactly like `gea_readOwnField`/`gea_ownFieldDescriptor`
// already did. Each case below uses a FRESH, never-statically-touched
// instance so the sentinel is still in place when the dynamic operation runs.

// `Object.defineProperty` on a known declared field goes through a SEPARATE
// emission path from the dynamic protocol above (`emit-host-object.ts`'s
// `fixedFieldDefinePropertyText`, backed by runtime `applyNativeFixedDataDescriptor`
// rather than `applyNativeFieldDescriptor`) -- it has the identical
// SameValue-merge read of the current value, so it needs the identical
// materialize-first guard. This compiler has no sealed recipe for an
// attribute-only `defineProperty` on any statically-known declared field
// (`fixed-data-definition.ts` requires a `value` key), a pre-existing, general
// limitation unrelated to lazy fields, so this case supplies one -- still
// exercising the merge-against-current-value logic the fix targets.
const definedAttrsOnly = new Widget()
Object.defineProperty(definedAttrsOnly, 'describe', { value: (suffix: string): string => `defined:${suffix}`, enumerable: false })
//! expect: defined:defined-attrs-only
console.log(definedAttrsOnly.describe('defined-attrs-only'))
//! expect: identity-stable-after-define
console.log(definedAttrsOnly.describe === definedAttrsOnly.describe ? 'identity-stable-after-define' : 'identity-unstable-after-define')

// `Object.getOwnPropertyDescriptor` on an untouched field returns the SAME
// callable a later ordinary read returns -- not a fresh one, and not the
// empty sentinel.
const described = new Widget()
const descriptor = Object.getOwnPropertyDescriptor(described, 'describe')
//! expect: descriptor-matches-read
console.log(descriptor?.value === described.describe ? 'descriptor-matches-read' : 'descriptor-does-not-match')

// `Object.keys`/enumeration lists the field before anything materializes it
// -- presence and enumerability are bits independent of `invoke`, so this
// needs no materialization at all, unlike the cases above.
const enumerated = new Widget()
//! expect: has-describe-key
console.log(Object.keys(enumerated).includes('describe') ? 'has-describe-key' : 'missing-describe-key')

// `Object.freeze` locks writability/configurability, never the value itself
// -- a frozen field is still lazily materialized on its first READ exactly
// like an unfrozen one.
const frozen = new Widget()
Object.freeze(frozen)
//! expect: widget:frozen
console.log(frozen.describe('frozen'))

// `in` / `hasOwnProperty` are presence questions, answered before any
// materialization the same way a plain eager field's would be.
const membership = new Widget()
//! expect: in-operator-true
console.log('describe' in membership ? 'in-operator-true' : 'in-operator-false')
//! expect: has-own-property-true
console.log(membership.hasOwnProperty('describe') ? 'has-own-property-true' : 'has-own-property-false')

// `delete` on an untouched lazy field behaves exactly like deleting an
// already-materialized (or plain eager) one: the key is gone, `in` reports
// false, and redefining it afterward still works.
const deleted = new Widget()
delete (deleted as unknown as { describe?: unknown }).describe
//! expect: deleted-key-absent
console.log('describe' in deleted ? 'deleted-key-present' : 'deleted-key-absent')
;(deleted as unknown as { describe: (suffix: string) => string }).describe = (suffix: string): string => `redefined:${suffix}`
//! expect: redefined:after-delete
console.log(deleted.describe('after-delete'))

// A DIRECT CALL (`emit-callable.ts`'s `emitLazyArrowFieldCall`) on a field no
// static or dynamic access has touched yet must invoke the arrow's body
// itself rather than refuse or crash against the empty sentinel -- and must
// leave the field in a state a later ORDINARY read still resolves correctly
// and stably, exactly as if the direct call had gone through the
// materializing path instead.
const directUntouched = new Widget()
//! expect: widget:direct-first
console.log(directUntouched.describe('direct-first'))
//! expect: identity-stable-after-direct-call
console.log(
  directUntouched.describe === directUntouched.describe ? 'identity-stable-after-direct-call' : 'identity-unstable-after-direct-call'
)

// A direct call, then a reassignment, then another direct call: the SECOND
// direct call must run the NEW callable -- the fused fast path re-reads the
// field's `invoke` guard on every call rather than latching onto the arrow's
// body the first time it ran.
const reassignThenDirectCall = new Widget()
//! expect: widget:before-reassign
console.log(reassignThenDirectCall.describe('before-reassign'))
reassignThenDirectCall.describe = (suffix: string): string => `after-reassign:${suffix}`
//! expect: after-reassign:direct
console.log(reassignThenDirectCall.describe('direct'))

// Optional and rest parameters through the fused direct-call path: argument
// conversion, padding and defaults must match the ordinary (materialized)
// call path exactly.
class OptionalRestWidget {
  combine = (first: string, second?: string, ...rest: string[]): string => `${first}|${second ?? 'none'}|${rest.join(',')}`
}
const optionalRestWidget = new OptionalRestWidget()
//! expect: a|none|
console.log(optionalRestWidget.combine('a'))
//! expect: a|b|
console.log(optionalRestWidget.combine('a', 'b'))
//! expect: a|b|c,d
console.log(optionalRestWidget.combine('a', 'b', 'c', 'd'))

// A direct call whose body reads `this`'s PRIVATE fields: the receiver the
// fused path threads through has to be the real instance, not some erased or
// partial view that a private-field access would refuse.
class PrivateFieldWidget {
  #secret = 'hidden'
  reveal = (label: string): string => `${label}:${this.#secret}`
}
const privateFieldWidget = new PrivateFieldWidget()
//! expect: reveal:hidden
console.log(privateFieldWidget.reveal('reveal'))

// A direct call on a SUBCLASS instance whose body reads an inherited PRIVATE
// receiver-typed value (`extra`) declared only on the subclass: the fused
// call must still resolve through the base's plan (`class-layout.ts`'s
// `lazyArrowFieldPlanOf` is keyed by the DECLARING class) while passing the
// actual subclass instance as `this`.
class SpecialWidgetDirectCall extends Widget {
  extra = 'special-direct'
}
const specialDirectCall = new SpecialWidgetDirectCall()
//! expect: widget:sub-direct
console.log(specialDirectCall.describe('sub-direct'))
//! expect: special-direct
console.log(specialDirectCall.extra)

// An `async` arrow field's direct call still returns a promise that resolves
// to the arrow's own result -- the fused path's result conversion must match
// the ordinary (materialized) call path's, not just its synchronous one.
class AsyncWidget {
  fetchValue = async (id: number): Promise<string> => {
    return `value-${id}`
  }
}
const asyncWidget = new AsyncWidget()
const runAsyncDirectCall = async (): Promise<void> => {
  //! expect: value-7
  console.log(await asyncWidget.fetchValue(7))
  // Reassignment still works for an async field's direct call too.
  asyncWidget.fetchValue = async (id: number): Promise<string> => `override-${id}`
  //! expect: override-9
  console.log(await asyncWidget.fetchValue(9))
}
void runAsyncDirectCall()

// A DIRECT CALL whose ARGUMENT is built by its own effectful operation
// BETWEEN the field's read and the call -- an object literal, exactly
// `c.json({ hello: 'world' })`'s shape in node-compat's hono-hello -- forces
// the GET to render as its OWN statement rather than deferred/withheld into
// the call (`ir/deferral.ts` never defers a read across an `allocate-record`).
// `class-layout.ts`'s `lazyCalleeReadsOf` still proves this GET's one reader
// is the call that reads it as its own callee, so `emit-properties.ts`'s
// `emitGet` renders that statement as a RAW, unmaterialized snapshot copy --
// never `lazyMaterializedFieldText`'s guard-and-store text -- and the call
// fusion (`emit-callable.ts`'s `emitLazyArrowFieldCall`) calls the census
// arrow's body straight off that snapshot. No `CallableObject` is ever built
// for this field: `gea_lazy_receiver->respond` (the field access a
// materializing render would alias and assign through) never appears in the
// emitted program at all.
//! emitted-lacks: gea_lazy_receiver->respond
class HonoShapeContext {
  respond = (payload: { message: string }): string => `sent:${payload.message}`
}
const honoShapeContext = new HonoShapeContext()
//! expect: sent:hello-hono
console.log(honoShapeContext.respond({ message: 'hello-hono' }))

// ECMA-262 evaluates a call's callee reference BEFORE its arguments (12.3.4.1,
// 13.3.7.2): `obj.f(obj.f = other, ...)` must still invoke the ORIGINAL
// arrow, because the read of `obj.f` that names the callee happens before the
// argument's assignment ever runs -- even though the assignment (folded into
// the argument through a comma expression here, so both sides keep valid
// static types) reassigns the very field the call is about to read again at
// CALL time. A guard read at call time, after the argument already ran (the
// defect this fix replaces), would call `other` instead.
class ReassignDuringArgumentWidget {
  greetWith = (label: string): string => `original:${label}`
}
const reassignDuringArgumentWidget = new ReassignDuringArgumentWidget()
const reassignDuringArgumentReplacement = (label: string): string => `replacement:${label}`
//! expect: original:mid-call
console.log(
  reassignDuringArgumentWidget.greetWith(((reassignDuringArgumentWidget.greetWith = reassignDuringArgumentReplacement), 'mid-call'))
)
// The reassignment from the argument above DID take effect on the field --
// an ordinary later read/call now goes through the replacement.
//! expect: replacement:after
console.log(reassignDuringArgumentWidget.greetWith('after'))

// The identical snapshot path, but the field is ALREADY materialized (a real
// `CallableObject`, not the empty sentinel) before this call runs: an
// ordinary value read forces materialization first, exactly like
// `describeRef` far above. The snapshot then copies THAT materialized value,
// and the fusion's `else` branch calls through the copy -- proving the
// snapshot is not "only correct while unmaterialized".
class AlreadyMaterializedHonoShapeContext {
  reply = (payload: { message: string }): string => `sent:${payload.message}`
}
const alreadyMaterializedHonoShapeContext = new AlreadyMaterializedHonoShapeContext()
const alreadyMaterializedReplyRef = alreadyMaterializedHonoShapeContext.reply
//! expect: sent:already-materialized
console.log(alreadyMaterializedHonoShapeContext.reply({ message: 'already-materialized' }))
//! expect: sent:via-ref
console.log(alreadyMaterializedReplyRef({ message: 'via-ref' }))
