import { iteratorPrototypeMethods } from '../../../representation/prototype-domains.js'
export { iteratorPrototypeMethods } from '../../../representation/prototype-domains.js'
import type { CallOperation, IrOperand } from '../../../ir/model.js'
import { thrownValueCarrier } from '../../../ir/lower-exceptions.js'
import type { RecordField, Representation } from '../../../representation/model.js'
import { representationKey } from '../../../representation/model.js'
import { createCppEmitBlockedError, operandText, type EmitContext } from '../emit-context.js'
import { alignedValueText } from '../emit-narrowing.js'
import { memberAccessOperator } from '../emit-carrier-members.js'
import { recordFieldsOfShape } from '../records.js'
import { cppRecordFieldName, cppRecordFieldPresenceName, cppRecordStructName, cppTypeOf, cppUndefinedValue } from '../types.js'

/**
 * `%GeneratorPrototype%.next`/`.return`/`.throw` (ECMA-262 27.5.1.2-27.5.1.4)
 * off a generator value, which this backend carries as the cursor
 * `gea::Iterator<T, TReturn, TNext>` -- one type that is both the coroutine
 * and the iterator over it (`gea_runtime.h`'s own rationale:
 * `%GeneratorPrototype%[@@iterator]` returns `this`).
 *
 * The call is fused with its deferred `[[Get]]` exactly as a Promise method
 * is (`emit-prototype-invoke.ts`'s header), and its result is the value the
 * CHECKER typed the call with: `IteratorResult<T, TReturn>`, which is
 * `IteratorYieldResult<T> | IteratorReturnResult<TReturn>` in `lib.es2015.iterable.d.ts`
 * and derives to a tagged union of two records. Nothing here invents a
 * `{value, done}` carrier of its own -- `CreateIterResultObject` (7.4.14) is
 * rendered by constructing whichever of the two records the checker already
 * laid out and tagging the union with it, so every later `.value`/`.done`
 * read goes through the same union-member path any other two-record union
 * takes.
 *
 * Which arm is which is read off the layout rather than off the union's arm
 * order (which is the checker's type-id order, and differs from program to
 * program): the return arm is the one whose `done` is REQUIRED (declared
 * `done: true`), the yield arm the one whose `done` is optional (declared
 * `done?: false`). A result with any other shape is refused by name.
 *
 * `.return`/`.throw` are claimed ONLY for a generator-sourced cursor
 * (`carrier.source === 'generator'`, `representation/model.ts`'s `iterator`
 * kind): the four fixed-storage walks (`Array`/`Set`/`string`/`Map`) and the
 * `for`-`in` enumerator publish the identical `iterator(E)` carrier but their
 * real `%ArrayIteratorPrototype%` and siblings define neither method at all
 * (ECMA-262 27.1.2), so a `'sequence'`-sourced receiver refuses both by name
 * rather than certifying a method its real prototype does not have.
 *
 * What a `'sequence'` cursor's `next` (and a valueless generator's `next`)
 * still does not carry is refused by name too, never approximated: a
 * `next(v)`/`.return(v)`'s own value, or a completion value, that resolved to
 * no native carrier (`representation/derive.ts` collapses an unresolved/
 * dynamic `TReturn`/`TNext` to `undefined` on purpose, rather than boxing it)
 * has no storage to read or fill, and the read/call that needs one refuses
 * here instead.
 */

type RecordArm = Extract<Representation, { kind: 'record' | 'native-record-ref' }>

const isRecordArm = (representation: Representation): representation is RecordArm =>
  representation.kind === 'record' || representation.kind === 'native-record-ref'

/** The arm's own declared fields, or `null` for a host-named struct this compiler did not lay out. */
const armFieldsOf = (ctx: EmitContext, arm: RecordArm): readonly RecordField[] | null =>
  arm.kind === 'record' ? arm.fields : arm.native === null ? recordFieldsOfShape(ctx.deriver, arm.shapeId) : null

const constructionText = (arm: RecordArm): string => {
  switch (arm.ownership) {
    case 'owned':
      return `${cppTypeOf(arm)}{}`
    case 'shared-refcount':
      return `gea::makeRef<${cppRecordStructName(arm.shapeId)}>()`
    case 'borrowed':
      throw createCppEmitBlockedError(
        `physical-cpp-type:${representationKey(arm)}`,
        'an IteratorResult arm carries ownership "borrowed", and a fresh iteration result has no other frame to borrow it from'
      )
  }
}

