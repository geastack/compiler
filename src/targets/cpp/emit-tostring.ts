import { representationKey, type CallableAbi, type Ownership, type RecordField, type Representation } from '../../representation/model.js'
import { isNativeError } from './error-types.js'
import { operandText, type EmitContext } from './emit-context.js'
import type { ComputeOperation, IrOperand } from '../../ir/model.js'
import type { DeclarationId } from '../../identity/ids.js'
import { constructedBaseOf, type ClassLayout } from '../../projection/classes.js'
import type { RepresentationDeriver } from '../../representation/derive.js'
import { recordFieldsOfShape, recordLayoutPolicyOf } from '../../projection/fields.js'
import type { RecordLayoutPolicy } from '../../representation/policies.js'
import { cppBodyName, cppConstantLiteral, cppRecordFieldName, cppTypeOf } from './types.js'
import { memberAccessOperator } from './emit-carrier-members.js'
import { cppDateType, isDateCarrier } from './prototype/emit-prototype-date.js'

/**
 * ToString of a value, spelled from the carrier it actually arrived in.
 *
 * Both callers -- an explicit `String(x)` and a template expression's
 * substitution -- run the same abstract operation, so they read the same table
 * rather than two that could disagree about what `String(true)` is.
 *
 * `null` is returned for a carrier this has no conversion for; the caller
 * names the refusal, because what it can say about *why* the value is there
 * differs between a call argument and a substitution.
 */
export const toStringText = (
  text: string,
  carrier: Representation,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  deriver: RepresentationDeriver,
  /**
   * Whether this is `String(x)` itself rather than the ToString an operator
   * performs. ECMA-262 22.1.1.1 special-cases exactly that call: a symbol
   * argument answers its SymbolDescriptiveString, while ToString of a symbol
   * (`\`${s}\``, `s + ""`) throws a TypeError. The distinction is the caller's
   * to state, so the implicit sites keep refusing a symbol rather than
   * silently printing what only the explicit call may.
   */
  explicit = false,
  /**
   * `Array.prototype.join`'s own ToString (ECMA-262 23.1.3.18 step 3.d) is the
   * SAME abstract operation with one capability toggled: a `null`/`undefined`
   * element contributes the empty string rather than the text "null"/"undefined"
   * every other caller of this table needs (`String(undefined)`, `\`${x}\``,
   * `"" + x` all print the text). `joinText` (`prototype/emit-prototype-array.ts`)
   * is the only caller that sets this.
   */
  nullishJoinsEmpty = false,
  /** See `toStringTextOver`'s `symbolThrows`. */
  symbolThrows = false
): string | null => toStringTextOver(text, carrier, recordLayoutPolicyOf(deriver, classes), explicit, nullishJoinsEmpty, symbolThrows)

/**
 * The `[[Call]]` convention a stored member holds, for the four carriers whose
 * C++ spelling is a `gea::CallableObject` and which therefore expose `.call()`.
 *
 * `function-and-constructor` is deliberately absent: it spells a
 * `CallableConstructorObject`, a different type, and a member that is BOTH is
 * a built-in constructor rather than an ordinary method. A `recursive`
 * dispatch is absent for the same fail-closed reason -- its spelling is the
 * wrapper struct's name, not the callable template.
 */
const storedCallAbiOf = (member: Representation): CallableAbi | null => {
  if (member.kind === 'function' || member.kind === 'function-family') return member.abi
  if (member.kind === 'function-value-family') return member.optional ? null : member.abi
  if (member.kind === 'function-value-dispatch') return member.recursive ? null : member.abi
  return null
}

/**
 * ECMA-262 7.1.1.1 `OrdinaryToPrimitive(O, string)` over a record's OWN
 * `toString` member -- the first of the two method names that algorithm tries.
 *
 * This is the native answer to "a statically typed object needs a dynamic
 * capability": the shape declares `toString`, its carrier states the exact
 * convention, and the call is an ordinary indirect call through the struct
 * member. Boxing the record to reach a dynamic ToString would be the forbidden
 * shortcut, and answering `[object Object]` for a shape that declares the
 * method is the silently-wrong one.
 *
 * The gate is what makes the answer exact rather than probable, and every part
 * of it is load-bearing:
 *
 * - The member must be a REQUIRED data field. An optional one may be absent at
 *   run time, and OrdinaryToPrimitive then skips to `valueOf`, which this does
 *   not render.
 * - The convention must take no receiver and no arguments. A receiver in the
 *   ABI means the compiler proved the body reads `this` and the physical slot
 *   expects it first (`captures.ts`'s `readsReceiver`); a leaf that has only
 *   an expression for the object, not an operand, cannot bind one, so it
 *   refuses instead of calling with the wrong frame.
 * - The result must be `string` or a `scalar`, which is a STATIC proof that it
 *   is not an Object -- exactly the test step 3.c of OrdinaryToPrimitive
 *   applies at run time before it accepts the value. Any other result carrier
 *   would have to fall through to `valueOf`.
 *
 * Anything outside that returns `null`, which keeps the previous refusal
 * rather than substituting a wrong constant.
 */
