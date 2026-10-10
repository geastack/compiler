import { stringMethodShapes, type StringMethodShape } from '../../../representation/prototype-domains.js'
export { stringPrototypeMethods } from '../../../representation/prototype-domains.js'
import type { IrOperand, IrResult } from '../../../ir/model.js'
import { representationKey } from '../../../representation/model.js'
import { createCppEmitBlockedError, operandText, type EmitContext } from '../emit-context.js'
import { toStringText } from '../emit-tostring.js'
import { matchAllRefusal, regexpMatchText, regexpReplaceText, regexpSearchText, regexpSplitText } from './emit-prototype-regexp.js'

/**
 * `String.prototype`, as this backend renders it.
 *
 * The mechanism -- a deferred `[[Get]]` fused with the call that follows it --
 * is `emit-prototype-invoke.ts`'s, and its header states why a String method
 * cannot be materialized as a first-class value. What lives here is only the
 * table: which members are claimed, at which arities, over which argument
 * carriers, and which are refused BY NAME with what missing.
 *
 * Every runtime function named below is `gea::runtime::string`'s, which is a
 * port of v1 geatsc's own `src/targets/cpp/runtime/string.cpp` -- the shipping
 * implementation, not a re-derivation. That port is also what settles the
 * index space: v1 indexes in UTF-16 CODE UNITS over UTF-8 storage, which is
 * what ECMA-262 specifies and what node answers, and `.length` moved with it
 * (`emit-carrier-members.ts`).
 */

/** A native scalar primitive may preserve its refined result locally. The
 * primitive producer publishes expression and storage together; ordinary
 * Number ABI positions still receive its exact implicit double conversion. */
export interface NativeScalarCall {
  readonly expression: string
  readonly resultStorage: 'gea::runtime::string::CodeUnit'
}

/** The one signature every member's renderer has. `result` is read only by the two members whose ECMA-262 result is `undefined` out of range. */
export type StringCallRenderer = (
  ctx: EmitContext,
  receiverText: string,
  args: readonly IrOperand[],
  result: IrResult | null,
  metadata?: string
) => string | NativeScalarCall

/**
 * The shape shared by every String.prototype member whose whole content is
 * *which* arities and argument carriers it accepts: a fixed spelling in
 * `gea::runtime::string`, a permitted range of argument counts, and a required
 * carrier per positional argument.
 *
 * Stated as data rather than as twenty near-identical functions because a
 * hand-written function per member is where one of them quietly stops
 * checking. The runtime overload set mirrors each `arities` entry exactly --
 * `startsWith(s, search)` and `startsWith(s, search, position)` are two real
 * C++ overloads -- so an omitted trailing optional argument (which never
 * reaches `operation.arguments` at all) selects the shorter overload rather
 * than being given a synthesized default here. Each shorter overload supplies
 * the spec's own default, stated at its definition.
 */

const carrierMatches = (operand: IrOperand, wanted: 'string' | 'number'): boolean =>
  wanted === 'string'
    ? operand.representation.kind === 'string'
    : (operand.representation.kind === 'scalar' && operand.representation.domain === 'number') || isOptionalNumber(operand.representation)

/**
 * Whether a carrier is `T | undefined` over a number -- ECMA-262's OWN
 * spelling for "this parameter was not supplied", not a caller's mistake.
 * `String.prototype.slice`/`substring`'s numeric parameters are declared
 * optional in `lib.es5.d.ts`, so a call that forwards an already-optional
 * local (`s.slice(maybeStart)`) hands this renderer `optional(scalar(number),
 * undefined)` rather than a bare number -- the value genuinely may be absent
 * at RUNTIME, which an omitted argument (a different arity, handled by the
 * overload set above) cannot express. `numericDefaultText` below is what
 * turns the flag back into ECMA-262's own default for the position.
 */
const isOptionalNumber = (representation: IrOperand['representation']): boolean =>
  representation.kind === 'optional' &&
  representation.absence === 'undefined' &&
  representation.payload.kind === 'scalar' &&
  representation.payload.domain === 'number'

/**
 * The C++ text for a `number`-shaped argument, materializing an absent
 * `optional` into the ECMA-262 default ToIntegerOrInfinity(undefined) already
 * gives its position -- 0 for a leading index (22.1.3.22 step 4, 22.1.3.24
 * step 4) and `+Infinity` for a trailing one (22.1.3.22 step 3: "If end is
 * undefined, let relativeEnd be len"). `+Infinity` is not a guess: it is the
 * exact sentinel the runtime's own single-argument `slice` overload
 * (gea_runtime.h) already passes for a genuinely OMITTED end, so a present-
 * but-undefined end renders through the identical downstream clamp to `len`
 * rather than a second, possibly-disagreeing spelling of the same default.
 */
