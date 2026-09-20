import { representationKey, type Representation } from '../../representation/model.js'
import { createCppEmitBlockedError, type UnionMemberTypeofAnswer } from './emit-context.js'
import { cppConstantLiteral, cppStringLiteral } from './types.js'

/**
 * `typeof`, which is a question about a carrier and only sometimes about a
 * value.
 *
 * For everything except a sum, the answer is decided before the program runs:
 * a `std::string` is a `"string"` at every execution, and emitting a runtime
 * test for it would compute a constant. So the ordinary case is a literal, and
 * that is not an optimization -- it is what the operator means once a carrier
 * has been selected.
 *
 * A sum is the case where the value really is consulted, and it is the case
 * `typeof` exists for: `typeof x === 'string'` on a `string | number` is how a
 * program narrows one. There the answer dispatches on the discriminant the
 * carrier already keeps -- `gea::TaggedUnion::index()` -- and each arm
 * contributes its own constant.
 *
 * A `dynamic` box is the third case, and the only one where the value's own
 * runtime tag is read: a carrier is `dynamic` only for the four admissible
 * reasons `representation/model.ts` lists, all of which are genuine dynamic
 * boundaries where the program itself has no static type to answer from. Note
 * the direction -- nothing is ever boxed *in order to* ask `typeof`; a value
 * that has a carrier answers from the carrier, and only a value that was
 * already dynamic reaches `gea::host::detail::typeOf`.
 *
 * The mapping is ECMAScript's own table, not a convenience. `null` is
 * `"object"` (the specification's oldest wart, and observable), a function is
 * `"function"` however it is carried, and every other object-like carrier is
 * `"object"`. A carrier with no answer in that table is refused by name rather
 * than given a plausible one: `typeof` returning the wrong string is a
 * narrowing that silently takes the wrong branch. `unresolved` is the carrier
 * that stays refused on purpose: it is lattice bottom, not a physical thing a
 * runtime tag could be read off, so a `typeof` over one means a carrier failed
 * upstream and the defect is there.
 */

const objectLike = new Set([
  'class-ref',
  'record',
  'record-with-index',
  'native-record-ref',
  'native-handle',
  'array-object',
  'dictionary',
  'typed-array',
  'dense-buffer',
  'native-sequence',
  'iterator',
  'promise',
  // `typeof new Map()` is `"object"` -- a keyed collection is an ordinary
  // Object for this operator, exactly as an Array is.
  'keyed-collection',
  // `typeof null` is `"object"`. The specification says so, every engine agrees,
  // and a program that tests for it is testing for exactly this.
  'null',
  // `ArrayBuffer` and `DataView` are ordinary objects (ECMA-262 25.1, 25.3) --
  // no different from a record or a native handle for this operator, which
  // does not care that one of them backs a typed array's bytes. The manifest
  // keys `typeof` by complete representation, so this row contributes to the
  // union that actually contains it without affecting unrelated unions.
  'array-buffer',
  'shared-array-buffer',
  'data-view'
])

const functionLike = new Set([
  'function',
  'function-family',
  'function-value-family',
  'function-value-dispatch',
  'generic-function-set',
  'constructor-family',
  'constructor-value-dispatch',
  'function-and-constructor'
])

