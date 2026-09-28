import type { Representation } from '../../../representation/model.js'
import type { RecordLayoutPolicy } from '../../../representation/policies.js'
import { cppRecordFieldName, cppRecordStructName } from '../types.js'
import { hostMemberValueText } from './emit-host-value.js'
import { coreHostMembers, hostMemberOf, type HostMemberTable } from './host-members.js'

/**
 * A host object stored where an interface of its own methods is expected:
 * ajv's `getLogger` returns `console` where its `Logger` (`{ log, warn, error
 * }`) is declared. The interface is laid out as a record, and a host object is
 * no record, but every member the interface names is a method the host table
 * spells: the record the program reads is exactly those methods read as
 * values (`hostMemberValueText`), each in its field's own convention. `null`
 * unless every field is a required callable some host row answers, so no
 * member is ever invented.
 */
export const hostRecordViewOf = (
  layouts: RecordLayoutPolicy,
  source: Representation,
  target: Representation,
  members: HostMemberTable = coreHostMembers
): { readonly shapeId: string; readonly assignments: readonly string[] } | null => {
  if (source.kind !== 'native-handle') return null
  const shared =
    (target.kind === 'record' || (target.kind === 'native-record-ref' && target.native === null)) && target.ownership === 'shared-refcount'
  if (!shared) return null
  const fields = target.kind === 'record' ? target.fields : layouts.forShape(target.shapeId)
  if (!fields || fields.length === 0) return null
  const assignments: string[] = []
  for (const field of fields) {
    if (!field.required || field.value.kind !== 'function-value-dispatch') return null
    const host = hostMemberOf(members, source.protocol, field.key)
    const thunk = host === undefined ? null : hostMemberValueText(field.value, host, layouts)
    if (thunk === null) return null
    assignments.push(`gea_host_view->${cppRecordFieldName(field.key)} = ${thunk};`)
  }
  return { shapeId: target.shapeId, assignments }
}

/** The record `hostRecordViewOf` plans, built over `text` (evaluated for its effects and then unused). */
export const hostRecordViewText = (
  layouts: RecordLayoutPolicy,
  source: Representation,
  target: Representation,
  text: string
): string | null => {
  const view = hostRecordViewOf(layouts, source, target)
  if (view === null) return null
  return (
    `([&]() { (void)(${text}); auto gea_host_view = gea::makeRef<${cppRecordStructName(view.shapeId)}>(); ` +
    `${view.assignments.join(' ')} return gea_host_view; })()`
  )
}