const isValueless = (representation: Representation): boolean => representation.kind === 'void' || representation.kind === 'undefined'

/** `member = <value>;` plus the presence bit an optional field keeps beside its storage (`emitFieldInits`'s own rule). */
const fieldStoreText = (accessor: string, field: RecordField, valueText: string): string =>
  `gea_result${accessor}${cppRecordFieldName(field.key)} = ${valueText}; ` +
  (field.required ? '' : `gea_result${accessor}${cppRecordFieldPresenceName(field.key)} = true; `)

/**
 * A padded `undefined` (an omitted optional argument the lowering fills in)
 * sends nothing -- `next(undefined)` and `next()` are one `GeneratorResume`
 * (27.5.1.2 passes the value through unchanged, and the first resumption
 * discards it) -- and so is the EMPTY rest pack `next(...[value]: [] |
 * [TNext])`'s variadic convention makes `ir/lower-operands.ts`'s
 * `packRestArguments` build for a bare `next()`: withheld whole
 * (`ctx.pendingPacks`), it lists its element expressions, and none is no
 * value sent.
 */
const sendsNothing = (ctx: EmitContext, argument: IrOperand): boolean =>
  argument.representation.kind === 'undefined' ||
  argument.representation.kind === 'void' ||
  (argument.representation.kind === 'array-object' && ctx.pendingPacks.get(argument.value)?.elements.length === 0)

/** How one settled step reads its three facts, whichever carrier produced it. */
interface StepReads {
  readonly done: string
  readonly value: string
  readonly completion: string
}

/** The two channels a step's record is built from: what a yield carries, and what completion carries. */
interface StepChannels {
  readonly element: Representation
  readonly completion: Representation
}

/**
 * Builds `IteratorYieldResult<T> | IteratorReturnResult<TReturn>` from
 * whichever `stepText` expression already advanced (or injected an abrupt
 * completion into) the cursor -- shared by `next`, `return` and `throw`,
 * which differ only in how they got the frame moving, never in how the
 * record that comes back is read off it.
 */
const iteratorResultText = (
  ctx: EmitContext,
  receiverText: string,
  carrier: Extract<Representation, { kind: 'iterator' }>,
  result: NonNullable<CallOperation['result']>,
  stepText: string
): string => {
  // An async generator's `next`/`return`/`throw` answers a PROMISE of the
  // record (ECMA-262 27.6.1): the same record, settled, and a step that throws
  // -- `throw(e)` the body does not catch, or a hand-written iterator's own
  // rejected `next()` -- is that promise's rejection rather than a synchronous
  // throw. `this.events?.throw(error).then(undefined, ignoreError)`.
  if (result.representation.kind === 'promise' && result.representation.value.kind === 'tagged-union') {
    const promiseType = cppTypeOf(result.representation)
    const settled = iteratorResultText(ctx, receiverText, carrier, { ...result, representation: result.representation.value }, stepText)
    return (
      `([&]() -> ${promiseType} { try { return ${promiseType}(${settled}); } ` +
      `catch (...) { return ${promiseType}::rejected_with(std::current_exception()); } }())`
    )
  }
  const union = iteratorResultUnionOf(carrier, result.representation)
  const arms = iteratorResultArmsText(ctx, carrier, union, {
    done: `${receiverText}.done()`,
    value: 'gea_next',
    completion: `${receiverText}.takeCompletionValue()`
  })
  return `([&]() -> ${cppTypeOf(union)} { auto gea_next = ${stepText}; (void)gea_next; ${arms} })()`
}