const numericArgumentText = (ctx: EmitContext, operand: IrOperand, position: number): string => {
  const text = operandText(ctx, operand)
  if (!isOptionalNumber(operand.representation)) return text
  const fallback = position === 0 ? '0.0' : 'std::numeric_limits<double>::infinity()'
  return `(${text}.has_value() ? *${text} : ${fallback})`
}

/**
 * A carrier the runtime overload does not take is refused by name here rather
 * than handed to C++ to reject: the specification COERCES it (ToString /
 * ToIntegerOrInfinity of an arbitrary value), and coercion of an arbitrary
 * value is exactly what this backend has no box for.
 *
 * The check reads the ARGUMENT OPERAND's own resolved carrier, never the
 * declared ABI parameter's. `lib.es5.d.ts` declares `split(separator: string |
 * RegExp)` and `replace(searchValue: string | RegExp, ...)`, so the declared
 * parameter is a `tagged-union` at every call site including the ones that
 * pass a plain string -- the checker's ABI states what is LEGAL to pass, not
 * what this call passes. Reading the operand is what lets a string separator
 * render natively while a RegExp one refuses by name instead of being forced
 * through a carrier this file does not implement.
 */
const shapedStringMethodText =
  (member: string, shape: StringMethodShape): StringCallRenderer =>
  (ctx, receiverText, args, result, metadata): string | NativeScalarCall => {
    // The three members `lib.es5.d.ts` declares over `string | RegExp` are
    // asked of `emit-prototype-regexp.ts` first, and it answers `null` for a
    // string argument so the shaped rendering below is reached unchanged. This
    // is what replaced the union refusal that used to stand here: a RegExp
    // member of the declared union is now rendered, not named as missing.
    const byPattern =
      member === 'split'
        ? regexpSplitText(ctx, receiverText, args, result)
        : member === 'replace' || member === 'replaceAll'
          ? regexpReplaceText(member, ctx, receiverText, args)
          : null
    if (byPattern !== null) return byPattern
    if (!shape.arities.includes(args.length)) {
      throw createCppEmitBlockedError(
        `runtime-helper:element:${member}:string`,
        `"String.prototype.${member}" is spelled for ${shape.arities.join(' or ')} argument(s) (ECMA-262 ${shape.clause}); this call passes ${args.length}`
      )
    }
    const rendered: string[] = []
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index]
      const wanted = shape.carriers[index]
      // ReplaceValue is specified as `callable ? callback : ToString(value)`.
      // The checker overload describes its common string case, while the
      // operand still records the concrete non-callable value this call uses.
      // Reuse the language's one ToString table so numbers and other proven
      // carriers reach GetSubstitution without a dynamic box.
      const replacementText =
        argument && wanted === 'string' && (member === 'replace' || member === 'replaceAll') && index === 1
          ? toStringText(operandText(ctx, argument), argument.representation, ctx.classes, ctx.deriver)
          : null
      if (!argument || !wanted || (!carrierMatches(argument, wanted) && replacementText === null)) {
        throw createCppEmitBlockedError(
          `runtime-helper:element:${member}:string`,
          `"String.prototype.${member}" argument ${index} carries ` +
            `"${argument ? representationKey(argument.representation) : 'nothing'}", and this backend spells it only for a ${wanted ?? 'declared'} carrier` +
            (wanted === 'string' && argument && argument.representation.kind === 'tagged-union'
              ? ' -- the declared parameter is a union, and this call passes an operand carried as the union itself rather than as one resolved arm, ' +
                'so neither the string spelling nor the RegExp one above can be selected'
              : '')
        )
      }
      rendered.push(wanted === 'number' ? numericArgumentText(ctx, argument, index) : (replacementText ?? operandText(ctx, argument)))
    }
    if (member === 'charCodeAt' && metadata !== undefined) {
      return {
        expression: `gea::runtime::string::charCodeAtWithMetadata(${[receiverText, ...rendered, `${metadata}_units`, `${metadata}_basic_latin`, `${metadata}.cursor`].join(', ')})`,
        resultStorage: 'gea::runtime::string::CodeUnit'
      }
    }
    return `gea::runtime::string::${shape.spelling ?? member}(${[receiverText, ...rendered].join(', ')})`
  }

