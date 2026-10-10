import type { Representation } from '../../representation/model.js'
import { representationKey, thrownValueCarrier } from '../../representation/model.js'
import type { RecordLayoutPolicy } from '../../representation/policies.js'
import {
  iteratorResultRecordsOf,
  protocolIteratorPlan,
  type ProtocolIteratorMember,
  type ProtocolIteratorPlan
} from '../../conversion/protocol-iterator.js'
import { namedConversionText, chainConverts, type ConversionSite } from './emit-narrowing.js'
import { nativeCallReceiverText } from './emit-native-method.js'
import { structuralConversionKey } from '../../conversion/structural-plan.js'
import type { CertifiedProtocolIteratorPlan } from '../../conversion/certified-iterator-protocols.js'
import { viewPlanFor } from './emit-record-view.js'
import { memberAccessOperator } from './emit-carrier-members.js'
import { paddedArguments } from './emit-context.js'
import { booleanTestText } from './emit-presence.js'
import { unionPropertyLeaves } from './emit-union-properties.js'
import { cppRecordFieldName, cppRecordFieldPresenceName, cppStringLiteral, cppTypeOf } from './types.js'
import { nativeFieldPolicyType } from './records.js'

/** The materializer id `conversions.ts` installs a protocol-object cursor under, and `recipeText` renders. */
export const PROTOCOL_ITERATOR = 'gea::Iterator::protocol'

const planConverts = (layouts: RecordLayoutPolicy) => (source: Representation, target: Representation) =>
  chainConverts(source, target) || viewPlanFor(layouts, source, target) !== null

/** `conversion/protocol-iterator.ts`'s plan over the pairs this backend renders: the chain's own, or a structural record view. */
export const protocolIteratorPlanFor = (
  layouts: RecordLayoutPolicy,
  source: Representation,
  target: Representation
): ProtocolIteratorPlan | null => protocolIteratorPlan(layouts, source, target, planConverts(layouts))

const holder = 'gea_protocol_holder'

interface ProtocolIteratorSite extends ConversionSite {
  readonly protocolRecipe: CertifiedProtocolIteratorPlan
}

const protocolLeafText = (
  ctx: ConversionSite,
  site: string,
  source: Representation,
  target: Representation,
  text: string
): string | null => {
  const key = structuralConversionKey(source, target)
  const node = (ctx as ProtocolIteratorSite).protocolRecipe.leaves.get(key)
  if (node === undefined) throw new Error(`protocol iterator has no certified conversion for ${key}`)
  return namedConversionText(ctx, site, node, text)
}

/** Whether an optional member is there when the step runs: its presence bit, then its payload. */
const presenceText = (plan: ProtocolIteratorPlan, member: ProtocolIteratorMember): string | null => {
  const access = memberAccessOperator(plan.source.ownership)
  const tests = [
    ...(member.presence.flag ? [`${holder}${access}${cppRecordFieldPresenceName(member.key)}`] : []),
    ...(member.presence.payload ? [`${holder}${access}${cppRecordFieldName(member.key)}.has_value()`] : [])
  ]
  return tests.length === 0 ? null : tests.join(' && ')
}
const result = 'gea_protocol_result'
const out = 'gea_protocol_out'
const completion = 'gea_protocol_completion'

/** One call of the object's own member, with the object as its receiver and the result awaited when it is a promise. */
const memberCallText = (ctx: ConversionSite, plan: ProtocolIteratorPlan, member: ProtocolIteratorMember, leading: readonly string[]) => {
  const receiver =
    member.abi.receiver === null
      ? []
      : [protocolLeafText(ctx, 'emit-protocol-iterator.ts:receiver', plan.source, member.abi.receiver, holder)]
  if (receiver.some((text) => text === null)) return null
  const args = paddedArguments(member.abi, [...(receiver as string[]), ...leading], `protocol iterator ${member.key}()`)
  const stored = `${holder}${memberAccessOperator(plan.source.ownership)}${cppRecordFieldName(member.key)}`
  const logical = nativeCallReceiverText(plan.source, holder)
  return `${member.presence.payload ? `(*${stored})` : stored}.callWithReceiver(${logical}${args.length === 0 ? '' : `, ${args.join(', ')}`})`
}

