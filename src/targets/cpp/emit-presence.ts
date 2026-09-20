import { carriesMergeAbsence, carriesUndefined, type Representation } from '../../representation/model.js'
import { createCppEmitBlockedError } from './emit-context.js'

/**
 * Presence: whether a value is neither `null` nor `undefined`.
 *
 * This is the test `a?.b`, `a ?? b` and a default parameter initializer branch
 * on, and it is emphatically not truthiness. `0`, `''`, `NaN` and `false` are
 * all *present* and all falsy, so running `ToBoolean` where the language runs a
 * nullish check takes the wrong branch for exactly the values a program is most
 * likely to hold -- `count ?? 10` would yield `10` for a real zero.
 *
 * Most carriers answer without consulting the value at all. A `double` is never
 * `null`, so `x ?? y` over one is `x` and the test is the constant `true`. That
 * is not an optimization: it is what presence means once a carrier has been
 * selected, and emitting a runtime test there would compute a constant.
 *
 * The three that do consult the value are the three that can hold absence: an
 * optional, whose flag is the whole answer; the `null` and `undefined`
 * carriers, which are absence; and a tagged union, which is present unless the
 * live arm is one of those.
 */

/** Carriers that are absence itself, so presence over one is the constant `false`. */
const absent = new Set(['null', 'undefined', 'void'])

/**
 * Definedness: whether a value is `undefined`. The narrow half of presence.
 *
 * One construct asks it: a defaulted parameter. The language substitutes an
 * initializer for a MISSING argument and for nothing else -- ECMA-262 8.6.3
 * tests `undefined`, so `f(x = 0)` called `f(null)` binds `null`. Asking the
 * presence question there re-runs the default on a `null` the caller chose,
 * which is a silently wrong answer rather than a refusal.
 *
 * It made no observable difference while a defaulted parameter's slot could
 * only be `T | undefined`: with no `null` state in the carrier, both tests read
 * the same flag. It does now that `T | null | undefined` has a carrier
 * (`normalize/parameter-slot.ts`), and it always did for a box, whose tag has
 * both states.
 *
 * `null` is DEFINED, and that is the one place the two tests disagree in
 * writing: presence over the `null` carrier is `false`, definedness is `true`.
 */
export const definedTestText = (text: string, representation: Representation): string => {
  if (representation.kind === 'undefined' || representation.kind === 'void') return 'false'
  if (representation.kind === 'borrowed-ref') return definedTestText(text, representation.referent)
  if (representation.kind === 'unresolved') {
    throw createCppEmitBlockedError(
      'runtime-helper:conversion:is-present:unresolved',
      'a definedness test on an "unresolved" carrier has no carrier to read: selection never happened'
    )
  }
  // WHICH carriers have an `undefined` state is `representation/model.ts`'s
  // `carriesUndefined`, not a second list kept here: the IR lowering asks the
  // same question before it merges over a definedness guard, and two lists
  // would let a carrier be untestable there and testable here. What stays here
  // is only the spelling of the test for the carriers that do have one. A flag
  // standing for `null` says nothing about `undefined`; only the
  // `undefined`-tagged optional's flag IS this question.
  if (!carriesUndefined(representation)) return 'true'
  if (representation.kind === 'optional') return `(${text}).has_value()`
  if (representation.kind === 'tagged-union') {
    // An `undefined`-tagged optional ARM is a second place definedness can
    // live, and reading both is what the language says: the value is
    // `undefined` when the live arm is the `undefined` one, OR when it is an
    // optional arm whose flag is empty. Those are not two competing answers to
    // pick between -- they are two disjoint cases of one question, joined by
    // the arm test that already tells them apart.
    const undefinedTests = representation.arms.flatMap((arm, index) => {
      if (arm.value.kind === 'undefined' || arm.value.kind === 'void') return [`${text}.is<${index}>()`]
      if (arm.value.kind === 'optional' && arm.value.absence === 'undefined') {
        return [`(${text}.is<${index}>() && !${text}.get<${index}>().has_value())`]
      }
      return []
    })
    if (undefinedTests.length === 0) return 'true'
    return `!(${undefinedTests.join(' || ')})`
  }
  if (representation.kind === 'dynamic') return `((${text}).tag() != gea::Value::Tag::Undefined)`
  return 'true'
}

