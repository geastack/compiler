import ts from 'typescript'
import type { StructuralTypeId } from '../../identity/ids.js'
import type { StructuralTypeTable } from '../model/structural-type-table.js'
import type { SignatureParameter, SignatureShape } from '../model/structural-types.js'

/**
 * One physical signature for an INTERSECTION of function types whose frames
 * differ only at parameter positions.
 *
 * An intersection of callables is one value that must satisfy every member,
 * and `derive.ts`'s `deriveIntersection` pools their signatures and hands
 * them to `sharedAbiOf` as an overload set -- which refuses, correctly for an
 * overload set: a caller reaching one overload through another's frame passes
 * the wrong arguments. But this is not an overload set. A value of `((a: A)
 * => R) & ((b: B) => R)` is a SINGLE function that has to accept an `A` and
 * a `B`, so the frame it physically has takes `A | B` -- and a caller with an
 * `A` in hand reaches it by the ordinary widening into that union, which is
 * a conversion this compiler already renders.
 *
 * TypeScript builds exactly this shape by contravariance and hono hits it:
 * `this.#matchResult[0].map(([[, route]]) => route)` (`request.ts:421`) has a
 * receiver that is a union of two array types, so `map`'s callback parameter
 * is the INTERSECTION of the two arms' callbacks. Fourteen mandatory
 * obligations on two lines, and the arrow written there has one parameter
 * list, which is the whole point.
 *
 * Congruence is required, not assumed: same arity, same minimum arity, same
 * optional/rest/initializer state at every position, same receiver, same
 * result. Anything else really is a set of different frames and stays an
 * intersection, refused by name downstream. A member that is not a pure
 * function type -- one carrying properties, or a construct signature -- is
 * not this shape either; the callable-and-record intersection is what the
 * ordinary intersection merge exists for.
 */
export const joinedCallableOf = (
  table: StructuralTypeTable,
  type: ts.IntersectionType,
  members: readonly StructuralTypeId[]
): StructuralTypeId | null => {
  if (members.length < 2 || members.length !== type.types.length) return null
  const pure = type.types.every(
    (member) =>
      member.getCallSignatures().length === 1 && member.getConstructSignatures().length === 0 && member.getProperties().length === 0
  )
  if (!pure) return null
  const calls: SignatureShape[] = []
  for (const member of members) {
    const shape = table.get(member).shape
    const call = shape.kind === 'signature' && shape.construct.length === 0 ? shape.call[0] : undefined
    if (!call || shape.kind !== 'signature' || shape.call.length !== 1) return null
    calls.push(call)
  }
  const first = calls[0]
  if (!first) return null
  const congruent = calls.every(
    (call) =>
      call.parameters.length === first.parameters.length &&
      call.minimumArity === first.minimumArity &&
      call.thisParameter === first.thisParameter &&
      call.result === first.result &&
      call.parameters.every(
        (parameter, index) =>
          parameter.optional === first.parameters[index]?.optional &&
          parameter.rest === first.parameters[index]?.rest &&
          parameter.hasInitializer === first.parameters[index]?.hasInitializer
      )
  )
  if (!congruent) return null
  const widen = (at: number, read: (parameter: SignatureParameter) => StructuralTypeId): StructuralTypeId => {
    const seen: StructuralTypeId[] = []
    for (const call of calls) {
      const parameter = call.parameters[at]
      const id = parameter ? read(parameter) : null
      if (id !== null && !seen.includes(id)) seen.push(id)
    }
    const only = seen.length === 1 ? seen[0] : undefined
    return only ?? table.intern({ kind: 'union', members: seen })
  }
  return table.intern({
    kind: 'signature',
    construct: [],
    call: [
      {
        minimumArity: first.minimumArity,
        thisParameter: first.thisParameter,
        result: first.result,
        parameters: first.parameters.map((parameter, index) => ({
          ...parameter,
          type: widen(index, (one) => one.type),
          slot: widen(index, (one) => one.slot)
        }))
      }
    ]
  })
}

/**
 * Join compatible index-signature arms even inside a mixed union. A table
 * must keep the same storage when it enters `Table | string`: leaving its
 * component table types separate there would require splitting one mutable
 * object into several homogeneous dictionaries and lose aliasing.
 *
 * Each group requires exactly one index signature, the same key type and
 * readonly state, no named members, and no call or construct signatures.
 * Non-table arms and incompatible tables remain separate union members.
 */
export const joinedIndexUnionOf = (
  checker: ts.TypeChecker,
  table: StructuralTypeTable,
  typeOf: (type: ts.Type) => StructuralTypeId,
  members: readonly ts.Type[]
): StructuralTypeId | null => {
  const groups: { key: 'string' | 'number' | 'symbol'; index: ts.IndexInfo; members: ts.Type[]; values: ts.Type[] }[] = []
  for (const member of members) {
    const indexes = checker.getIndexInfosOfType(member)
    const index = indexes.length === 1 ? indexes[0] : undefined
    const key = index ? keyDomainOf(index.keyType) : null
    if (
      !index ||
      key === null ||
      member.getProperties().length !== 0 ||
      member.getCallSignatures().length !== 0 ||
      member.getConstructSignatures().length !== 0
    )
      continue
    const group = groups.find((candidate) => candidate.index.keyType === index.keyType && candidate.index.isReadonly === index.isReadonly)
    if (group) {
      group.members.push(member)
      group.values.push(index.type)
    } else groups.push({ key, index, members: [member], values: [index.type] })
  }
  const joined = groups.filter((group) => group.members.length > 1)
  if (joined.length === 0) return null
  const replacements = new Map<ts.Type, StructuralTypeId>()
  for (const group of joined) {
    const values = [...new Set(group.values.map(typeOf))]
    const value = values.length === 1 ? values[0] : undefined
    const id = table.intern({
      kind: 'object',
      members: [],
      membersDropped: false,
      index: [{ key: group.key, value: value ?? table.intern({ kind: 'union', members: values }), readonly: group.index.isReadonly }]
    })
    for (const member of group.members) replacements.set(member, id)
  }
  const result = [...new Set(members.map((member) => replacements.get(member) ?? typeOf(member)))]
  return result.length === 1 ? (result[0] ?? null) : table.intern({ kind: 'union', members: result })
}

/** The key domain an index signature's key type names, or `null` for one this layer does not model. */
const keyDomainOf = (keyType: ts.Type): 'string' | 'number' | 'symbol' | null => {
  if ((keyType.flags & ts.TypeFlags.String) !== 0) return 'string'
  if ((keyType.flags & ts.TypeFlags.Number) !== 0) return 'number'
  if ((keyType.flags & ts.TypeFlags.ESSymbol) !== 0) return 'symbol'
  return null
}