const iteratorResultUnionOf = (
  carrier: Extract<Representation, { kind: 'iterator' | 'async-generator' }>,
  result: Representation
): Extract<Representation, { kind: 'tagged-union' }> => {
  if (result.kind !== 'tagged-union') {
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:result:${representationKey(carrier)}`,
      `publishes "${representationKey(result)}", but ` +
        'IteratorResult<T, TReturn> is a union of two records and this file renders exactly that'
    )
  }
  return result
}

/**
 * The statements that build `IteratorYieldResult<T> | IteratorReturnResult<TReturn>`
 * from one step's three reads and return it -- shared by the synchronous
 * cursor, whose reads are `done()`/the stepped value/`takeCompletionValue()`,
 * and an async generator, whose settled `AsyncIteratorResult` carries all
 * three as fields.
 */
const iteratorResultArmsText = (
  ctx: EmitContext,
  carrier: StepChannels & Representation,
  union: Extract<Representation, { kind: 'tagged-union' }>,
  reads: StepReads
): string => {
  const arms = union.arms.map((arm, index) => {
    const value = arm.value
    if (!isRecordArm(value)) return null
    const fields = armFieldsOf(ctx, value)
    const done = fields?.find((field) => field.key === 'done')
    if (fields === null || done === undefined) return null
    return { index, value, done, valueField: fields.find((field) => field.key === 'value') ?? null }
  })
  const returnArm = arms.find((arm) => arm !== null && arm.done.required) ?? null
  const yieldArm = arms.find((arm) => arm !== null && !arm.done.required) ?? null
  if (union.arms.length !== 2 || returnArm === null || yieldArm === null) {
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:result:${representationKey(carrier)}`,
      `publishes "${representationKey(union)}", which is not IteratorYieldResult<T> | IteratorReturnResult<TReturn> ` +
        '(two records, told apart by a required `done: true` against an optional `done?: false`)'
    )
  }
  // The return arm's `value` field is the generator's COMPLETION value,
  // read off the cursor's own completion slot -- never off whatever was
  // passed to `next`/`return`, because a `finally` block that runs during an
  // abrupt completion can override it with its own `return` (ECMA-262
  // 27.5.3.3's own note), and `promise_type::completion_value` is exactly the
  // slot both roads write through (`gea_runtime.h`).
  const completionText =
    returnArm.valueField === null || isValueless(returnArm.valueField.value)
      ? null
      : (() => {
          // A valueless completion channel completes with `undefined`, which
          // a field that can hold it -- `IteratorResult<T, any>`'s `value:
          // any` -- is written as. Only a field that cannot is a refusal.
          const absent = isValueless(carrier.completion)
            ? alignedValueText(
                ctx,
                'prototype/emit-prototype-iterator.ts:absent-completion',
                { kind: 'undefined' },
                returnArm.valueField!.value,
                cppUndefinedValue
              )
            : null
          if (absent !== null) return absent
          if (isValueless(carrier.completion)) {
            throw createCppEmitBlockedError(
              `conversion:${representationKey(carrier.completion)}->${representationKey(returnArm.valueField!.value)}`,
              `a generator's completion value is carried as "${representationKey(returnArm.valueField!.value)}", and this generator's own ` +
                'completion channel is "undefined" -- either TReturn never resolved to a native carrier, or this generator is not ' +
                'annotated as one -- so the cursor has no storage to read one back from'
            )
          }
          const text = alignedValueText(
            ctx,
            'prototype/emit-prototype-iterator.ts:155',
            carrier.completion,
            returnArm.valueField!.value,
            reads.completion
          )
          if (text === null) {
            throw createCppEmitBlockedError(
              `conversion:${representationKey(carrier.completion)}->${representationKey(returnArm.valueField!.value)}`,
              `the cursor completes with "${representationKey(carrier.completion)}" while the IteratorResult "value" field carries ` +
                `"${representationKey(returnArm.valueField!.value)}", and no installed conversion reconciles them`
            )
          }
          return text
        })()
  const trueText = alignedValueText(
    ctx,
    'prototype/emit-prototype-iterator.ts:165',
    { kind: 'scalar', domain: 'boolean' },
    returnArm.done.value,
    'true'
  )
  const falseText = alignedValueText(
    ctx,
    'prototype/emit-prototype-iterator.ts:166',
    { kind: 'scalar', domain: 'boolean' },
    yieldArm.done.value,
    'false'
  )
  if (trueText === null || falseText === null) {
    throw createCppEmitBlockedError(
      `conversion:scalar(boolean)->${representationKey((trueText === null ? returnArm : yieldArm).done.value)}`,
      `an IteratorResult "done" field carries "${representationKey((trueText === null ? returnArm : yieldArm).done.value)}", ` +
        'and no installed conversion writes a boolean into it'
    )
  }
  const yieldValueText =
    yieldArm.valueField === null || isValueless(yieldArm.valueField.value)
      ? null
      : alignedValueText(ctx, 'prototype/emit-prototype-iterator.ts:177', carrier.element, yieldArm.valueField.value, reads.value)
  if (yieldArm.valueField !== null && !isValueless(yieldArm.valueField.value) && yieldValueText === null) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(carrier.element)}->${representationKey(yieldArm.valueField.value)}`,
      `the cursor yields "${representationKey(carrier.element)}" while the IteratorResult "value" field carries ` +
        `"${representationKey(yieldArm.valueField.value)}", and no installed conversion reconciles them`
    )
  }
  const unionType = cppTypeOf(union)
  const returnAccessor = memberAccessOperator(returnArm.value.ownership)
  const yieldAccessor = memberAccessOperator(yieldArm.value.ownership)
  const returnBranch =
    `auto gea_result = ${constructionText(returnArm.value)}; ${fieldStoreText(returnAccessor, returnArm.done, trueText)}` +
    (completionText === null || returnArm.valueField === null ? '' : fieldStoreText(returnAccessor, returnArm.valueField, completionText)) +
    `return ${unionType}::ofArm<${returnArm.index}>(gea_result);`
  const yieldBranch =
    `auto gea_result = ${constructionText(yieldArm.value)}; ${fieldStoreText(yieldAccessor, yieldArm.done, falseText)}` +
    (yieldValueText === null || yieldArm.valueField === null ? '' : fieldStoreText(yieldAccessor, yieldArm.valueField, yieldValueText)) +
    `return ${unionType}::ofArm<${yieldArm.index}>(gea_result);`
  return `if (${reads.done}) { ${returnBranch} } ${yieldBranch}`
}

/**
 * `iter.next(v)` (member already checked to be `"next"`). Builds the step
 * text -- an ordinary `arrayNext()` when nothing was sent, `resumeWith(v)`
 * once converted into the cursor's own resume carrier -- and, only when the
 * call's own result is actually read, the `IteratorResult` on top of it.
 */
const nextCallText = (
  ctx: EmitContext,
  receiverText: string,
  carrier: Extract<Representation, { kind: 'iterator' }>,
  operation: CallOperation
): string => {
  const sent = operation.arguments.filter((argument) => !sendsNothing(ctx, argument))
  const stepText =
    sent.length === 0
      ? `${receiverText}.arrayNext()`
      : (() => {
          if (isValueless(carrier.resume)) {
            throw createCppEmitBlockedError(
              `runtime-helper:protocol:next:${representationKey(carrier)}`,
              "a generator's next(v) sends a value back into the suspended yield, and this generator's own resume channel is " +
                '"undefined" -- either TNext never resolved to a native carrier, or this generator is not annotated as one -- so the ' +
                `cursor has no storage to send it through; the call carries ` +
                `${operation.arguments.map((argument) => `"${representationKey(argument.representation)}"`).join(', ')}`
            )
          }
          if (sent.length !== 1) {
            throw createCppEmitBlockedError(
              'call-abi:next',
              `next(v) sends more than one value operand (${sent.length}), which is not valid syntax to model`
            )
          }
          const argument = sent[0]!
          const text = alignedValueText(
            ctx,
            'prototype/emit-prototype-iterator.ts:235',
            argument.representation,
            carrier.resume,
            operandText(ctx, argument)
          )
          if (text === null) {
            throw createCppEmitBlockedError(
              `conversion:${representationKey(argument.representation)}->${representationKey(carrier.resume)}`,
              `sends "${representationKey(argument.representation)}" into a resume channel carried as "${representationKey(carrier.resume)}", ` +
                'and no installed conversion reconciles them'
            )
          }
          return `${receiverText}.resumeWith(${text})`
        })()
  return operation.result === null ? stepText : iteratorResultText(ctx, receiverText, carrier, operation.result, stepText)
}

/**
 * `iter.return(v)`/`iter.throw(e)`, claimed only for `carrier.source ===
 * 'generator'` -- see this file's own header comment for why. Both read back
 * through the identical `IteratorResult` construction `next` uses: ECMA-262
 * 27.5.3.3/27.5.3.4 both resume the frame like an ordinary step, they just
 * inject an ABRUPT completion at the paused `yield` instead of a normal one
 * (`gea_runtime.h`'s `resumeReturn`/`resumeThrow`), and a `finally` in scope
 * can still turn either into an ordinary yield (`{value, done: false}`) --
 * exactly the shape `iteratorResultText` already renders generically.
 */
const abruptCallText = (
  ctx: EmitContext,
  member: 'return' | 'throw',
  receiverText: string,
  carrier: Extract<Representation, { kind: 'iterator' }>,
  operation: CallOperation
): string => {
  if (carrier.source !== 'generator') {
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:${member}:${representationKey(carrier)}`,
      `"${member}" was recorded as a deferred %GeneratorPrototype% read over a "${carrier.source}"-sourced cursor -- only a real ` +
        `generator's iterator has a %GeneratorPrototype%.${member}; the four fixed-storage walks and the \`for\`-in enumerator do not`
    )
  }
  const argument = operation.arguments[0]
  if (member === 'throw') {
    if (!argument) {
      throw createCppEmitBlockedError('call-abi:throw', 'throw(e) carries no argument to inject as the abrupt completion')
    }
    // The coroutine body's own `catch` clauses match by C++ type, and every
    // `catch (e)` this backend can ever emit binds `e` as `thrownValueCarrier`
    // -- see `lower.ts`'s ordinary `throw` terminator, which converts into the
    // identical carrier before its own native `throw` for the identical
    // reason. Injecting the raw, unboxed argument here throws a type no
    // `catch` inside the generator was ever written to match, so ECMA-262's
    // "the generator catches its own injected exception" silently became "the
    // exception escapes the coroutine and the process aborts".
    const text = alignedValueText(
      ctx,
      'prototype/emit-prototype-iterator.ts:285',
      argument.representation,
      thrownValueCarrier,
      operandText(ctx, argument)
    )
    if (text === null) {
      throw createCppEmitBlockedError(
        `conversion:${representationKey(argument.representation)}->${representationKey(thrownValueCarrier)}`,
        `throw(e) sends "${representationKey(argument.representation)}" into the thrown-value carrier, and no installed conversion reconciles them`
      )
    }
    return `${receiverText}.resumeThrow(std::make_exception_ptr(${text}))`
  }
  // `return(v)`'s completion value is whatever this call site passed, not
  // what the cursor's `completion` carrier declares elsewhere in the
  // program -- but if THIS generator's completion channel never resolved to
  // a native carrier, there is still no storage for it, and `v`'s own value
  // (as opposed to its evaluation, which still has to happen for its
  // effects) is discarded exactly as a valueless `return` terminator's own
  // operand already is (`emit-return.ts`).
  if (isValueless(carrier.completion)) {
    const discard = argument && !sendsNothing(ctx, argument) ? `(void)(${operandText(ctx, argument)}), ` : ''
    return `${discard}${receiverText}.resumeReturn({})`
  }
  if (!argument) {
    throw createCppEmitBlockedError(
      'call-abi:return',
      "return(v) carries no argument, but this generator's completion channel carries a real value"
    )
  }
  const text = alignedValueText(
    ctx,
    'prototype/emit-prototype-iterator.ts:308',
    argument.representation,
    carrier.completion,
    operandText(ctx, argument)
  )
  if (text === null) {
    throw createCppEmitBlockedError(
      `conversion:${representationKey(argument.representation)}->${representationKey(carrier.completion)}`,
      `return(v) sends "${representationKey(argument.representation)}" into a completion channel carried as "${representationKey(carrier.completion)}", ` +
        'and no installed conversion reconciles them'
    )
  }
  return `${receiverText}.resumeReturn(${text})`
}