const ownToStringCallText = (
  text: string,
  fields: readonly RecordField[],
  ownership: Ownership,
  layouts: RecordLayoutPolicy,
  explicit: boolean
): string | null => {
  const field = fields.find((candidate) => candidate.key === 'toString')
  if (field === undefined || !field.required) return null
  const abi = storedCallAbiOf(field.value)
  if (abi === null || abi.receiver !== null || abi.restFrom !== null || abi.parameters.length !== 0) return null
  if (abi.result.kind !== 'string' && abi.result.kind !== 'scalar') return null
  return toStringTextOver(
    `(${text}${memberAccessOperator(ownership)}${cppRecordFieldName('toString')}).call()`,
    abi.result,
    layouts,
    explicit
  )
}

/**
 * The record-layout table plus, where the reader has the emitted class
 * families in hand, the virtual member a class's overridden method dispatches
 * through (`virtual-methods.ts`). ToString of a class instance whose
 * `toString` a subclass overrides runs the ALLOCATED object's own method
 * (7.1.1.1 step 5.b.i looks it up on the object), which is that member and
 * never the base's body -- so without it such a class refuses.
 */
export interface ToStringLayouts extends RecordLayoutPolicy {
  readonly virtualMethodCallFor?: (
    declaration: DeclarationId,
    key: string
  ) => { readonly call: (receiver: string) => string; readonly result: Representation } | null
}

/** The name a nullable class reference is bound to while its ToString tests for `null`. */
const nullableClassReceiver = 'gea_to_string_receiver'

/**
 * The same table over the one `RecordLayoutPolicy` every reader of record
 * shapes shares (`projection/fields.ts`). The conversion registry's `coercion`
 * entry (`conversions.ts`) decides whether a ToString is INSTALLED for a
 * carrier by asking this very function for a placeholder -- so the census's
 * "is there a conversion" and the printer's "what is its text" cannot
 * disagree: a carrier this returns `null` for is a `never` coercion node, and
 * a carrier it renders is rendered by exactly this text.
 */
