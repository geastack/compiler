import type ts from 'typescript'
import type { ProducerContext } from './producer-context.js'
import { intrinsicObjectKeysIntact } from './host-mutation-keys.js'

type IntrinsicContext = Pick<ProducerContext, 'checker' | 'identities' | 'globalHostMutationTaint' | 'isStandardLibraryDeclaration'>

/** Shared static-member identity and sealed mutation authority. Constructor
 * value declarations and static member declarations have distinct identities;
 * instance-interface augmentation does not replace a constructor static.
 *
 * Per key: the owner must not have had THIS member's key written (directly,
 * or through a receiver that might be any intrinsic) nor its binding
 * replaced, and the member declaration itself must not have been replaced.
 * A write of some other key on the owner says nothing about this member.
 */
export const intrinsicStaticMemberIsIntact = (
  context: IntrinsicContext,
  owner: ts.Symbol | undefined,
  member: ts.Symbol | undefined,
  location: ts.Node
): boolean => {
  if (!owner?.valueDeclaration || !member?.declarations?.length) return false
  if (
    ![owner.valueDeclaration, ...member.declarations].every((declaration) => context.isStandardLibraryDeclaration?.(declaration) === true)
  )
    return false
  const ownerId = context.identities.symbolValueDeclarationId(owner, location)
  const memberId = context.identities.symbolDeclarationId(member)
  const taint = context.globalHostMutationTaint
  return (
    ownerId !== null &&
    memberId !== null &&
    !taint.has(memberId) &&
    intrinsicObjectKeysIntact(taint, ownerId, { names: [member.getName()] })
  )
}
