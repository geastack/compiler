import type { Representation } from '../../../representation/model.js'
import { cppRecordFieldName, cppScalarType, cppTypeOf } from '../types.js'
import { createCppEmitBlockedError, operandText, type EmitContext, type HostMemberRead } from '../emit-context.js'
import { fillHostTemplate, hostCallName, hostMemberOf, type HostCallSpelling } from './host-members.js'
import { unboxedReadText } from '../emit-dynamic-properties.js'

/**
 * A host call whose trailing arguments the program may omit.
 *
 * TypeScript writes an omissible parameter `buttons?: number` and C++ writes
 * the same parameter `double buttons = 0.0`. They agree about the program --
 * a caller may leave it out -- and they disagree about *where the default
 * lives*: TypeScript says the argument is `number | undefined` and hands the
 * callee an absence, C++ says the argument is a `double` and fills the
 * omission in at the call site, from a default only the callee's own
 * declaration carries.
 *
 * So a value carried as `gea::Optional<double>` cannot be passed to
 * `double buttons = 0.0`, and nothing at this boundary knows what to pass
 * instead: the default is written in the host's header, which is not a table
 * this compiler reads and not a fact it may invent. `value_or(0)` is the shape
 * of the guess -- it would be right for this one parameter and silently wrong
 * for the first host that defaults one to `-1`.
 *
 * What both languages DO agree on is the omission itself. So the call is
 * emitted once per arity: absent means "not passed", which is exactly what
 * TypeScript means and exactly what lets C++ supply its own default. Nothing
 * is guessed, and a host that instead takes the optional as a template
 * parameter (the engine's `getCurrentPosition(Success, Error)`) gets the
 * unwrapped value, which is the callable it wanted rather than a wrapper it
 * cannot call.
 *
 * The one shape neither language can express is a HOLE -- an omitted argument
 * followed by a supplied one. `f(a, undefined, 5)` is legal TypeScript and
 * means "default the second"; C++ default arguments are positional and cannot
 * skip. That call is refused at run time, by name, at the point it happens:
 * the alternative is passing a fabricated default, which is the silent wrong
 * answer this whole rule exists to avoid.
 */

/** One rendered argument at a host call, with the carrier the program holds it in. */
export interface HostCallArgument {
  readonly text: string
  readonly representation: Representation
}

/** One host call site, with its trailing optional arguments held apart from the rest. */
export interface HostArityCall {
  /** The host's own spelling of the function: a path to append arguments to, or a template that places them. */
  readonly spelling: HostCallSpelling
  /** Arguments that are always passed: the receiver, if the convention declares one, and every argument before the optional tail. */
  readonly fixed: readonly HostCallArgument[]
  /** Arguments carried as optionals, in call order; every one of them trails the fixed arguments. */
  readonly optionals: readonly HostCallArgument[]
  /**
   * The assignment target for the call's result and the carrier the program
   * holds it in, or `null` when the call publishes none. The carrier travels
   * with the name because the crossing back is decided by it -- see
   * `hostResultText`.
   */
  readonly result: { readonly name: string; readonly representation: Representation } | null
}

/**
 * One argument, as the host takes it.
 *
 * A carrier this compiler chose for the *program*'s sake is not always the one
 * a host declares, and where the two differ the crossing is a conversion rather
 * than a cast. Only one carrier needs one statically: an Array exotic object --
 * identity, growth, and holes, so `shared_ptr<ArrayObject<E>>` -- meeting a
 * host that declares `const std::vector<E>&` and wants the elements. The
 * runtime performs it (`gea::detail::hostArrayArgument`), including refusing a
 * hole rather than filling one in.
 *
 * Everything else passes through untouched, which is the point: this is not a
 * universal wrapper around host arguments but the named list of carriers whose
 * host spelling differs, and a carrier absent from it reaches the host exactly
 * as the program holds it.
 */
