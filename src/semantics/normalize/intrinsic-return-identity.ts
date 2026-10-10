import ts from 'typescript'
import type { ProducerContext } from './producer-context.js'
import { intrinsicStaticMemberIsIntact } from './intrinsic-static-member.js'
import { isGlobalObjectConstructor } from './derived-expression-type.js'
import { unwrapErasedExpression } from './producers/erasure.js'
import type { InvocationOperation } from '../model/operations.js'

/** Source declaration and sealed mutation facts authenticate the actual Object entry. */
export const intrinsicObjectReturnIdentityOf = (
  context: Pick<ProducerContext, 'checker' | 'identities' | 'globalHostMutationTaint' | 'isStandardLibraryDeclaration'>,
  node: ts.CallExpression | ts.NewExpression,
  callee: ts.Node
): Pick<InvocationOperation, 'intrinsicReturnIdentity' | 'intrinsicIntegrity'> | null => {
  if (
    !ts.isCallExpression(node) ||
    !ts.isPropertyAccessExpression(callee) ||
    node.arguments.length === 0 ||
    node.arguments.some(ts.isSpreadElement)
  )
    return null
  const owner = callee.expression
  const member = callee.name.text
  if (
    !isGlobalObjectConstructor(context.checker, owner, context.checker.getTypeAtLocation(owner)) ||
    !intrinsicStaticMemberIsIntact(
      context,
      context.checker.getSymbolAtLocation(owner),
      context.checker.getSymbolAtLocation(callee.name),
      owner
    )
  )
    return null
  if (member === 'freeze' || member === 'seal' || member === 'preventExtensions')
    return { intrinsicReturnIdentity: 'argument0', intrinsicIntegrity: member }
  if (member === 'defineProperty' || member === 'defineProperties') return { intrinsicReturnIdentity: 'argument0' }
  if (member !== 'assign') return null
  // Object.assign first performs ToObject. A primitive target would acquire a
  // fresh wrapper, so a result of the same checker type is insufficient.
  const objectType = (type: ts.Type): boolean =>
    type.isUnionOrIntersection() ? type.types.every(objectType) : (type.flags & ts.TypeFlags.Object) !== 0
  return objectType(context.checker.getTypeAtLocation(unwrapErasedExpression(node.arguments[0]!)))
    ? { intrinsicReturnIdentity: 'argument0' }
    : null
}