/** The string `typeof` yields for one carrier, or `null` when the table has no answer for it. */
export const typeofTextFor = (representation: Representation): string | null => {
  if (representation.kind === 'scalar') {
    if (representation.domain === 'boolean') return 'boolean'
    if (representation.domain === 'bigint') return 'bigint'
    // `int32`, `uint32` and `float64` are storage choices this compiler made
    // for a value the language calls a number; the operator answers about the
    // language's type, not about the width the carrier settled on.
    return 'number'
  }
  if (representation.kind === 'string') return 'string'
  if (representation.kind === 'undefined') return 'undefined'
  // `void` is storage for a value the program never stated a payload for --
  // `undefined` under a different name (`representation/model.ts`'s own
  // memory: "void in a stored position is undefined"). `typeof` asks what the
  // value IS, and this carrier is never anything else, so it answers exactly
  // as the bare `undefined` kind two lines up does. Missing here left every
  // `computation:typeof:void` site refused, and -- the same all-or-nothing
  // manifest rule `array-buffer` above documents -- could poison an unrelated
  // `tagged-union` claim the moment a `void` arm reached one.
  if (representation.kind === 'void') return 'undefined'
  // A `gea::Symbol` is a symbol at every execution -- ECMA-262 13.5.3's own
  // row, and the one carrier whose answer is its own name. It was missing, and
  // the cost was not confined to a bare `typeof sym`: a union with one
  // symbol-carrying arm was refused whole, because a sum is answerable only
  // when every arm is.
  if (representation.kind === 'symbol') return 'symbol'
  // A borrow and a proxy both answer for what they stand in front of: `typeof`
  // on a reference is `typeof` of the referent, and a proxy has no `[[TypeOf]]`
  // trap -- the operator sees straight through it to the target, which is why a
  // proxy over a function is `"function"`.
  if (representation.kind === 'borrowed-ref') return typeofTextFor(representation.referent)
  if (representation.kind === 'proxy-object') return typeofTextFor(representation.target)
  if (objectLike.has(representation.kind)) return 'object'
  if (functionLike.has(representation.kind)) return 'function'
  return null
}

/**
 * The expression that yields `typeof operand`.
 *
 * `quote` is passed in rather than imported so this file states no opinion about
 * how a C++ string literal is spelled; the one authority for that already exists
 * and this asks it.
 *
 * The operand arrives as a THUNK, not as text, because for most carriers this
 * function never asks for it: the answer is settled by the carrier, and
 * rendering the operand to hand it over would demand a value the question does
 * not depend on. That is not a saving -- it is the difference between an
 * answer and a refusal for anything a program can name but not hold. `typeof
 * deviceInfo !== 'undefined'` is the shape that proved it: the host states
 * that namespace exists, the answer is `"object"` before the program runs, and
 * eagerly rendering the operand refused the whole program for using a
 * namespace as a value it never used it as.
 */
export const typeofExpression = (
  representation: Representation,
  operand: () => string,
  quote: (text: string) => string,
  dynamic: (text: string) => string = (text) => `gea::host::detail::typeOf(${text})`
): string | null => {
  if (representation.kind === 'optional') {
    // An absent optional answers for its exact absence tag; a present one is whatever the payload
    // answers, which is itself a `typeof` question and is asked as one -- an
    // optional over a sum is both a presence test and a discriminant test, and
    // answering only the first half here would silently pick one arm.
    const payload = typeofExpression(representation.payload, () => `(*${operand()})`, quote, dynamic)
    if (payload === null) return null
    const absent = quote(representation.absence === 'null' ? 'object' : 'undefined')
    return payload === absent ? absent : `(${operand()}.has_value() ? ${payload} : ${absent})`
  }
  // The one carrier whose `typeof` genuinely is a runtime question. A `dynamic`
  // carrier exists only for the four admissible reasons `dynamicReasons`
  // (representation/model.ts) names -- a value the program itself declared
  // `any`/`unknown` and never narrowed, a thrown value, an unasserted
  // `JSON.parse`, `ToString` of an unknown -- and for exactly those, "what is
  // this at runtime" has no compile-time answer to give. The box already
  // carries its own tag for precisely this question (`gea::Value`'s own doc
  // comment), so this reads that tag; it never unpacks the payload, and it is
  // never reached by a value that has a static type, because every other
  // carrier above answers as a literal without consulting the value at all.
  if (representation.kind === 'dynamic') return dynamic(operand())
  if (representation.kind !== 'tagged-union') {
    const answer = typeofTextFor(representation)
    return answer === null ? null : quote(answer)
  }
  const answers: string[] = []
  for (const [index, arm] of representation.arms.entries()) {
    // Each arm is asked the same question this function answers, over that
    // arm's own payload, rather than being restricted to the constant-only
    // `typeofTextFor`. An arm may itself be an optional, a nested sum, or --
    // the case that motivated this -- a `dynamic` box, and a sum with one
    // such arm is still fully answerable: the discriminant says which arm is
    // live, and that arm answers for itself. Refusing the whole union because
    // one arm needs a runtime read would refuse a question the carrier can
    // answer exactly.
    const answer = typeofExpression(arm.value, () => `${operand()}.get<${index}>()`, quote, dynamic)
    if (answer === null) return null
    answers.push(answer)
  }
  const first = answers[0]
  if (first === undefined) return null
  // Arms that agree collapse: `number | float64` is `"number"` whichever arm is
  // live, and dispatching on a discriminant to pick between two identical
  // strings would emit a test whose two outcomes are the same value. This is
  // not an optimization pass -- it is the same rule as the non-sum case, that
  // an answer the carrier already decides is a constant. Comparing the
  // RENDERED answers keeps this sound now that an arm may render a runtime
  // read: two such reads name their own arm index, so they never compare equal
  // to each other and only genuinely identical constants ever collapse.
  if (answers.every((answer) => answer === first)) return first
  // Falls through to the last arm without testing it: the discriminant is
  // always one of the arms, so a test there would have no branch to take when
  // it failed.
  const reversed = answers.slice().reverse()
  let result = ''
  for (const [offset, answer] of reversed.entries()) {
    const index = answers.length - 1 - offset
    // `answer` is already a rendered expression -- `quote` was applied by the
    // per-arm recursion above, which is the only place that knows whether an
    // arm's answer is a literal at all.
    result = offset === 0 ? answer : `${operand()}.is<${index}>() ? ${answer} : ${result}`
  }
  return `(${result})`
}