/**
 * `%AsyncGeneratorPrototype%.next`/`.return`/`.throw` (ECMA-262 27.6.1.2-4)
 * off an `async function*`'s own `gea::AsyncGenerator`: each call enqueues a
 * request and answers the promise of its step, which is mapped onto the
 * `IteratorResult` union the checker typed the call's payload with -- the
 * same two records `iteratorResultArmsText` builds for the synchronous
 * cursor, read off the settled `AsyncIteratorResult`'s fields. A rejected
 * step stays a rejection: `then` forwards it untouched, so
 * `this.events?.throw(error).then(undefined, ignoreError)` sees it.
 */
const asyncGeneratorCallText = (
  ctx: EmitContext,
  member: 'next' | 'return' | 'throw',
  receiverText: string,
  carrier: Extract<Representation, { kind: 'async-generator' }>,
  operation: CallOperation
): string => {
  const argument = operation.arguments[0]
  const sent = argument !== undefined && !sendsNothing(ctx, argument) ? argument : null
  const channelText = (channel: Representation, what: string): string => {
    if (sent === null) return ''
    if (isValueless(channel)) {
      throw createCppEmitBlockedError(
        `runtime-helper:protocol:${member}:${representationKey(carrier)}`,
        `${what} sends a value into an async generator whose channel for it is "undefined" -- the type argument never resolved ` +
          'to a native carrier -- so there is no storage to send it through'
      )
    }
    const text = alignedValueText(
      ctx,
      `prototype/emit-prototype-iterator.ts:async-${member}`,
      sent.representation,
      channel,
      operandText(ctx, sent)
    )
    if (text === null) {
      throw createCppEmitBlockedError(
        `conversion:${representationKey(sent.representation)}->${representationKey(channel)}`,
        `${what} sends "${representationKey(sent.representation)}" into a channel carried as "${representationKey(channel)}", ` +
          'and no installed conversion reconciles them'
      )
    }
    return text
  }
  const stepText = (() => {
    switch (member) {
      case 'next':
        return `${receiverText}.next(${channelText(carrier.resume, 'next(v)')})`
      case 'return':
        return `${receiverText}.return_(${channelText(carrier.completion, 'return(v)')})`
      case 'throw': {
        if (!argument) throw createCppEmitBlockedError('call-abi:throw', 'throw(e) carries no argument to inject as the abrupt completion')
        // Thrown as the carrier every `catch` inside the body binds, for the
        // reason the synchronous generator's `throw(e)` below gives.
        const text = alignedValueText(
          ctx,
          'prototype/emit-prototype-iterator.ts:async-throw',
          argument.representation,
          thrownValueCarrier,
          operandText(ctx, argument)
        )
        if (text === null) {
          throw createCppEmitBlockedError(
            `conversion:${representationKey(argument.representation)}->${representationKey(thrownValueCarrier)}`,
            `throw(e) sends "${representationKey(argument.representation)}" into the thrown-value carrier, and no installed conversion reconciles them`
          )
        }
        return `${receiverText}.throw_(std::make_exception_ptr(${text}))`
      }
    }
  })()
  if (operation.result === null) return stepText
  const promised = operation.result.representation
  if (promised.kind !== 'promise') {
    throw createCppEmitBlockedError(
      `runtime-helper:protocol:result:${representationKey(carrier)}`,
      `publishes "${representationKey(promised)}", but an async generator's ${member}() answers a promise of its IteratorResult`
    )
  }
  const union = iteratorResultUnionOf(carrier, promised.value)
  const arms = iteratorResultArmsText(ctx, carrier, union, {
    done: 'gea_step.done',
    value: 'gea_step.value',
    completion: 'gea_step.completion'
  })
  return `(${stepText}).then([](const ${cppTypeOf(carrier)}::Result& gea_step) -> ${cppTypeOf(union)} { ${arms} })`
}

export const iteratorCallText = (
  ctx: EmitContext,
  member: string,
  receiverText: string,
  carrier: Extract<Representation, { kind: 'iterator' | 'async-generator' }> | undefined,
  operation: CallOperation
): string => {
  if (!iteratorPrototypeMethods.has(member)) {
    throw createCppEmitBlockedError(
      'property-access:iterator:get:false',
      `"${member}" was recorded as a deferred %GeneratorPrototype% read but this file renders no call for it`
    )
  }
  if (carrier === undefined) {
    throw createCppEmitBlockedError(
      `host-invocation:GeneratorPrototype.${member}`,
      `"${member}" was recorded as a deferred iterator read with no cursor carrier to render it off`
    )
  }
  if (carrier.kind === 'async-generator')
    return asyncGeneratorCallText(ctx, member as 'next' | 'return' | 'throw', receiverText, carrier, operation)
  if (member === 'next') return nextCallText(ctx, receiverText, carrier, operation)
  const stepText = abruptCallText(ctx, member as 'return' | 'throw', receiverText, carrier, operation)
  return operation.result === null ? stepText : iteratorResultText(ctx, receiverText, carrier, operation.result, stepText)
}