/**
 * IteratorComplete/IteratorValue over whichever arm the member answered:
 * `true` with the yielded value written to the step's element, or `false`
 * with the done value written to the completion.
 */
const stepResultText = (ctx: ConversionSite, plan: ProtocolIteratorPlan, member: ProtocolIteratorMember): string | null => {
  const records = iteratorResultRecordsOf(ctx.layouts, member.result)
  if (records === null) return null
  const leaves = unionPropertyLeaves(member.result, result)
  const valueless = plan.target.completion.kind === 'void' || plan.target.completion.kind === 'undefined'
  const texts: string[] = []
  for (const leaf of leaves) {
    const arm = records.find((candidate) => representationKey(candidate.record) === representationKey(leaf.representation))
    if (arm === undefined || (arm.record.kind !== 'record' && arm.record.kind !== 'native-record-ref')) return null
    const shared = arm.record.ownership === 'shared-refcount'
    const read = `${leaf.text}${memberAccessOperator(arm.record.ownership)}`
    // A shared result arm may be a live view whose struct slots are inert:
    // its declared fields are read through the view's own route.
    const field = (key: 'done' | 'value', value: Representation): string =>
      shared
        ? `gea::record::readDeclaredField<${cppTypeOf(value)}, ${nativeFieldPolicyType(value)}>(${leaf.text}, ` +
          `${cppStringLiteral(key)}, [&]() -> ${cppTypeOf(value)} { return ${read}${cppRecordFieldName(key)}; })`
        : `${read}${cppRecordFieldName(key)}`
    const done = booleanTestText(field('done', arm.done.value), arm.done.value)
    const valueText = field('value', arm.value.value)
    let yielded = 'false'
    if (arm.yields) {
      const element = protocolLeafText(ctx, 'emit-protocol-iterator.ts:element', arm.value.value, plan.target.element, valueText)
      if (element === null) return null
      yielded = `(${out} = ${element}, true)`
    }
    let returned = 'false'
    if (arm.returns && !valueless) {
      const value = protocolLeafText(ctx, 'emit-protocol-iterator.ts:completion', arm.value.value, plan.target.completion, valueText)
      if (value === null) return null
      returned = `(${completion} = ${value}, false)`
    }
    texts.push(
      arm.yields && arm.returns ? `(${done} ? ${returned} : ${yielded})` : arm.yields ? `(${done} ? false : ${yielded})` : returned
    )
  }
  if (texts.length !== leaves.length || texts.length === 0) return null
  let dispatched = texts[texts.length - 1]!
  for (let index = texts.length - 2; index >= 0; index -= 1) dispatched = `(${leaves[index]!.test} ? ${texts[index]} : ${dispatched})`
  return dispatched
}

/**
 * The cursor view of a hand-written iterator object (`conversion/protocol-
 * iterator.ts`): `Iterator::ProtocolSteps` closures over one retained
 * reference to the object, each calling its own member.
 */
export const protocolIteratorText = (ctx: ConversionSite, source: Representation, target: Representation, text: string): string | null => {
  const node = ctx.conversions.nodeById(structuralConversionKey(source, target))
  const materializer = node?.capability.kind === 'atom' || node?.capability.kind === 'static' ? node.capability.materializer : null
  return materializer?.protocolIterator === undefined ? null : certifiedProtocolIteratorText(ctx, materializer.protocolIterator, text)
}

