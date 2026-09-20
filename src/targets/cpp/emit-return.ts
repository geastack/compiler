import type { IrOperand, IrTerminatorOperation } from '../../ir/model.js'
import { representationKey } from '../../representation/model.js'
import type { EmitContext } from './emit-context.js'
import { operandText, createCppEmitBlockedError } from './emit-context.js'
import { cppTypeOf, cppUndefinedIn } from './types.js'
import { alignedValueText, dynamicPromiseAdoptionText } from './emit-narrowing.js'
import { structuralRecordViewText } from './emit-record-view.js'

/**
 * The `return` terminator: the one place a body's own value meets the calling
 * convention its callers were compiled against.
 *
 * Three ABI results make different demands here -- a generator (`co_return`,
 * and no completion value), a promise (a SETTLED value rather than a converted
 * one), and everything else (an ordinary two-direction reconciliation) -- which
 * is why this lives beside `emit.ts` rather than inside its terminator switch.
 */
/**
 * A derived constructor's own completion rules (ECMA-262 10.2.2 step 13),
 * decided statically. A body with no `super-initialize` anywhere never binds
 * `this`, so every normal completion is the ReferenceError the language
 * throws; a `return` of a primitive is the TypeError. Both were silently
 * rendered as an ordinary construction before, which is a wrong answer, not
 * a refusal. `undefined`/`void` returns are the ordinary case and fall
 * through; a `return` of an OBJECT other than the receiver itself is the
 * return-override this backend does not implement, and is refused by name
 * rather than discarded.
 */
const constructorCompletionText = (ctx: EmitContext, value: IrOperand | null): string | null => {
  const owning = ctx.constructorOf
  if (owning === null) return null
  if (owning.derived && !owning.callsSuper) {
    return (
      'gea::host::throwRuntimeError("ReferenceError", "Must call super constructor in derived class before accessing \'this\' or ' +
      'returning from derived constructor");'
    )
  }
  const kind = value?.representation.kind
  if (value === null || kind === undefined || kind === 'void' || kind === 'undefined' || ctx.receiverValues.has(value.value)) return null
  if (kind === 'string' || kind === 'scalar' || kind === 'null') {
    if (!owning.derived) return null
    return `(void)(${operandText(ctx, value)}); gea::host::throwRuntimeError("TypeError", "Derived constructors may only return object or undefined");`
  }
  throw createCppEmitBlockedError(
    'call-abi:constructor-return-override',
    `a constructor of class ${owning.layout.declaration} returns a "${representationKey(value.representation)}" value, which would ` +
      'replace the constructed instance ([[Construct]] step 10.a); this backend does not implement a constructor return override'
  )
}