export const hostArgumentText = (representation: Representation, text: string, arrayArguments?: 'snapshot' | 'native'): string => {
  if (arrayArguments === 'native') return text
  if (representation.kind === 'array-object' && arrayArguments === 'snapshot') return `gea::detail::hostArraySnapshotArgument(${text})`
  if (representation.kind === 'array-object') return `gea::detail::hostArrayArgument(${text})`
  // A typed array is held behind a pointer and every host takes the sequence,
  // never the pointer -- see `gea::detail::hostTypedArrayArgument`.
  if (representation.kind === 'typed-array') return `gea::detail::hostTypedArrayArgument(${text})`
  return text
}

/**
 * The receiver a deferred host member call renders on, spelled here rather than
 * where the member was reached.
 *
 * The access that recorded the member produced no C++ (a host method is not a
 * value), so it had nothing of its own to print and no reason to print the
 * receiver either -- it did so only because the record it left behind held a
 * string. Recording the operand instead (`HostMemberRead`) moves the spelling
 * to the one place that consumes it, which is this call, and leaves the record
 * a fact rather than a rendering.
 *
 * The crossing is the same one every other host argument makes: a receiver a
 * row declares `raw` is taken as the program holds it, and anything else meets
 * `hostArgumentText`. That is not a new decision -- it is exactly what the
 * declaration-bound seed site already did, and the static-member seed site's
 * receivers are native handles and native record refs, for which
 * `hostArgumentText` is the identity.
 */
export const hostMemberReceiverText = (ctx: EmitContext, read: HostMemberRead): string | null => {
  if (read.receiver === null) return null
  const text = operandText(ctx, read.receiver)
  const host = hostMemberOf(ctx.hosts.members, read.protocol, read.member)
  if (host?.kind === 'method' && host.receiver === 'raw') return text
  return hostArgumentText(read.receiver.representation, text)
}

/**
 * One result, as the program holds it.
 *
 * The mirror of `hostArgumentText`, for the one carrier whose two sides differ:
 * a host that hands back a finished sequence declares `std::vector<E>`
 * (`AVCaptureDevice.virtualDeviceSwitchOverVideoZoomFactors` is `number[]` and
 * the generated bridge returns exactly that), and the program holds an Array
 * exotic object. Assigning one to the other does not compile, and reinterpreting
 * it would be a lie about identity -- so the runtime moves the elements across.
 *
 * Applied at every host result whose carrier is `array-object`, without asking
 * what the host's C++ actually returns: that fact belongs to each host and this
 * compiler does not hold it. `gea::detail::hostArrayResult` is overloaded for
 * both shapes precisely so the crossing does not need to know -- a host that
 * already hands back an array object gets the identity overload.
 *
 * A `typed-array` result carrier is the identical joint one level down:
 * `image.readFile` states its C++ return type as `std::vector<std::uint8_t>`
 * (`host-shims.ts`) -- a complete byte sequence the host built and shares no
 * identity over -- while the program's own carrier for the checker's declared
 * `Uint8Array` is `shared_ptr<gea::TypedArray<uint8_t>>`. Unlike the
 * `array-object` crossing, the element type is not recoverable from the
 * argument's own C++ type (every such host row returns the same
 * `vector<uint8_t>` regardless of which typed array it is declared to
 * produce), so it is named explicitly from the representation this compiler
 * already selected -- `gea::detail::hostTypedArrayResult`'s own header
 * explains why that is still not a guess.
 */