export const certifiedProtocolIteratorText = (
  ctx: ConversionSite,
  certified: CertifiedProtocolIteratorPlan,
  text: string
): string | null => {
  ctx = { ...ctx, protocolRecipe: certified } as ProtocolIteratorSite
  const plan = certified.view
  const wrap = (text: string): string => (certified.target.kind === 'optional' ? `${cppTypeOf(certified.target)}(${text})` : text)
  if (plan.target.kind === 'async-generator') {
    const built = asyncProtocolText(ctx, plan, text)
    return built === null ? null : wrap(built)
  }
  const cursor = cppTypeOf(plan.target)
  const element = cppTypeOf(plan.target.element)
  const storage = `${cursor}::ReturnStorage`
  const holderType = cppTypeOf(plan.source)

  const nextCall = memberCallText(ctx, plan, plan.next, [])
  const nextStep = stepResultText(ctx, plan, plan.next)
  if (nextCall === null || nextStep === null) return null
  const steps = [
    `gea_protocol_steps->next = [${holder}](${element}& ${out}, ${storage}& ${completion}) -> bool { ` +
      `auto ${result} = ${nextCall}; (void)${completion}; return ${nextStep}; };`
  ]
  if (plan.finish !== null) {
    const finishCall = memberCallText(ctx, plan, plan.finish, [])
    if (finishCall === null) return null
    const present = presenceText(plan, plan.finish)
    steps.push(
      `gea_protocol_steps->finish = [${holder}]() { ${present === null ? '' : `if (!(${present})) return; `}(void)(${finishCall}); };`
    )
  }
  if (plan.raise !== null) {
    const parameter = plan.raise.abi.parameters[0]
    if (parameter === undefined) return null
    const thrownType = cppTypeOf(thrownValueCarrier)
    const argument = protocolLeafText(ctx, 'emit-protocol-iterator.ts:thrown', thrownValueCarrier, parameter.value, 'gea_protocol_error')
    const raiseCall = argument === null ? null : memberCallText(ctx, plan, plan.raise, [argument])
    const raiseStep = stepResultText(ctx, plan, plan.raise)
    if (raiseCall === null || raiseStep === null) return null
    // Only a program value reaches `throw(e)`: a native exception that is not
    // the thrown-value carrier propagates exactly as it would past any other
    // JavaScript frame. An optional `throw` absent at the step answers as a
    // missing one does (`Iterator::resumeThrow`): the exception propagates.
    const present = presenceText(plan, plan.raise)
    steps.push(
      `gea_protocol_steps->raise = [${holder}](std::exception_ptr gea_protocol_thrown, ${element}& ${out}, ${storage}& ${completion}) -> bool { ` +
        (present === null ? '' : `if (!(${present})) std::rethrow_exception(gea_protocol_thrown); `) +
        `${thrownType} gea_protocol_error; ` +
        `try { std::rethrow_exception(gea_protocol_thrown); } catch (const ${thrownType}& gea_protocol_caught) { gea_protocol_error = gea_protocol_caught; } ` +
        `auto ${result} = ${raiseCall}; (void)${completion}; return ${raiseStep}; };`
    )
  }
  return wrap(
    `([&]() -> ${cursor} { ${holderType} ${holder} = ${text}; ` +
      `auto gea_protocol_steps = gea::makeRef<${cursor}::ProtocolSteps>(); ${steps.join(' ')} ` +
      `return ${cursor}(gea_protocol_steps); }())`
  )
}

/**
 * The async-generator view of a hand-written async iterator object (an
 * event-stream `onData` iterator): `AsyncGenerator::ProtocolSteps` closures that hand the member's
 * own promise back, mapped onto the generator's step. Nothing here waits --
 * the `for await` that drives the view suspends on the promise, so the object's
 * `next()` can settle from the event queue that pump is serving.
 */
