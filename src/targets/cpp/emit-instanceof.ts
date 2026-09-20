import {
  classViewCarrierKinds,
  typedArrayConstructorDomains,
  type ClassInstanceTest,
  type ClassInstanceTestRecipe
} from '../../projection/instance-test.js'
import type { DeclarationId } from '../../identity/ids.js'
import type { IrOperand } from '../../ir/model.js'
import type { Representation } from '../../representation/model.js'
import { representationKey } from '../../representation/model.js'
import { createCppEmitBlockedError, operandText, type EmitContext } from './emit-context.js'
import { cppClassName, cppScalarType } from './types.js'
import { cppErrorNativeType, errorConstructorNames, isNativeError } from './error-types.js'
import { cppRegExpNativeTypes } from './regexp-types.js'

/**
 * `v instanceof C` -- ECMA-262 13.10.2, for the one right-hand side this
 * backend has a real `[[HasInstance]]` for.
 *
 * The general operator is a prototype walk (7.3.22 OrdinaryHasInstance), and
 * this compiler's objects have no prototype chain: a record is a C++ struct
 * and a class instance is a C++ object, and neither carries a link to the
 * constructor that built it. So the general answer is not rendered, and this
 * refuses by name rather than approximating one -- a test that compared
 * payload types directly would answer `false` for `new RangeError(m)
 * instanceof Error`, which the language answers `true`, and a wrong answer
 * wearing a plausible shape is the one outcome worth refusing for.
 *
 * The ERROR family is different, and exactly so. Every error a compiled
 * program can hold was minted by `gea::host::<X>Constructor::create`, which
 * records the record struct it minted under its own constructor's name and
 * under every name that constructor inherits (`detail::registerErrorRecordType`,
 * gea_runtime.h) -- 20.5.6.3's prototype chain, stated once at the one place
 * that knows both halves. `gea::host::instanceOfError` reads it back through
 * the box's own payload type, so the answer is the language's for every value
 * this runtime can produce.
 */

/** Native object families whose identity survives an explicitly dynamic boundary. */
const dynamicNativeInstanceTests: ReadonlyMap<string, string> = new Map([
  ['MapConstructor', 'gea::host::instanceOfMap'],
  ['DateConstructor', 'gea::host::instanceOfDate'],
  ['RegExpConstructor', 'gea::host::instanceOfRegExp'],
  ['ArrayBufferConstructor', 'gea::host::instanceOfArrayBuffer']
])

/** A carrier that can never hold an object and therefore always fails OrdinaryHasInstance. */
const definitelyPrimitive = (representation: Representation): boolean =>
  representation.kind === 'scalar' ||
  representation.kind === 'string' ||
  representation.kind === 'symbol' ||
  representation.kind === 'null' ||
  representation.kind === 'undefined'

/** Render the hierarchy census's recipe without rediscovering membership. */
const classInstanceTestText = (test: ClassInstanceTest, text: string): string => {
  switch (test.kind) {
    case 'constant':
      return `((void)(${text}), ${test.value ? 'true' : 'false'})`
    case 'throws-non-object':
      return `(gea::host::throwInstanceofNonObject("${test.target}"), false)`
    case 'present':
      return `static_cast<bool>(${text})`
    case 'boxed-typed-array':
      return `gea::host::instanceOfTypedArray<${cppScalarType(test.domain)}>(${text})`
    case 'class-family':
      if (test.members.length === 0) return `((void)(${text}), false)`
      return `gea::host::${test.boxed ? 'instanceOfClassFamily' : 'instanceOfClassFamilyRef'}<${test.members.map(cppClassName).join(', ')}>(${text})`
    case 'view-origin':
      if (test.members.length === 0) return `((void)(${text}), false)`
      return `gea::host::instanceOfClassFamily<${test.members.map(cppClassName).join(', ')}>(gea::record::viewOrigin(${text}))`
    case 'optional':
      return `((${text}).has_value() ? (${classInstanceTestText(test.payload, `(*${text})`)}) : false)`
    case 'union': {
      const clauses = test.arms.map(({ index, test: arm }) => {
        const nested = classInstanceTestText(arm, `${text}.get<${index}>()`)
        return arm.kind === 'class-family' && arm.boxed
          ? `(${text}.is<${index}>() && ${nested})`
          : `(${text}.is<${index}>() && (${nested}))`
      })
      if (clauses.length === 0) return `((void)(${text}), false)`
      return clauses.length === 1 ? clauses[0]! : `(${clauses.join(' || ')})`
    }
  }
}

