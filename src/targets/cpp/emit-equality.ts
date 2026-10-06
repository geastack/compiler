import type { Representation } from '../../representation/model.js'
import { representationKey } from '../../representation/model.js'
import { absenceComparisonText } from './emit-presence.js'
import { emptyArraySentinelText } from './emit-narrowing.js'
import { typeofTextFor } from './emit-typeof.js'
import { nativeRecordBaseTransportKind } from './class-ref-transport.js'

export type EqualityConversionRenderer = (source: Representation, target: Representation, text: string) => string | null

/**
 * `===` and `!==` where one side is a sum -- ECMA-262 7.2.16 IsStrictlyEqual.
 *
 * "Sum" is both of this backend's: a `tagged-union`, and an `optional`, whose
 * two arms are discriminated by `has_value()` rather than by an index.
 *
 * The generic binary path cannot answer these. Two carriers that differ send it
 * to its mixed-carrier refusal, and two `gea::TaggedUnion`s that agree send it
 * to `binaryOperatorFor`, which has no `==` for a sum: the C++ type holds a raw
 * byte buffer plus an index, so the compiler-generated comparison it does not
 * have would be comparing padding.
 *
 * 7.2.16 is a two-step rule and both steps are decidable here. Step 1 -- "if
 * Type(x) is not Type(y), return false" -- is the discriminant, which a tagged
 * union carries as its own index and a concrete operand carries in its carrier.
 * Step 2 is the arm's own comparison. So `name === 'error'` over a
 * `string | symbol` is `name.is<0>() && name.get<0>() == "error"`, exactly, and
 * a concrete operand whose carrier matches NO arm is the constant `false`
 * without reading anything.
 *
 * Deliberately `===`/`!==` only. `==` is 7.2.15, which converts -- a union arm
 * against a number would run `ToPrimitive`/`ToNumber`, and choosing which side
 * converts is the conversion algebra's decision, not this file's.
 */

/**
 * Whether C++ `==` on this carrier IS JavaScript's `===` for the values it holds.
 *
 * Not a general "is comparable" test: what has to hold is that the two agree.
 * `std::string` and `double` compare by value, which is 7.2.16 for a string and
 * a number (`NaN != NaN` and `+0 == -0` are the same in both languages), and a
 * `shared_ptr` compares by address, which is 7.2.16's reference identity for an
 * object. A `native-handle` is left out even though it has a `bool` conversion:
 * a host's own struct states no `==` at all, and inventing one would compare
 * whatever the wrapper happens to hold.
 */
const armComparesByValue = (representation: Representation): boolean => {
  if (representation.kind === 'string' || representation.kind === 'scalar' || representation.kind === 'symbol') return true
  if (
    representation.kind === 'class-ref' ||
    representation.kind === 'native-record-ref' ||
    representation.kind === 'record' ||
    representation.kind === 'record-with-index' ||
    representation.kind === 'array-object' ||
    representation.kind === 'dictionary' ||
    representation.kind === 'typed-array' ||
    representation.kind === 'array-buffer' ||
    representation.kind === 'shared-array-buffer' ||
    representation.kind === 'data-view' ||
    representation.kind === 'keyed-collection'
  ) {
    return representation.ownership === 'shared-refcount'
  }
  return false
}

/** An arm that IS an absent value: two operands both holding it are equal without reading anything. */
const isAbsentArm = (representation: Representation): boolean => representation.kind === 'null' || representation.kind === 'undefined'

const callableIdentityCarrier = (representation: Representation): boolean =>
  representation.kind === 'function-value-dispatch' || representation.kind === 'function-and-constructor'

const negate = (operator: string, text: string): string =>
  operator === '!==' ? (text === 'true' ? 'false' : text === 'false' ? 'true' : `!(${text})`) : text