export const presenceTestText = (text: string, representation: Representation): string => {
  if (absent.has(representation.kind)) return 'false'
  if (representation.kind === 'optional') return `(${text}).has_value()`
  if (representation.kind === 'borrowed-ref') return presenceTestText(text, representation.referent)
  if (representation.kind === 'tagged-union') {
    // Present unless the live arm is an absent one. Testing the absent arms and
    // negating, rather than testing the present ones and or-ing, keeps the
    // expression the same length whichever way a union leans and states the
    // question the way the language does.
    // An optional ARM holds its own absence, so a union carrying one has two
    // places absence can live. Both are read: the value is nullish when the
    // live arm is an absent one, OR when it is an optional arm whose flag is
    // empty -- an empty `Optional<T>` IS the `null` or `undefined` its own tag
    // names. The arm test tells the two cases apart, so joining them states
    // one answer rather than choosing between two.
    //
    // hono reaches this on the `Data` union its `Context.body` builds and on
    // `compose`'s own middleware result; refusing it left `conversion:
    // is-present:tagged-union` uninstalled for the WHOLE program, since that
    // helper key carries only the kind.
    const absentTests = representation.arms.flatMap((arm, index) => {
      if (absent.has(arm.value.kind)) return [`${text}.is<${index}>()`]
      if (arm.value.kind === 'optional') return [`(${text}.is<${index}>() && !${text}.get<${index}>().has_value())`]
      return []
    })
    if (absentTests.length === 0) return 'true'
    return `!(${absentTests.join(' || ')})`
  }
  // A box answers this from its own tag, exactly as `absenceComparisonText`
  // below already answers `x == null` from it -- the nullish test IS that
  // comparison (ECMA-262 7.2.15 steps 2-3), so one carrier cannot have two
  // answers here without the two disagreeing. `unresolved` is lattice bottom
  // and genuinely has none.
  if (representation.kind === 'dynamic') {
    return `!((${text}).tag() == gea::Value::Tag::Null || (${text}).tag() == gea::Value::Tag::Undefined)`
  }
  if (representation.kind === 'unresolved') {
    throw createCppEmitBlockedError(
      'runtime-helper:conversion:is-present:unresolved',
      'a nullish test on an "unresolved" carrier has no carrier to read: selection never happened'
    )
  }
  // A host handle is the one value-carrier that holds its own absence: a
  // nullable host handle IS a handle, with nil as a state of it (see
  // `optionalOf`), so there is no flag beside it to read and the handle itself
  // is the answer. Both shapes spell that the same way -- the Apple bridge
  // writes `explicit operator bool() const { return handle != 0; }` on every
  // wrapper struct, and `gea::NativeHandle` carries the same conversion over
  // its own `valid()`.
  if (representation.kind === 'native-handle') return `static_cast<bool>(${text})`
  // A refcounted class instance is the program's own half of that same fact:
  // `gea::Ref<T>` is null or it is an object, and `optional.ts` collapses
  // `TreeNode | null` onto it for exactly that reason. `explicit operator bool`
  // reads the pointer, which is the whole of the question.
  if (representation.kind === 'class-ref' && representation.ownership === 'shared-refcount') return `static_cast<bool>(${text})`
  // Every remaining carrier is a value that exists: a number, a string, a
  // record, an owned class instance, a callable. None of them can be `null` or
  // `undefined` -- the plan puts those in an optional or a union arm -- so the
  // answer is settled before the program runs.
  return 'true'
}

/** Whether this backend can answer a presence test for a carrier, asked of the one authority rather than re-listed. */
export const presenceIsAnswerable = (representation: Representation): boolean => {
  try {
    presenceTestText('operand', representation)
    return true
  } catch {
    return false
  }
}

/**
 * `x === null`, `x !== undefined`, `x == null` -- equality against an absent
 * literal.
 *
 * Not a general comparison and never a conversion: the language settles most
 * of it from the two carriers alone. `null === undefined` is false. An
 * `Optional<T>` whose tag stands for `null` answers `x === undefined` false
 * whatever it holds, and a carrier that cannot be absent at all answers both
 * false without reading the value. Only when the tag and the literal agree is
 * there a runtime question, and that question is the presence flag.
 *
 * The loose operators are a different rule and get it: `x == null` is true for
 * *either* absent value, which is the presence test, so a union with both
 * absent arms answers it correctly where `===` has to name one arm.
 *
 * Returns `null` when neither side is an absent literal, leaving ordinary
 * equality to its own path, and when a side is carried dynamically -- a runtime
 * tag this backend does not read.
 */
