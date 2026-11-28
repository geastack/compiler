import type { OwnedRecordPlan } from '../../conversion/record-view.js'
import { cppRecordFieldName, cppRecordStructName, cppTypeOf } from './types.js'

export const ownedRecordMaterializationText = (plan: OwnedRecordPlan, text: string, depth = 0): string => {
  if (plan.kind === 'identity') {
    // Narrowed as a local: a `kind` guard on the field path would read the
    // stored union through its scalar arm's type.
    const target = plan.target
    return target.kind === 'scalar' && target.domain !== 'bigint' ? `static_cast<${cppTypeOf(target)}>(${text})` : text
  }
  if (plan.kind === 'arm') {
    return `${cppTypeOf(plan.target)}::ofArm<${plan.index}>(${ownedRecordMaterializationText(plan.payload, text, depth)})`
  }
  const holder = `gea_owned_record_${depth}`
  const reads = plan.fields.map((field) =>
    ownedRecordMaterializationText(field.value, `${holder}.${cppRecordFieldName(field.key)}`, depth + 1)
  )
  const structure = cppRecordStructName(plan.target.shapeId)
  const aggregate = `${structure}{${reads.join(', ')}}`
  const result = plan.target.ownership === 'shared-refcount' ? `gea::makeRef<${structure}>(${aggregate})` : aggregate
  return `[](const ${cppTypeOf(plan.source)}& ${holder}) { return ${result}; }(${text})`
}
