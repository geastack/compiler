import ts from 'typescript'
import type { ValueFlowIndex } from './model.js'
import { outermostErasureOf } from '../producers/erasure.js'
import { isTypePositionReference, namespaceMemberDeclarationOf } from './targets.js'

/**
 * A declaration that puts a source method in a class's non-static prototype
 * slot -- the only member shape whose value is a body this compiler has walked
 * and whose slot the class itself, rather than a constructor assignment,
 * created.
 *
 * Exported because two proofs need the same admission and a second spelling of
 * it would be two authorities on what a method slot is: the identity
 * observation below, and `sourceClassCallableMemberPlanOf`'s question of which
 * bodies a key on this family resolves to.
 */
export const isSourceInstanceMethod = (declaration: ts.Declaration): boolean =>
  ts.isMethodDeclaration(declaration) &&
  declaration.body !== undefined &&
  !declaration.getSourceFile().isDeclarationFile &&
  (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Static) === 0

const keyOf = (access: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null =>
  ts.isPropertyAccessExpression(access)
    ? access.name.text
    : ts.isStringLiteralLike(access.argumentExpression)
      ? access.argumentExpression.text
      : null

/** A source prototype METHOD can be observed for strict identity without
 * handing out the prototype or executing a receiver-bearing callback. The
 * caller still validates every constructor/prototype reference, including
 * the declaring base classes: this helper alone does not prove descriptors
 * immutable. Aliases are accepted only when all their graph-visible uses are
 * identity observations. Module import/export references use the same closed
 * source graph inventory as their owning constructor.
 */
export const sourcePrototypeMethodIdentityUseOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  reference: ts.Expression,
  instance: ts.InterfaceType
): boolean => {
  const prototype = reference.parent
  if (
    (!ts.isPropertyAccessExpression(prototype) && !ts.isElementAccessExpression(prototype)) ||
    prototype.expression !== reference ||
    keyOf(prototype) !== 'prototype'
  )
    return false
  const selected = outermostErasureOf(prototype)
  const access = selected.parent
  if ((!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) || access.expression !== selected) return false
  const key = keyOf(access)
  const method = key === null ? undefined : checker.getPropertyOfType(instance, key)
  if (!method?.declarations?.length || !method.declarations.every(isSourceInstanceMethod)) return false
  const seen = new Set<ts.Node>()
  const observed = (expression: ts.Expression): boolean => {
    if (seen.has(expression)) return true
    seen.add(expression)
    const current = outermostErasureOf(expression) as ts.Expression
    const parent = current.parent
    if (!parent) return false
    if (
      ts.isBinaryExpression(parent) &&
      (parent.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken ||
        parent.operatorToken.kind === ts.SyntaxKind.ExclamationEqualsEqualsToken)
    )
      return true
    if (!ts.isVariableDeclaration(parent) || parent.initializer !== current || !ts.isIdentifier(parent.name)) return false
    if ((parent.parent.flags & ts.NodeFlags.Const) === 0) return false
    const writes = flow.writesToDeclaration(parent).filter((write) => write.slot === 'whole')
    if (writes.some((write) => write.edge !== 'declaration-initializer' || write.value !== parent.initializer)) return false
    return flow.referencesToDeclaration(parent).every((mention) => {
      if (mention === parent.name || isTypePositionReference(mention)) return true
      const use = mention.parent
      if (ts.isImportSpecifier(use) || ts.isExportSpecifier(use)) return true
      const selected =
        ((ts.isPropertyAccessExpression(use) && use.name === mention) ||
          (ts.isElementAccessExpression(use) && use.argumentExpression === mention)) &&
        namespaceMemberDeclarationOf(checker, use) === parent
          ? use
          : mention
      return observed(selected)
    })
  }
  return observed(access)
}
