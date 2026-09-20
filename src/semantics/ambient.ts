import ts from 'typescript'

/**
 * Declared, never defined: what a host owns.
 *
 * A declaration file states that something exists; it never brings it into
 * being. That is the language's own notion, the same one `declare` spells
 * inside an ordinary file, and it is what separates a value the program owns
 * from one a host supplies. A symbol with even one non-ambient declaration is
 * defined by this program somewhere and is not a host's.
 *
 * This lives on its own rather than beside its callers because what they
 * decide with it is something a program cannot recover from being wrong about
 * -- placing a binding as an external cell, admitting a class into a library's
 * protocol -- and two spellings of "ambient" that drifted apart would disagree
 * silently on exactly the declarations that matter.
 */
/**
 * Whether an enclosing block put this declaration in an ambient context.
 *
 * `getCombinedModifierFlags` answers only for the declaration itself (and, for
 * a variable, its own statement). It walks out of neither `declare global { }`
 * nor `declare module 'x' { }`, whose `declare` sits on the block -- so a
 * function declared inside one carries no ambient modifier of its own and
 * reads as a definition this program owns.
 *
 * The parser does record it, as an internal `NodeFlags.Ambient` bit the public
 * typings do not expose; deriving the same fact from the ancestor chain asks
 * the same question through the API that is actually documented.
 */
const isInsideAmbientBlock = (declaration: ts.Declaration): boolean => {
  for (let node: ts.Node | undefined = declaration.parent; node !== undefined; node = node.parent) {
    if ((ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Ambient) !== 0) return true
  }
  return false
}

/**
 * The one-declaration half of the same fact.
 *
 * `isAmbientSymbol` asks it of every declaration a symbol has; a caller
 * holding a single `ts.Declaration` -- resolving which copy of a generic a
 * name means, say -- asks it of that one. Both go through this so the three
 * spellings of "ambient" below are stated once: a fourth caller deriving its
 * own is the drift this file exists to prevent.
 */
export const isAmbientDeclaration = (declaration: ts.Declaration): boolean =>
  declaration.getSourceFile().isDeclarationFile ||
  (ts.getCombinedModifierFlags(declaration) & ts.ModifierFlags.Ambient) !== 0 ||
  // The third spelling, and the one the other two miss.
  //
  // `declare global { function requestAnimationFrame(...): number }` in an
  // ordinary `.ts` file puts no `declare` modifier on the *function*: the
  // modifier is on the block, and `getCombinedModifierFlags` walks up only
  // from a variable declaration to its statement, not out of an ambient
  // module body. What the parser does instead is mark every node inside a
  // `declare` context with `NodeFlags.Ambient`, which is the language's own
  // answer to this exact question and is what the checker itself consults.
  //
  // Missing it made a host function look like one this program defines:
  // `canvas-3d` declares `requestAnimationFrame` that way, and the symbol
  // -- ambient in `lib`'s own `.d.ts` and ambient again here -- was judged
  // non-ambient on the strength of the second declaration. It then
  // allocated a function object with no body behind it, whose ABI declared
  // one parameter nothing could bind, and the whole program was refused.
  isInsideAmbientBlock(declaration)

export const isAmbientSymbol = (symbol: ts.Symbol): boolean => {
  const declarations = symbol.declarations
  if (!declarations || declarations.length === 0) return false
  return declarations.every(isAmbientDeclaration)
}

/**
 * Every declared base of a class or interface type, nearest first.
 *
 * A class can be recognized by what it derives from, and the base that
 * identifies it may be reached through an intermediate the program wrote
 * (`class View extends Base`, then `class Home extends View`). Stopping at the
 * immediate base would admit the first spelling and refuse the second for no
 * reason the program could act on, so the whole chain is walked -- and a type
 * visited twice is not revisited, because a declaration file is free to
 * declare a cycle this walk must still terminate on.
 */
export const declaredBaseTypesOf = (checker: ts.TypeChecker, type: ts.Type): readonly ts.Type[] => {
  const found: ts.Type[] = []
  const seen = new Set<ts.Type>()

  /**
   * The declaration-shaped type whose bases the checker will answer for.
   *
   * `getBaseTypes` answers only for the `ClassOrInterface` a declaration
   * produced. A *generic* class reached through an instantiation is not that:
   * `ReactiveComponent<unknown>` is a `Reference`, and its `target` is the
   * declaration-shaped type that actually states `extends Component<...>`.
   * Without this step the walk asked a reference for its bases, got none, and
   * stopped -- reporting a class that plainly extends something as having no
   * bases at all, at the first generic link in the chain.
   */
  const declarationShapeOf = (current: ts.Type): ts.InterfaceType | null => {
    if (current.isClassOrInterface()) return current
    if ((current.flags & ts.TypeFlags.Object) === 0) return null
    if (((current as ts.ObjectType).objectFlags & ts.ObjectFlags.Reference) === 0) return null
    const target = (current as ts.TypeReference).target
    return target !== current && target.isClassOrInterface() ? target : null
  }

  const visit = (current: ts.Type): void => {
    if (seen.has(current)) return
    seen.add(current)
    const declared = declarationShapeOf(current)
    const bases = declared ? checker.getBaseTypes(declared) : []
    for (const base of bases) {
      found.push(base)
      visit(base)
    }
  }
  visit(type)
  return found
}
