import type { NativeObjectSamplePlan } from '../../conversion/native-object-sample.js'
import type { ConversionNode } from '../../conversion/algebra.js'
import { cppRecordFieldName, cppRecordFieldPresenceName, cppStringLiteral, cppTypeOf } from './types.js'
import { nativeFieldPolicyType } from './records.js'

/** The receipt has already selected the actual storage and the normal path
 * that made each required property present. The runtime check detects a
 * broken invariant; it does not turn a required checker type into that proof.
 * Every optional path spells its separately certified undefined conversion.
 */
export const nativeObjectSampleText = (
  plan: NativeObjectSamplePlan,
  text: string,
  leaf: (node: ConversionNode, value: string) => string | null
): string | null => {
  const lines: string[] = []
  for (const entry of plan.fields) {
    const member = cppRecordFieldName(entry.field.key)
    const presence = cppRecordFieldPresenceName(entry.field.key)
    const converted = leaf(entry.present, 'gea_stored')
    const absence = entry.absent === null ? null : leaf(entry.absent, 'gea::Undefined{}')
    if (converted === null || (entry.absent !== null && absence === null)) return null
    const present = (entry.field.required ? '' : `gea_sample.${presence} = true; `) + `return ${converted};`
    const absent =
      entry.presence === 'proven'
        ? 'gea::host::throwRuntimeError("TypeError", "an authenticated native object property lost its proved presence");'
        : `gea_sample.${presence} = false; return ${absence};`
    const value =
      entry.from === 'extension'
        ? `gea::nativeObjectDataGet<${cppTypeOf(entry.storage)}, ${nativeFieldPolicyType(entry.storage)}>` +
          `(gea_source, gea::PropertyKey::string(${cppStringLiteral(entry.field.key)}), ` +
          `[&](const ${cppTypeOf(entry.storage)}& gea_stored) -> ${cppTypeOf(entry.field.value)} { ${present} }, ` +
          `[&]() -> ${cppTypeOf(entry.field.value)} { ${absent} })`
        : `([&]() -> ${cppTypeOf(entry.field.value)} { ` +
          `if (!gea_source->${presence}) { ${absent} } ` +
          `const auto& gea_stored = gea_source->${member}; ${present} })()`
    lines.push(`gea_sample.${member} = ${value};`)
  }
  return (
    `([&]() -> ${cppTypeOf(plan.target)} { const auto& gea_source = ${text}; ` +
    'if (!gea_source) gea::host::throwRuntimeError("TypeError", "Cannot sample native properties on a nullish receiver"); ' +
    `${cppTypeOf(plan.target)} gea_sample{}; ${lines.join(' ')} return gea_sample; })()`
  )
}