export const toStringTextOver = (
  text: string,
  carrier: Representation,
  layouts: ToStringLayouts,
  explicit = false,
  nullishJoinsEmpty = false,
  /**
   * The ToString an operator performs (`\`${s}\``, `s + ''`) of a symbol is a
   * TypeError (ECMA-262 7.1.17 step 1), so a symbol arm of a carrier that
   * also holds strings -- a Proxy trap's `string | symbol` key -- is rendered
   * as that throw instead of refusing the whole conversion. Only the coercion
   * nodes ask: every other reader of this table (a property key, a mixed
   * binary's string side) must keep treating a symbol as unconvertible,
   * because ToPropertyKey of a symbol is the symbol and never its text.
   */
  symbolThrows = false
): string | null => {
  if (carrier.kind === 'string') return text
  if (carrier.kind === 'symbol')
    return explicit
      ? `gea::symbolToString(${text})`
      : symbolThrows
        ? '(gea::host::throwRuntimeError("TypeError", "Cannot convert a Symbol value to a string"), std::string())'
        : null
  // ToPrimitive of a function object reaches `Function.prototype.toString`
  // (its own `valueOf` answers the object): the source text the mint site
  // registered. `translation-unit.ts`'s `preserveFunctionFacts` registers it
  // for every program coercing a callable operand.
  if (carrier.kind === 'function-value-dispatch' || carrier.kind === 'function-and-constructor') return `std::string(${text}.sourceText())`
  // A Date. ECMA-262 7.1.17 ToString of an object is ToPrimitive with hint
  // string, which for a Date is OrdinaryToPrimitive trying `toString` first --
  // 21.4.4.41, the member `gea::runtime::Date` already implements. So
  // `${d}`, `String(d)` and `"x" + d` all answer exactly `d.toString()`, and
  // this states that once rather than leaving the implicit spellings refused
  // while the explicit one renders. v1 does the same thing, in the same place:
  // its `gea_cpp_to_string(const gea::runtime::Date&)` overload, whose own
  // comment says a Date without it "stringifies to [object Object]".
  //
  // CAVEAT, and it is this backend's only ToString divergence from node: the
  // string carries no " (Zone Name)" suffix -- 21.4.4.41.7 step 8 makes that
  // suffix implementation-defined and permits an empty one, node prints it,
  // and this does not. It is the same divergence `d.toString()` already has
  // (probe `.scratch/probes/date-zonename`), applied to a second spelling of
  // the same operation, not a new one.
  // The Date test lives inside the `native-record-ref` branch below, because
  // that is what a Date IS in this backend and `isDateCarrier`'s type guard
  // narrows the NEGATIVE branch to exclude every native record, not just the
  // non-Date ones -- which made every later branch blind to the kind.
  // ECMA-262 23.1.3.18 `join` step 3.d contributes the EMPTY string for a
  // `null`/`undefined` element -- not the text every other caller of this
  // table needs -- so a `nullishJoinsEmpty` caller gets the join-specific
  // answer for a receiver whose element carrier IS exactly `null`/`undefined`
  // (never any other member `undefined`, e.g. a genuinely missing struct
  // field mid-record, which is not this operation).
  if (carrier.kind === 'null')
    return nullishJoinsEmpty ? cppConstantLiteral('', 'string', { kind: 'string' }) : 'gea::host::detail::toStringNull()'
  if (carrier.kind === 'undefined')
    return nullishJoinsEmpty ? cppConstantLiteral('', 'string', { kind: 'string' }) : 'gea::host::detail::toStringUndefined()'
  if (carrier.kind === 'scalar') {
    // The cast is not cosmetic. `int32`/`uint32` lower to fixed-width integer
    // types, and an integer argument converts to BOTH `double` and `bool` at
    // the same rank -- the overload call would be ambiguous and fail to
    // compile. Naming the domain's own type at the call site is what picks the
    // intended overload rather than leaving it to be resolved by accident.
    if (carrier.domain === 'boolean') return `gea::host::detail::toString(static_cast<bool>(${text}))`
    if (carrier.domain === 'bigint') return `(${text}).toString()`
    return `gea::host::detail::toString(static_cast<double>(${text}))`
  }
  // A caught exception is the one place a `dynamic` carrier's own runtime tag
  // is read back rather than assumed: `catch (e) { String(e) }` is real,
  // ordinary TypeScript (both `spread.ts` and the Dialer example use exactly
  // this), and `e`'s checker type -- `unknown` -- is one of the four
  // legitimate dynamic boundaries, not a value this emitter boxed on its own
  // initiative. `gea::host::detail::toString(const gea::Value&)`
  // tag-switches, mirroring `toBoolean(const gea::Value&)`.
  if (carrier.kind === 'dynamic') return `gea::host::detail::toString(${text})`
  // An optional DOES know which absence it holds. `Representation`'s own
  // `optional` variant carries `absence: 'null' | 'undefined'` -- it has to,
  // because `x === null` and `x === undefined` are different questions over
  // one `gea::Optional<T>` -- so the two answers the language gives
  // (`String(null)` is "null", `String(undefined)` is "undefined") are both
  // derivable here. This branch previously refused with "the carrier has lost
  // the distinction", and the refusal text it printed
  // (`optional(string,null)`) contained the very tag it claimed was missing.
  //
  // `text` is an SSA value name (`emit-context.ts`'s `nameOfValue` mints
  // `vN`), never an expression with an effect, so naming it twice in one
  // conditional reads one local twice rather than running anything twice.
  if (carrier.kind === 'optional') {
    const present = toStringTextOver(`(*${text})`, carrier.payload, layouts, explicit, nullishJoinsEmpty, symbolThrows)
    if (present === null) return null
    const absent = nullishJoinsEmpty
      ? cppConstantLiteral('', 'string', { kind: 'string' })
      : carrier.absence === 'null'
        ? 'gea::host::detail::toStringNull()'
        : 'gea::host::detail::toStringUndefined()'
    return `(${text}.has_value() ? std::string(${present}) : std::string(${absent}))`
  }
  // A tagged union is a statically known, finite set of arms with a runtime
  // discriminant, which is exactly what ToString needs: ECMA-262 7.1.17 is
  // applied per arm, and the arm is selected by the discriminant the carrier
  // already stores. `gea::TaggedUnion<Arms...>` exposes `is<I>()` and
  // `get<I>()` over the arm's position -- the same index `arms` is ordered by
  // -- so this is a conditional chain over positions, not a box.
  //
  // The final arm is the `else`, with no test of its own: the discriminant is
  // always one of `0..arity-1`, so testing it would add a branch that can
  // never be taken and leave the chain with no value on the impossible path.
  if (carrier.kind === 'tagged-union') {
    const arms: string[] = []
    for (const [index, arm] of carrier.arms.entries()) {
      const converted = toStringTextOver(`${text}.get<${index}>()`, arm.value, layouts, explicit, nullishJoinsEmpty, symbolThrows)
      if (converted === null) return null
      arms.push(`std::string(${converted})`)
    }
    const last = arms[arms.length - 1]
    if (last === undefined) return null
    let chain = last
    for (let index = arms.length - 2; index >= 0; index -= 1) {
      chain = `${text}.is<${index}>() ? ${arms[index]} : ${chain}`
    }
    return `(${chain})`
  }
  // ECMA-262 7.1.17: ToString of an object is ToPrimitive(hint string), which
  // for an ordinary object (`OrdinaryToPrimitive`) tries `toString()` first --
  // the Date case above is exactly that, for the one class this backend wrote
  // by hand. A `class-ref` is a program-declared class this backend PROJECTED
  // from TypeScript, and the identical rule applies, decided at compile time
  // rather than run: a class that installs its own `toString` needs that
  // METHOD actually invoked, which is a real call this leaf has no
  // `EmitContext`/receiver-binding machinery to build (`text` is a receiver
  // expression, not something a bound-method call can be assembled around
  // here) -- refused rather than answered wrong. A class with no own
  // `toString` anywhere up its `extends` chain has a decidable answer with NO
  // call at all: 20.1.3.6's `OrdinaryToPrimitive`-independent tag walk lands
  // on the literal `builtinTag` "Object" for every ordinary object that is
  // not one of the handful of exotic/boxed kinds the spec special-cases by
  // name (Array, Function, Error, Boolean, Number, String, Date, RegExp,
  // Arguments) -- and none of those is ever represented as `class-ref` in
  // this backend (each has its own dedicated representation kind), so a
  // `class-ref` can never BE one. The constant is per the CLASS, not per
  // instance: `class Foo {}; Object.prototype.toString.call(new Foo())` is
  // `"[object Object]"`, not `"[object Foo]"` -- `Symbol.toStringTag` is the
  // only thing that changes the tag, and `declaresOwnToString`'s own comment
  // says why that one is out of reach here too.
  if (carrier.kind === 'class-ref') {
    // `representation/optional.ts` collapses `T | null` onto a shared class
    // reference, so its null state is JavaScript's `null` and prints as one;
    // answering the class's own text for it printed `[object Object]` for a
    // null `Job | null`. The receiver is bound once because `text` may be a call.
    if (carrier.ownership === 'shared-refcount' && text !== nullableClassReceiver) {
      const present = toStringTextOver(nullableClassReceiver, carrier, layouts, explicit, nullishJoinsEmpty, symbolThrows)
      if (present === null) return null
      const absent = nullishJoinsEmpty ? cppConstantLiteral('', 'string', { kind: 'string' }) : 'gea::host::detail::toStringNull()'
      return `([&]() -> std::string { const auto& ${nullableClassReceiver} = ${text}; return static_cast<bool>(${nullableClassReceiver}) ? std::string(${present}) : std::string(${absent}); })()`
    }
    // The exception to the tag above: a class extending `Error` inherits
    // 20.5.3.4 `Error.prototype.toString`, and its struct derives in place
    // from the intrinsic layout that implements it over the stored `name` and
    // `message`. A family that redeclares either with a non-constant accessor
    // (`nativeBaseOverridden`) has fields that need not agree, and refuses.
    const ownToString = layouts.classMethodFor?.(carrier.declaration, 'toString') ?? false
    if (!ownToString && carrier.nativeBase?.kind === 'native-record-ref' && isNativeError(carrier.nativeBase)) {
      if (carrier.nativeBaseOverridden) return null
      return `static_cast<const ${carrier.nativeBase.native}&>(*${text}).toString()`
    }
    if (!ownToString) return cppConstantLiteral('[object Object]', 'string', { kind: 'string' })
    // The class DOES declare its own `toString`, so 7.1.17 says that method
    // runs -- and a zero-argument instance method nothing overrides is a
    // direct call on its own body, the very same C++ `p.toString()` already
    // emits (`gea_body_<method>(receiver)`), so this is the same call reached
    // by a different spelling rather than a second convention for it. The
    // result goes back through this table because `toString` is declared to
    // return a string in every case that matters and a `scalar` in the ones
    // that do not, and ToString of THAT is what the caller asked for.
    // `classDirectMethodFor` answers `null` for an overridden key, and this
    // keeps refusing there: picking the base's body for a derived instance is
    // the wrong answer, not a missing one.
    const direct = layouts.classDirectMethodFor?.(carrier.declaration, 'toString') ?? null
    if (direct === null) {
      const dispatched = layouts.virtualMethodCallFor?.(carrier.declaration, 'toString') ?? null
      return dispatched === null ? null : toStringTextOver(dispatched.call(text), dispatched.result, layouts, explicit)
    }
    // Each declared parameter is default-constructed, which for every carrier
    // `classDirectMethodFor` admits (an `undefined`-absence optional, the
    // dynamic box, `undefined` itself) IS the `undefined` a no-argument call binds.
    const absent = direct.absentParameters.map((parameter) => `, ${cppTypeOf(parameter)}{}`).join('')
    return toStringTextOver(`${cppBodyName(direct.callable)}(${text}${absent})`, direct.result, layouts, explicit)
  }
  // ECMA-262 25.1.5.15: `ArrayBuffer.prototype` defines a `get
  // [Symbol.toStringTag]` returning the literal "ArrayBuffer", and defines no
  // own `toString`/`valueOf` of its own. So ToPrimitive(hint string) falls
  // through OrdinaryToPrimitive's `toString` lookup to the inherited
  // `Object.prototype.toString`, whose own algorithm (19.1.3.6 step 16) reads
  // that tag back -- giving a fixed, class-INDEPENDENT answer with no method
  // call needed, the same shape the `class-ref` case above resolves at
  // compile time for a class with no own `toString`. `hono`'s `BodyInit`
  // union (`request.ts`'s cached-body arm) is a real caller: `${body}` where
  // `body` narrows to a bare `ArrayBuffer` reaches exactly this.
  if (carrier.kind === 'array-buffer') return cppConstantLiteral('[object ArrayBuffer]', 'string', { kind: 'string' })
  if (carrier.kind === 'shared-array-buffer') return cppConstantLiteral('[object SharedArrayBuffer]', 'string', { kind: 'string' })
  // ECMA-262 23.1.3.36 gives Array its inherited `toString` through
  // `Array.prototype.join`. The runtime's `array::join` already implements the
  // required comma separator, hole handling and per-element ToString. Admit
  // exactly the element carriers that renderer accepts, so an array whose
  // elements need arbitrary user-code coercion still refuses here instead of
  // being boxed or guessed.
  if (carrier.kind === 'array-object' && (carrier.element.kind === 'string' || carrier.element.kind === 'scalar')) {
    return `gea::runtime::array::join(${text})`
  }
  // ECMA-262 23.2.3.18 gives TypedArray the same comma-joined ToString shape
  // as Array, without holes or nullish elements. Every typed-array carrier in
  // this backend stores Number elements, so the runtime overload converts each
  // one through Number::toString while preserving the native view.
  if (carrier.kind === 'typed-array') return `gea::runtime::array::join(${text})`
  // A plain object -- an object literal, an interface, a host-declared struct.
  // The `class-ref` case above already argues this exact answer from 20.1.3.6:
  // an ordinary object with no own `toString` anywhere reachable falls through
  // OrdinaryToPrimitive to `Object.prototype.toString`, whose builtinTag walk
  // lands on the literal "Object" for everything that is not one of the nine
  // exotic kinds the spec names -- none of which is ever carried as a record.
  // The guard is the same guard, asked of the record's own members instead of
  // a class's prototype chain: a shape that declares `toString` needs that
  // method invoked, which this leaf cannot build a call for, so it refuses.
  //
  // hono reaches this constantly: `${c.req.raw}` and `console.error(err)` over
  // an interface-typed value are both a ToString of a record.
  // An open table (`{ [key: string]: any }`, mongodb's `Document`): its
  // `toString` and `valueOf` are keys it may or may not hold, so which one
  // answers is a question about the value, asked by the runtime of the table
  // itself (`gea::dictionaryToString`, OrdinaryToPrimitive over
  // `Object.prototype`). A table whose values are typed callables would need
  // each called through its own ABI, with no receiver slot to pass the table
  // in, so it refuses.
  if (
    carrier.kind === 'dictionary' &&
    carrier.key === 'string' &&
    carrier.ownership === 'shared-refcount' &&
    !holdsTypedCallable(carrier.value)
  ) {
    return `gea::dictionaryToString(${text})`
  }
  if (carrier.kind === 'record' || carrier.kind === 'record-with-index') {
    return carrier.fields.some((field) => field.key === 'toString')
      ? ownToStringCallText(text, carrier.fields, carrier.ownership, layouts, explicit)
      : cppConstantLiteral('[object Object]', 'string', { kind: 'string' })
  }
  if (carrier.kind === 'native-record-ref') {
    if (isNativeError(carrier)) return `(${text})->toString()`
    // A Date. ECMA-262 7.1.17 ToString of an object is ToPrimitive with hint
    // string, which for a Date is OrdinaryToPrimitive trying `toString` first
    // -- 21.4.4.41, the member `gea::runtime::Date` already implements. So
    // `${d}`, `String(d)` and `"x" + d` all answer exactly `d.toString()`, and
    // this states that once rather than leaving the implicit spellings refused
    // while the explicit one renders. v1 does the same thing, in the same
    // place: its `gea_cpp_to_string(const gea::runtime::Date&)` overload,
    // whose own comment says a Date without it "stringifies to
    // [object Object]".
    //
    // CAVEAT, and it is this backend's only ToString divergence from node: the
    // string carries no " (Zone Name)" suffix -- 21.4.4.41.7 step 8 makes that
    // suffix implementation-defined and permits an empty one, node prints it,
    // and this does not. It is the same divergence `d.toString()` already has,
    // applied to a second spelling of the same operation, not a new one.
    if (carrier.native === cppDateType) return `${text}->toString()`
    const fields = layouts.forShape(carrier.shapeId)
    if (fields === null) return null
    return fields.some((field) => field.key === 'toString')
      ? ownToStringCallText(text, fields, carrier.ownership, layouts, explicit)
      : cppConstantLiteral('[object Object]', 'string', { kind: 'string' })
  }
  // ECMA-262 27.2.5.5: `Promise.prototype[Symbol.toStringTag]` is the literal
  // "Promise", and `Promise.prototype` defines no own `toString`/`valueOf`, so
  // ToPrimitive(hint string) falls through to `Object.prototype.toString`,
  // which reads that tag back (20.1.3.6 step 15). Class-independent, no call
  // -- the identical shape as `array-buffer` just above.
  if (carrier.kind === 'promise') return cppConstantLiteral('[object Promise]', 'string', { kind: 'string' })
  return null
}