/** One arm's comparison against a same-carrier value, or `null` when this backend cannot state it. */
/**
 * The answer for two carriers that are not the same key, when neither is a sum
 * to walk -- `'false'` where 7.2.16 step 1 settles it ("If Type(x) is not
 * Type(y), return false"), and `null`, a REFUSAL, where it does not.
 *
 * Two callables are the case that makes the distinction load-bearing. Their
 * C++ carriers differ whenever monomorphization gave one declaration two
 * copies, or an adapter re-spelled a signature -- and `gea::CallableObject`
 * carries a `Ref<FunctionObjectIdentity>` across exactly those transforms on
 * purpose, precisely so that all of them remain ONE ECMAScript function
 * object. So a differing carrier key proves nothing about identity here, and
 * folding to `false` answers a question the carriers were never entitled to
 * settle.
 *
 * Measured: `stack[0] === Impl.a` over a namespace-qualified generic function
 * rendered as the constant `false` while node answers `true`, which turned
 * `test/runtime/generic-state-function-array.ts`'s loop condition into an
 * infinite loop. The identical program written with NON-generic functions --
 * one copy, one carrier -- refused fail-closed at the mixed-carrier boundary
 * instead, which is what made the fold visible as a fail-OPEN: the same
 * comparison was refused in the shape that had no answer and answered wrongly
 * in the shape that had two carriers for one function object.
 *
 * `typeofTextFor` is the one authority for "what type does the language say
 * this carrier holds", already keyed by complete representation for the
 * `typeof` operator itself; asking it here rather than restating a second
 * table is what keeps the two from ever disagreeing.
 */
const foldedCarrierMismatchText = (left: Representation, right: Representation): string | null => {
  const leftType = typeofTextFor(left)
  const rightType = typeofTextFor(right)
  if (leftType === null || rightType === null) return null
  return leftType === rightType ? null : 'false'
}

const armEqualityText = (
  arm: Representation,
  leftText: string,
  rightText: string,
  convert?: EqualityConversionRenderer
): string | null => {
  if (isAbsentArm(arm)) return 'true'
  const callable = callableIdentityEqualityText('===', { text: leftText, representation: arm }, { text: rightText, representation: arm })
  if (callable !== null) return callable
  // A sum nested in a sum (`undefined | null | (string | number | boolean)`,
  // the shape a three-way absence gives a union payload) is the same
  // question one level down.
  if (arm.kind === 'tagged-union' || arm.kind === 'optional') {
    return strictEqualityText('===', { text: leftText, representation: arm }, { text: rightText, representation: arm }, convert)
  }
  return armComparesByValue(arm) ? `${leftText} == ${rightText}` : null
}

/**
 * The JavaScript answer for a comparison between two string CONSTANTS.
 *
 * A `string` constant is emitted as a C++ string literal, and a C++ string
 * literal is a `const char[N]` -- an initializer the carrier converts from, not
 * a value of the carrier. That is invisible everywhere except between two of
 * them, where `("object") != ("undefined")` compares two array ADDRESSES.
 * Whether two literals even have distinct addresses is up to the linker, so
 * `("a") == ("a")` is permitted to answer false; clang says as much
 * (`-Warray-compare`, `-Wstring-compare`) and it was emitted by every gea app,
 * because `@geastack/core`'s runtime guards its host globals with `typeof X !==
 * "undefined"` and `typeof` had already folded to a constant.
 *
 * Both operands are known here, so this is not a runtime question. Answering it
 * in the source language is also the only way to answer it correctly: relational
 * comparison of strings is by UTF-16 code unit (ECMA-262 7.2.13), which is what
 * comparing the two contents here does, while `std::string`'s `<` compares
 * UTF-8 bytes and disagrees outside the BMP.
 *
 * Only reached when BOTH sides are constants. One constant against a real value
 * is already correct -- `std::string == "literal"` selects the `const char *`
 * overload and compares contents -- so it is left alone.
 */
export const constantStringComparisonText = (operator: string, left: string, right: string): string | null => {
  if (operator === '===' || operator === '==') return left === right ? 'true' : 'false'
  if (operator === '!==' || operator === '!=') return left === right ? 'false' : 'true'
  if (operator === '<') return left < right ? 'true' : 'false'
  if (operator === '>') return left > right ? 'true' : 'false'
  if (operator === '<=') return left <= right ? 'true' : 'false'
  if (operator === '>=') return left >= right ? 'true' : 'false'
  return null
}

