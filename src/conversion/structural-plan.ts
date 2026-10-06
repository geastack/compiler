import type { ConversionNode } from './algebra.js'
import type { RecordLayoutPolicy } from '../representation/policies.js'
import { containsUnresolved, representationKey, type RecordField, type Representation } from '../representation/model.js'
import { optionalMethodPayloadOf, structuralRecordViewPlan, type FamilyMemberKeys, type RecordViewPlan } from './record-view.js'

export type AcceptedConversion = (source: Representation, target: Representation) => ConversionNode | null

export interface CertifiedRecordViewPlan {
  readonly view: RecordViewPlan
  readonly leaves: ReadonlyMap<string, ConversionNode>
}

export interface RecordToArrayPlan {
  readonly source: Extract<Representation, { kind: 'record' }>
  readonly target: Extract<Representation, { kind: 'array-object' }>
  readonly fields: readonly { readonly field: RecordField; readonly conversion: ConversionNode }[]
}

export const structuralConversionKey = (source: Representation, target: Representation): string =>
  `${representationKey(source)}->${representationKey(target)}`

const dynamicSidecar: Representation = { kind: 'dynamic', reason: 'declared-any-never-narrowed' }

/** The selected view's leaf obligations, rather than the candidates its planner considered. */
export const certifiedRecordViewPlan = (
  layouts: RecordLayoutPolicy,
  source: Representation,
  target: Representation,
  accepted: AcceptedConversion,
  members?: FamilyMemberKeys
): CertifiedRecordViewPlan | null => {
  const view = structuralRecordViewPlan(layouts, source, target, (from, into) => accepted(from, into) !== null, members)
  if (view === null) return null
  const leaves = new Map<string, ConversionNode>()
  const add = (from: Representation, into: Representation): boolean => {
    const key = structuralConversionKey(from, into)
    if (leaves.has(key)) return true
    const node = accepted(from, into)
    if (node === null || node.capability.kind === 'never') return false
    if (representationKey(node.source) !== representationKey(from) || representationKey(node.target) !== representationKey(into))
      throw new Error(`structural conversion ${key} received proof for ${structuralConversionKey(node.source, node.target)}`)
    leaves.set(key, node)
    return true
  }
  const walk = (plan: RecordViewPlan): boolean => {
    switch (plan.kind) {
      case 'owned':
        return true
      case 'optional':
      case 'assert':
        return walk(plan.payload)
      case 'arm': {
        const arm = plan.target.arms[plan.index]
        return arm !== undefined && (plan.payload === null ? add(plan.source, arm.value) : walk(plan.payload))
      }
      case 'recast-union':
        return plan.arms.every((home, index) => {
          const from = plan.source.arms[index]
          const into = plan.target.arms[home.index]
          return (
            from !== undefined &&
            into !== undefined &&
            (home.via === 'exact' || (home.via === 'convert' ? add(from.value, into.value) : walk(home.via)))
          )
        })
      case 'dispatch': {
        const payload = plan.target.kind === 'optional' ? plan.target.payload : plan.target
        return plan.arms.every((home, index) => {
          const from = plan.source.arms[index]
          return (
            from !== undefined &&
            (home.via === 'exact' || home.via === 'absent' || (home.via === 'convert' ? add(from.value, payload) : walk(home.via)))
          )
        })
      }
      case 'iterator-result':
        return [plan.yieldHome, plan.returnHome].every((home) => {
          const arm = plan.target.arms[home.index]
          return arm !== undefined && (home.payload === null ? add(plan.source, arm.value) : walk(home.payload))
        })
      case 'fields':
        return (
          plan.fields.every(({ field, read }) => {
            switch (read.kind) {
              case 'absent':
                return true
              case 'held':
                return add(read.held.value, field.value)
              case 'view':
                return walk(read.plan)
              case 'sidecar':
                return add(dynamicSidecar, field.value)
              case 'class-accessor':
                return add(read.value, field.value)
              case 'method-value': {
                if (plan.source.kind !== 'class-ref') return false
                const own = layouts.classMethodAbiFor?.(plan.source.declaration, field.key)
                const member = optionalMethodPayloadOf(field.value)
                if (own === undefined || own === null || member.kind !== 'function-value-dispatch') return false
                return add({ ...member, abi: own }, member)
              }
              case 'bound-method': {
                if (plan.source.kind !== 'class-ref') return false
                const own = layouts.classMethodAbiFor?.(plan.source.declaration, field.key)
                const member = optionalMethodPayloadOf(field.value)
                if (own === undefined || own === null || !('abi' in member)) return false
                const abi = member.abi
                const rest = own.restFrom === null ? null : own.parameters[own.restFrom]?.value
                const passed =
                  own.restFrom === null && abi.restFrom === null
                    ? Math.min(own.parameters.length, abi.parameters.length)
                    : abi.parameters.length
                for (const [ordinal, parameter] of abi.parameters.slice(0, passed).entries()) {
                  const targetParameter =
                    own.restFrom !== null && abi.restFrom === null && ordinal >= own.restFrom
                      ? rest?.kind === 'array-object'
                        ? rest.element
                        : null
                      : own.parameters[ordinal]?.value
                  if (targetParameter === null || targetParameter === undefined || !add(parameter.value, targetParameter)) return false
                }
                return abi.result.kind === 'void' || add(own.result, abi.result)
              }
            }
          }) &&
          (plan.spilled ?? []).every(({ held, index }) => add(held.value, index.value)) &&
          (plan.expandoSpilled ?? []).every((held) => add(held.value, dynamicSidecar))
        )
    }
  }
  return walk(view) ? { view, leaves } : null
}

/** Contiguous tuple storage is materialized once, with the exact admitted conversion of each element. */
export const recordToArrayPlan = (
  source: Extract<Representation, { kind: 'record' }>,
  target: Extract<Representation, { kind: 'array-object' }>,
  accepted: AcceptedConversion
): RecordToArrayPlan | null => {
  if (
    source.accessors.length !== 0 ||
    source.fields.length === 0 ||
    target.ownership !== 'shared-refcount' ||
    containsUnresolved(target.element) ||
    !source.fields.every((field, index) => field.key === String(index))
  )
    return null
  const fields: { field: RecordField; conversion: ConversionNode }[] = []
  for (const field of source.fields) {
    if (containsUnresolved(field.value)) return null
    const conversion = accepted(field.value, target.element)
    if (conversion === null || conversion.capability.kind === 'never') return null
    if (
      representationKey(conversion.source) !== representationKey(field.value) ||
      representationKey(conversion.target) !== representationKey(target.element)
    )
      throw new Error(`tuple field ${field.key} received a conversion for different carriers`)
    fields.push({ field, conversion })
  }
  return { source, target, fields }
}
