import { nativeArrayViewPlanMatches, type NativeArrayViewPlan } from '../../conversion/array-view.js'
import type { ConversionNode } from '../../conversion/algebra.js'
import { recipeText, type ConversionSite } from './emit-narrowing.js'
import { nativeFieldPolicyType } from './records.js'
import { cppStringLiteral, cppTypeOf } from './types.js'

/** The source envelope and each deferred callback consume the selected
 * canonical node. No callback classifies a new storage carrier at runtime.
 */
export const nativeArrayViewText = (ctx: ConversionSite, node: ConversionNode, plan: NativeArrayViewPlan, text: string): string | null => {
  if (!nativeArrayViewPlanMatches(plan, node.source, node.target, ctx.conversions.nodeById)) return null
  const sourceType = cppTypeOf(plan.storage.element)
  const targetType = cppTypeOf(plan.target.element)
  const targetPolicy = nativeFieldPolicyType(plan.target.element)
  const sourcePolicy = nativeFieldPolicyType(plan.storage.element)
  const readerText = recipeText(ctx, plan.read, 'gea_array_entry')
  if (readerText === null) return null
  const reader = `[](const ${sourceType}& gea_array_entry) -> ${targetType} { return ${readerText}; }`
  if (plan.write.kind === 'native-entry') {
    const observed = recipeText(ctx, plan.write.observation, 'gea_array_entry')
    if (observed === null) return null
    const observer = `[](const ${targetType}& gea_array_entry) -> gea::Value { return ${observed}; }`
    const checked = (boxed: string): string =>
      `gea::detail::checkedNativeArrayView<${targetType}, ${targetPolicy}>(${boxed}, ${cppStringLiteral('a live native array view')}, ${reader}, ${observer})`
    if (plan.source.kind === 'dynamic') return checked(text)
    if (plan.source.kind === 'array-object')
      return `gea::makeNativeEntryArrayView<${targetType}, ${targetPolicy}>(${text}, ${reader}, ${observer})`
    // An open Document is checked as the object it aliases; an absent
    // Document stays absent, exactly as the boxed absence would.
    const result = cppTypeOf(plan.target)
    return (
      `[](const ${cppTypeOf(plan.source)}& gea_document) -> ${result} { ` +
      `if (gea_document.isUndefined()) return ${result}::undefined(); if (!gea_document) return ${result}(); ` +
      `return ${checked('gea::dictionary::aliasedObject(gea_document)')}; }(${text})`
    )
  }
  if (plan.source.kind !== 'array-object' || plan.sourceObservation === undefined || plan.ownerObservation === undefined) return null
  const written = recipeText(ctx, plan.write.conversion, 'gea_array_entry')
  const observed = recipeText(ctx, plan.sourceObservation, 'gea_array_entry')
  const ownerObserved = recipeText(ctx, plan.ownerObservation, 'gea_array_owner')
  if (written === null || observed === null || ownerObserved === null) return null
  const writer = `[](const ${targetType}& gea_array_entry) -> ${sourceType} { return ${written}; }`
  const observer = `[](const ${sourceType}& gea_array_entry) -> gea::Value { return ${observed}; }`
  const ownerObserver = `[](const ${cppTypeOf(plan.storage)}& gea_array_owner) -> gea::Value { return ${ownerObserved}; }`
  return `gea::makeNativeArrayView<${targetType}, ${targetPolicy}, ${sourcePolicy}>(${text}, ${reader}, ${writer}, ${ownerObserver}, ${observer})`
}
