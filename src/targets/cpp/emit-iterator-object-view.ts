import type { Representation } from '../../representation/model.js'
import type { RecordLayoutPolicy } from '../../representation/policies.js'
import type { CertifiedIteratorObjectViewPlan } from '../../conversion/certified-iterator-object-view.js'
import { iteratorObjectViewPlan, type IteratorObjectViewPlan, type IteratorResultArm } from '../../conversion/iterator-object-view.js'
import { chainConverts, namedConversionText, type ConversionSite } from './emit-narrowing.js'
import { structuralConversionKey } from '../../conversion/structural-plan.js'
import { viewPlanFor } from './emit-record-view.js'
import { memberAccessOperator } from './emit-carrier-members.js'
import {
  cppAbiParameterType,
  cppRecordFieldName,
  cppRecordFieldPresenceName,
  cppRecordStructName,
  cppResultTypeOf,
  cppTypeOf,
  cppUndefinedValue
} from './types.js'

/** The materializer id `conversions.ts` installs a cursor's object view under, and `recipeText` renders. */
export const ITERATOR_OBJECT_VIEW = 'gea::Iterator::objectView'

const planConverts = (layouts: RecordLayoutPolicy) => (source: Representation, target: Representation) =>
  chainConverts(source, target) || viewPlanFor(layouts, source, target) !== null

/** `conversion/iterator-object-view.ts`'s plan over the pairs this backend renders. */
export const iteratorObjectViewPlanFor = (
  layouts: RecordLayoutPolicy,
  source: Representation,
  target: Representation
): IteratorObjectViewPlan | null => iteratorObjectViewPlan(layouts, source, target, planConverts(layouts))

const cursorName = 'gea_view_cursor'

const leafText = (
  ctx: ConversionSite,
  plan: CertifiedIteratorObjectViewPlan,
  source: Representation,
  target: Representation,
  text: string
): string | null => {
  const key = structuralConversionKey(source, target)
  const node = plan.leaves.get(key)
  if (node === undefined) throw new Error(`iterator object view has no certified leaf for ${key}`)
  return namedConversionText(ctx, 'emit-iterator-object-view.ts:certified-leaf', node, text)
}

/** One `IteratorResult` arm built fresh, its `done` and `value` written from the step. */
const resultArmText = (
  ctx: ConversionSite,
  plan: CertifiedIteratorObjectViewPlan,
  result: Representation,
  arm: IteratorResultArm,
  done: boolean,
  value: { readonly source: Representation; readonly text: string }
): string | null => {
  const record = arm.record.record
  if (record.kind !== 'record' && record.kind !== 'native-record-ref') return null
  if (record.ownership === 'borrowed') return null
  const accessor = memberAccessOperator(record.ownership)
  const doneText = leafText(ctx, plan, { kind: 'scalar', domain: 'boolean' }, arm.record.done.value, done ? 'true' : 'false')
  const valueText = leafText(ctx, plan, value.source, arm.record.value.value, value.text)
  if (doneText === null || valueText === null) return null
  const store = (key: string, required: boolean, text: string): string =>
    `gea_result${accessor}${cppRecordFieldName(key)} = ${text}; ` +
    (required ? '' : `gea_result${accessor}${cppRecordFieldPresenceName(key)} = true; `)
  const construction = record.ownership === 'owned' ? `${cppTypeOf(record)}{}` : `gea::makeRef<${cppRecordStructName(record.shapeId)}>()`
  const built = `auto gea_result = ${construction}; ${store('done', arm.record.done.required, doneText)}${store('value', arm.record.value.required, valueText)}`
  const wrapped = arm.index === null ? 'gea_result' : `${cppTypeOf(result)}::ofArm<${arm.index}>(gea_result)`
  return `${built}return ${wrapped};`
}

/**
 * The object view of a native cursor (`conversion/iterator-object-view.ts`):
 * a fresh record whose `next` closes over ONE shared cursor, so every copy of
 * the record advances the same walk, and whose `[Symbol.iterator]` answers
 * its own receiver.
 */
export const iteratorObjectViewText = (
  ctx: ConversionSite,
  source: Representation,
  target: Representation,
  text: string
): string | null => {
  const node = ctx.conversions.nodeById(structuralConversionKey(source, target))
  const materializer = node?.capability.kind === 'atom' || node?.capability.kind === 'static' ? node.capability.materializer : null
  return materializer?.iteratorObjectView === undefined ? null : certifiedIteratorObjectViewText(ctx, materializer.iteratorObjectView, text)
}

