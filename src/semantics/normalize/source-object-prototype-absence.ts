import ts from 'typescript'
import type { IntrinsicProtocolRequirement } from './deferred-intrinsic-protocols.js'
import { intrinsicPrototypeKeyIsAbsent } from './intrinsic-prototype.js'

/** Declaration absence and final mutation intactness are separate facts.
 * Only the actual standard Object prototype can supply this obligation.
 * @semanticCategory generic-primitive
 */
export const sourceObjectPrototypeAbsenceOf = (
  checker: ts.TypeChecker,
  names: readonly string[],
  location: ts.Node
): IntrinsicProtocolRequirement | null => {
  const owner = checker.resolveName('Object', location, ts.SymbolFlags.Value, false)
  if (
    !owner?.valueDeclaration?.getSourceFile().hasNoDefaultLib ||
    !owner.declarations?.every((declaration) => declaration.getSourceFile().hasNoDefaultLib)
  )
    return null
  const prototype = checker.getTypeOfSymbolAtLocation(owner, location).getProperty('prototype')
  if (!prototype?.declarations?.length || !prototype.declarations.every((declaration) => declaration.getSourceFile().hasNoDefaultLib))
    return null
  const type = checker.getTypeOfSymbolAtLocation(prototype, location)
  return names.some((key) => !intrinsicPrototypeKeyIsAbsent(checker, 'Object', type, key))
    ? null
    : { intrinsic: 'Object', prototypeKeys: { names }, prototypeAbsentNames: names, location }
}
