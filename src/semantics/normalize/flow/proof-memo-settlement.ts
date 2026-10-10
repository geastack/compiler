import { intrinsicProtocolRequirementKind, type IntrinsicProtocolRequirement } from '../deferred-intrinsic-protocols.js'

/** A positive memo owns its receipt array so settlement also updates readers
 * that retained the exact conditional receipt before the leader finished.
 * @semanticCategory generic-primitive
 */
export interface ProvisionalProofMemo {
  readonly assumed: Set<object>
  readonly escaped: ReadonlySet<object>
  readonly requirements: IntrinsicProtocolRequirement[]
}

/** Only the completed member/family proof supplies `own`. Other parks and
 * all intrinsic obligations survive; an unsuccessful leader settles nothing.
 */
export const settleProofMemoClaims = (
  claims: ProvisionalProofMemo[],
  start: number,
  leader: {
    readonly closed: boolean
    readonly own: ReadonlySet<object>
    readonly inherited: ReadonlySet<object>
    readonly assumed: ReadonlySet<object>
    readonly escaped: ReadonlySet<object>
    readonly requirements: readonly IntrinsicProtocolRequirement[]
  }
): void => {
  if (!leader.closed || leader.escaped.size !== 0) {
    claims.length = start
    return
  }
  let kept = start
  for (let at = start; at < claims.length; at++) {
    const claim = claims[at]!
    if (claim.escaped.size !== 0) continue
    let leaned = false
    for (const key of leader.own) if (claim.assumed.delete(key)) leaned = true
    if (leaned) {
      for (const key of leader.assumed) claim.assumed.add(key)
      for (const requirement of leader.requirements)
        if (
          !claim.requirements.some(
            (held) =>
              held.location === requirement.location &&
              held.intrinsic === requirement.intrinsic &&
              intrinsicProtocolRequirementKind(held) === intrinsicProtocolRequirementKind(requirement)
          )
        )
          claim.requirements.push(requirement)
    }
    if ([...claim.assumed].some((key) => leader.inherited.has(key))) claims[kept++] = claim
  }
  claims.length = kept
}
