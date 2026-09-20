import ts from 'typescript'
import { heritageClassOrInterfaceOf } from './model.js'

/**
 * Shape half of the ordinary instanceof protocol proof. The caller must also
 * prove the constructor family's references closed: definitions cannot show
 * later defineProperty/setPrototypeOf calls or constructor escapes.
 *
 * Every source class initially inherits the realm's Function.prototype hook.
 * That intrinsic own property is nonwritable and nonconfigurable. Replacing a
 * global Function binding, or changing Function.prototype's parent, cannot
 * change it. Source static computed members can shadow it, so admit only keys
 * proven to be strings/numbers; unknown and symbol keys remain conservative.
 */
export const sourceClassHasDefaultInstanceOfShape = (checker: ts.TypeChecker, instance: ts.InterfaceType): boolean => {
  const seen = new Set<ts.Type>()
  const nonSymbolKey = (type: ts.Type): boolean =>
    type.isUnion() ? type.types.every(nonSymbolKey) : (type.flags & (ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike)) !== 0
  const visit = (type: ts.InterfaceType): boolean => {
    if (seen.has(type)) return false
    seen.add(type)
    const owner = type.getSymbol()?.valueDeclaration
    if (!owner || (!ts.isClassDeclaration(owner) && !ts.isClassExpression(owner)) || owner.getSourceFile().isDeclarationFile) return false
    for (const member of owner.members) {
      if ((ts.getCombinedModifierFlags(member) & ts.ModifierFlags.Static) === 0 || !member.name || !ts.isComputedPropertyName(member.name))
        continue
      if (!nonSymbolKey(checker.getTypeAtLocation(member.name.expression))) return false
    }
    const bases = checker.getBaseTypes(type) ?? []
    return bases.every((base) => {
      const declared = heritageClassOrInterfaceOf(base)
      return declared !== null && visit(declared)
    })
  }
  return visit(instance)
}
