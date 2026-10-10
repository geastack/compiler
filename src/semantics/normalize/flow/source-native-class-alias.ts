import ts from 'typescript'
import { carriesUnsubstitutedGeneric } from '../parameter-bindings.js'
import { outermostErasureOf } from '../producers/erasure.js'
import { exactSourceConstructionOf } from './member-call-forwarding.js'
import type { ValueFlowIndex } from './model.js'
import { sourceValueSessionOf } from './source-value-session.js'
import { isModuleExportedDeclaration } from './targets.js'

/** An immutable local alias of one closed native class family retains that
 * allocation carrier. An `any` assertion does not allocate a dynamic owner;
 * every actual root and consumer still comes from the joint source solver.
 */
export const sourceNativeClassAliasTypeAt = (checker: ts.TypeChecker, flow: ValueFlowIndex, node: ts.Node): ts.Type | null => {
  const positioned = ts.isExpression(node) ? outermostErasureOf(node) : node
  const declaration = ts.isVariableDeclaration(node)
    ? node
    : ts.isIdentifier(node)
      ? flow.targetOf(node)?.declaration
      : // The mapper is also asked about the flow's synthetic stand-ins (a
        // shared `void 0` for an absent value) that no source tree parents.
        positioned.parent !== undefined && ts.isVariableDeclaration(positioned.parent) && positioned.parent.initializer === positioned
        ? positioned.parent
        : undefined
  if (
    !declaration ||
    !ts.isVariableDeclaration(declaration) ||
    !ts.isIdentifier(declaration.name) ||
    !declaration.initializer ||
    !ts.isVariableDeclarationList(declaration.parent) ||
    (declaration.parent.flags & ts.NodeFlags.Const) === 0 ||
    isModuleExportedDeclaration(checker, declaration, checker.getSymbolAtLocation(declaration.name) ?? null) ||
    (checker.getTypeAtLocation(declaration).flags & ts.TypeFlags.Any) === 0
  )
    return null
  const writes = flow.writesToDeclaration(declaration).filter((write) => write.slot === 'whole')
  if (writes.length !== 1 || writes[0]!.edge !== 'declaration-initializer' || writes[0]!.value !== declaration.initializer) return null
  const roots = sourceValueSessionOf(checker, flow).closedValuesOf(declaration.initializer)
  if (roots === null || roots.length === 0) return null
  let physical: ts.Type | null = null
  for (const root of roots) {
    if (!ts.isNewExpression(root)) return null
    const construction = exactSourceConstructionOf(checker, flow, root)
    const type = checker.getTypeAtLocation(root)
    const symbol = type.getSymbol()
    if (
      construction === null ||
      construction.alternatives.length !== 1 ||
      !symbol ||
      (symbol.flags & ts.SymbolFlags.Class) === 0 ||
      carriesUnsubstitutedGeneric(checker, type) ||
      type.getProperties().some((member) => carriesUnsubstitutedGeneric(checker, checker.getTypeOfSymbolAtLocation(member, root))) ||
      !symbol.declarations?.includes(construction.alternatives[0]!) ||
      (physical !== null && physical !== type)
    )
      return null
    physical = type
  }
  // TypeScript accepts the alias wherever its class is STRUCTURALLY
  // assignable, but a compiled class is nominal: `consume(forged)` with
  // `forged: any = new Wrong()` and `consume(value: Expected)` type-checks
  // through the `any`, and the program relies on that boundary to reject the
  // wrong class at run time. A read whose position names only classes this
  // one is not keeps the declared dynamic boundary instead of a native cell
  // no conversion leaves.
  if (physical !== null && flow.referencesToDeclaration(declaration).some((read) => !positionAdmitsClass(checker, read, physical!)))
    return null
  return physical
}

const absentOrDynamic = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Any | ts.TypeFlags.Unknown

const isClassInstance = (type: ts.Type): boolean => ((type.getSymbol()?.flags ?? 0) & ts.SymbolFlags.Class) !== 0

/** The class itself or any of its base classes. */
const derivesFrom = (type: ts.Type, base: ts.Type, seen = new Set<ts.Type>()): boolean => {
  if (seen.has(type)) return false
  seen.add(type)
  if (type.getSymbol() === base.getSymbol()) return true
  return (type.getBaseTypes?.() ?? []).some((parent) => derivesFrom(parent, base, seen))
}

const positionAdmitsClass = (checker: ts.TypeChecker, read: ts.Expression, physical: ts.Type): boolean => {
  const positioned = outermostErasureOf(read)
  if (positioned !== read) return true
  const contextual = checker.getContextualType(read)
  if (contextual === undefined) return true
  const all = contextual.isUnion() ? contextual.types : [contextual]
  if (all.some((part) => (part.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0)) return true
  const parts = all.filter((part) => (part.flags & absentOrDynamic) === 0)
  if (!parts.some(isClassInstance)) return true
  return parts.some((part) => (isClassInstance(part) ? derivesFrom(physical, part) : checker.isTypeAssignableTo(physical, part)))
}