export const absenceComparisonText = (
  operator: string,
  left: { readonly text: string; readonly representation: Representation },
  right: { readonly text: string; readonly representation: Representation }
): string | null => {
  const strict = operator === '===' || operator === '!=='
  const loose = operator === '==' || operator === '!='
  if (!strict && !loose) return null
  const negated = operator === '!==' || operator === '!='

  const isLiteral = (representation: Representation): boolean => representation.kind === 'null' || representation.kind === 'undefined'
  const literal = isLiteral(left.representation) ? left : isLiteral(right.representation) ? right : null
  if (!literal) return null
  const other = literal === left ? right : left
  const negate = (text: string): string => (negated ? (text === 'true' ? 'false' : text === 'false' ? 'true' : `!(${text})`) : text)

  // Both sides are absent literals: `null === undefined` is false and
  // `null == undefined` is true, and neither reads a value.
  if (isLiteral(other.representation)) {
    return negate(loose || other.representation.kind === literal.representation.kind ? 'true' : 'false')
  }
  // `unresolved` is lattice bottom, not a carrier: nothing is known about what
  // holds the value, so nothing can be said about its absence either.
  if (other.representation.kind === 'unresolved') return null
  // A boxed value answers this from its own tag and never unpacks the payload.
  // ECMA-262 7.2.16 IsStrictlyEqual returns `true` for `x === null` exactly
  // when `x` IS the null value -- a type test, which the box already carries --
  // and 7.2.15 IsLooselyEqual steps 2-3 make `x == null` true for `null` and
  // `undefined` alike. This is the one comparison a dynamic operand settles
  // without a conversion, which is why it belongs here rather than in the
  // binary-operator tables: `emitCompute` refuses a mixed-carrier operator
  // immediately after asking this function, so declining here (as this used
  // to, before `gea::Value` had a tag to read) refused `caught !== null` --
  // the single most ordinary thing a `catch` body does, and the reason
  // `test/fixtures/try-catch-equality.ts` could not emit at all.
  //
  // `other.text` is read twice in the loose form, which is safe because
  // `operandText` always answers an already-materialized SSA value name
  // (`nameOfValue`, emit-context.ts) and never an expression with effects.
  if (other.representation.kind === 'dynamic') {
    const tag = `(${other.text}).tag()`
    if (loose) return negate(`(${tag} == gea::Value::Tag::Null || ${tag} == gea::Value::Tag::Undefined)`)
    return negate(`${tag} == gea::Value::Tag::${literal.representation.kind === 'null' ? 'Null' : 'Undefined'}`)
  }

  // `x == null` asks about absence itself, whichever value carries it.
  if (loose) return negate(`!(${presenceTestText(other.text, other.representation)})`)

  if (other.representation.kind === 'optional') {
    return negate(other.representation.absence === literal.representation.kind ? `!(${other.text}).has_value()` : 'false')
  }
  if (other.representation.kind === 'tagged-union') {
    const arm = other.representation.arms.findIndex((candidate) => candidate.value.kind === literal.representation.kind)
    return negate(arm < 0 ? 'false' : `(${other.text}).is<${arm}>()`)
  }
  // The two carriers that hold their own absence answer `=== null` at RUNTIME,
  // where every other carrier answers it before the program runs. Folding it to
  // `false` here is what `sum(node)`'s `node === null` would have become --
  // `optional.ts` collapsed `TreeNode | null` onto the bare `Ref`, so the
  // carrier no longer says whether absence is possible and the value has to.
  // `=== undefined` stays settled: neither collapse admits that absence.
  if (carriesMergeAbsence(other.representation)) {
    return negate(literal.representation.kind === 'null' ? `!(${presenceTestText(other.text, other.representation)})` : 'false')
  }
  // Every remaining carrier is a value that exists, so it is neither `null` nor
  // `undefined` and the comparison is settled before the program runs.
  return negate('false')
}

/**
 * `ToBoolean` of one value, per carrier.
 *
 * The table is the language's, not a convenience: `0` and `NaN` are false and
 * every other number true, an empty string is false and a one-space string
 * true, `null` and `undefined` are false, an absent optional is false, and
 * *every* object is true no matter what it holds. Writing any of these as a
 * C++ implicit conversion would get several of them wrong -- `NaN` converts to
 * `true`, and a `std::string` does not convert at all -- so each carrier gets
 * the expression that is exactly its rule, and a carrier with no stated rule
 * is refused rather than left to whatever `if (x)` happens to mean in C++.
 *
 * Truthiness and presence live in one file because they are the two questions
 * a program asks of a value it has not looked at, they disagree on exactly the
 * values that matter (`0`, `''`, `NaN` are present and falsy), and keeping them
 * apart is how a backend ends up answering one with the other's rule.
 */
/**
 * `integral` says the value is HELD in a `long long` -- the integer storage
 * census narrowed the cell, the field or the formal it came out of.
 *
 * It changes one answer and it has to: a `long long` has no NaN, so `v == v`
 * is not a NaN test there but a tautology, and gcc rejects it outright under
 * `-Werror=tautological-compare`. `examples/apps/weather` is where that
 * surfaced -- five `if (store.searchResultVisible)` sites the moment those
 * flags became `Signal<long long>` -- and it is a compile error rather than a
 * wrong answer only because the board builds with `-Werror`.
 */
