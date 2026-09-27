import ts from 'typescript'
import type { ValueFlowIndex } from './model.js'

/** A value no call or construction can invoke. `object` is refused with
 * `any`: it admits every function, so it cannot vouch that the value is data. */
const dataValue = (type: ts.Type): boolean =>
  type.isUnion()
    ? type.types.every(dataValue)
    : (type.flags &
        (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.TypeParameter | ts.TypeFlags.Never | ts.TypeFlags.NonPrimitive)) ===
        0 &&
      type.getCallSignatures().length === 0 &&
      type.getConstructSignatures().length === 0

/** A constructor's data field is a separate value, not a publication of the
 * constructor. The caller still checks every constructor reference, which
 * rejects descriptor/prototype mutation and ordinary constructor aliases.
 * Static `this` captures and callable values need receiver-flow evidence and
 * cannot use this data-only path.
 *
 * Data-ness is judged by the values actually written, never by the declared
 * type. Because the caller has explained every mention of the constructor,
 * no alias can store into the static, so its named writes are all it holds.
 * A declared type only states what a write MAY store: three's
 * `@type {?Image} Texture.DEFAULT_IMAGE = null` names a constructor type that
 * no write realises.
 */
export const sourceClassStaticDataUseOf = (checker: ts.TypeChecker, flow: ValueFlowIndex, reference: ts.Expression): boolean => {
  const access = reference.parent
  if ((!ts.isPropertyAccessExpression(access) && !ts.isElementAccessExpression(access)) || access.expression !== reference) return false
  const target = flow.targetOf(access)
  const declaration = target?.declaration
  if (!declaration || declaration.getSourceFile().isDeclarationFile) return false
  const staticField = ts.isPropertyDeclaration(declaration) && (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Static) !== 0
  const expando =
    (ts.isPropertyAccessExpression(declaration) || ts.isElementAccessExpression(declaration)) &&
    ts.isBinaryExpression(declaration.parent) &&
    declaration.parent.left === declaration &&
    declaration.parent.operatorToken.kind === ts.SyntaxKind.EqualsToken
  if (!staticField && !expando) return false
  if (flow.receiverReferencesToDeclaration(declaration).length > 0) return false
  const writes = flow.writesToDeclaration(declaration)
  return (
    writes.length > 0 &&
    writes.every(
      (write) =>
        write.slot === 'whole' &&
        (write.edge === 'class-field-initializer' || write.edge === 'property-assignment') &&
        write.value !== null &&
        dataValue(checker.getTypeAtLocation(write.value))
    )
  )
}

/** A literal that evaluates to a primitive and runs no code. */
const primitiveLiteral = (expression: ts.Expression): boolean => {
  let value = expression
  while (ts.isParenthesizedExpression(value)) value = value.expression
  return (
    ts.isNumericLiteral(value) ||
    ts.isStringLiteralLike(value) ||
    value.kind === ts.SyntaxKind.TrueKeyword ||
    value.kind === ts.SyntaxKind.FalseKeyword ||
    value.kind === ts.SyntaxKind.NullKeyword
  )
}

/**
 * `static { C.prototype.isC = true }` inside `C`'s own declaration: three's
 * `Vector2`/`Vector3`/`Vector4` and `Matrix2`/`Matrix3`/`Matrix4` type flags.
 * The statement installs one primitive data value on the prototype while the
 * class is being defined, before any instance exists, and hands the
 * constructor and the prototype nowhere: the prototype is read only to store
 * into it. So this mention of the class binding is not a publication of the
 * constructor.
 *
 * The key must not name a method or accessor anywhere the checker sees it on
 * the instance, so a proof that reads a method slot as the class's own body
 * (`sourcePrototypeMethodIdentityUseOf`, the callable member plan) is never
 * contradicted by this store. Reading the installed key is the ordinary data
 * member plan: the checker gives the instance type the member, declared by
 * this very assignment.
 */
export const sourcePrototypeDataInstallUseOf = (
  checker: ts.TypeChecker,
  reference: ts.Expression,
  owner: ts.ClassLikeDeclaration,
  instance: ts.Type
): boolean => {
  const prototype = reference.parent
  if (!ts.isPropertyAccessExpression(prototype) || prototype.expression !== reference || prototype.name.text !== 'prototype') return false
  const slot = prototype.parent
  if (!ts.isPropertyAccessExpression(slot) || slot.expression !== prototype) return false
  const store = slot.parent
  if (!ts.isBinaryExpression(store) || store.left !== slot || store.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return false
  if (!primitiveLiteral(store.right)) return false
  const statement = store.parent
  if (!ts.isExpressionStatement(statement)) return false
  const block = statement.parent
  if (!ts.isBlock(block) || !ts.isClassStaticBlockDeclaration(block.parent) || block.parent.parent !== owner) return false
  const member = checker.getPropertyOfType(instance, slot.name.text)
  return (
    member?.declarations?.every(
      (declaration) =>
        !ts.isMethodDeclaration(declaration) &&
        !ts.isGetAccessorDeclaration(declaration) &&
        !ts.isSetAccessorDeclaration(declaration) &&
        !ts.isFunctionLike(declaration)
    ) ?? true
  )
}
