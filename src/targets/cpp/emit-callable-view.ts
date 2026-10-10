import type { CallablePayloadPlan, CallableViewPlan } from '../../conversion/structural-plan.js'
import { abiOfCallee } from '../../projection/callee.js'
import { namedConversionText, recipeText, type ConversionSite } from './emit-narrowing.js'
import { abiKey, representationKey } from '../../representation/model.js'
import { nativeCallReceiverText } from './emit-native-method.js'
import { cppThunkName } from './emit-context.js'
import {
  cppAbiParameterType,
  cppCallableFrameArguments,
  cppRecordFieldName,
  cppRecordFieldPresenceName,
  cppResultTypeOf,
  cppTypeOf,
  cppUndefinedValue
} from './types.js'

/** The certified finite frame names each adaptation; printing never searches for a structural home. */
export const callableViewText = (ctx: ConversionSite, plan: CallableViewPlan, text: string): string | null => {
  const from = abiOfCallee(plan.source)
  const to = abiOfCallee(plan.target)
  if (from === null || to === null) throw new Error('a certified callable view names no native convention')
  const environment = 'gea_adapt_environment'
  const receiver = 'gea_adapt_receiver'
  const result = 'gea_adapt_result'
  const formal = (ordinal: number): string => `gea_adapt_arg_${ordinal}`
  const formals = [
    `void* ${environment}`,
    ...(to.receiver === null ? [] : [`${cppTypeOf(to.receiver)} ${receiver}`]),
    ...to.parameters.map((parameter, ordinal) => `${cppAbiParameterType(parameter)} ${formal(ordinal)}`)
  ]
  const actuals: string[] = []
  if (plan.receiver !== null) {
    const converted = namedConversionText(ctx, 'emit-callable-view.ts:receiver', plan.receiver, receiver)
    if (converted === null) return null
    actuals.push(converted)
  }
  for (const [ordinal, conversion] of plan.parameters.entries()) {
    const converted = namedConversionText(ctx, 'emit-callable-view.ts:parameter', conversion, formal(ordinal))
    if (converted === null) return null
    actuals.push(converted)
  }
  for (const conversion of plan.omittedArguments ?? []) {
    const converted = namedConversionText(ctx, 'emit-callable-view.ts:omitted-argument', conversion, cppUndefinedValue)
    if (converted === null) return null
    actuals.push(converted)
  }
  if (plan.restPacking !== undefined) {
    const elements: string[] = []
    for (const [ordinal, conversion] of plan.restPacking.elements.entries()) {
      const converted = namedConversionText(ctx, 'emit-callable-view.ts:rest-element', conversion, formal(plan.restPacking.from + ordinal))
      if (converted === null) return null
      elements.push(converted)
    }
    actuals.push(`gea::arrayOf<${cppTypeOf(plan.restPacking.array.element)}>({${elements.join(', ')}})`)
  }
  if (plan.restUnpacking !== undefined) {
    const rest = formal(plan.restUnpacking.from)
    const slot = plan.restUnpacking.slot
    const arrow = slot.ownership === 'shared-refcount' ? '->' : '.'
    for (const [position, element] of plan.restUnpacking.elements.entries()) {
      const actualPosition = position + (plan.restUnpacking.offset ?? 0)
      const stored =
        element.field === null ? `${rest}->readElementAt(${actualPosition})` : `${rest}${arrow}${cppRecordFieldName(element.field.key)}`
      const present = namedConversionText(ctx, 'emit-callable-view.ts:rest-present', element.present, stored)
      if (present === null) return null
      if (element.absent === null) actuals.push(present)
      else {
        const absent = namedConversionText(ctx, 'emit-callable-view.ts:rest-absent', element.absent, cppUndefinedValue)
        if (absent === null) return null
        const has =
          element.field === null
            ? `(${rest}.get() != nullptr && ${rest}->hasElementValue(${actualPosition}))`
            : `${rest}${arrow}${cppRecordFieldPresenceName(element.field.key)}`
        actuals.push(`(${has} ? ${present} : ${absent})`)
      }
    }
  }
  const sourceType = cppTypeOf(plan.source)
  const sourceValue = `static_cast<${sourceType}*>(${environment})`
  const call =
    from.receiver === null && to.receiver !== null
      ? `${sourceValue}->callWithReceiver(${nativeCallReceiverText(to.receiver, receiver, (source, value) => {
          const node = plan.logicalReceiver?.materializers.find((node) => representationKey(node.source) === representationKey(source))
          return node ? recipeText(ctx, node, value) : null
        })}${actuals.length === 0 ? '' : `, ${actuals.join(', ')}`})`
      : `${sourceValue}->call(${actuals.join(', ')})`
  const logicalReceiver = 'gea_adapt_logical_receiver'
  const receiverCall = `${sourceValue}->callWithReceiver(${logicalReceiver}${actuals.length === 0 ? '' : `, ${actuals.join(', ')}`})`
  const convertedResult =
    plan.result === null
      ? null
      : namedConversionText(ctx, 'emit-callable-view.ts:result', plan.result, from.result.kind === 'void' ? 'gea::Undefined{}' : result)
  if (plan.result !== null && convertedResult === null) return null
  const bodyOf = (invocation: string): string =>
    from.result.kind === 'void'
      ? `${invocation};${convertedResult === null ? '' : ` return ${convertedResult};`}`
      : to.result.kind === 'void'
        ? `${invocation};`
        : `${cppTypeOf(from.result)} ${result} = ${invocation}; return ${convertedResult};`
  // A source the emitter saw allocated from one function whose frame IS the
  // source's: its entry is that function's thunk, so the adapter calls the
  // thunk on the source's own environment and the view needs no block to hold
  // a copy (`CallableObject::adaptSourceInPlace`). A body that never reads its
  // receiver answers a receiver-carrying call exactly as a plain one, so the
  // receiver entry would add nothing.
  const known = ctx.knownCallableEntry?.(text) ?? null
  const knownAbi = known === null ? null : ctx.abiOfCallable?.(known)
  if (
    known !== null &&
    knownAbi &&
    abiKey(knownAbi) === abiKey(from) &&
    from.receiver === null &&
    to.receiver === null &&
    !ctx.captures.readsReceiver(known)
  ) {
    const thunk = cppThunkName(known)
    const direct = `${thunk}(${[environment, ...actuals].join(', ')})`
    return (
      `${cppTypeOf(plan.target)}::adaptSourceInPlace<&${thunk}, ${cppCallableFrameArguments(to)}>(${sourceType}{${text}}, ` +
      `[](${formals.join(', ')}) -> ${cppResultTypeOf(to.result)} { ${bodyOf(direct)} })`
    )
  }
  const receiverFormals = [...formals]
  receiverFormals.splice(1, 0, `const gea::NativeCallReceiver& ${logicalReceiver}`)
  return (
    `${cppTypeOf(plan.target)}::adaptSourceWithReceiver<${cppCallableFrameArguments(to)}>(${sourceType}{${text}}, ` +
    `[](${formals.join(', ')}) -> ${cppResultTypeOf(to.result)} { ${bodyOf(call)} }, ` +
    `[](${receiverFormals.join(', ')}) -> ${cppResultTypeOf(to.result)} { ${bodyOf(receiverCall)} })`
  )
}

/** Presence is transported around the exact named native callable adaptation. */
export const callablePayloadText = (ctx: ConversionSite, plan: CallablePayloadPlan, text: string): string | null => {
  const value = plan.mode === 'wrap' ? text : 'gea_callable_payload'
  const converted = namedConversionText(ctx, 'emit-callable-view.ts:payload', plan.payload, plan.mode === 'wrap' ? value : `(*${value})`)
  if (converted === null) return null
  const target = cppTypeOf(plan.target)
  const held = (result: string): string => `([&](const ${cppTypeOf(plan.source)}& ${value}) -> ${target} { return ${result}; }(${text}))`
  if (plan.mode === 'unwrap') return held(`(${value}.has_value() ? ${converted} : gea::host::throwGetPropertyOfNullish<${target}>())`)
  if (plan.target.kind !== 'optional') throw new Error('a certified callable payload wrapper names no Optional target')
  const wrapped = `${target}{${cppTypeOf(plan.target.payload)}{${converted}}}`
  return plan.mode === 'wrap' ? wrapped : held(`(${value}.has_value() ? ${wrapped} : ${target}{})`)
}