/**
 * `value instanceof Promise` for a left operand the checker joined into a
 * `tagged-union`, the exact counterpart of the instance-test census
 * for the one host protocol this backend's own `Promise<T>` carrier answers
 * for.
 *
 * Like that function, no runtime read is needed for a `promise` arm: which
 * arms could ever BE a Promise is the checker's own declared member list, so
 * the answer is the union's own discriminant test. A `dynamic` arm is refused
 * rather than approximated -- see `instanceofText`'s own `dynamic` refusal
 * below for why a boxed value cannot answer this either (no boxing path
 * exists for a `promise` carrier at all: `emit-narrowing.ts`'s `dynamicTagFor`
 * has no case for it, so a box reaching this test was never produced FROM a
 * promise, but this file does not lean on that absence to fabricate `false`
 * for the arm -- it refuses by name, the same posture every other
 * unanswerable shape here takes).
 */
const instanceofTaggedUnionPromiseText = (
  ctx: EmitContext,
  left: IrOperand,
  union: Extract<Representation, { kind: 'tagged-union' }>
): string => {
  const text = operandText(ctx, left)
  const clauses: string[] = []
  for (const [index, arm] of union.arms.entries()) {
    if (arm.value.kind === 'promise') {
      clauses.push(`${text}.is<${index}>()`)
    } else if (arm.value.kind === 'dynamic') {
      throw createCppEmitBlockedError(
        'runtime-helper:computation:instanceof:dynamic:native-handle(PromiseConstructor)',
        '"instanceof" against "Promise" over a boxed union arm needs a runtime read this backend does not perform for a Promise payload'
      )
    }
    // Every other arm kind is never how this backend carries a Promise
    // (`types.ts`'s `promise -> gea::Promise<T>` is the only spelling), so it
    // contributes nothing.
  }
  if (clauses.length === 0) return `((void)(${text}), false)`
  return clauses.length === 1 ? (clauses[0] as string) : `(${clauses.join(' || ')})`
}

/**
 * `value instanceof Promise` for a left operand the checker settled to an
 * `optional`.
 *
 * The same question `instanceofTaggedUnionPromiseText` above answers, asked of
 * the other spelling of one absence: `T | undefined` and `T | void` are one
 * carrier (`representation/union.ts`'s `absenceOf`), and this compiler names
 * it `optional(T, undefined)`. hono's `defineWebSocketHelper` and
 * node-compat's `whatwg-streams.ts` both reach it -- `const result =
 * write(chunk, ...)` typed `void | Promise<void>`, then `result instanceof
 * Promise`.
 *
 * Written as its own renderer rather than folded into the tagged-union one:
 * that function's text is what every program carrying a union arm already
 * emits, and a shared recursion would re-spell it. A `dynamic` payload is
 * refused by name for exactly the reason stated there.
 */
const instanceofOptionalPromiseText = (
  ctx: EmitContext,
  left: IrOperand,
  optional: Extract<Representation, { kind: 'optional' }>
): string => {
  const test = (carrier: Representation, value: string): string => {
    if (carrier.kind === 'promise') return `((void)(${value}), true)`
    if (carrier.kind === 'dynamic')
      throw createCppEmitBlockedError(
        'runtime-helper:computation:instanceof:dynamic:native-handle(PromiseConstructor)',
        '"instanceof" against "Promise" over a boxed optional payload needs a runtime read this backend does not perform for a Promise payload'
      )
    if (carrier.kind === 'optional') return `((${value}).has_value() && (${test(carrier.payload, `(*${value})`)}))`
    if (carrier.kind === 'tagged-union') {
      const clauses: string[] = []
      for (const [index, arm] of carrier.arms.entries()) {
        if (arm.value.kind === 'promise') clauses.push(`${value}.is<${index}>()`)
        else if (arm.value.kind === 'dynamic') test(arm.value, `${value}.get<${index}>()`)
      }
      return clauses.length === 0 ? `((void)(${value}), false)` : clauses.length === 1 ? clauses[0]! : `(${clauses.join(' || ')})`
    }
    // Every other carrier is never how this backend holds a Promise
    // (`types.ts`'s `promise -> gea::Promise<T>` is the only spelling).
    return `((void)(${value}), false)`
  }
  return test(optional, operandText(ctx, left))
}

