import type { Representation } from '../../representation/model.js'
import { nativeSumPlan, type NativeSumPlan } from '../../conversion/native-sum.js'
export { nativeSumWidenable } from '../../conversion/native-sum.js'
import { cppTypeOf, cppUndefinedValue } from './types.js'

/**
 * The alias the widening lambda binds its TARGET spelling to. A nine-arm
 * typed-array union is ~400 bytes to spell; `render` wrote it at every
 * `wrap` of a nine-arm `dispatch`, and the three.js app's `BufferAttribute.array`
 * store emitted one 773KB line of nothing but that spelling. Bound once in
 * the lambda body, every wrap names the alias instead. Only the top-level
 * target is aliased: an inner `class-upcast`/`wrap` target is a single arm's
 * type, short, and spelled once per arm either way.
 */
const sumTargetAliasName = 'GeaSumTarget'

export const renderNativeSumPlan = (
  step: NativeSumPlan,
  text: string,
  spell: (target: Representation) => string,
  dependent = false
): string => {
  const template = dependent ? 'template ' : ''
  switch (step.kind) {
    case 'identity':
      return `std::move(${text})`
    case 'class-upcast':
      return `${spell(step.target)}(${text})`
    case 'null-reference':
      return `${spell(step.target)}{}`
    case 'empty':
      return `${spell(step.target)}{}`
    case 'nullable-reference':
      return `(${text} ? ${renderNativeSumPlan(step.present, text, spell, dependent)} : ${renderNativeSumPlan(step.absent, 'nullptr', spell, dependent)})`
    case 'wrap': {
      const payload = renderNativeSumPlan(step.payload, text, spell, dependent)
      return step.index === null ? `${spell(step.target)}{${payload}}` : `${spell(step.target)}::ofArm<${step.index}>(${payload})`
    }
    case 'optional': {
      const present = renderNativeSumPlan(step.present, `(*(${text}))`, spell, dependent)
      const absent = renderNativeSumPlan(step.absent, step.absence === 'null' ? 'nullptr' : cppUndefinedValue, spell, dependent)
      return `((${text}).has_value() ? ${present} : ${absent})`
    }
    case 'dispatch': {
      const alternatives = step.arms.map((arm, index) => renderNativeSumPlan(arm, `(${text}).${template}get<${index}>()`, spell, dependent))
      let result = alternatives[alternatives.length - 1] as string
      for (let index = alternatives.length - 2; index >= 0; index--) {
        result = `((${text}).${template}is<${index}>() ? ${alternatives[index]} : ${result})`
      }
      return result
    }
  }
}

/**
 * Own the source while dispatching: lvalues copy once, temporaries move into
 * the parameter, and the selected payload moves into its destination. Borrowing
 * a temporary through const& would force an otherwise unnecessary deep copy.
 */
export const widenedNativeSumText = (source: Representation, target: Representation, text: string): string | null => {
  const conversion = nativeSumPlan(source, target)
  if (!conversion) return null
  const targetText = cppTypeOf(target)
  // A bare wrap of the value as it is -- one arm of the sum, no dispatch, no
  // optional to unpack -- needs no lambda: `Target::ofArm<k>(text)` copies an
  // lvalue once and moves a temporary, exactly what the lambda's by-value
  // parameter did, and spells the target ONCE instead of twice (return type
  // plus alias). This is the shape a union's arm-by-arm dispatch reaches for
  // at every arm (`emit-bindings.ts`'s `structuralUnionLoadText`), and it was
  // 882 lambdas on one three.js line.
  if (conversion.kind === 'wrap' && conversion.payload.kind === 'identity') {
    return conversion.index === null ? `${targetText}{${text}}` : `${targetText}::ofArm<${conversion.index}>(${text})`
  }
  const spell = (step: Representation): string => (cppTypeOf(step) === targetText ? sumTargetAliasName : cppTypeOf(step))
  return (
    `([](${cppTypeOf(source)} __gea_sum_value) -> ${targetText} { using ${sumTargetAliasName} = ${targetText}; ` +
    `return ${renderNativeSumPlan(conversion, '__gea_sum_value', spell)}; })(${text})`
  )
}