export const hostResultText = (representation: Representation, text: string, spelling?: HostCallSpelling): string => {
  // A host that states `result: 'dynamic'` answers in a `gea::Value` and the
  // program holds whatever the compiler proved -- so the crossing back is the
  // same checked unbox a dynamic property read performs, and a no-op when the
  // program's own carrier is dynamic too.
  if (spelling?.result === 'dynamic') return unboxedReadText(representation, text, `${hostCallName(spelling)} result`)
  if (representation.kind === 'array-object') return `gea::detail::hostArrayResult(${text})`
  if (representation.kind === 'typed-array') return `gea::detail::hostTypedArrayResult<${cppScalarType(representation.element)}>(${text})`
  // TypeScript tuples derive as records with required consecutive numeric
  // fields. A host tuple is not an Array exotic object: it has no JS-visible
  // identity, growth, holes, or prototype, so adapting it through
  // `hostArrayResult` would manufacture the wrong ABI. Materialise the record
  // directly from the host's fixed indexed result instead.
  if (
    representation.kind === 'record' &&
    representation.fields.length > 0 &&
    representation.fields.every(
      (field, index) => field.key === String(index) && field.required && field.value.kind === 'scalar' && field.value.domain === 'number'
    )
  ) {
    const fields = representation.fields
      .map((field, index) => `gea_host_tuple_result.${cppRecordFieldName(field.key)} = gea_host_tuple[${index}];`)
      .join(' ')
    return `([&]() { const auto gea_host_tuple = ${text}; auto gea_host_tuple_result = ${cppTypeOf(representation)}{}; ${fields} return gea_host_tuple_result; }())`
  }
  return text
}

/**
 * The call itself, with every argument rendered as the host takes it -- and one
 * branch per live arm of any argument the program carries as a sum.
 *
 * `setSupportedOrientations(orientations: string | string[])` is the shape. The
 * host declares that as two things it can be handed (a `std::string`, or
 * something with `.size()` and `[0]`) and picks between them with `if
 * constexpr` -- a COMPILE-TIME question. The program's carrier answers it at run
 * time: a `gea::TaggedUnion` whose live arm is a fact only the running program
 * has. There is no single C++ argument that is both, and passing the union
 * itself reaches the host's `else` branch, which casts it to `std::string` and
 * does not compile.
 *
 * So the arm is chosen where it is known -- at the call, at run time -- and each
 * arm is then an ordinary argument of its own carrier, adapted by the rule
 * above. This is the same move the arity split makes for an optional: the
 * program's runtime fact becomes a branch, and each branch is a call the host
 * already accepts.
 */
/**
 * One call, in whichever of the two forms the host stated.
 *
 * A path appends its arguments; a template places them, through the same
 * `fillHostTemplate` every host MEMBER row already renders through, so a
 * namespace member and a carrier member can never drift on what `{args}` means.
 * A template that names a slot this call cannot fill is refused by name rather
 * than emitted with a hole -- the identical fail-closed answer
 * `emit-host-properties.ts` gives for a member row written for the wrong
 * position.
 */
const callText = (spelling: HostCallSpelling, args: readonly string[]): string => {
  if (spelling.kind === 'path') return `${spelling.text}(${args.join(', ')})`
  const filled = fillHostTemplate(spelling.emit, null, args, args.join(', '))
  if (filled === null) {
    throw createCppEmitBlockedError(
      `host-invocation:${hostCallName(spelling)}`,
      `the "${spelling.emit}" host template names a slot this call cannot fill`
    )
  }
  return filled
}

