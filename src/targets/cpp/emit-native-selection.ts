import type { NativeSelectionRecipe, NativeSelectionStep } from '../../conversion/native-selection.js'
import type { Representation } from '../../representation/model.js'
import { representationKey } from '../../representation/model.js'
import { renderNativeSumPlan } from './emit-sum-widening.js'
import { cppClassName, cppTypeOf, cppUndefinedValue } from './types.js'

/** The census already chose every arm and transfer; this renderer only spells them. */
export const nativeSelectionBody = (recipe: NativeSelectionRecipe, source: Representation, target: Representation): string | null => {
  if (recipe.source !== representationKey(source) || recipe.target !== representationKey(target)) return null
  const alias = 'GeaSelectionTarget'
  const spell = (value: Representation): string => (representationKey(value) === recipe.target ? alias : cppTypeOf(value))
  const render = (step: NativeSelectionStep | null, value: string): string => {
    if (step === null) return ''
    switch (step.kind) {
      case 'identity':
        return `return ${value};`
      case 'null':
        return `return ${alias}{};`
      case 'reference-null':
        return `if (!(${value})) { ${render(step.absent, 'nullptr')} }`
      case 'transfer':
        return `return ${renderNativeSumPlan(step.plan, value, spell, true)};`
      case 'class-cast':
        return `return ${step.down ? `gea::host::downcastClassRef<${cppClassName(step.target.declaration)}>` : spell(step.target)}(${value});`
      case 'optional':
        return `if ((${value}).has_value()) { ${render(step.present, `(*(${value}))`)} } else { ${render(step.absent, step.absence === 'null' ? 'nullptr' : cppUndefinedValue)} }`
      case 'dispatch':
        return step.arms
          .map((arm, index) =>
            arm === null ? '' : `if ((${value}).template is<${index}>()) { ${render(arm, `(${value}).template get<${index}>()`)} }`
          )
          .join(' ')
    }
  }
  return `using ${alias} = ${cppTypeOf(target)}; ${render(recipe.step, 'gea_selection')} gea::detail::refusePayloadMismatch("native sum selection has no matching alternative");`
}

export const nativeSelectionText = (
  recipe: NativeSelectionRecipe,
  source: Representation,
  target: Representation,
  text: string
): string | null => {
  const body = nativeSelectionBody(recipe, source, target)
  return body === null ? null : `([](const auto& gea_selection) -> ${cppTypeOf(target)} { ${body} })(${text})`
}
