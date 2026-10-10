import ts from 'typescript'
import { isGlobalObjectConstructor, isStandardGlobalValue } from './derived-expression-type.js'
import { unwrapErasedExpression } from './producers/erasure.js'
import { intrinsicStaticMemberIsIntact } from './intrinsic-static-member.js'
import type { ProducerContext } from './producer-context.js'

/** The standard zero-argument constructor has one fresh ordinary result.
 * Declaration identity is the source fact; replacement of its binding or
 * prototype is independently discharged before operation publication.
 */
export const sourceFreshOrdinaryObjectOf = (checker: ts.TypeChecker, node: ts.Node): node is ts.CallExpression | ts.NewExpression => {
  if ((!ts.isCallExpression(node) && !ts.isNewExpression(node)) || (node.arguments?.length ?? 0) !== 0) return false
  const callee = unwrapErasedExpression(node.expression)
  const symbol = checker.getSymbolAtLocation(callee)
  return (
    ts.isIdentifier(callee) &&
    symbol?.valueDeclaration?.getSourceFile().hasNoDefaultLib === true &&
    symbol.declarations?.every((declaration) => declaration.getSourceFile().hasNoDefaultLib) === true &&
    isStandardGlobalValue(checker, callee, 'Object') &&
    isGlobalObjectConstructor(checker, callee, checker.getTypeAtLocation(callee))
  )
}

export const freshOrdinaryObjectOf = (context: ProducerContext, node: ts.CallExpression | ts.NewExpression): boolean => {
  if (!sourceFreshOrdinaryObjectOf(context.checker, node)) return false
  const callee = unwrapErasedExpression(node.expression)
  const owner = context.checker.getSymbolAtLocation(callee)
  const prototype = context.checker.getTypeAtLocation(callee).getProperty('prototype')
  return intrinsicStaticMemberIsIntact(context, owner, prototype, node)
}