/**
 * Whether this backend can answer `typeof` for a carrier.
 *
 * Implemented by asking `typeofExpression` rather than by re-listing the kinds
 * it handles: a second list would be a second authority, and the two would
 * eventually disagree about a nested carrier -- an optional over a boxed value
 * is unanswerable for a reason the outer kind cannot see. The operand text and
 * the quoting are placeholders because only the presence of an answer is being
 * asked about, not its spelling.
 */
export const typeofIsAnswerable = (representation: Representation): boolean =>
  typeofExpression(
    representation,
    () => 'operand',
    (text) => text
  ) !== null

/** The carrier `cppConstantLiteral` needs to know a text is meant as a string literal rather than an identifier. */
const stringCarrier: Representation = { kind: 'string' }

const typeQueryTags = new Map([
  ['undefined', 'Undefined'],
  ['object', 'Object'],
  ['boolean', 'Boolean'],
  ['number', 'Number'],
  ['string', 'String'],
  ['function', 'Function'],
  ['symbol', 'Symbol'],
  ['bigint', 'BigInt']
])

/** Null signals a string that typeof can never produce, not a fallback tag. */
export const typeofTagLiteral = (text: string): string | null => {
  const tag = typeQueryTags.get(text)
  return tag === undefined ? null : `gea::Value::Tag::${tag}`
}

export const typeofTagText = (representation: Representation, operand: () => string): string => {
  const expression = typeofExpression(
    representation,
    operand,
    (text) => {
      const tag = typeofTagLiteral(text)
      if (tag === null)
        throw createCppEmitBlockedError(
          `runtime-helper:computation:typeof:${representationKey(representation)}`,
          `typeof published an unknown result ${text}`
        )
      return tag
    },
    (text) => `gea::host::detail::typeOfTag(${text})`
  )
  if (expression === null)
    throw createCppEmitBlockedError(
      `runtime-helper:computation:typeof:${representationKey(representation)}`,
      `typeof on a "${representation.kind}" carrier has no tag answer`
    )
  return expression
}

const quote = (text: string): string => cppConstantLiteral(text, 'string', stringCarrier)