export const emitReturn = (ctx: EmitContext, lines: string[], terminator: Extract<IrTerminatorOperation, { kind: 'return' }>): void => {
  const completion = constructorCompletionText(ctx, terminator.value ?? null)
  if (completion !== null) {
    lines.push(completion)
    return
  }
  // A coroutine may not use `return` at all -- C++20 [stmt.return] makes it
  // ill-formed inside one -- so a generator body's every return, implicit
  // fall-off included, spells `co_return`. A generator's completion VALUE
  // (`return v` inside a `function*`) is carried when the cursor's own
  // `completion` slot is a real native carrier (`representation/derive.ts`'s
  // `GeneratorDeclarationPolicy`, `runtime/gea_runtime.h`'s
  // `promise_type::return_value`) -- otherwise (an unresolved/dynamic
  // `TReturn`, collapsed to `undefined` on purpose rather than boxed) a
  // valued return is refused, since there is no storage to fill with it.
  //
  // Keyed on the BODY's own generator-ness, never on its result carrier: an
  // ordinary `function makeGen() { return g() }` returns the identical
  // `iterator(source: generator)` cursor a `function*` does, and spelling its
  // `return` as `co_return` (or refusing it for lacking a completion channel)
  // mistook the value's shape for the frame's.
  if (ctx.generatorBody) {
    const cursor = ctx.abi?.result
    if (cursor?.kind !== 'iterator') {
      throw createCppEmitBlockedError(
        'runtime-helper:boundary:generator-resume',
        `a generator body's calling convention returns "${cursor ? representationKey(cursor) : 'nothing'}" rather than an iterator cursor`
      )
    }
    if (!terminator.value) {
      lines.push('co_return;')
      return
    }
    if (cursor.completion.kind === 'void' || cursor.completion.kind === 'undefined') {
      throw createCppEmitBlockedError(
        'runtime-helper:boundary:generator-resume',
        'returns a value from a generator body whose completion channel is "undefined" -- either TReturn never resolved to a native ' +
          'carrier, or this generator is not annotated as one -- and this cursor has no storage to fill with it'
      )
    }
    const text = operandText(ctx, terminator.value)
    const converted = alignedValueText(ctx, 'emit-return.ts:92', terminator.value.representation, cursor.completion, text)
    if (converted === null) {
      throw createCppEmitBlockedError(
        `conversion:${representationKey(terminator.value.representation)}->${representationKey(cursor.completion)}`,
        `returns a ${terminator.value.representation.kind} where this generator's completion channel is ${cursor.completion.kind}, ` +
          'and no conversion is installed between them'
      )
    }
    lines.push(`co_return ${converted};`)
    return
  }
  if (!terminator.value) {
    // `Promise<void>` is a real class type, not the literal `void` -- a
    // bare `return;` inside a function whose ABI result is
    // `Promise<void>` is a C++ compile error (returning nothing from a
    // function declared to return a class). `T === void` is the only
    // payload for which a `return` terminator carries no value operand
    // at all here, so this is reached exactly once per such function, at
    // its implicit or explicit valueless return.
    if (ctx.abi?.result.kind === 'promise' && ctx.abi.result.value.kind === 'void') {
      lines.push(`return ${cppTypeOf(ctx.abi.result)}::settled_value();`)
      return
    }
    if (ctx.abi && ctx.abi.result.kind !== 'void') {
      const result = ctx.abi.result
      const payload = result.kind === 'promise' ? result.value : result
      const absent = cppUndefinedIn(payload)
      if (absent === null) {
        // A valueless return into a result with no absence value is the one
        // shape TypeScript admits only at an unreachable point: `return
        // fail(...)` where `fail(): never`. The lowering drops the `never`
        // carrier (it names no value), the call itself was rendered as its
        // own statement and does not return, and this is the point after it
        // -- `[[noreturn]]`, so the function's own result type needs no
        // value here (`emit-callable.ts` renders an unreachable argument the
        // same way).
        lines.push(`return gea::host::unreachableValue<${cppTypeOf(result)}>();`)
        return
      }
      lines.push(result.kind === 'promise' ? `return ${cppTypeOf(result)}(${absent});` : `return ${absent};`)
      return
    }
    lines.push('return;')
    return
  }

  const text = operandText(ctx, terminator.value)
  // The body's own declared ABI result is the "held" side of the same
  // reconciliation `emit-bindings.ts` already applies to a binding cell -- see
  // citations.md finding 1. `ctx.abi` is `null` only for an uncalled region,
  // which never has a `return` with a value to widen.
  //
  // `convertedValueText`, not `widenedStoreText`: the store direction alone
  // answers only a value WIDENING into the declared result, and returns `null`
  // for the mirror case -- a `dynamic` value returned where the ABI result is
  // concrete. That `null` then fell through to the bare `text`, emitting
  // `return gea_arg_1;` from a `gea::Value` into a
  // `gea::TaggedUnion<std::string, double>` with no conversion at all: a
  // certified, preflight-clean program that clang rejects. A JSDoc
  // `@returns {number|string}` on a JS function whose parameter's call sites
  // disagree is enough to reach it. `convertedValueText` is the general
  // reconciliation in both directions -- it asks `unboxedLoadText` for a
  // dynamic source and falls through to the same `widenedStoreText` otherwise
  // -- and is already what every argument slot (`emit-callable.ts`) uses.
  //
  // An async body's ABI result is `Promise<V>` while its `return v` carries a
  // bare `V`: that pair is a RESOLUTION, not a conversion, and `Promise`'s
  // converting constructor exists for this one site and no other -- its own
  // class comment says so ("TypeScript never lets an ordinary binding or field
  // hold a bare `T` where `Promise<T>` is declared -- so this is reached only
  // from a function whose declared return type is `Promise<T>`"). Verified by
  // RUNNING it: an async arrow returning an awaited `number` emits `return
  // total;` from a `gea::Promise<double>` function and prints the right answer.
  // Reconciling against the promise's PAYLOAD rather than against the promise
  // keeps the guard below fail-closed on the part that really is a conversion.
  // Returning an already-promise value (a pass-through) reconciles against the
  // promise itself, so it is left to the general path.
  // A DYNAMIC value may itself be a promise (hono's `formData()` returns its
  // `any`-typed `#cachedBody(...)`), and an async return adopts one rather
  // than fulfilling with it (ECMA-262 27.2.1.3.2) -- decided at run time.
  // Lowering already converted the value toward the payload, so the dynamic
  // operand is the convert's source.
  const dynamicSource =
    terminator.value.representation.kind === 'dynamic' ? terminator.value : (ctx.conversionSources.get(terminator.value.value) ?? null)
  if (ctx.abi?.result.kind === 'promise' && dynamicSource?.representation.kind === 'dynamic') {
    const adopted = dynamicPromiseAdoptionText(ctx.abi.result, operandText(ctx, dynamicSource))
    if (adopted !== null) {
      lines.push(`return ${adopted};`)
      return
    }
  }
  const settlesIntoPromise = ctx.abi !== null && ctx.abi.result.kind === 'promise' && terminator.value.representation.kind !== 'promise'
  const abiResult = settlesIntoPromise && ctx.abi ? ctx.abi.result.value : (ctx.abi?.result ?? null)
  // `Promise<void>` carries no payload at all (`cppResultTypeOf` elides
  // `void`), so a valued return whose value is itself `void` -- `return f()`
  // where `f` completes without producing one -- has nothing to settle WITH.
  // The evaluation still has to happen for its effects, so it is discarded
  // explicitly and the settled promise minted by the same named factory the
  // valueless return above uses.
  if (ctx.abi && ctx.abi.result.kind === 'promise' && abiResult && abiResult.kind === 'void') {
    lines.push(`(void)(${text});`)
    lines.push(`return ${cppTypeOf(ctx.abi.result)}::settled_value();`)
    return
  }
  // A value-returning source statement may still implement a `void` ABI:
  // `return undefined` and `return sideEffect()` both evaluate an expression,
  // then expose no result to the caller. Preserve that evaluation and discard
  // its value explicitly. Passing `void` into the general conversion below is
  // invalid by construction -- it has no C++ value type for `cppTypeOf` to
  // compare -- and previously crashed the entire emission after lowering had
  // already accepted the body.
  if (abiResult?.kind === 'void') {
    lines.push(`(void)(${text});`)
    lines.push('return;')
    return
  }
  // The same two-step an ARGUMENT already takes (`alignedText`, emit-callable.
  // ts): `convertedValueText` first, and only when it refuses, the view that
  // needs both LAYOUTS in hand. A `native-record-ref` carries a shape id and no
  // field list, so the general conversion cannot reach the target's members --
  // this is the one place the deriver is available to resolve them. `return
  // options` out of a method declared to return an overlapping named shape is
  // ordinary TypeScript and the mongodb driver is built out of it.
  const converted = abiResult
    ? (alignedValueText(ctx, 'emit-return.ts:202', terminator.value.representation, abiResult, text) ??
      structuralRecordViewText(ctx, terminator.value.representation, abiResult, text))
    : null
  // FAIL CLOSED. `convertedValueText` answers `text` unchanged whenever the two
  // carriers already agree, so `null` here means no recipe exists for this pair
  // -- and emitting the bare operand anyway is how a `gea::Value` came to be
  // returned from a function declared `gea::TaggedUnion<std::string, double>`:
  // certified, preflight-clean, and rejected by clang. A missing conversion is
  // a refusal, not a silently unconverted store.
  if (abiResult && converted === null) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(terminator.value.representation)}->${representationKey(abiResult)}`,
      `returns a ${terminator.value.representation.kind} where this body's ABI result is ${abiResult.kind}, ` +
        'and no conversion is installed between them'
    )
  }
  // ONE user-defined conversion, and the promise already spends it.
  //
  // Reconciling against the payload is right, but it leaves the step from the
  // payload to the promise implicit -- and `convertedValueText` renders a
  // widening that `gea::Optional<T>`'s (or any other) converting constructor
  // performs as the operand text UNCHANGED, because for an ordinary store that
  // single implicit conversion is exactly what happens. Stacked, they are two:
  // `return v3;` from a `double` in a body whose result is
  // `gea::Promise<gea::Optional<double>>` needs `double` -> `Optional<double>`
  // -> `Promise<Optional<double>>`, and C++ [over.ics.user] permits one
  // user-defined conversion per implicit sequence. clang rejected it -- "no
  // viable conversion from returned value of type 'double'" -- on a body that
  // certified clean and emitted. `async next(): Promise<number | null>` with
  // `return this.index++` is the whole program it takes; mongodb's
  // `AbstractCursor.next` is the same shape.
  //
  // Naming the promise explicitly spends the sequence's one slot on the
  // payload widening instead, which is the step that actually needs it. The
  // file's own optional-target comment makes the same argument at the other
  // end of the same pair.
  if (settlesIntoPromise && ctx.abi) {
    lines.push(`return ${cppTypeOf(ctx.abi.result)}(${converted ?? text});`)
    return
  }
  lines.push(`return ${converted ?? text};`)
}