/**
 * `value instanceof Map` for a flow-carrier union containing a native Map.
 *
 * A `Map<K,V>` has one physical spelling in this backend: a
 * `keyed-collection` whose family is `map`. The union discriminant therefore
 * answers concrete arms exactly. A genuinely dynamic arm uses the same
 * payload identity test as the standalone dynamic case; every other carrier
 * is a different allocation kind and contributes false.
 */
const instanceofTaggedUnionMapText = (
  ctx: EmitContext,
  left: IrOperand,
  union: Extract<Representation, { kind: 'tagged-union' }>
): string => {
  const text = operandText(ctx, left)
  const test = (representation: Representation, value: string): string => {
    if (representation.kind === 'keyed-collection') {
      return `((void)(${value}), ${representation.family === 'map' ? 'true' : 'false'})`
    }
    if (representation.kind === 'dynamic') return `gea::host::instanceOfMap(${value})`
    if (representation.kind === 'optional') {
      return `((${value}).has_value() && (${test(representation.payload, `(*${value})`)}))`
    }
    if (representation.kind === 'tagged-union') {
      const nested: string[] = []
      for (const [index, arm] of representation.arms.entries()) {
        const clause = test(arm.value, `${value}.get<${index}>()`)
        nested.push(`(${value}.is<${index}>() && (${clause}))`)
      }
      return nested.length === 0 ? `((void)(${value}), false)` : `(${nested.join(' || ')})`
    }
    return `((void)(${value}), false)`
  }
  const clauses: string[] = []
  for (const [index, arm] of union.arms.entries()) {
    const armText = `${text}.get<${index}>()`
    clauses.push(`(${text}.is<${index}>() && (${test(arm.value, armText)}))`)
  }
  if (clauses.length === 0) return `((void)(${text}), false)`
  return clauses.length === 1 ? (clauses[0] as string) : `(${clauses.join(' || ')})`
}

/**
 * `v instanceof C` for a native protocol whose identity this backend really
 * can settle, over a left operand the checker joined into an `optional` or a
 * `tagged-union` -- `Buffer | Error`, `string | RegExp`, `BodyInit`.
 *
 * It is the generalization of `instanceofTaggedUnionPromiseText` and
 * `instanceofTaggedUnionMapText` above, written once instead of a third time,
 * and it exists because those two already established that a composite carrier
 * is not an obstacle to answering `instanceof`: a sum's discriminant IS the
 * question for every arm whose carrier is a settled physical allocation, and
 * only the arms that are not need a runtime read. The two older functions are
 * left where they are rather than folded in, because folding them would move
 * the emitted text of programs this change is not about.
 *
 * Which protocols: the seven error constructors, whose `gea::runtime::Error`
 * handle answers its own inheritance chain through `instanceOf` (see this
 * file's header), plus `RegExp` and `ArrayBuffer`, each of which has exactly
 * one physical carrier here, so an arm carrying it IS one and an arm carrying
 * anything else is not. `Map` and `Promise` are deliberately absent: their own
 * composite renderers above already claim those keys, and routing them here
 * would move their output.
 */
const compositeNativeInstanceProtocols: ReadonlySet<string> = new Set([
  ...errorConstructorNames.keys(),
  'RegExpConstructor',
  'ArrayBufferConstructor'
])

/** A settled answer that still evaluates the operand, the way every other constant verdict in this file does. */
const settledInstanceText = (value: string, answer: boolean): string => `((void)(${value}), ${answer ? 'true' : 'false'})`

/**
 * Whether any class in this one's base chain links a NATIVE base.
 *
 * The intrinsic `Error` family is the only native base this compiler links
 * (`emit-callable.ts` refuses every other `nativeBase.instance.native`), so a
 * class with none anywhere in its chain is a plain C++ object of its own
 * layout and cannot BE a native allocation of any kind -- which is what lets
 * an arm carrying it settle `false` without a read. A class that DOES link one
 * is refused rather than guessed at: `class NativeFailure extends Error` is
 * real, supported code (`test/runtime/native-error-descriptor-inheritance.ts`),
 * and answering `false` for `new NativeFailure() instanceof Error` would be
 * exactly the plausibly-shaped wrong answer this file exists to refuse.
 */