/**
 * `at` and `codePointAt` -- the two String members whose ECMA-262 result is
 * `undefined` when the index is out of range (22.1.3.1 step 7, 22.1.3.4 step
 * 5), rather than the empty string (`charAt`) or NaN (`charCodeAt`).
 *
 * `undefined` is a real value here, not an absence to shrug at, so the runtime
 * returns a `gea::Optional<T>` and this checks that the plan agrees before
 * rendering: an `Optional`-producing expression assigned into a bare `T` does
 * not compile, and an `Optional` silently unwrapped would answer the payload
 * type's zero for an out-of-range read. If the plan gave the result a
 * non-optional carrier, the disagreement is upstream and is refused by name
 * rather than papered over at the C++ boundary.
 */
const optionalResultMethodText =
  (member: 'at' | 'codePointAt', clause: string, payload: 'string' | 'number'): StringCallRenderer =>
  (ctx, receiverText, args, result): string => {
    const index = args[0]
    if (args.length !== 1 || !index) {
      throw createCppEmitBlockedError(
        `runtime-helper:element:${member}:string`,
        `"String.prototype.${member}" is spelled for its one index argument (ECMA-262 ${clause}); this call passes ${args.length}`
      )
    }
    if (!carrierMatches(index, 'number')) {
      throw createCppEmitBlockedError(
        `runtime-helper:element:${member}:string`,
        `"String.prototype.${member}"'s index argument carries a "${representationKey(index.representation)}" carrier, not a number scalar`
      )
    }
    // A call with NO result at all passes: `s.at(0);` in statement position
    // discards the value and `emitCall` renders it as a bare expression
    // statement, so there is no carrier to disagree with.
    const carrier = result?.representation
    const payloadMatches =
      carrier === undefined ||
      (carrier.kind === 'optional' &&
        (payload === 'string'
          ? carrier.payload.kind === 'string'
          : carrier.payload.kind === 'scalar' && carrier.payload.domain === 'number'))
    if (!payloadMatches) {
      throw createCppEmitBlockedError(
        `conversion:optional(${payload})->${carrier ? representationKey(carrier) : 'nothing'}`,
        `"String.prototype.${member}" answers \`undefined\` for an out-of-range index (ECMA-262 ${clause}), so this backend renders it as an ` +
          `optional ${payload}; this call's result carries "${carrier ? representationKey(carrier) : 'nothing'}", and narrowing the absence away here would ` +
          "answer the payload type's zero for a read the program can observe as absent"
      )
    }
    return `gea::runtime::string::${member}(${receiverText}, ${operandText(ctx, index)})`
  }

/**
 * ECMA-262 22.1.3.5 `String.prototype.concat(...strings)`.
 *
 * `concat`'s checker signature is `(...strings: string[]): string` -- a rest
 * parameter -- so `ir/lower.ts`'s `packRestArguments` has already packed every
 * call argument into one `array-object` before this runs, exactly as it has
 * for `Array.prototype.push`. So the rendering takes the packed array rather
 * than a C++ argument per source argument, and the runtime overload mirrors
 * that: v1 spells this as a brace-init list because v1's emitter still has the
 * physical arguments at this point; this backend does not, and inventing them
 * back would mean unpacking a runtime array at compile time.
 *
 * The packed element carrier is checked rather than assumed: a non-string
 * element would be a value the specification ToStrings, and ToString of an
 * arbitrary value is what this backend has no box for.
 */
const concatText: StringCallRenderer = (ctx, receiverText, args): string => {
  const packed = args[0]
  if (args.length !== 1 || !packed) {
    throw createCppEmitBlockedError(
      'runtime-helper:element:concat:string',
      '"String.prototype.concat" expects its rest argument already packed into one array-object by ir/lower.ts\'s packRestArguments; ' +
        `this call arrives with ${args.length} operand(s)`
    )
  }
  if (packed.representation.kind !== 'array-object' || packed.representation.element.kind !== 'string') {
    throw createCppEmitBlockedError(
      'runtime-helper:element:concat:string',
      `"String.prototype.concat"'s packed rest argument carries "${representationKey(packed.representation)}"; this backend spells it only for an ` +
        'array-object of strings, because ECMA-262 22.1.3.5 ToStrings every other argument and ToString of an arbitrary value has no box here'
    )
  }
  return `gea::runtime::string::concat(${receiverText}, ${operandText(ctx, packed)})`
}

