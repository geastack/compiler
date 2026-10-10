import ts from 'typescript'

/**
 * A symbol's first declaration -- except where a CLASS merges with an
 * interface, where it is the class's.
 *
 * That merge is one type written twice: the class's instance type IS the
 * merged interface, so anchoring on the class moves no cycle (unlike the
 * `interface Error` + `declare var Error` merge `declarationOfSymbol`
 * describes, whose value half has a different type). And it is required,
 * because every class census -- evaluation, construct convention, member
 * publication, specialization -- keys on the class node, while a lookup
 * through the symbol answered the interface whenever it is written first.
 * A `TypedEventEmitter` class+interface merge is written that way: its subclasses' implicit
 * `super()` found "no construct convention" under the interface's id and its
 * instances were laid out as a plain record.
 *
 * The merge's TYPE PARAMETERS are one symbol too, declared once per half, so
 * the same rule picks the class's list -- which is what a specialization of
 * the class is recorded against.
 */
export const mergedDeclarationOf = (symbol: ts.Symbol): ts.Declaration | null => {
  const declarations = symbol.getDeclarations() ?? []
  if (declarations.length > 1) {
    if ((symbol.flags & ts.SymbolFlags.Class) !== 0 && (symbol.flags & ts.SymbolFlags.Interface) !== 0) {
      const merged = declarations.find(ts.isClassLike)
      if (merged) return merged
    }
    if ((symbol.flags & ts.SymbolFlags.TypeParameter) !== 0) {
      const merged = declarations.find((declaration) => ts.isClassLike(declaration.parent))
      if (merged) return merged
    }
  }
  return declarations[0] ?? null
}

/**
 * The base-class member a class instance actually installs under a name its
 * merged interface only RE-DECLARES -- or `null` when the member is anything
 * else.
 *
 * `interface TypedEventEmitter<Events> extends EventEmitter { emit<K>(event:
 * K | symbol, ...args: Parameters<Events[K]>): boolean }` merged with an
 * empty `class TypedEventEmitter<Events> extends EventEmitter {}` is a common
 * way for a library to type its events. The interface member has no body: every
 * `this.emit(...)` runs `EventEmitter.emit`, whatever the merged signature
 * says, so the value -- and the frame a call passes its arguments in -- is
 * the base class's. Laying the call out from the typing view gave it a packed
 * tuple of the event's parameters where the body takes an array of values:
 * a direct call C++ could not compile.
 *
 * Only where EVERY declaration is an interface signature on an interface
 * merged with a class: a class that declares the member itself installs its
 * own body, and a plain interface has no class body to find.
 */
export const inheritedImplementationOf = (checker: ts.TypeChecker, member: ts.Symbol): ts.Symbol | null => {
  const declarations = member.declarations ?? []
  let merged: ts.ClassLikeDeclaration | null = null
  for (const declaration of declarations) {
    if (!ts.isMethodSignature(declaration) || !ts.isInterfaceDeclaration(declaration.parent)) return null
    const owner = checker.getSymbolAtLocation(declaration.parent.name)
    const cls = owner && (owner.flags & ts.SymbolFlags.Class) !== 0 ? owner.declarations?.find(ts.isClassLike) : undefined
    if (!cls || (merged !== null && merged !== cls)) return null
    merged = cls
  }
  const owner = merged?.name ? checker.getSymbolAtLocation(merged.name) : undefined
  if (!owner) return null
  const instance = checker.getDeclaredTypeOfSymbol(owner)
  if (!instance.isClassOrInterface()) return null
  for (const base of checker.getBaseTypes(instance)) {
    const implementation = checker.getPropertyOfType(base, member.getName())
    const installed = implementation?.declarations?.some(
      (declaration) => (ts.isMethodDeclaration(declaration) || ts.isPropertyDeclaration(declaration)) && ts.isClassLike(declaration.parent)
    )
    if (implementation && installed) return implementation
  }
  return null
}