/** The array carrier a comparison's other side holds: itself, its optional payload, or its one array arm. */
const arrayCarrierWithin = (representation: Representation): Extract<Representation, { kind: 'array-object' }> | null => {
  if (representation.kind === 'array-object') return representation
  if (representation.kind === 'optional') return arrayCarrierWithin(representation.payload)
  if (representation.kind === 'tagged-union') {
    const arrays = representation.arms.flatMap((arm) => (arm.value.kind === 'array-object' ? [arm.value] : []))
    const only = arrays[0]
    return arrays.length === 1 && only ? only : null
  }
  return null
}

/**
 * Two CALLABLES compared by allocation identity, or `null` when neither pair
 * of carriers is one.
 *
 * `CallableObject` retains one shared function-object owner through every ABI
 * adapter, so comparing that owner is exact across two different C++ template
 * instantiations -- which is the whole reason it cannot be an `operator==`:
 * the two sides need not have the same C++ type, and often do not.
 * `function-and-constructor` is the same identity carrier under another name;
 * `gea::CallableConstructorObject` lays out `invoke`/`environment`/
 * `environmentOwner`/`functionObject` exactly like `gea::CallableObject`,
 * because a source function usable both as `f()` and `new f()` is still one
 * allocation with one identity.
 *
 * Loose equality has the same answer: both operands already have ECMAScript
 * Function type, so 7.2.15 falls through to 7.2.16 unchanged.
 *
 * Lives here rather than inline in `emit.ts` so that every path reaching an
 * equality asks it -- the bare pair, and the one an OPTIONAL wraps.
 * `stateStack[stackIndex] !== State.done` is the second: under
 * `noUncheckedIndexedAccess` the element read is `State | undefined`, so the
 * comparison arrives as `optional(callable)` against `callable`, recurses into
 * the payload, and found no answer at all while this rule lived somewhere the
 * recursion could not reach. It then fell to the arm-key test, which requires
 * the two carriers to spell the SAME key -- and the whole point of comparing
 * the owner is that they need not.
 */
const constructorIdentityCarrier = (representation: Representation): boolean =>
  representation.kind === 'constructor-family' || representation.kind === 'constructor-value-dispatch'

/**
 * Two CLASS CONSTRUCTORS compared by identity, or `null` when the pair is not
 * two constructor carriers.
 *
 * `gea::ConstructorObject` carries no function-object owner: a class object
 * is its construct pointer and the environment that pointer closes over, so
 * two values naming the same class hold the same pair and two naming
 * different classes differ in the pointer. That is exact for the shape a
 * CommonJS record hands around -- `require('./box') !== require('./box')` is
 * two copies of one module's `exports` -- and mirrors the callable rule's
 * environment test: a class statement evaluated twice yields two objects,
 * distinguished by their environments.
 *
 * A class evaluation's environment is its own freshly allocated state
 * (`gea::allocateNativeClassMethodEnvironment`), so when there is one it alone
 * is the identity: a subclass stored into its base's constructor slot is
 * reached through an upcasting construct pointer (`gea::upcastConstructor`)
 * and is still the same class object.
 *
 * A monomorphized copy has its own construct pointer, so a family naming a
 * specialization copy is refused rather than answered `false` for two names
 * of one generic class. The two sides need not spell the same C++ type, hence
 * the `void*` view of each pointer rather than an `operator==`.
 */
const constructorIdentityEqualityText = (
  operator: string,
  left: { readonly text: string; readonly representation: Representation },
  right: { readonly text: string; readonly representation: Representation }
): string | null => {
  if (!constructorIdentityCarrier(left.representation) || !constructorIdentityCarrier(right.representation)) return null
  for (const side of [left.representation, right.representation])
    if (side.kind === 'constructor-family' && side.members.some((member) => member.includes('@'))) return null
  const equal =
    `([](const auto& gea_left, const auto& gea_right) -> bool { ` +
    `if (gea_left.environment != nullptr) return gea_left.environment == gea_right.environment; ` +
    `return reinterpret_cast<const void*>(gea_left.construct_) == reinterpret_cast<const void*>(gea_right.construct_) && ` +
    `gea_right.environment == nullptr; })(${left.text}, ${right.text})`
  return operator === '!==' || operator === '!=' ? `!${equal}` : equal
}