const extendsNativeClass = (ctx: EmitContext, declaration: DeclarationId): boolean => {
  let layout = ctx.classes.get(declaration)
  const seen = new Set<DeclarationId>()
  while (layout !== undefined && !seen.has(layout.declaration)) {
    if (layout.nativeBase !== null) return true
    seen.add(layout.declaration)
    layout = layout.base === null ? undefined : ctx.classes.get(layout.base)
  }
  return false
}

/**
 * The carriers that are a DIFFERENT physical allocation than any native object
 * tested for here, so `instanceof` is `false` for them with nothing read.
 *
 * Spelled as an explicit list rather than a default arm for the same reason
 * `instanceofLeftKinds` below is: a carrier kind added to the representation
 * model must not silently acquire a verdict here. Anything absent refuses by
 * name, which is the posture every unanswerable shape in this file takes.
 */
const settledNonNativeCarrier = (ctx: EmitContext, carrier: Representation): boolean => {
  switch (carrier.kind) {
    case 'scalar':
    case 'string':
    case 'symbol':
    case 'null':
    case 'undefined':
    case 'void':
    case 'record':
    case 'record-with-index':
    case 'array-object':
    case 'typed-array':
    case 'dense-buffer':
    case 'native-sequence':
    case 'keyed-collection':
    case 'dictionary':
    case 'iterator':
    case 'promise':
    case 'data-view':
    case 'array-buffer':
    case 'shared-array-buffer':
      return true
    case 'class-ref':
      return !extendsNativeClass(ctx, carrier.declaration)
    default:
      return false
  }
}

/** One arm/payload of the walk above: a carrier with no discriminant left to read. */
const nativeInstanceLeafText = (ctx: EmitContext, protocol: string, carrier: Representation, value: string): string => {
  const errorName = errorConstructorNames.get(protocol)
  if (carrier.kind === 'dynamic') {
    const nativeTest = dynamicNativeInstanceTests.get(protocol)
    if (nativeTest !== undefined) return `${nativeTest}(${value})`
    if (errorName !== undefined) return `gea::host::instanceOfError(${value}, "${errorName}")`
  } else if (errorName !== undefined) {
    if (isNativeError(carrier)) return `(${value})->instanceOf("${errorName}")`
    // A `gea::runtime::Error` held some other way than by a counted handle has
    // no `instanceOf` to call through, and `false` would be a wrong answer for
    // the one carrier that certainly IS an error. Refuse, so the defect is
    // named at the carrier rather than folded into a verdict. Every OTHER
    // native record is one C++ layout and not that one.
    const isOtherNativeRecord = carrier.kind === 'native-record-ref' && carrier.native !== cppErrorNativeType
    if (isOtherNativeRecord || settledNonNativeCarrier(ctx, carrier)) return settledInstanceText(value, false)
  } else if (protocol === 'RegExpConstructor' || protocol === 'ArrayBufferConstructor') {
    const matches =
      protocol === 'RegExpConstructor'
        ? carrier.kind === 'native-record-ref' && carrier.native === cppRegExpNativeTypes.pattern
        : carrier.kind === 'array-buffer'
    // A `native-record-ref` of a different native layout IS that layout and no
    // other -- one C++ type per native record -- so it settles as flatly as a
    // scalar does.
    if (matches || carrier.kind === 'native-record-ref' || settledNonNativeCarrier(ctx, carrier)) {
      return settledInstanceText(value, matches)
    }
  }
  throw createCppEmitBlockedError(
    `runtime-helper:computation:instanceof:${carrier.kind}:native-handle(${protocol})`,
    `"instanceof" against "${protocol}" over a "${representationKey(carrier)}" arm has no identity this backend can read`
  )
}

const compositeNativeInstanceText = (ctx: EmitContext, left: IrOperand, protocol: string): string => {
  const render = (carrier: Representation, value: string): string => {
    if (carrier.kind === 'optional') return `((${value}).has_value() ? (${render(carrier.payload, `(*${value})`)}) : false)`
    if (carrier.kind === 'tagged-union') {
      const clauses = carrier.arms.map((arm, index) => `(${value}.is<${index}>() && (${render(arm.value, `${value}.get<${index}>()`)}))`)
      return clauses.length === 0 ? settledInstanceText(value, false) : `(${clauses.join(' || ')})`
    }
    return nativeInstanceLeafText(ctx, protocol, carrier, value)
  }
  return render(left.representation, operandText(ctx, left))
}