/** Whether a value of `carrier` can be a callable with a typed ABI -- one this leaf cannot call with a dynamic receiver. */
const holdsTypedCallable = (carrier: Representation): boolean => {
  if (carrier.kind === 'optional') return holdsTypedCallable(carrier.payload)
  if (carrier.kind === 'tagged-union') return carrier.arms.some((arm) => holdsTypedCallable(arm.value))
  return (
    carrier.kind === 'function' ||
    carrier.kind === 'function-family' ||
    carrier.kind === 'function-value-family' ||
    carrier.kind === 'function-value-dispatch' ||
    carrier.kind === 'function-and-constructor'
  )
}

/**
 * A tuple is an Array, carried as a positional record (there is no tuple
 * carrier), and ECMA-262 23.1.3.36 gives an Array the ToString of
 * `join(",")`: each position through 23.1.3.18's ToString, a nullish one as
 * the empty string. Answering the ordinary object's "[object Object]" tag
 * made `Object.entries(o).join(';')` print that tag for every entry.
 *
 * An optional position refuses: whether it is present decides the tuple's
 * length, and with it whether a trailing separator is written.
 */
const tupleToStringText = (
  text: string,
  carrier: Extract<Representation, { kind: 'record' }>,
  layouts: RecordLayoutPolicy
): string | null => {
  if (carrier.fields.some((field, position) => field.key !== String(position) || !field.required)) return null
  if (carrier.fields.length === 0) return cppConstantLiteral('', 'string', { kind: 'string' })
  const tuple = '__gea_tuple'
  const pieces: string[] = []
  for (const field of carrier.fields) {
    const piece = toStringTextOver(
      `${tuple}${memberAccessOperator(carrier.ownership)}${cppRecordFieldName(field.key)}`,
      field.value,
      layouts,
      false,
      true
    )
    if (piece === null) return null
    if (pieces.length > 0) pieces.push(cppConstantLiteral(',', 'string', { kind: 'string' }))
    pieces.push(piece)
  }
  return `([&](const ${cppTypeOf(carrier)}& ${tuple}) -> std::string { return gea::concatStrings({${pieces.join(', ')}}); }(${text}))`
}