export const callableIdentityEqualityText = (
  operator: string,
  left: { readonly text: string; readonly representation: Representation },
  right: { readonly text: string; readonly representation: Representation }
): string | null => {
  if (!['===', '!==', '==', '!='].includes(operator)) return null
  const constructors = constructorIdentityEqualityText(operator, left, right)
  if (constructors !== null) return constructors
  if (!callableIdentityCarrier(left.representation) || !callableIdentityCarrier(right.representation)) return null
  // TWO tests, in the order ECMAScript's own answer requires.
  //
  // A function with NO captured environment is one object however many
  // monomorphic copies the compiler made of it, so the copies' shared source
  // declaration is the identity -- that is what `declarationIdentity` holds and
  // what `identifyCallable` installs. Without this, `State.done` compiled as
  // `..._206_0` and `..._206_1` compares two allocations and answers `false`
  // for two names of one function.
  //
  // A function that DOES carry an environment is a fresh object per
  // evaluation: `function outer() { return function inner() {} }` returns a
  // different `inner` every call, and both share one declaration. So the
  // environment test guards the declaration test, and everything else falls
  // through to the allocation comparison -- exact across two C++
  // instantiations, because `CallableObject`'s copy propagates the owner, which
  // is the same reason this cannot be an `operator==`.
  //
  // The allocation comparison reads through `functionObjectIdentity()`, not
  // the `functionObject` field directly: a heap-environment closure anchors
  // its identity lazily in its environment block (`gea_runtime.h`'s
  // `EnvironmentIdentityHeader`) and mints nothing at allocation, so the field
  // itself may still be empty on BOTH sides here even though they are the
  // same function object. `functionObjectIdentity()` is what resolves that --
  // through the override, the anchor, or a fallback mint -- and this is the
  // first point anything actually asks, so it is also where the mint (if any
  // is still needed at all) legitimately happens.
  //
  // Two heap-environment closures with no explicit override compare by their
  // environment blocks' identity ANCHORS before either side is asked to mint:
  // the anchor is the one slot a block's identity is ever minted into
  // (`functionObjectIdentity()`), so equal anchors are one function object
  // and distinct anchors are two, whether or not the mint has happened yet.
  // Without this, node-compat's `removeListener` scan (`fns[i] === fn`)
  // minted a `FunctionObjectIdentity` for EVERY registered listener it
  // walked past -- one heap object and one cycle candidate per listener per
  // removal, on the mongodb driver's two `once`/`off` pairs per command.
  //
  // Written as one generic lambda so each side's text is mentioned once: the
  // operand this reaches through an optional payload is a whole nested
  // conditional, and spelling it six times is unreadable emitted code.
  const equal =
    `([](const auto& gea_left, const auto& gea_right) -> bool { ` +
    `if (gea_left.environment == nullptr && gea_right.environment == nullptr) { ` +
    `const void* gea_left_decl = gea::callableDeclarationIdentityOf(gea_left.functionObjectIdentity()); ` +
    `const void* gea_right_decl = gea::callableDeclarationIdentityOf(gea_right.functionObjectIdentity()); ` +
    `if (gea_left_decl != nullptr && gea_right_decl != nullptr) return gea_left_decl == gea_right_decl; } ` +
    `if constexpr (requires { gea_left.identityHeader; gea_right.identityHeader; }) { ` +
    `if (!gea_left.functionObject && !gea_right.functionObject && gea_left.identityHeader != nullptr && gea_right.identityHeader != nullptr) ` +
    `return gea_left.identityHeader == gea_right.identityHeader; } ` +
    `const auto& gea_left_identity = gea_left.functionObjectIdentity(); ` +
    `return static_cast<bool>(gea_left_identity) && gea_left_identity == gea_right.functionObjectIdentity(); })` +
    `(${left.text}, ${right.text})`
  return operator === '!==' || operator === '!=' ? `!${equal}` : equal
}