/**
 * The carrier kinds a left operand can arrive in, for the `undefined`
 * right-hand side below.
 *
 * The obligation key names BOTH sides (`preflight/instanceof-key.ts`), and this
 * answer does not depend on the left one at all -- 13.10.2 throws before it
 * looks at `V`. So the claim has to be made for every left kind rather than
 * once, and the list is spelled here rather than derived from
 * `Representation`'s own union because a manifest row must claim only what this
 * file renders: adding a carrier kind to the model should not silently widen a
 * claim.
 */
export const cppInstanceofLeftKinds: readonly string[] = [
  'absent',
  'constant',
  'unplanned',
  'dynamic',
  'record',
  'class-ref',
  'native-record-ref',
  'array-object',
  'string',
  'scalar',
  'optional',
  'tagged-union',
  'undefined',
  'null',
  'typed-array',
  'keyed-collection',
  'dictionary',
  'iterator',
  'promise',
  'symbol'
]

/**
 * The left carrier kinds `constructorFamilyInstanceofText` actually renders a
 * verdict for against a program-class (`constructor-family`) right-hand
 * side. `dynamic` is included since `instanceOfClassFamilyText` above --
 * `Value::classIdentity()` answers the family test exactly for a boxed
 * operand, upcast or not (see that function's own doc comment).
 */
const constructorFamilyLeftKinds: readonly string[] = [
  'class-ref',
  'dynamic',
  'optional',
  'tagged-union',
  // A structural view the class census settled (`projection/instance-test.ts`'s `viewed`).
  ...classViewCarrierKinds
]

/** Every `computation:instanceof:*` key this file renders -- what `capabilities.ts` claims, derived from the tables above so the two cannot drift. */
export const cppInstanceofHelperKeys: ReadonlySet<string> = new Set([
  ...[...errorConstructorNames.keys()].map((protocol) => `computation:instanceof:dynamic:native-handle(${protocol})`),
  ...[...errorConstructorNames.keys()].map((protocol) => `computation:instanceof:native-record-ref:native-handle(${protocol})`),
  ...cppInstanceofLeftKinds.map((left) => `computation:instanceof:${left}:undefined`),
  ...[...dynamicNativeInstanceTests.keys()].map((protocol) => `computation:instanceof:dynamic:native-handle(${protocol})`),
  ...[...dynamicNativeInstanceTests.keys()].map((protocol) => `computation:instanceof:dictionary:native-handle(${protocol})`),
  'computation:instanceof:scalar:native-handle(NumberConstructor)',
  'computation:instanceof:tagged-union(primitive-only):native-handle(NumberConstructor)',
  // The native element domain is also sufficient when narrowing has already
  // removed the union: it is the same identity used for each union arm.
  ...[...typedArrayConstructorDomains.keys()].map((protocol) => `computation:instanceof:typed-array:native-handle(${protocol})`),
  ...[...typedArrayConstructorDomains.keys()].map((protocol) => `computation:instanceof:optional:native-handle(${protocol})`),
  ...[...typedArrayConstructorDomains.keys()].map((protocol) => `computation:instanceof:dynamic:native-handle(${protocol})`),
  ...[...typedArrayConstructorDomains.keys()].map((protocol) => `computation:instanceof:tagged-union:native-handle(${protocol})`),
  ...[...typedArrayConstructorDomains.keys()].map((protocol) => `computation:instanceof:dictionary:native-handle(${protocol})`),
  // A `class-ref` left operand: the census's own plan answers it (`constant
  // false`), because a program class's instance is a C++ object of that
  // class's layout and the only native base this compiler ever links is the
  // intrinsic Error family -- never a typed array. It was renderable all
  // along and merely unclaimed, which is how `@hono/node-server`'s `body
  // instanceof Uint8Array` over a narrowed `BodyInit` slot refused.
  ...[...typedArrayConstructorDomains.keys()].map((protocol) => `computation:instanceof:class-ref:native-handle(${protocol})`),
  // `compositeNativeInstanceText` above -- an `optional`/`tagged-union` left
  // operand against a protocol whose identity is a physical carrier here.
  ...[...compositeNativeInstanceProtocols].flatMap((protocol) => [
    `computation:instanceof:optional:native-handle(${protocol})`,
    `computation:instanceof:tagged-union:native-handle(${protocol})`
  ]),
  // `v instanceof <program class>` -- `constructorFamilyInstanceofText`'s own
  // three renderable left shapes.
  ...constructorFamilyLeftKinds.map((left) => `computation:instanceof:${left}:constructor-family`),
  // `v instanceof Promise` / `v instanceof String` for a left operand the
  // checker already settled to exactly `promise` -- `instanceofText`'s own
  // `left.representation.kind === 'promise'` branch below, sound for ANY
  // right-hand protocol (a Promise's identity can only ever be Promise's),
  // claimed for the two protocols this program actually exercises rather
  // than every authenticated protocol, matching this file's own
  // one-row-per-demonstrated-need practice elsewhere.
  'computation:instanceof:promise:native-handle(PromiseConstructor)',
  'computation:instanceof:promise:native-handle(StringConstructor)',
  // `v instanceof Promise` for a left operand joined into a `tagged-union` --
  // `instanceofTaggedUnionPromiseText` above.
  'computation:instanceof:tagged-union:native-handle(PromiseConstructor)',
  // ...and for one joined into an `optional`, the other spelling of the same
  // absence -- `instanceofOptionalPromiseText` above.
  'computation:instanceof:optional:native-handle(PromiseConstructor)',
  'computation:instanceof:tagged-union(map-testable):native-handle(MapConstructor)',
  // `v instanceof Promise` for a BOXED left operand -- the branch above that
  // reads `gea::host::instanceOfPromise`'s family table.
  'computation:instanceof:dynamic:native-handle(PromiseConstructor)',
  // `v instanceof C` where `C` is a plain JS function boxed `dynamic` under
  // `--dynamic-fallback` (its own `.prototype` is read or written) -- the
  // general prototype WALK `gea::host::instanceOfDynamicConstructor` renders,
  // over a left operand this same census also boxed (see that function's own
  // doc comment for why the left operand can only ever be `dynamic` too).
  'computation:instanceof:dynamic:dynamic'
])

