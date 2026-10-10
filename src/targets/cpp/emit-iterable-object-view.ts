import type { Representation } from '../../representation/model.js'
import type { RecordLayoutPolicy } from '../../representation/policies.js'
import { iterableObjectViewPlan, type IterableObjectViewPlan } from '../../conversion/iterable-object-view.js'
import type { CertifiedIterableObjectViewPlan } from '../../conversion/certified-iterator-protocols.js'
import { structuralConversionKey } from '../../conversion/structural-plan.js'
import { namedConversionText, chainConverts, type ConversionSite } from './emit-narrowing.js'
import { viewPlanFor } from './emit-record-view.js'
import {
  cppAbiParameterType,
  cppRecordFieldName,
  cppRecordFieldPresenceName,
  cppRecordStructName,
  cppResultTypeOf,
  cppTypeOf
} from './types.js'

/** The materializer id `conversions.ts` installs a collection's iterable object view under, and `recipeText` renders. */
export const ITERABLE_OBJECT_VIEW = 'gea::Iterable::objectView'

const planConverts = (layouts: RecordLayoutPolicy) => (source: Representation, target: Representation) =>
  chainConverts(source, target) || viewPlanFor(layouts, source, target) !== null

/** `conversion/iterable-object-view.ts`'s plan over the pairs this backend renders. */
export const iterableObjectViewPlanFor = (
  layouts: RecordLayoutPolicy,
  source: Representation,
  target: Representation
): IterableObjectViewPlan | null => iterableObjectViewPlan(layouts, source, target, planConverts(layouts))

/**
 * The iterable object view of an Array or Set (`conversion/iterable-object-view.ts`):
 * a fresh record whose `[Symbol.iterator]` closes over the collection and opens
 * a new native cursor over it on every call, read as the iterator object the
 * member declares.
 */
export const iterableObjectViewText = (
  ctx: ConversionSite,
  source: Representation,
  target: Representation,
  text: string
): string | null => {
  const node = ctx.conversions.nodeById(structuralConversionKey(source, target))
  const materializer = node?.capability.kind === 'atom' || node?.capability.kind === 'static' ? node.capability.materializer : null
  return materializer?.iterableObjectView === undefined ? null : certifiedIterableObjectViewText(ctx, materializer.iterableObjectView, text)
}

export const certifiedIterableObjectViewText = (
  ctx: ConversionSite,
  certified: CertifiedIterableObjectViewPlan,
  text: string
): string | null => {
  const plan = certified.view
  const sourceType = cppTypeOf(plan.source)
  const holderType = `gea::Ref<${sourceType}>`
  const structName = cppRecordStructName(plan.target.shapeId)
  const { abi, field } = plan
  const member = cppTypeOf(field.value.kind === 'optional' ? field.value.payload : field.value)
  const formals = [
    ...(abi.receiver === null ? [] : [`${cppTypeOf(abi.receiver)} gea_view_this`]),
    ...abi.parameters.map((parameter, ordinal) => `${cppAbiParameterType(parameter)} gea_view_arg_${ordinal}`)
  ]
  const signature = `void* gea_view_env${formals.length > 0 ? ', ' : ''}${formals.join(', ')}`
  const resultType = cppResultTypeOf(abi.result)
  const cursorText = `${cppTypeOf(plan.cursor)}(**gea::unpackEnvironment<${holderType}>(gea_view_env, gea_view_slot))`
  const object = abi.result.kind === 'optional' ? abi.result.payload : abi.result
  const cursor = certified.leaves.get(structuralConversionKey(plan.cursor, object))
  if (cursor === undefined) throw new Error('an iterable view has no certified cursor object recipe')
  const viewed = namedConversionText(ctx, 'emit-iterable-object-view.ts:cursor', cursor, cursorText)
  if (viewed === null) return null
  const answer = abi.result.kind === 'optional' ? `${cppTypeOf(abi.result)}(${viewed})` : viewed
  const ignored = abi.parameters.map((_, ordinal) => `(void)gea_view_arg_${ordinal}; `).join('')
  const receiverIgnored = abi.receiver === null ? '' : '(void)gea_view_this; '
  const callable =
    `${member}(+[](${signature}) -> ${resultType} { ${receiverIgnored}${ignored}` +
    `alignas(void*) unsigned char gea_view_slot[sizeof(void*)]; return ${answer}; }, ` +
    `gea::packEnvironment<${holderType}>(gea_view_holder))`
  const stores = [`gea_view->${cppRecordFieldName(field.key)} = ${callable};`]
  if (!field.required) stores.push(`gea_view->${cppRecordFieldPresenceName(field.key)} = true;`)
  const built =
    `([&]() -> ${cppTypeOf(plan.target)} { ${holderType} gea_view_holder = gea::makeRef<${sourceType}>(${text}); ` +
    `auto gea_view = gea::makeRef<${structName}>(); ${stores.join(' ')} return gea_view; }())`
  return certified.target.kind === 'optional' ? `${cppTypeOf(certified.target)}(${built})` : built
}