const asyncProtocolText = (ctx: ConversionSite, plan: ProtocolIteratorPlan, text: string): string | null => {
  const cursor = cppTypeOf(plan.target)
  const step = `${cursor}::Result`
  const holderType = cppTypeOf(plan.source)
  // A member answering a plain `IteratorResult` rather than a promise settles
  // at once; either way the step is the member's answer, mapped.
  const mapped = (member: ProtocolIteratorMember, call: string, stepText: string): string => {
    const mapper =
      `[](const ${cppTypeOf(member.result)}& ${result}) -> ${step} { ${step} gea_protocol_step; ` +
      `auto& ${out} = gea_protocol_step.value; auto& ${completion} = gea_protocol_step.completion; (void)${out}; (void)${completion}; ` +
      `gea_protocol_step.done = !(${stepText}); return gea_protocol_step; }`
    return member.awaited ? `gea::mapSettledPromise<${step}>(${call}, ${mapper})` : `gea::Promise<${step}>((${mapper})(${call}))`
  }
  const doneStep = (value: string) => `${step} gea_protocol_done; gea_protocol_done.done = true; gea_protocol_done.completion = ${value};`

  const nextCall = memberCallText(ctx, plan, plan.next, [])
  const nextStep = stepResultText(ctx, plan, plan.next)
  if (nextCall === null || nextStep === null) return null
  const steps = [`gea_protocol_steps->next = [&${holder}]() -> gea::Promise<${step}> { return ${mapped(plan.next, nextCall, nextStep)}; };`]
  if (plan.finish !== null) {
    const finishCall = memberCallText(ctx, plan, plan.finish, [])
    if (finishCall === null) return null
    const present = presenceText(plan, plan.finish)
    // AsyncIteratorClose reads only that `return()` answered an object; a
    // result whose value cannot reach the completion still closes as done.
    const finishStep = (ctx as ProtocolIteratorSite).protocolRecipe.finishStep ? stepResultText(ctx, plan, plan.finish) : 'false'
    if (finishStep === null) throw new Error('a protocol iterator return step has no renderable certified frame')
    steps.push(
      `gea_protocol_steps->finish = [&${holder}](${cursor}::ReturnStorage gea_protocol_value) -> gea::Promise<${step}> { ` +
        (present === null
          ? ''
          : `if (!(${present})) { ${doneStep('gea_protocol_value')} return gea::Promise<${step}>(gea_protocol_done); } `) +
        `(void)gea_protocol_value; return ${mapped(plan.finish, finishCall, finishStep)}; };`
    )
  }
  if (plan.raise !== null) {
    const parameter = plan.raise.abi.parameters[0]
    if (parameter === undefined) return null
    const thrownType = cppTypeOf(thrownValueCarrier)
    const argument = protocolLeafText(ctx, 'emit-protocol-iterator.ts:thrown', thrownValueCarrier, parameter.value, 'gea_protocol_error')
    const raiseCall = argument === null ? null : memberCallText(ctx, plan, plan.raise, [argument])
    const raiseStep = stepResultText(ctx, plan, plan.raise)
    if (raiseCall === null || raiseStep === null) return null
    // As the synchronous view: only a program value reaches `throw(e)`; any
    // other exception, or an optional `throw` absent at the step, rejects.
    const present = presenceText(plan, plan.raise)
    const rejected = `{ gea::Promise<${step}> gea_protocol_rejected; gea_protocol_rejected.reject(gea_protocol_thrown); return gea_protocol_rejected; }`
    steps.push(
      `gea_protocol_steps->raise = [&${holder}](std::exception_ptr gea_protocol_thrown) -> gea::Promise<${step}> { ` +
        (present === null ? '' : `if (!(${present})) ${rejected} `) +
        `${thrownType} gea_protocol_error; ` +
        `try { std::rethrow_exception(gea_protocol_thrown); } catch (const ${thrownType}& gea_protocol_caught) { gea_protocol_error = gea_protocol_caught; } catch (...) ${rejected} ` +
        `return ${mapped(plan.raise, raiseCall, raiseStep)}; };`
    )
  }
  return (
    `([&]() -> ${cursor} { auto gea_protocol_owner = std::make_shared<${holderType}>(${text}); ${holderType}& ${holder} = *gea_protocol_owner; ` +
    `auto gea_protocol_steps = gea::makeRef<${cursor}::ProtocolSteps>(); gea_protocol_steps->owner = gea_protocol_owner; ${steps.join(' ')} ` +
    `return ${cursor}(gea_protocol_steps); }())`
  )
}