const callLines = (call: HostArityCall, passed: readonly HostCallArgument[], indent: string, depth: number): readonly string[] => {
  const union = passed.findIndex((argument) => argument.representation.kind === 'tagged-union')
  const carrier = union < 0 ? null : passed[union]?.representation
  if (carrier === null || carrier === undefined || carrier.kind !== 'tagged-union') {
    const text = callText(
      call.spelling,
      passed.map((argument) => hostArgumentText(argument.representation, argument.text, call.spelling.arrayArguments))
    )
    const bound = call.result === null ? null : hostResultText(call.result.representation, text, call.spelling)
    return [`${indent}${call.result === null ? `${text};` : `${call.result.name} = ${bound};`}`]
  }
  // Bound once, then branched on: the argument's text is an expression, and
  // testing `index()` on it and then reading an arm out of it would evaluate
  // that expression twice per branch -- building the value again, and running
  // whatever it does again with it.
  //
  // Inside a block of its own, always. The name is keyed by NESTING DEPTH, not
  // by call site, so two calls in one body that each carry a union argument
  // both bind `gea_host_arg_0` -- and where the call has no optional tail,
  // `hostArityCallLines` below emits no enclosing block, so the second binding
  // redeclared the first at function scope and clang refused the unit.
  // (`encodeURIComponent(a); encodeURIComponent(b);` is exactly that shape:
  // one `string | number | boolean` parameter, no optionals.) Bracing here
  // rather than at the caller keeps the block with the declaration it scopes,
  // and also removes a jump-over-initialization hazard: bodies branch with
  // `goto`, and a `const auto&` at function scope can be jumped past.
  const held = `${cppHostArgumentName}${depth}`
  const lines = [`${indent}{`, `${indent}const auto& ${held} = ${passed[union]?.text};`]
  carrier.arms.forEach((arm, index) => {
    const chosen = passed.map((argument, position) =>
      position === union ? { text: `${held}.get<${index}>()`, representation: arm.value } : argument
    )
    const last = index === carrier.arms.length - 1
    lines.push(last ? `${indent}} else {` : `${indent}${index === 0 ? 'if' : '} else if'} (${held}.index() == ${index}) {`)
    lines.push(...callLines(call, chosen, `${indent}  `, depth + 1))
  })
  lines.push(`${indent}}`)
  lines.push(`${indent}}`)
  return lines
}

const invocation = (call: HostArityCall, count: number, indent: string): readonly string[] =>
  callLines(
    call,
    [...call.fixed, ...call.optionals.slice(0, count).map((argument) => ({ ...argument, text: `(*${argument.text})` }))],
    indent,
    0
  )

/**
 * The guard for one arity: every optional AFTER the omitted one must also be
 * omitted, or the call is the hole this boundary cannot express.
 */
const holeGuard = (call: HostArityCall, omitted: number, indent: string, names: readonly string[]): readonly string[] =>
  names
    .slice(omitted + 1)
    .map(
      (name) =>
        `${indent}if (${name}.has_value()) gea::detail::refuseOmittedArgument(${JSON.stringify(hostCallName(call.spelling))}, ${omitted});`
    )

/** The prefix of the temporaries this call binds; scoped to the call's own block, so two calls in one function never collide. */
const cppHostArgumentName = 'gea_host_arg_'

/**
 * The call, once per arity the program can actually reach.
 *
 * `k` optional arguments produce `k + 1` branches: one for each prefix of them
 * that is present, and the last for all of them. Presence is tested in order,
 * so each branch knows every earlier optional is present and needs only to
 * prove the ones after the first absence are absent too.
 *
 * Every optional is bound to a name first, for the reason the union branch
 * binds one: the argument is an expression, and it is read once in a condition
 * and again in a call. The whole thing sits inside a block so those names are
 * this call's alone.
 */
export const hostArityCallLines = (call: HostArityCall): readonly string[] => {
  if (call.optionals.length === 0) return invocation(call, 0, '')
  const names = call.optionals.map((_, index) => `${cppHostArgumentName}optional_${index}`)
  const bound: HostArityCall = {
    ...call,
    optionals: call.optionals.map((argument, index) => ({ ...argument, text: names[index] as string }))
  }
  const lines = ['{', ...call.optionals.map((argument, index) => `  const auto& ${names[index]} = ${argument.text};`)]
  for (let omitted = 0; omitted < bound.optionals.length; omitted += 1) {
    const opener = omitted === 0 ? 'if' : '} else if'
    lines.push(`  ${opener} (!${names[omitted]}.has_value()) {`)
    lines.push(...holeGuard(bound, omitted, '    ', names))
    lines.push(...invocation(bound, omitted, '    '))
  }
  lines.push('  } else {')
  lines.push(...invocation(bound, bound.optionals.length, '    '))
  lines.push('  }')
  lines.push('}')
  return lines
}