/** Primitive String `toString`/`valueOf` both return the receiver unchanged. */
const identityText =
  (member: 'toString' | 'valueOf'): StringCallRenderer =>
  (_ctx, receiverText, args): string => {
    if (args.length !== 0) {
      throw createCppEmitBlockedError(
        `runtime-helper:element:${member}:string`,
        `"String.prototype.${member}" takes no arguments; this call passes ${args.length}`
      )
    }
    return receiverText
  }

/**
 * ECMA-262 22.1.3.15 `String.prototype.normalize(form)`. An absent or
 * `undefined` form is NFC (step 3); any other form must be one of the four
 * names, which the runtime checks and answers a RangeError for otherwise.
 */
const normalizeText: StringCallRenderer = (ctx, receiverText, args): string => {
  const form = args[0]
  if (args.length > 1) {
    throw createCppEmitBlockedError(
      'runtime-helper:element:normalize:string',
      `"String.prototype.normalize" takes at most one form; this call passes ${args.length}`
    )
  }
  if (form === undefined || form.representation.kind === 'undefined') return `gea::runtime::string::normalize(${receiverText})`
  if (form.representation.kind === 'string') return `gea::runtime::string::normalize(${receiverText}, ${operandText(ctx, form)})`
  if (
    form.representation.kind === 'optional' &&
    form.representation.absence === 'undefined' &&
    form.representation.payload.kind === 'string'
  ) {
    return (
      `([&](const auto& gea_normalize_form) { return gea_normalize_form.has_value() ? ` +
      `gea::runtime::string::normalize(${receiverText}, *gea_normalize_form) : gea::runtime::string::normalize(${receiverText}); })` +
      `(${operandText(ctx, form)})`
    )
  }
  throw createCppEmitBlockedError(
    'runtime-helper:element:normalize:string',
    `"String.prototype.normalize"'s form carries "${representationKey(form.representation)}"; ToString of it (step 4) is not spelled here`
  )
}

/** `emit-carrier-members.ts`'s `stringMemberText` defers exactly these keys off a `string` receiver -- one authority for "is this method implemented", never two lists that could drift. */
export const stringMethods: ReadonlyMap<string, StringCallRenderer> = new Map<string, StringCallRenderer>([
  ['concat', concatText],
  ['toString', identityText('toString')],
  ['valueOf', identityText('valueOf')],
  ['normalize', normalizeText],
  // The two members that take a regular expression and NOTHING else: ECMA-262
  // 22.1.3.11 and 22.1.3.13 both `RegExpCreate` a non-RegExp argument first,
  // so there is no string-shaped form to fall back to and these do not go
  // through `shapedStringMethodText` at all.
  ['match', (ctx, receiverText, args, result) => regexpMatchText(ctx, receiverText, args, result)],
  ['search', (ctx, receiverText, args) => regexpSearchText(ctx, receiverText, args)],
  ['at', optionalResultMethodText('at', '22.1.3.1', 'string')],
  ['codePointAt', optionalResultMethodText('codePointAt', '22.1.3.4', 'number')],
  ...[...stringMethodShapes].map(([member, shape]) => [member, shapedStringMethodText(member, shape)] as const)
])

/**
 * Members this backend states a REASON for not implementing, rather than
 * letting them fall into the generic "here is the list of what is implemented"
 * refusal.
 *
 * A member is here when the gap is a specific missing thing a reader would
 * otherwise have to guess at -- a Unicode table, a regular-expression engine,
 * a locale database. The distinction matters: "not built yet" and "cannot be
 * built without X" are different answers, and only the second one tells you
 * what to build.
 */
export const stringMemberRefusals: ReadonlyMap<string, string> = new Map([
  ['matchAll', matchAllRefusal()],
  [
    'toLocaleLowerCase',
    'ECMA-262 22.1.3.30 / ECMA-402 is the LOCALE-SENSITIVE case conversion (a Turkish locale maps I to a dotless lowercase form, which toLowerCase ' +
      'explicitly must not do). There is no locale database here, and rendering it as toLowerCase would silently answer the locale-independent ' +
      'mapping for a call that asked for the other one'
  ],
  [
    'toLocaleUpperCase',
    'ECMA-262 22.1.3.31 / ECMA-402 is the LOCALE-SENSITIVE case conversion; see toLocaleLowerCase -- there is no locale database here'
  ],
  [
    'localeCompare$options',
    'ECMA-402 localeCompare(that, locales, options) selects a collation; this runtime has no ICU and no collation table, so only the one-argument ' +
      'form is rendered, and even that one is a code-unit ordering rather than a collation (see gea::runtime::string::localeCompare)'
  ]
])
