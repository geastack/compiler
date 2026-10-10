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
 * TypeScript builds exactly this shape by contravariance:
 * `this.#result[0].map(([[, route]]) => route)` over a receiver that is a
 * union of two array types makes `map`'s callback parameter the INTERSECTION
 * of the two arms' callbacks. Many mandatory obligations on two lines, and the arrow written there has one parameter
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
      call.implicitReceiver === first.implicitReceiver &&
      call.result === first.result &&
      call.parameters.every(
        (parameter, index) =>
          parameter.optional === first.parameters[index]?.optional &&
          parameter.rest === first.parameters[index]?.rest &&
          parameter.argumentsFrame === first.parameters[index]?.argumentsFrame &&
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
        ...(first.implicitReceiver ? { implicitReceiver: true as const } : {}),
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
