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