/**
 * Two carriers that hold the same numeric language type in different storage
 * widths. 7.2.16 compares Numbers by value (Number::equal), and C++ `==`
 * between an integer carrier and a `double` promotes to `double`, which keeps
 * `NaN != NaN` and `+0 == -0` and is exact for every integer an `int32`/
 * `uint32` carrier can hold.
 */
const sameNumericType = (left: Representation, right: Representation): boolean =>
  left.kind === 'scalar' &&
  right.kind === 'scalar' &&
  representationKey(left) !== representationKey(right) &&
  typeofTextFor(left) === 'number' &&
  typeofTextFor(right) === 'number'

/**
 * One arm of one sum against one arm of the other, when the two sums are
 * different carriers: `'false'` where 7.2.16 step 1 settles the pair, the
 * comparison's text where both arms hold one language type, and `null`, a
 * refusal, where this backend cannot state which.
 */
const armPairEqualityText = (
  left: { readonly text: string; readonly representation: Representation },
  right: { readonly text: string; readonly representation: Representation },
  convert?: EqualityConversionRenderer
): string | null => {
  if (representationKey(left.representation) === representationKey(right.representation))
    return armEqualityText(left.representation, left.text, right.text, convert)
  // `null` is only ever equal to `null`, and `undefined` to `undefined`; the
  // same kind always shares one key, so any other pairing is Type(x) != Type(y).
  if (isAbsentArm(left.representation) || isAbsentArm(right.representation)) return 'false'
  if (sameNumericType(left.representation, right.representation)) return `${left.text} == ${right.text}`
  const nested = strictEqualityText('===', left, right, convert)
  if (nested !== null) return nested
  return foldedCarrierMismatchText(left.representation, right.representation)
}

/**
 * `===` between two sums whose arm sets differ (`string | number` against
 * `number | boolean`): equal exactly when some pair of live arms holds one
 * language type and that pair's comparison says so. Every pair is visited,
 * because one language type can sit in two arms of one sum (two class arms
 * holding one upcast object, or two numeric widths).
 */
const mixedSumEqualityText = (
  operator: string,
  left: { readonly text: string; readonly union: Extract<Representation, { kind: 'tagged-union' }> },
  right: { readonly text: string; readonly union: Extract<Representation, { kind: 'tagged-union' }> },
  convert?: EqualityConversionRenderer
): string | null => {
  const arms: string[] = []
  for (const [leftIndex, leftArm] of left.union.arms.entries()) {
    for (const [rightIndex, rightArm] of right.union.arms.entries()) {
      const compared = armPairEqualityText(
        { text: `${left.text}.get<${leftIndex}>()`, representation: leftArm.value },
        { text: `${right.text}.get<${rightIndex}>()`, representation: rightArm.value },
        convert
      )
      if (compared === null) return null
      if (compared === 'false') continue
      arms.push(`${left.text}.is<${leftIndex}>() && ${right.text}.is<${rightIndex}>() ? (${compared}) : `)
    }
  }
  return negate(operator, `(${arms.join('')}false)`)
}