/**
 * ToString over a list of operands, folded with `separator` inserted between
 * every pair -- the one machine behind two different joins: a template
 * literal's own adjacency (`separator: null`, `templateText` below) and
 * `console.log`'s single-space rule (`separator: 'std::string(" ")'`,
 * `consoleArgumentsText` below). Both need the identical per-operand
 * ToString and identical empty/singleton handling; only what sits between
 * pieces differs, so one function states the fold once instead of two copies
 * that could quietly disagree about what an empty operand list means.
 *
 * `null` is returned when an operand's carrier has no ToString, and the
 * caller names which one refused -- what differs between a template
 * substitution and a call argument is what the caller can say about *why*
 * the value is there, not the conversion rule itself.
 *
 * `emit.ts` has two callers today: a template literal's own chunks
 * (`templateText` below, `separator: null`) and the string-concatenation `+`
 * fold (`emit.ts`'s "`+` is string concatenation..." branch, also
 * `separator: null` via `templateText`) -- both pass `operation.operands`
 * directly, which is why one binary-`+`'s two operands and an N-piece
 * template's chunks fold identically here.
 */
const joinedToStringText = (
  ctx: EmitContext,
  operands: readonly IrOperand[],
  separator: string | null,
  rendered: (operand: IrOperand) => string | null = () => null
): { text: string } | { refused: Representation } => {
  const pieces: string[] = []
  for (const operand of operands) {
    // A template or `+` throws on a symbol; `console.log` inspects it instead, so only the
    // separator-less fold may state that throw.
    const converted = toStringText(
      operandText(ctx, operand),
      operand.representation,
      ctx.classes,
      ctx.deriver,
      false,
      false,
      separator === null
    )
    if (converted === null) return { refused: operand.representation }
    pieces.push(converted)
  }
  // No operands is the empty string: a template with no text and no
  // substitution, or `console.log()` with no arguments, both say nothing.
  const first = pieces[0]
  if (first === undefined) return { text: cppConstantLiteral('', 'string', { kind: 'string' }) }
  // The first piece is forced to `std::string` so the fold is string
  // concatenation rather than pointer arithmetic between two `const char *`.
  if (pieces.length === 1) return { text: `std::string(${first})` }
  const separated = separator === null ? pieces : pieces.flatMap((piece, index) => (index === 0 ? [piece] : [separator, piece]))
  return { text: `gea::concatStrings({${separated.join(', ')}})` }
}