/**
 * `typeof <union>.<member>` where the arms disagree about the member, from the
 * per-arm answers `unionMemberTypeofReadsOf` settled.
 *
 * The same dispatch `typeofExpression` builds for a sum, over answers that
 * came from the RECEIVER's arms rather than from the read's own carrier --
 * which is the point: the read's carrier is the member type TypeScript gave
 * the access, and on an arm that has no such member that type is an assertion
 * the program made, not a fact. The discriminant is the fact.
 *
 * An `expando` arm is the one answer that is not settled before the program
 * runs: a class declares no such member, so the only place one could be is the
 * runtime property table, and asking it -- and then asking the boxed result
 * its own tag -- is exact. This is not a value being boxed to get an answer;
 * it is a lookup whose result never had a static type in the first place.
 *
 * Falls through to the last arm without testing it, exactly as the sum case
 * does and for the same reason: the discriminant is always one of the arms.
 */
const unionMemberDispatchText = (
  answers: readonly UnionMemberTypeofAnswer[],
  operand: string,
  member: string,
  constant: (text: string) => string,
  dynamic: (text: string) => string
): string | null => {
  const key = `gea::PropertyKey::string(${cppStringLiteral(member)})`
  const rendered = answers.map((answer, index) =>
    answer.kind === 'constant' ? constant(answer.answer) : dynamic(`gea::nativeDynamicGet(${operand}.get<${index}>(), ${key})`)
  )
  if (rendered.length === 0) return null
  let result = ''
  for (const [offset, answer] of rendered.slice().reverse().entries()) {
    const index = rendered.length - 1 - offset
    result = offset === 0 ? answer : `${operand}.is<${index}>() ? ${answer} : ${result}`
  }
  return `(${result})`
}

/** The string form; see `unionMemberDispatchText`. `std::string` for the reason `typeofText` states. */
export const unionMemberTypeofText = (answers: readonly UnionMemberTypeofAnswer[], operand: string, member: string): string => {
  const expression = unionMemberDispatchText(answers, operand, member, quote, (text) => `gea::host::detail::typeOf(${text})`)
  if (expression === null)
    throw createCppEmitBlockedError(
      'runtime-helper:computation:typeof:union-member',
      'a union member typeof read claimed no arms to answer for'
    )
  return `std::string(${expression})`
}

/** The tag form, for a result only equality tests consume; see `typeofTagText`. */
export const unionMemberTypeofTagText = (answers: readonly UnionMemberTypeofAnswer[], operand: string, member: string): string => {
  const expression = unionMemberDispatchText(
    answers,
    operand,
    member,
    (text) => {
      const tag = typeofTagLiteral(text)
      if (tag === null)
        throw createCppEmitBlockedError('runtime-helper:computation:typeof:union-member', `typeof published an unknown result ${text}`)
      return tag
    },
    (text) => `gea::host::detail::typeOfTag(${text})`
  )
  if (expression === null)
    throw createCppEmitBlockedError(
      'runtime-helper:computation:typeof:union-member',
      'a union member typeof read claimed no arms to answer for'
    )
  return expression
}

/**
 * The C++ expression for `typeof operand`, or a refusal naming the carrier it
 * has no answer for.
 *
 * The refusal is by name and not a fallback, because the fallback would be a
 * guess: a `typeof` that returns the wrong string is a narrowing that silently
 * takes the wrong branch, which is worse than a program that does not build.
 */
export const typeofText = (representation: Representation, operand: () => string): string => {
  const expression = typeofExpression(representation, operand, quote)
  if (expression === null) {
    throw createCppEmitBlockedError(
      `runtime-helper:computation:typeof:${representationKey(representation)}`,
      `typeof on a "${representation.kind}" carrier has no answer in this emitter: nothing states what such a value is at runtime`
    )
  }
  // This result has the string carrier even when its runtime branch selects
  // between C++ literals. Deferral can inline it straight into an equality;
  // without the carrier construction C++ compares literal addresses there.
  return `std::string(${expression})`
}