export const strictEqualityText = (
  operator: string,
  left: { readonly text: string; readonly representation: Representation },
  right: { readonly text: string; readonly representation: Representation },
  convert?: EqualityConversionRenderer
): string | null => {
  if (operator !== '===' && operator !== '!==') return null

  // The box on either side. Answered before the sums below because a
  // `dynamic` operand settles the comparison whatever the other side is: the
  // tag `Value` carries IS 7.2.16's Type(x), so step 1 is a runtime test
  // rather than a static one, and no carrier the other side could have makes
  // that any less true.
  //
  // A concrete operand is boxed to meet it, which is not a coercion: boxing
  // records the JavaScript type the carrier already had (`dynamicTagFor`), so
  // `signal.aborted === true` compares a Boolean tag against a Boolean tag and
  // answers false for a `signal.aborted` holding the string "true", exactly as
  // the language says. A carrier whose certified conversion cannot box has no
  // JavaScript type this backend can name, and refusing is then the only
  // answer that is not a guess.
  const dynamicSide = left.representation.kind === 'dynamic' || right.representation.kind === 'dynamic'
  if (dynamicSide) {
    // A native callable against a box is answered on the callable itself:
    // `fns[i] === fn` in an event emitter's `removeListener(name, fn: unknown)`
    // scans every stored listener, and boxing each one to meet the `unknown`
    // side allocated a box (and minted an identity on an unminted one) per
    // comparison. The identity question 7.2.16 asks needs neither: a box
    // whose tag is not Function is unequal at once, and a callable that has
    // no identity yet cannot be the one the box already holds.
    const callableHelper = (representation: Representation): string | null => {
      if (representation.kind === 'callable-identity') return 'gea::Value::strictEqualsCallableIdentity'
      const callable =
        representation.kind === 'function' ||
        representation.kind === 'function-family' ||
        representation.kind === 'function-value-family' ||
        (representation.kind === 'function-value-dispatch' && representation.recursive === undefined)
      return callable ? 'gea::Value::strictEqualsCallable' : null
    }
    const concrete = left.representation.kind === 'dynamic' ? right : left
    const boxed = left.representation.kind === 'dynamic' ? left : right
    const helper = callableHelper(concrete.representation)
    if (helper !== null) return negate(operator, `${helper}(${boxed.text}, ${concrete.text})`)
    const box = (side: typeof left, against: Representation): string | null =>
      side.representation.kind === 'dynamic' ? side.text : (convert?.(side.representation, against, side.text) ?? null)
    const leftText = box(left, right.representation)
    const rightText = box(right, left.representation)
    if (leftText === null || rightText === null) return null
    return negate(operator, `gea::Value::strictEquals(${leftText}, ${rightText})`)
  }

  // An OPTIONAL on exactly one side. `gea::Optional<T>` is a sum too -- two
  // arms, with `has_value()` for the discriminant instead of an index -- so
  // 7.2.16 reads exactly as it does below: step 1 is the presence test, since
  // an absent optional's Type is Undefined/Null and a present value of any
  // other type never shares it, and step 2 is the payload's own comparison.
  //
  // `boolean | undefined === true` is what reaches here, and before this it
  // reached `emitCompute`'s mixed-carrier refusal instead -- "optional and
  // scalar need a conversion this emitter has no recipe for". There is no
  // conversion to install: the comparison is not one.
  //
  // Against `null`/`undefined` this is never reached: `absenceComparisonText`
  // answers those first. Two optionals compare their absence tags before
  // reading either payload: undefined equals undefined, while undefined does
  // not equal null, regardless of their payload carriers.
  // `elements === emptyArray`: a `never[]` side compares against the other
  // side's own array carrier, as the one empty array of that element type
  // (`emptyArraySentinelText`) -- the identity that comparison exists to
  // test. Only that side is rewritten; the recursion then sees two carriers
  // of one key, or an optional/union holding one.
  // Asked WITHOUT requiring the two carriers to spell one key. Two monomorphic
  // copies of one source function have different keys and are the same
  // JavaScript function object, which is exactly the pair
  // `stateStack[stackIndex] !== State.done` compares once the element read's
  // `State | undefined` has been unwrapped.
  const callableIdentity = callableIdentityEqualityText(operator, left, right)
  if (callableIdentity !== null) return callableIdentity

  const sentinelSide = (side: typeof left, against: Representation): typeof left | null => {
    if (side.representation.kind !== 'array-object' || side.representation.element.kind !== 'undefined') return null
    const target = arrayCarrierWithin(against)
    if (target === null || representationKey(target) === representationKey(side.representation)) return null
    const text = emptyArraySentinelText(side.representation, target, side.text)
    return text === null ? null : { text, representation: target }
  }
  const leftAsSentinel = sentinelSide(left, right.representation)
  if (leftAsSentinel !== null) return strictEqualityText(operator, leftAsSentinel, right, convert)
  const rightAsSentinel = sentinelSide(right, left.representation)
  if (rightAsSentinel !== null) return strictEqualityText(operator, left, rightAsSentinel, convert)

  const leftOptional = left.representation.kind === 'optional' ? left.representation : null
  const rightOptional = right.representation.kind === 'optional' ? right.representation : null
  if (leftOptional && rightOptional) {
    const leftPayload = { text: `(*${left.text})`, representation: leftOptional.payload }
    const rightPayload = { text: `(*${right.text})`, representation: rightOptional.payload }
    const compared =
      strictEqualityText('===', leftPayload, rightPayload, convert) ??
      (representationKey(leftOptional.payload) === representationKey(rightOptional.payload)
        ? armEqualityText(leftOptional.payload, leftPayload.text, rightPayload.text, convert)
        : null)
    if (compared === null) return null
    const absent = leftOptional.absence === rightOptional.absence ? `!(${right.text}).has_value()` : 'false'
    return negate(operator, `((${left.text}).has_value() ? ((${right.text}).has_value() && (${compared})) : (${absent}))`)
  }
  if ((leftOptional === null) !== (rightOptional === null)) {
    const optional = leftOptional ?? rightOptional
    if (!optional) return null
    const optionalText = leftOptional ? left.text : right.text
    const other = leftOptional ? right : left
    const present = `(${optionalText}).has_value()`
    // The payload may itself be a sum. Comparing its carrier key with a
    // concrete operand would incorrectly fold Optional<string | T[]> ===
    // 'plain' to false. Recursively dispatch the live payload, keeping the
    // presence test outside so no absent payload is read.
    const payload = { text: `(*${optionalText})`, representation: optional.payload }
    const compared =
      strictEqualityText('===', payload, other, convert) ??
      (representationKey(optional.payload) === representationKey(other.representation)
        ? armEqualityText(optional.payload, payload.text, other.text, convert)
        : optional.payload.kind === 'tagged-union' || other.representation.kind === 'tagged-union'
          ? null
          : foldedCarrierMismatchText(optional.payload, other.representation))
    if (compared === null) return null
    const absent = absenceComparisonText('===', { text: optional.absence, representation: { kind: optional.absence } }, other)
    if (absent !== null && absent !== 'false') {
      return negate(operator, `(${present} ? (${compared}) : (${absent}))`)
    }
    return negate(operator, compared === 'true' ? present : `(${present} && (${compared}))`)
  }

  const leftUnion = left.representation.kind === 'tagged-union' ? left.representation : null
  const rightUnion = right.representation.kind === 'tagged-union' ? right.representation : null
  if (!leftUnion && !rightUnion) {
    // Shared native object storage compares by reference identity even when
    // neither operand needs a discriminant. Leave primitive literal folding
    // to the existing binary path (C++ string literals compare addresses).
    const value = left.representation
    // An upcast changes the layout carrier, not the object's identity. Ref's
    // cross-type equality already compares the held native object addresses.
    if (
      value.kind === 'class-ref' &&
      value.ownership === 'shared-refcount' &&
      right.representation.kind === 'class-ref' &&
      right.representation.ownership === 'shared-refcount'
    ) {
      return negate(operator, `${left.text} == ${right.text}`)
    }
    // A class deriving in place from a native record (an `Error` subclass over
    // `gea::runtime::Error`) is that record: the two refs hold one object, and
    // Ref's cross-type `==` compares exactly its address.
    if (
      nativeRecordBaseTransportKind(value, right.representation) !== null ||
      nativeRecordBaseTransportKind(right.representation, value) !== null
    ) {
      return negate(operator, `${left.text} == ${right.text}`)
    }
    if (
      'ownership' in value &&
      value.ownership === 'shared-refcount' &&
      representationKey(value) === representationKey(right.representation)
    ) {
      const compared = armEqualityText(value, left.text, right.text, convert)
      return compared === null ? null : negate(operator, compared)
    }
    return null
  }

  // Two sums: equal exactly when the same arm is live in both and that arm's
  // own comparison says so. Written as a chain over the arms rather than a
  // memcmp of the storage, which would compare padding, and rather than a
  // single `index()` test, which would call two different strings equal.
  if (leftUnion && rightUnion) {
    if (representationKey(left.representation) !== representationKey(right.representation)) {
      return mixedSumEqualityText(operator, { text: left.text, union: leftUnion }, { text: right.text, union: rightUnion }, convert)
    }
    const arms: string[] = []
    for (const [index, arm] of leftUnion.arms.entries()) {
      const compared = armEqualityText(arm.value, `${left.text}.get<${index}>()`, `${right.text}.get<${index}>()`, convert)
      if (compared === null) return null
      arms.push(`${left.text}.is<${index}>() && ${right.text}.is<${index}>() ? (${compared}) : `)
      if (arm.value.kind !== 'class-ref' && !callableIdentityCarrier(arm.value)) continue
      // Upcasting before storage can put the same object in a different
      // class arm of the same sum. Discriminant inequality is not identity.
      for (const [otherIndex, otherArm] of rightUnion.arms.entries()) {
        if (
          otherIndex === index ||
          (!(arm.value.kind === 'class-ref' && otherArm.value.kind === 'class-ref') &&
            !(callableIdentityCarrier(arm.value) && callableIdentityCarrier(otherArm.value)))
        )
          continue
        const crossClass = strictEqualityText(
          '===',
          { text: `${left.text}.get<${index}>()`, representation: arm.value },
          { text: `${right.text}.get<${otherIndex}>()`, representation: otherArm.value },
          convert
        )
        if (crossClass === null) return null
        arms.push(`${left.text}.is<${index}>() && ${right.text}.is<${otherIndex}>() ? (${crossClass}) : `)
      }
    }
    return negate(operator, `(${arms.join('')}false)`)
  }

  // A sum against a concrete value: step 1 of 7.2.16 is the arm test, and a
  // carrier no arm holds settles the whole comparison before the program runs.
  const union = leftUnion ?? rightUnion
  const other = leftUnion ? right : left
  if (!union) return null
  const otherKey = representationKey(other.representation)
  const index = union.arms.findIndex((arm) => representationKey(arm.value) === otherKey)
  const unionText = leftUnion ? left.text : right.text
  // A union may retain both a base and a derived class arm. Matching the
  // base's carrier key alone would miss that same object in the derived arm.
  if (index < 0 || other.representation.kind === 'class-ref' || callableIdentityCarrier(other.representation)) {
    const nested: string[] = []
    for (const [nestedIndex, arm] of union.arms.entries()) {
      if (index < 0 && sameNumericType(arm.value, other.representation)) {
        nested.push(`(${unionText}.is<${nestedIndex}>() && (${unionText}.get<${nestedIndex}>() == ${other.text}))`)
        continue
      }
      if (
        arm.value.kind !== 'tagged-union' &&
        arm.value.kind !== 'optional' &&
        !(arm.value.kind === 'class-ref' && other.representation.kind === 'class-ref') &&
        !(callableIdentityCarrier(arm.value) && callableIdentityCarrier(other.representation))
      )
        continue
      const compared = strictEqualityText('===', { text: `${unionText}.get<${nestedIndex}>()`, representation: arm.value }, other, convert)
      if (compared === null) return null
      if (compared !== 'false') nested.push(`(${unionText}.is<${nestedIndex}>() && (${compared}))`)
    }
    return negate(operator, nested.length ? `(${nested.join(' || ')})` : 'false')
  }
  const arm = union.arms[index]
  if (!arm) return null
  // The concrete side's carrier names one arm, but another arm may still hold
  // the same language type in a different storage width (`int32` beside
  // `float64`); each of those is a live pairing too.
  const widths: string[] = []
  for (const [otherIndex, otherArm] of union.arms.entries()) {
    if (otherIndex === index || !sameNumericType(otherArm.value, other.representation)) continue
    widths.push(`(${unionText}.is<${otherIndex}>() && (${unionText}.get<${otherIndex}>() == ${other.text}))`)
  }
  if (widths.length > 0) {
    const own = armEqualityText(arm.value, `${unionText}.get<${index}>()`, other.text, convert)
    if (own === null) return null
    return negate(operator, `((${unionText}.is<${index}>() && (${own})) || ${widths.join(' || ')})`)
  }
  const compared = armEqualityText(arm.value, `${unionText}.get<${index}>()`, other.text, convert)
  if (compared === null) return null
  if (compared === 'true') return negate(operator, `${unionText}.is<${index}>()`)
  return negate(operator, `(${unionText}.is<${index}>() && (${compared}))`)
}