/**
 * The value appended by a proven in-place string update.
 *
 * Rebuilding `oldS + suffix` with `concatStrings` copies `oldS` before
 * assigning the result back. The write emitters remove that first operand;
 * this helper preserves the efficient single-piece spelling, including the
 * `char` overload for one printable ASCII byte.
 */
const stringAppendSuffixText = (ctx: EmitContext, operands: readonly IrOperand[]): string => {
  const only = operands.length === 1 ? operands[0] : undefined
  if (only !== undefined) {
    const text = ctx.constantTexts.get(only.value)
    const code = text?.length === 1 ? text.charCodeAt(0) : 0
    if (code >= 0x20 && code <= 0x7e && text !== "'" && text !== '\\') return `'${text}'`
    return operandText(ctx, only)
  }
  return `gea::concatStrings({${operands.map((operand) => operandText(ctx, operand)).join(', ')}})`
}

/**
 * Append a suffix without allocating its multi-piece concatenation first.
 * Deferred string-addition subtrees are flattened into their leaves, then the
 * runtime reserves and appends them directly. Its alias path snapshots pieces
 * that view the target, preserving self-append across a possible reallocation.
 */
export const stringAppendStatement = (ctx: EmitContext, target: string, operands: readonly IrOperand[]): string => {
  const leaves: IrOperand[] = []
  const collect = (operand: IrOperand): void => {
    const origin = ctx.computeOrigins.get(operand.value)
    if (
      operand.representation.kind === 'string' &&
      ctx.deferredTexts.has(operand.value) &&
      origin?.form === 'binary' &&
      origin.operator === '+' &&
      origin.operands.every((part) => part.representation.kind === 'string')
    ) {
      for (const part of origin.operands) collect(part)
    } else leaves.push(operand)
  }
  for (const operand of operands) collect(operand)
  if (leaves.length === 1) return `${target} += ${stringAppendSuffixText(ctx, leaves)};`
  return `gea::appendStrings(${target}, {${leaves.map((operand) => operandText(ctx, operand)).join(', ')}});`
}

/**
 * A template expression, as one concatenation.
 *
 * Lowering already put the operands in the order the language concatenates
 * them -- literal chunk, substitution, literal chunk, ... -- so this only has
 * to run ToString over each and fold with no separator, which is what an
 * empty `separator` in `joinedToStringText` means. The chunks arrive carrying
 * `string` and pass through unchanged, which is why one rule covers both
 * kinds of piece.
 */
