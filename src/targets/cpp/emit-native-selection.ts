import type { NativeSelectionRecipe, NativeSelectionStep } from '../../conversion/native-selection.js'
import type { Representation } from '../../representation/model.js'
import { representationKey } from '../../representation/model.js'
import { renderNativeSumPlan } from './emit-sum-widening.js'
import { cppClassName, cppTypeOf, cppUndefinedValue, unitFunctionName } from './types.js'

/** The census already chose every arm and transfer; this renderer only spells them. */
export const nativeSelectionBody = (
  recipe: NativeSelectionRecipe,
  source: Representation,
  target: Representation,
  mismatch: 'compiler' | 'type-error' = 'compiler'
): string | null => {
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
        return step.undefined === undefined
          ? `if (!(${value}) && !(${value}).isUndefined()) { ${render(step.absent, 'nullptr')} }`
          : `if ((${value}).isUndefined()) { ${render(step.undefined, cppUndefinedValue)} } else if (!(${value})) { ${render(step.absent, 'nullptr')} }`
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
  const failure =
    mismatch === 'compiler'
      ? 'gea::detail::refusePayloadMismatch("native sum selection has no matching alternative");'
      : 'gea::host::throwRuntimeError("TypeError", "dictionary entry has no matching native alternative");'
  const body = `${render(recipe.step, 'gea_selection')} ${failure}`
  // Only a body that spells the target needs the alias: a `downcastClassRef`
  // or `identity` arm does not, and an unused local typedef is an error under
  // the ESP-IDF build's `-Werror=unused-local-typedefs`.
  return body.includes(alias) ? `using ${alias} = ${cppTypeOf(target)}; ${body}` : body
}

export const nativeSelectionText = (
  recipe: NativeSelectionRecipe,
  source: Representation,
  target: Representation,
  text: string,
  mismatch: 'compiler' | 'type-error' = 'compiler'
): string | null => {
  const body = nativeSelectionBody(recipe, source, target, mismatch)
  if (body === null) return null
  // The census chose every arm, so the selection depends on the two carriers
  // alone: one unit function per pair (`unitFunctionName`), the same shape the
  // balanced layout's `nativeSelectionHelpers` already defines out of line.
  const named = unitFunctionName(
    'gea_native_selection',
    (name) => `${cppTypeOf(target)} ${name}(const ${cppTypeOf(source)}& gea_selection)`,
    body
  )
  return named !== null ? `${named}(${text})` : `([](const auto& gea_selection) -> ${cppTypeOf(target)} { ${body} })(${text})`
}