/**
 * `v instanceof <host namespace root>` -- the host's own `[[HasInstance]]`.
 *
 * A namespace root is a PATH, not a value, and the object behind it carries an
 * empty facade struct with no prototype chain 13.10.2 could walk. Node's
 * `Buffer` is exactly that shape and `x instanceof Buffer` is exactly the
 * question `@hono/node-server` asks of it. The host is the one authority that
 * can answer: `gea::node::buffer::isBuffer` reads the opaque brand a Buffer
 * factory attached to the byte view, so a `Uint8Array` no Buffer ever produced
 * answers `false` -- which is the language's answer and not a structural guess
 * a shared byte-view carrier could ever have made.
 *
 * The predicate is applied per LEAF, never to a composite: an `Optional<T>`
 * or a `TaggedUnion<...>` is a different C++ type than anything the host
 * declared an overload for, and handing one over would silently select a
 * catch-all `false`. The presence and discriminant tests are this backend's own
 * question anyway, exactly as they are for every other `instanceof` here.
 */
const hostInstanceTestText = (ctx: EmitContext, left: IrOperand, spelling: string): string => {
  const render = (carrier: Representation, value: string): string => {
    if (carrier.kind === 'optional') return `((${value}).has_value() ? ${spelling}(*${value}) : false)`
    if (carrier.kind === 'tagged-union') {
      const clauses = carrier.arms.map((arm, index) => `(${value}.is<${index}>() && (${render(arm.value, `${value}.get<${index}>()`)}))`)
      return clauses.length === 0 ? settledInstanceText(value, false) : `(${clauses.join(' || ')})`
    }
    return `${spelling}(${value})`
  }
  return render(left.representation, operandText(ctx, left))
}