export const certifiedIteratorObjectViewText = (
  ctx: ConversionSite,
  certified: CertifiedIteratorObjectViewPlan,
  text: string
): string | null => {
  const plan = certified.view
  const cursorType = cppTypeOf(plan.source)
  const holderType = `gea::Ref<${cursorType}>`
  const structName = cppRecordStructName(plan.target.shapeId)
  const stores: string[] = []
  for (const planned of plan.fields) {
    const { field } = planned
    if (planned.kind === 'absent') continue
    const member = cppTypeOf(field.value.kind === 'optional' ? field.value.payload : field.value)
    const { abi } = planned
    const formals = [
      ...(abi.receiver === null ? [] : [`${cppTypeOf(abi.receiver)} gea_view_this`]),
      ...abi.parameters.map((parameter, ordinal) => `${cppAbiParameterType(parameter)} gea_view_arg_${ordinal}`)
    ]
    const signature = `void* gea_view_env${formals.length > 0 ? ', ' : ''}${formals.join(', ')}`
    const resultType = cppResultTypeOf(abi.result)
    let callable: string
    if (planned.kind === 'self') {
      const recordType = cppTypeOf(plan.target)
      // With no receiver the member holds the record it is stored in: a cycle
      // through the environment block, which the collector traces
      // (`HeapEnvironmentBlock`'s `geaTraceRefs`).
      const held = abi.receiver !== null ? null : `*gea::unpackEnvironment<${recordType}>(gea_view_env, gea_view_slot)`
      const self = leafText(ctx, certified, plan.target, abi.result, held ?? 'gea_view_this')
      if (self === null) return null
      const ignored = abi.parameters.map((_, ordinal) => `(void)gea_view_arg_${ordinal}; `).join('')
      callable =
        held === null
          ? `${member}(+[](${signature}) -> ${resultType} { (void)gea_view_env; ${ignored}return ${self}; }, nullptr)`
          : `${member}(+[](${signature}) -> ${resultType} { ${ignored}alignas(void*) unsigned char gea_view_slot[sizeof(void*)]; ` +
            `return ${self}; }, gea::packEnvironment<${recordType}>(gea_view))`
    } else {
      // A cursor with no completion value completes with `undefined`.
      const valueless = plan.source.completion.kind === 'void' || plan.source.completion.kind === 'undefined'
      const completion = valueless
        ? { source: { kind: 'undefined' } as Representation, text: cppUndefinedValue }
        : { source: plan.source.completion, text: `${cursorName}.takeCompletionValue()` }
      const generator = plan.source.kind === 'async-generator'
      const returned = resultArmText(
        ctx,
        certified,
        planned.settled,
        planned.returnArm,
        true,
        generator && !valueless ? { source: plan.source.completion, text: 'gea_step.completion' } : completion
      )
      const yielded = resultArmText(ctx, certified, planned.settled, planned.yieldArm, false, {
        source: plan.source.element,
        text: generator ? 'gea_step.value' : 'gea_next'
      })
      if (returned === null || yielded === null) return null
      const ignored = abi.parameters.map((_, ordinal) => `(void)gea_view_arg_${ordinal}; `).join('')
      const receiverIgnored = abi.receiver === null ? '' : '(void)gea_view_this; '
      const settledType = cppTypeOf(planned.settled)
      let body: string
      if (generator) {
        // The generator's own step promise, mapped onto the record: nothing
        // waits here, the caller's `for await` suspends on it.
        body =
          `return ${cursorName}.next().then([](const ${cursorType}::Result& gea_step) -> ${settledType} { ` +
          `if (gea_step.done) { ${returned} } ${yielded} });`
      } else {
        const step = `auto gea_next = ${cursorName}.arrayNext(); (void)gea_next; if (${cursorName}.done()) { ${returned} } ${yielded}`
        // An async iterator's `next` answers the same record settled, and a
        // step that throws is that promise's rejection (ECMA-262 27.6.3.3), as
        // `prototype/emit-prototype-iterator.ts` answers a generator's own call.
        body = planned.awaited
          ? `try { return ${resultType}(([&]() -> ${settledType} { ${step} }())); } ` +
            `catch (...) { return ${resultType}::rejected_with(std::current_exception()); }`
          : step
      }
      callable =
        `${member}(+[](${signature}) -> ${resultType} { ${receiverIgnored}${ignored}` +
        `alignas(void*) unsigned char gea_view_slot[sizeof(void*)]; ` +
        `${cursorType}& ${cursorName} = **gea::unpackEnvironment<${holderType}>(gea_view_env, gea_view_slot); ` +
        `${body} }, gea::packEnvironment<${holderType}>(gea_view_holder))`
    }
    stores.push(`gea_view->${cppRecordFieldName(field.key)} = ${callable};`)
    if (!field.required) stores.push(`gea_view->${cppRecordFieldPresenceName(field.key)} = true;`)
  }
  const built =
    `([&]() -> ${cppTypeOf(plan.target)} { ${holderType} gea_view_holder = gea::makeRef<${cursorType}>(${text}); ` +
    `auto gea_view = gea::makeRef<${structName}>(); ${stores.join(' ')} return gea_view; }())`
  return certified.target.kind === 'optional' ? `${cppTypeOf(certified.target)}(${built})` : built
}