export const booleanTestText = (text: string, representation: Representation, integral = false): string => {
  switch (representation.kind) {
    case 'scalar':
      // `NaN` is false, and `NaN != 0` is true, so the zero test alone is
      // wrong for the one domain that has a NaN. `v == v` is the ordinary
      // spelling of "not NaN" and needs no <cmath>.
      if (representation.domain === 'boolean') return text
      if (representation.domain === 'number' && !integral) return `((${text}) == (${text}) && (${text}) != 0)`
      return `((${text}) != 0)`
    case 'string':
      return `(!(${text}).empty())`
    case 'null':
    case 'undefined':
      return 'false'
    case 'tagged-union': {
      // Each arm has its own rule -- a `null` arm is false, a string arm is
      // false only when empty, an object arm is always true -- so the test is
      // the arm dispatch, not one expression over the union. The final arm
      // needs no discriminant check: the union always holds one of them, and
      // testing for it anyway would leave a value C++ requires an answer for.
      const arms = representation.arms
      const last = arms[arms.length - 1]
      if (!last)
        throw createCppEmitBlockedError(
          'runtime-helper:conversion:to-boolean:tagged-union',
          'a tagged union with no arms has no value to test'
        )
      return arms
        .slice(0, -1)
        .reduceRight(
          (fallback, arm, index) => `((${text}).is<${index}>() ? ${booleanTestText(`(${text}).get<${index}>()`, arm.value)} : ${fallback})`,
          booleanTestText(`(${text}).get<${arms.length - 1}>()`, last.value)
        )
    }
    case 'optional':
      // An absent optional is the language's `undefined` or `null`, which is
      // false; a present one is whatever its payload's own rule says, because
      // `Optional<string>` holding `""` is false and not true.
      return `((${text}).has_value() && ${booleanTestText(`*(${text})`, representation.payload)})`
    case 'native-handle':
      // The one carrier in this group that is not always an object. A nullable
      // host handle IS a handle with nil as a state of it, so the absence the
      // plan would put in an `Optional` for any other carrier lives inside the
      // handle itself -- which `presenceTestText` above already states, and
      // answering `true` here contradicted it. A nil handle is the language's
      // `null`, whose `ToBoolean` is false, and a valid one is an object,
      // whose `ToBoolean` is true; `explicit operator bool` is exactly that
      // distinction, so presence and truthiness genuinely coincide here and
      // are spelled the same way rather than by accident.
      //
      // Getting this wrong is invisible: `if (!root)` over a handle folded to
      // `!true`, so the guard tested a constant instead of the value.
      return presenceTestText(text, representation)
    case 'symbol':
      // ECMA-262's ToBoolean table has no symbol row of its own: a symbol is
      // not a primitive with a falsy value, it is one of the values that is
      // simply true. `Symbol()` and `Symbol('')` are both truthy.
      return 'true'
    case 'class-ref':
      // Truthy as every object is -- unless it is the refcounted shape
      // `optional.ts` collapses `T | null` onto, whose null state is the
      // absence that collapse removed the flag for. `presenceTestText` states
      // that distinction once; answering `true` here would contradict it, the
      // same way it once did for `native-handle`.
      return presenceTestText(text, representation)
    case 'record':
    case 'record-with-index':
    case 'native-record-ref':
    case 'array-object':
    case 'dictionary':
    case 'proxy-object':
    case 'typed-array':
    case 'array-buffer':
    case 'shared-array-buffer':
    case 'data-view':
    case 'promise':
    case 'keyed-collection':
    case 'function':
    case 'function-family':
    case 'function-value-family':
    case 'function-value-dispatch':
    case 'callable-identity':
    case 'generic-function-set':
    case 'constructor-family':
    case 'constructor-value-dispatch':
    case 'function-and-constructor':
      // Every object is truthy, including an empty array and a `new
      // Boolean(false)`. The value is not read at all, which is the point.
      // ECMA-262 gives `Promise` no special ToBoolean rule -- it is an
      // ordinary object for this purpose, same as every other carrier in
      // this group.
      return 'true'
    case 'dynamic':
      // A value the program declared `any`/`unknown` and never narrowed --
      // one of the four reasons a box is legitimate at all
      // (representation/model.ts). `ToBoolean` is a closed nine-tag table
      // with no user code in it, unlike a property get or a call, so
      // `gea::host::detail::toBoolean` (gea_runtime.h) can state the whole
      // thing rather than leaving it as an open dispatch: undefined/null
      // false, an object/function/symbol always true, and a boxed
      // boolean/number/string reads its own payload for the same
      // NaN/zero/empty-string rule the scalar and string cases above already
      // state. Only bigint has no answer, because no arbitrary-precision
      // type exists anywhere in this runtime for it to hold.
      return `gea::host::detail::toBoolean(${text})`
    default:
      throw createCppEmitBlockedError(
        `runtime-helper:conversion:to-boolean:${representation.kind}`,
        `a "${representation.kind}" carrier has no stated ToBoolean rule; testing it would mean choosing one, and the wrong choice is invisible`
      )
  }
}