export const instanceofText = (ctx: EmitContext, left: IrOperand, right: IrOperand, recipe?: ClassInstanceTestRecipe): string => {
  const constructor = right.representation
  // A right-hand side that is not an Object is the one case the specification
  // answers with no prototype chain at all: 13.10.2 step 3 throws a TypeError
  // before `[[HasInstance]]` is consulted. It arises when a host has declared a
  // global ABSENT and a program tests against it anyway. Rendering the throw is
  // the language's own answer; rendering `false` would be a fabricated one, and
  // refusing would reject a library whose guard already made the test dead.
  // The instance-test census publishes the same answer for every non-Object
  // carrier (`throws-non-object`), which is what reflection consumes.
  if (recipe?.test.kind === 'throws-non-object') return classInstanceTestText(recipe.test, operandText(ctx, left))
  if (constructor.kind === 'undefined') {
    return `(gea::host::throwInstanceofNonObject("undefined"), false)`
  }
  // A `constructor-family` right-hand side names a PROGRAM class rather than
  // a host protocol, and unlike the general prototype-walk case just above,
  // the left operand's own carrier already answers this without one --
  // `constructorFamilyInstanceofText`'s own doc comment states exactly how
  // far that goes (declaration membership, no inheritance chain) and where it
  // refuses instead (a boxed left operand).
  if (constructor.kind === 'constructor-family') {
    if (recipe === undefined)
      throw createCppEmitBlockedError(
        'runtime-helper:instanceof:missing-class-recipe',
        'class membership was not published by the hierarchy census'
      )
    return classInstanceTestText(recipe.test, operandText(ctx, left))
  }
  // A BOXED right-hand side: a plain JS function whose own `.prototype` is
  // read or written somewhere in the program, so `representation/derive.ts`
  // (under `--dynamic-fallback`) answers its structural type `dynamic`
  // instead of `function-and-constructor` -- there is no declaration here for
  // `constructorFamilyInstanceofText`'s membership test to read, only a
  // runtime value. `gea::host::instanceOfDynamicConstructor` performs the
  // general prototype WALK 13.10.2 asks for, over the left operand's own
  // chain (also boxed: a program's own class instance never derives
  // `dynamic` on its own, so the only left operand that can reach a `dynamic`
  // constructor is one this same census also marked `dynamic` -- its own
  // construct signature's return type).
  if (constructor.kind === 'dynamic') {
    if (left.representation.kind !== 'dynamic') {
      throw createCppEmitBlockedError(
        `runtime-helper:computation:instanceof:${left.representation.kind}:dynamic`,
        `"instanceof" against a boxed constructor function needs a boxed left operand too, and this one carries "${representationKey(left.representation)}"`
      )
    }
    return `gea::host::instanceOfDynamicConstructor(${operandText(ctx, left)}, ${operandText(ctx, right)})`
  }
  if (constructor.kind === 'native-record-ref' && constructor.native !== null) {
    const spelling = ctx.hosts.instanceTests.get(constructor.native)
    if (spelling !== undefined) return hostInstanceTestText(ctx, left, spelling)
  }
  if (constructor.kind !== 'native-handle') {
    throw createCppEmitBlockedError(
      `runtime-helper:computation:instanceof:${left.representation.kind}:${representationKey(constructor)}`,
      `"instanceof" against a "${representationKey(constructor)}" right-hand side needs a prototype chain, which this backend does not model`
    )
  }
  if (left.representation.kind === 'dynamic') {
    const nativeTest = dynamicNativeInstanceTests.get(constructor.protocol)
    if (nativeTest !== undefined) return `${nativeTest}(${operandText(ctx, left)})`
  }
  // A native Dictionary is an ordinary object whose physical allocation is
  // neither a Map exotic nor a Date/RegExp object. Its static carrier proves
  // the result false; preserve evaluation of the left operand.
  if (left.representation.kind === 'dictionary' && dynamicNativeInstanceTests.has(constructor.protocol)) {
    return `((void)(${operandText(ctx, left)}), false)`
  }
  // OrdinaryHasInstance returns false for a primitive. A scalar carrier is
  // never a Number wrapper object, including when an erased `as unknown`
  // assertion was used to write the test. Keep evaluation of the operand.
  if (constructor.protocol === 'NumberConstructor' && left.representation.kind === 'scalar') {
    return `((void)(${operandText(ctx, left)}), false)`
  }
  if (
    constructor.protocol === 'NumberConstructor' &&
    left.representation.kind === 'tagged-union' &&
    left.representation.arms.every((arm) => definitelyPrimitive(arm.value))
  ) {
    return `((void)(${operandText(ctx, left)}), false)`
  }
  // A `promise` left operand settles ANY native-handle right-hand side
  // without reading anything: ECMA-262 27.2's Promise objects have exactly
  // one exotic kind, so the checker having already proved this exact carrier
  // IS the whole answer -- `true` for `PromiseConstructor` itself, `false`
  // for every other protocol, the same posture the instance-test census
  // takes for a typed-array arm that can never match a DIFFERENT element
  // domain.
  if (left.representation.kind === 'promise') {
    return `((void)(${operandText(ctx, left)}), ${constructor.protocol === 'PromiseConstructor' ? 'true' : 'false'})`
  }
  if (constructor.protocol === 'PromiseConstructor' && left.representation.kind === 'tagged-union') {
    return instanceofTaggedUnionPromiseText(ctx, left, left.representation)
  }
  if (constructor.protocol === 'PromiseConstructor' && left.representation.kind === 'optional') {
    return instanceofOptionalPromiseText(ctx, left, left.representation)
  }
  if (constructor.protocol === 'MapConstructor' && left.representation.kind === 'tagged-union') {
    return instanceofTaggedUnionMapText(ctx, left, left.representation)
  }
  // A BOXED left operand, answered by the family table `Value::box` fills.
  // Between the two shapes this file already renders: a promise needs a table
  // like the error family, because `gea::Promise<V>` is a different C++ type
  // for every `V` and no single `payloadType()` address identifies "a
  // promise"; but it needs no inheritance reconciliation like the errors,
  // because every promise is an instance of exactly one constructor
  // (ECMA-262 27.2.5). Sound for any box -- a payload that is not a promise
  // answers `false`, the same OrdinaryHasInstance step every other renderer
  // here takes.
  if (constructor.protocol === 'PromiseConstructor' && left.representation.kind === 'dynamic') {
    return `gea::host::instanceOfPromise(${operandText(ctx, left)})`
  }
  // A composite left operand against one of the protocols whose identity IS a
  // physical carrier here -- the seven errors, `RegExp`, `ArrayBuffer`. It sits
  // below the Map/Promise/typed-array branches on purpose: each of those has
  // its own composite renderer already, and `compositeNativeInstanceProtocols`
  // deliberately excludes them so this cannot take a program's output away
  // from the renderer that already claims its key.
  if (
    (left.representation.kind === 'optional' || left.representation.kind === 'tagged-union') &&
    compositeNativeInstanceProtocols.has(constructor.protocol)
  ) {
    return compositeNativeInstanceText(ctx, left, constructor.protocol)
  }
  if (typedArrayConstructorDomains.has(constructor.protocol)) {
    if (recipe === undefined)
      throw createCppEmitBlockedError(
        'runtime-helper:instanceof:missing-typed-array-recipe',
        'typed array membership was not published by the instance-test census'
      )
    return classInstanceTestText(recipe.test, operandText(ctx, left))
  }
  const name = errorConstructorNames.get(constructor.protocol)
  if (name === undefined) {
    throw createCppEmitBlockedError(
      `runtime-helper:computation:instanceof:${left.representation.kind}:native-handle(${constructor.protocol})`,
      `"instanceof" against the host protocol "${constructor.protocol}" over a "${representationKey(left.representation)}" left operand has ` +
        'no [[HasInstance]] rendered here -- only the error constructors answer a boxed left operand, and Promise/TypedArray answer only the ' +
        'left shapes their own tables above cover'
    )
  }
  if (isNativeError(left.representation)) return `(${operandText(ctx, left)})->instanceOf("${name}")`
  if (left.representation.kind !== 'dynamic') {
    // A statically typed left operand is a question the checker already
    // answered, and answering it again from a carrier would be a second
    // authority over the same fact -- one that cannot see the narrowing the
    // checker performed. Refused until the constant folding is written where
    // the proof lives.
    throw createCppEmitBlockedError(
      `runtime-helper:computation:instanceof:${left.representation.kind}:native-handle(${constructor.protocol})`,
      `"instanceof" over a "${representationKey(left.representation)}" left operand is settled by the checker, and this backend renders only the boxed test`
    )
  }
  return `gea::host::instanceOfError(${operandText(ctx, left)}, "${name}")`
}