export const templateText = (ctx: EmitContext, operation: ComputeOperation): { text: string } | { refused: Representation } => {
  const leaves: IrOperand[] = []
  const collect = (operand: IrOperand): void => {
    const origin = ctx.computeOrigins.get(operand.value)
    if (
      operand.representation.kind === 'string' &&
      ctx.deferredTexts.has(operand.value) &&
      origin?.form === 'binary' &&
      origin.operator === '+' &&
      origin.operands.every((part) => part.representation.kind === 'string')
    ) {
      // Only a single-use, effect-free deferred subtree can lose its temporary.
      // Numeric additions and already-materialized string snapshots stay leaves.
      for (const part of origin.operands) collect(part)
    } else leaves.push(operand)
  }
  for (const operand of operation.operands) collect(operand)
  return joinedToStringText(ctx, leaves, null)
}

/**
 * `console.log`/`console.error`'s own join rule. ECMA-262 leaves `console`
 * entirely host-defined, but every runtime that implements one (Node, every
 * browser devtools console) stringifies each argument and separates the
 * pieces with exactly one space. v2 has no per-call-site C++ template
 * mechanism in the `host-members.ts` model -- a template there fills one
 * fixed textual shape with pre-rendered strings, it cannot emit a variadic
 * C++ template -- so the join happens here, before the joined text is
 * substituted into the `{args}` slot (`host-members.ts`/`emit-host-invoke.ts`).
 *
 * `operation.arguments` at the call site is guaranteed to be N individual
 * operands here, not one packed `array-object`: `ir/lower.ts`'s
 * `lowerInvocation` skips `packRestArguments` for exactly this callee shape
 * (a method call whose receiver is a `native-handle`) -- see `lower.ts`'s
 * `calleeReceiverIsNativeHandle`.
 */
export const consoleArgumentsText = (ctx: EmitContext, operands: readonly IrOperand[]): { text: string } | { refused: Representation } => {
  // A Date argument is refused HERE even though `toStringText` renders one,
  // and the two are not in disagreement: they are different operations.
  // `String(d)` and `${d}` are ECMA-262 7.1.17 and answer `d.toString()`;
  // node's `console.log(d)` does not run ToString at all -- it inspects, and
  // `util.inspect` prints a Date as its ISO form. Measured:
  // `console.log(new Date(0))` prints `1970-01-01T00:00:00.000Z`, while
  // `console.log(String(new Date(0)))` prints `Thu Jan 01 1970 ...`. Rendering
  // the ToString here would print the second where node prints the first --
  // a green line with the wrong text in it, which is the one outcome this
  // backend refuses to produce.
  // An open table is refused for the same reason: `String(doc)` is
  // "[object Object]" (or the table's own `toString`), while node's
  // `console.log(doc)` inspects it and prints `{ x: 1 }`.
  for (const operand of operands) {
    if (carrierWithADate(operand.representation) !== null || carrierWithADictionary(operand.representation) !== null)
      return { refused: operand.representation }
  }
  return joinedToStringText(ctx, operands, 'std::string(" ")', (operand) => inspectedClassInstanceText(ctx, operand))
}

/**
 * `util.inspect` of a class instance, the way node's `console.log` prints
 * one: `Logged { logged: 12 }` where ToString answers "[object Object]".
 *
 * Only where the answer is certain. The class must be one nothing derives
 * from, since the name printed is the instance's own constructor's and a
 * base-class handle may hold a subclass; its name must not be shadowed by a
 * static member; and every field must be a primitive, whose inspection needs
 * no depth, cycle or nesting rule. Every other operand keeps its ToString.
 *
 * The keys are the runtime's own-enumerable list (`gea::nativeDynamicKeys`,
 * which `Object.keys` answers from), so a deleted or absent field is left out
 * and an expando is printed; a declared field is inspected from its native
 * carrier, anything else from its box.
 */
const inspectedClassInstanceText = (ctx: EmitContext, operand: IrOperand): string | null => {
  const carrier = operand.representation
  if (carrier.kind !== 'class-ref') return null
  const layout = ctx.classes.get(carrier.declaration)
  if (layout === undefined || layout.name === null || layout.nativeBase !== null) return null
  const statics = [...layout.staticFields, ...layout.staticMethods, ...layout.staticAccessors]
  if (statics.some((member) => member.key === 'name')) return null
  for (const other of ctx.classes.values()) {
    if (other.base === carrier.declaration || constructedBaseOf(other) === carrier.declaration) return null
  }
  const fields = recordFieldsOfShape(ctx.deriver, carrier.shapeId)
  if (fields === null) return null
  const object = '__gea_object'
  const declared: string[] = []
  for (const field of fields) {
    if (cppRecordFieldKeyIsSymbol(field.key)) return null
    const value = inspectedPrimitiveText(`${object}${memberAccessOperator(carrier.ownership)}${cppRecordFieldName(field.key)}`, field.value)
    if (value === null) return null
    declared.push(`if (__gea_key == ${cppStringLiteral(field.key)}) { __gea_out = ${value}; return true; }`)
  }
  return (
    `gea::inspect::object(${operandText(ctx, operand)}, ${cppStringLiteral(layout.name)}, ` +
    `[&](const auto& ${object}, const std::string& __gea_key, std::string& __gea_out) -> bool { ${declared.join(' ')} return false; })`
  )
}

