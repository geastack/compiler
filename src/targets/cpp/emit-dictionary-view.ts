import type { ComposedDictionaryViewPlan, DictionaryReadContract, DictionaryViewStep } from '../../conversion/dictionary-view.js'
import type { Representation } from '../../representation/model.js'
import type { ConversionNode } from '../../conversion/algebra.js'
import { recipeText, type ConversionSite } from './emit-narrowing.js'
import { cppClassName, cppTypeOf, cppUndefinedValue } from './types.js'
import { nativeSelectionText } from './emit-native-selection.js'

export const dictionaryReadText = (
  plan: DictionaryReadContract,
  text: string,
  leaf?: (node: ConversionNode, value: string) => string | null
): string | null => {
  switch (plan.kind) {
    case 'dynamic-optional': {
      if (!leaf) return null
      const present = leaf(plan.present, 'gea_dictionary_entry')
      const absent = leaf(plan.absent, plan.target.absence === 'null' ? 'nullptr' : 'gea::Undefined{}')
      const tag = plan.target.absence === 'null' ? 'Null' : 'Undefined'
      if (present === null || absent === null) return null
      return (
        `[](const gea::Value& gea_dictionary_entry) -> ${cppTypeOf(plan.target)} { ` +
        `if (gea_dictionary_entry.tag() == gea::Value::Tag::${tag}) return ${absent}; ` +
        `return ${cppTypeOf(plan.target)}(${present}); }(${text})`
      )
    }
    case 'dynamic-absence':
      return (
        `[](const gea::Value& gea_dictionary_entry) -> ${cppTypeOf(plan.conversion.target)} { ` +
        `if (gea_dictionary_entry.tag() != gea::Value::Tag::${plan.absence === 'null' ? 'Null' : 'Undefined'}) ` +
        'gea::host::throwRuntimeError("TypeError", "dictionary entry has the wrong absence tag"); ' +
        `return ${plan.absence === 'null' ? 'nullptr' : cppUndefinedValue}; }(${text})`
      )
    case 'dynamic-class':
      return `gea::dictionary::checkedClassEntry<${cppClassName(plan.target.declaration)}>(${text})`
    case 'dynamic-payload':
      return `gea::dictionary::checkedPayloadEntry<${cppTypeOf(plan.target)}>(${text}, gea::Value::Tag::${plan.tag})`
    case 'dynamic-callable':
      return leaf ? leaf(plan.conversion, text) : null
    case 'native-selection':
      return nativeSelectionText(plan.selection, plan.conversion.source, plan.conversion.target, text, 'type-error')
  }
}

/** Every selected entry/wrapper conversion is a named canonical child of this plan. */
export const dictionaryViewText = (ctx: ConversionSite, plan: ComposedDictionaryViewPlan, text: string): string | null => {
  const render = (step: DictionaryViewStep, source: Representation, target: Representation, value: string): string | null => {
    switch (step.kind) {
      case 'conversion':
        return recipeText(ctx, step.conversion, value)
      case 'dictionary':
      case 'read-only-dictionary': {
        const read = recipeText(ctx, step.view.read, 'gea_dictionary_entry')
        if (read === null) return null
        const reader = `[](const ${cppTypeOf(step.view.source.value)}& gea_dictionary_entry) -> ${cppTypeOf(step.view.target.value)} { return ${read}; }`
        const table = cppTypeOf({ ...step.view.target, ownership: 'owned' })
        if (step.kind === 'read-only-dictionary') return `gea::dictionary::nativeReadOnlyView<${table}>(${value}, ${reader})`
        const write = recipeText(ctx, step.view.write, 'gea_dictionary_entry')
        if (write === null) return null
        const writer = `[](const ${cppTypeOf(step.view.target.value)}& gea_dictionary_entry) -> ${cppTypeOf(step.view.source.value)} { return ${write}; }`
        return `gea::dictionary::nativeView<${table}>(${value}, ${reader}, ${writer})`
      }
      case 'document': {
        // A table this program boxed at the target carrier is handed back as
        // itself; any other object is viewed as the Document it is.
        const document = recipeText(ctx, step.conversion, 'gea_document_source')
        const viewed = document === null ? null : render(step.payload, step.conversion.target, target, document)
        const type = cppTypeOf(target)
        return viewed === null
          ? null
          : `([&](const gea::Value& gea_document_source) -> ${type} { ` +
              `if (gea_document_source.tag() == gea::Value::Tag::Object && gea_document_source.payloadType() == gea::detail::payloadTypeTagFor<${type}>()) ` +
              `return gea_document_source.as<${type}>(); return ${viewed}; })(${value})`
      }
      case 'wrap': {
        const payload = render(step.payload, source, step.target.payload, value)
        return payload === null ? null : `${cppTypeOf(step.target)}(${payload})`
      }
      case 'inject': {
        const arm = step.target.arms[step.index]
        if (arm === undefined) return null
        const payload = render(step.payload, source, arm.value, value)
        return payload === null ? null : `${cppTypeOf(step.target)}::ofArm<${step.index}>(${payload})`
      }
      case 'optional': {
        if (source.kind !== 'optional') return null
        const present = render(step.present, source.payload, target, `*(${value})`)
        const absent = render(step.absent, { kind: source.absence }, target, source.absence === 'null' ? 'nullptr' : cppUndefinedValue)
        return present === null || absent === null ? null : `((${value}).has_value() ? (${present}) : (${absent}))`
      }
      case 'dispatch': {
        if (source.kind !== 'tagged-union' || source.arms.length !== step.arms.length) return null
        const arms = step.arms.map((arm, index) => {
          const representation = source.arms[index]!.value
          const payload = render(arm, representation, target, `(${value}).template get<${index}>()`)
          return payload === null ? null : `if ((${value}).template is<${index}>()) return ${payload};`
        })
        return arms.some((arm) => arm === null)
          ? null
          : `([&]() -> ${cppTypeOf(target)} { ${arms.join(' ')} gea::detail::refusePayloadMismatch("dictionary view source has no live arm"); })()`
      }
    }
  }
  const body = render(plan.step, plan.source, plan.target, 'gea_dictionary_view')
  return body === null
    ? null
    : `([&](const ${cppTypeOf(plan.source)}& gea_dictionary_view) -> ${cppTypeOf(plan.target)} { return ${body}; })(${text})`
}
