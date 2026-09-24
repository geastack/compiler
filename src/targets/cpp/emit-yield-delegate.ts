import type { Representation } from '../../representation/model.js'
import { representationKey } from '../../representation/model.js'
import type { YieldOperation } from '../../ir/model.js'
import { createCppEmitBlockedError, defineValue, operandText, type EmitContext } from './emit-context.js'
import { alignedValueText } from './emit-narrowing.js'
import { cppTypeOf } from './types.js'

/**
 * The `yield*` delegations this backend renders, by generator kind and by the
 * iterable's carrier: a boxed iterable in either kind of generator. A typed
 * iterable (another native generator, an array) keys a different, unclaimed
 * shape and refuses at preflight rather than being boxed to reach this loop.
 */
export const yieldDelegateHelperClaims: readonly string[] = ['yield-delegate:sync:dynamic', 'yield-delegate:async:dynamic']

const isValueless = (carrier: Representation): boolean => carrier.kind === 'void' || carrier.kind === 'undefined'

const converted = (ctx: EmitContext, site: string, source: Representation, target: Representation, text: string, what: string): string => {
  const aligned = alignedValueText(ctx, site, source, target, text)
  if (aligned === null) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(source)}->${representationKey(target)}`,
      `a yield* ${what} converts "${representationKey(source)}" to "${representationKey(target)}", and no installed conversion does`
    )
  }
  return aligned
}

/**
 * ECMA-262 15.5.5 `yield*`, rendered as its own loop inside the coroutine.
 *
 * `gea::runtime::iterator::delegateStep` performs one inner step for however
 * the outer generator was resumed -- `next(v)`, `throw(e)` or `return(v)` --
 * and answers whether the delegation goes on (with the value to yield) or is
 * over (with the delegation's value, or the value the generator returns). The
 * loop's own `co_yield` is the only suspension; C++ forbids one inside a
 * `catch` handler, so a handler records how the frame was resumed and the
 * step runs after it. The cursor's `ReturnSignal` is the abrupt `return(v)`
 * its awaiter throws (`gea::Iterator::YieldAwaiter`); a thrown program value
 * is a `gea::Value`.
 */
export const emitYieldDelegate = (ctx: EmitContext, lines: string[], operation: YieldOperation): void => {
  const cursor = ctx.abi?.result
  const operand = operation.operand
  if (cursor?.kind !== 'iterator' || operand === null || operation.delegate === null) {
    throw createCppEmitBlockedError('abrupt-edge:suspend', 'a yield* appears outside a body emitted as a coroutine, or delegates nothing')
  }
  if (operand.representation.kind !== 'dynamic') {
    throw createCppEmitBlockedError(
      `runtime-helper:yield-delegate:${operation.delegate}:${operand.representation.kind}`,
      `a yield* over a "${operand.representation.kind}" iterable has no delegation this backend renders`
    )
  }
  const boxed = operand.representation
  const cursorType = cppTypeOf(cursor)
  const ordinal = ctx.nextValueOrdinal++
  const state = `gea_delegation_${ordinal}`
  const value = `gea_delegated_${ordinal}`
  const going = `gea_delegating_${ordinal}`
  const mode = `gea_resumed_${ordinal}`
  const received = `gea_received_${ordinal}`
  const resumption = 'gea::runtime::iterator::Resumption'
  const yielded = converted(ctx, 'emit-yield-delegate:element', boxed, cursor.element, value, 'yielded value')
  const resumed = isValueless(cursor.resume)
    ? null
    : converted(ctx, 'emit-yield-delegate:resume', cursor.resume, boxed, `(co_yield ${yielded})`, 'resume value')
  const signal = isValueless(cursor.completion)
    ? { caught: `const ${cursorType}::ReturnSignal&`, value: 'gea::Value()', rethrow: `throw ${cursorType}::ReturnSignal{};` }
    : {
        caught: `const ${cursorType}::ReturnSignal& gea_signal_${ordinal}`,
        value: converted(ctx, 'emit-yield-delegate:return-in', cursor.completion, boxed, `gea_signal_${ordinal}.value`, 'return value'),
        rethrow: `throw ${cursorType}::ReturnSignal{${converted(ctx, 'emit-yield-delegate:return-out', boxed, cursor.completion, value, 'return value')}};`
      }
  lines.push(
    '{',
    `auto ${state} = gea::runtime::iterator::delegate(${operandText(ctx, operand)}, ${operation.delegate === 'async'});`,
    `gea::Value ${value};`,
    `bool ${going} = gea::runtime::iterator::delegateStep(${state}, ${resumption}::Next, gea::Value(), ${value});`,
    `while (${going}) {`,
    `${resumption} ${mode} = ${resumption}::Next;`,
    `gea::Value ${received};`,
    'try {',
    resumed === null ? `(co_yield ${yielded});` : `${received} = ${resumed};`,
    `} catch (${signal.caught}) {`,
    `${mode} = ${resumption}::Return;`,
    `${received} = ${signal.value};`,
    `} catch (const gea::Value& gea_thrown_${ordinal}) {`,
    `${mode} = ${resumption}::Throw;`,
    `${received} = gea_thrown_${ordinal};`,
    '}',
    `${going} = gea::runtime::iterator::delegateStep(${state}, ${mode}, ${received}, ${value});`,
    `if (!${going} && ${mode} == ${resumption}::Return) ${signal.rethrow}`,
    '}'
  )
  if (operation.result !== null) {
    lines.push(
      `${defineValue(ctx, operation.result)} = ${converted(ctx, 'emit-yield-delegate:result', boxed, operation.result.representation, value, 'result')};`
    )
  }
  lines.push('}')
}