/** `util.inspect` of a primitive carrier, or `null` for any other. */
const inspectedPrimitiveText = (text: string, carrier: Representation): string | null => {
  if (carrier.kind === 'string') return `gea::inspect::string(${text})`
  if (carrier.kind === 'null') return 'std::string("null")'
  if (carrier.kind === 'undefined') return 'std::string("undefined")'
  if (carrier.kind === 'scalar') {
    if (carrier.domain === 'boolean') return `std::string((${text}) ? "true" : "false")`
    if (carrier.domain === 'bigint') return null
    return `gea::inspect::number(static_cast<double>(${text}))`
  }
  if (carrier.kind === 'optional') {
    const present = inspectedPrimitiveText(`(*${text})`, carrier.payload)
    if (present === null) return null
    return `(${text}.has_value() ? ${present} : std::string("${carrier.absence}"))`
  }
  return null
}

/** The Date inside a carrier -- itself, an optional's payload, or a union arm -- or `null`. */
const carrierWithADate = (carrier: Representation): Representation | null => {
  if (isDateCarrier(carrier)) return carrier
  if (carrier.kind === 'optional') return carrierWithADate(carrier.payload)
  if (carrier.kind === 'tagged-union') {
    for (const arm of carrier.arms) {
      const found = carrierWithADate(arm.value)
      if (found !== null) return found
    }
  }
  return null
}

/** The open table inside a carrier -- itself, an optional's payload, or a union arm -- or `null`. */
const carrierWithADictionary = (carrier: Representation): Representation | null => {
  if (carrier.kind === 'dictionary') return carrier
  if (carrier.kind === 'optional') return carrierWithADictionary(carrier.payload)
  if (carrier.kind === 'tagged-union') {
    for (const arm of carrier.arms) {
      const found = carrierWithADictionary(arm.value)
      if (found !== null) return found
    }
  }
  return null
}

/**
 * The carrier that actually has no ToString, which is not always the one the
 * caller was holding.
 *
 * `optional` and `tagged-union` convert by descending into their payload/arms,
 * so when one of those refuses it is because something *inside* it did. Naming
 * the wrapper would say something false about the backend -- "no ToString for
 * an optional" when optionals convert fine and the payload is a `Map` -- so
 * this walks down to the first sub-carrier with no conversion of its own and
 * lets the message name that.
 */
const unconvertibleToStringCarrier = (
  carrier: Representation,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  deriver: RepresentationDeriver
): Representation => {
  if (carrier.kind === 'optional') return unconvertibleToStringCarrier(carrier.payload, classes, deriver)
  if (carrier.kind === 'tagged-union') {
    for (const arm of carrier.arms) {
      if (toStringText('x', arm.value, classes, deriver) === null) return unconvertibleToStringCarrier(arm.value, classes, deriver)
    }
  }
  return carrier
}

/** Why a carrier has no ToString, for a refusal message. */
export const toStringRefusal = (
  outer: Representation,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  deriver: RepresentationDeriver
): string => {
  // A Date has a ToString and still reaches this function, from exactly one
  // caller: `consoleArgumentsText`, which refuses it on purpose. Saying "not
  // implemented" about a member that IS implemented would send the reader to
  // build something that exists, so the reason it was actually refused for is
  // the one printed.
  const date = carrierWithADate(outer)
  if (date !== null) {
    return (
      `console.log of a "${representationKey(date)}" carrier is refused: node does not ToString a console argument, it ` +
      'inspects it, and `util.inspect` prints a Date as its ISO form -- `console.log(new Date(0))` is ' +
      '`1970-01-01T00:00:00.000Z`, not the `Thu Jan 01 1970 ...` that ToString answers. Write `String(d)`, `` `${d}` `` or ' +
      '`d.toISOString()` and the intended one renders'
    )
  }
  const dictionary = carrierWithADictionary(outer)
  if (dictionary !== null && toStringText('x', dictionary, classes, deriver) !== null) {
    return (
      `console.log of a "${representationKey(dictionary)}" carrier is refused: node does not ToString a console argument, it ` +
      'inspects it, and `util.inspect` prints an object as its own entries -- `console.log({ x: 1 })` is `{ x: 1 }`, not the ' +
      '`[object Object]` that ToString answers. Write `JSON.stringify(doc)` or `String(doc)` and the intended one renders'
    )
  }
  const carrier = unconvertibleToStringCarrier(outer, classes, deriver)
  const within = representationKey(carrier) === representationKey(outer) ? '' : ` (inside a "${representationKey(outer)}")`
  // A `class-ref` reaching this message is one that DOES declare its own
  // `toString` (`declaresOwnToString`) -- the one class-ref shape `toStringText`
  // still refuses, since calling that method needs a real bound-method call
  // this leaf cannot build. Every other class-ref converts (the ECMA-262
  // "Object" tag), so it is named specifically rather than folded into the
  // generic list below, which would tell the reader a strictly false thing:
  // that no class ever converts.
  if (carrier.kind === 'class-ref') {
    return (
      `ToString of a "${representationKey(carrier)}" carrier${within} needs its own declared \`toString\` method actually ` +
      'called, which this backend cannot build here (no bound-method call site to assemble from a bare receiver expression) -- ' +
      'a class with no own `toString` converts to the ECMA-262 "[object Object]" tag instead'
    )
  }
  return carrier.kind === 'scalar' && carrier.domain === 'bigint'
    ? `ToString of a bigint${within} needs arbitrary-precision digits, which are not implemented`
    : `ToString of a "${representationKey(carrier)}" carrier${within} is not implemented; only string, number, boolean, ` +
        'null, undefined, a class with no own `toString`, an optional of those and a tagged union of those convert without a box'
}
