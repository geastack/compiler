import type {
  ComposedDocumentRecordViewPlan,
  DocumentRecordViewPlan,
  DocumentRecordViewStep
} from '../../conversion/document-record-view.js'
import { recipeClosureOf } from '../../conversion/recipe-closure.js'
import { recipeText, type ConversionSite } from './emit-narrowing.js'
import { cppRecordStructName, cppTypeOf, fieldPropertyKeyText, unitFunctionName } from './types.js'
import { nativeFieldPolicyType } from './records.js'
import type { Representation } from '../../representation/model.js'
import { canonicalIndexLiteral } from '../../representation/array-index.js'

/** Runtime field adapters consume the exact future recipes; allocating a view reads no entry. */
const fieldViewText = (ctx: ConversionSite, plan: DocumentRecordViewPlan, text: string): string | null => {
  const sourceType = cppTypeOf(plan.source)
  const immediate = `gea_immediate.staticCast<typename ${sourceType}::element_type>()`
  const prefix = '+[](const gea::Ref<void>& gea_immediate, const gea::PropertyKey& gea_key'
  const read =
    `${prefix}, const gea::NativeFieldRead& gea_read) -> bool { ` +
    `return gea::dictionary::readDocumentField(${immediate}, gea_key, gea_read); }`
  const nativeWrites: string[] = []
  for (const field of plan.fields) {
    if (field.write.kind !== 'native-entry') continue
    // `writeDocumentNativeEntry` is the lane-checked store; a writer that did
    // not select it cannot own a numeric key.
    if (field.write.laneChecked !== true && canonicalIndexLiteral(field.key) !== null) return null
    const target = field.write.stored.target
    const type = cppTypeOf(target)
    const observed = recipeText(ctx, field.write.observation, 'gea_document_entry')
    if (observed === null || field.write.stored.capability.kind !== 'identity') return null
    const observer = `+[](const ${type}& gea_document_entry) -> gea::Value { return ${observed}; }`
    nativeWrites.push(
      `if (gea_key == ${fieldPropertyKeyText(field.key)}) ` +
        `return gea::dictionary::writeDocumentNativeEntry<${type}, ${nativeFieldPolicyType(target)}>` +
        `(${immediate}, gea_key, gea_write, ${observer});`
    )
  }
  const write =
    `${prefix}, const gea::NativeFieldWrite& gea_write) -> bool { ` +
    (nativeWrites.length === 0 ? '' : `${nativeWrites.join(' ')} `) +
    `return gea::dictionary::writeDocumentField(${immediate}, gea_key, gea_write); }`
  const define =
    `${prefix}, const gea::PropertyDescriptor& gea_descriptor) -> bool { ` +
    `return gea::dictionary::defineDocumentField(${immediate}, gea_key, gea_descriptor); }`
  const ownHas = `${prefix}) -> bool { return gea::dictionary::hasOwnDocumentField(${immediate}, gea_key); }`
  const fullHas = `${prefix}) -> bool { return gea::dictionary::hasDocumentField(${immediate}, gea_key); }`
  return (
    `gea::record::makeDocumentViewWithOrigin<${cppRecordStructName(plan.target.shapeId)}>` +
    `(${text}, ${read}, ${write}, ${define}, ${ownHas}, ${fullHas})`
  )
}

export const documentRecordViewText = (ctx: ConversionSite, plan: ComposedDocumentRecordViewPlan, text: string): string | null => {
  const closure = recipeClosureOf(plan.dependencies, ctx.conversions.nodeById)
  for (const node of plan.dependencies)
    if (ctx.conversions.nodeById(node.id) !== node || closure.get(node.id) !== node || recipeText(ctx, node, 'gea_entry') === null)
      return null
  const render = (step: DocumentRecordViewStep, source: Representation, target: Representation, value: string): string | null => {
    switch (step.kind) {
      case 'view':
        return fieldViewText(ctx, step.view, value)
      case 'conversion':
        return recipeText(ctx, step.conversion, value)
      case 'document': {
        const document = recipeText(ctx, step.conversion, value)
        return document === null ? null : render(step.payload, step.conversion.target, target, document)
      }
      case 'wrap': {
        const payload = render(step.payload, source, step.target.payload, value)
        return payload === null ? null : `${cppTypeOf(step.target)}(${payload})`
      }
      case 'inject': {
        const arm = step.target.arms[step.index]
        if (!arm) return null
        const payload = render(step.payload, source, arm.value, value)
        return payload === null ? null : `${cppTypeOf(step.target)}::ofArm<${step.index}>(${payload})`
      }
      case 'optional': {
        if (source.kind !== 'optional') return null
        const present = render(step.present, source.payload, target, `*(${value})`)
        const absent = recipeText(ctx, step.absent, source.absence === 'null' ? 'nullptr' : 'gea::Undefined{}')
        return present === null || absent === null ? null : `((${value}).has_value() ? (${present}) : (${absent}))`
      }
      case 'dynamic-optional': {
        const present = render(step.present, source, target, value)
        const absent = recipeText(ctx, step.absent, step.absence === 'null' ? 'nullptr' : 'gea::Undefined{}')
        const tag = step.absence === 'null' ? 'Null' : 'Undefined'
        return present === null || absent === null ? null : `((${value}).tag() == gea::Value::Tag::${tag} ? (${absent}) : (${present}))`
      }
      case 'dispatch': {
        if (source.kind !== 'tagged-union' || source.arms.length !== step.arms.length) return null
        const arms = step.arms.map((arm, index) => {
          const payload = render(arm, source.arms[index]!.value, target, `(${value}).template get<${index}>()`)
          return payload === null ? null : `if ((${value}).template is<${index}>()) return ${payload};`
        })
        return arms.some((arm) => arm === null)
          ? null
          : `([&]() -> ${cppTypeOf(target)} { ${arms.join(' ')} gea::detail::refusePayloadMismatch("document view source has no live arm"); })()`
      }
    }
  }
  const body = render(plan.step, plan.source, plan.target, 'gea_document_source')
  if (body === null) return null
  // The view's text depends on its carriers and recipes alone, so a unit
  // defines it once and every site calls it by name (`unitFunctionName`):
  // each inline copy re-spelled all five field adapters.
  const signature = (name: string): string => `${cppTypeOf(plan.target)} ${name}(const ${cppTypeOf(plan.source)}& gea_document_source)`
  const named = unitFunctionName('gea_document_view', signature, `return ${body};`)
  return named !== null
    ? `${named}(${text})`
    : `([&](const ${cppTypeOf(plan.source)}& gea_document_source) -> ${cppTypeOf(plan.target)} { return ${body}; })(${text})`
}
