import ts from 'typescript'
import type { DeclarationId } from '../identity/ids.js'
import type { IdentityTable } from './normalize/identities.js'
import { transparentConstClassAliasTarget } from './class-alias.js'

/**
 * Which classes each class INHERITS FROM, transitively -- the one fact two
 * separate carrier questions both need and neither can answer on its own.
 *
 * `representation/derive.ts` reduces `T & AggregateOperation` -- what
 * `operation instanceof AggregateOperation` narrows a `T extends
 * AbstractOperation` parameter to -- and a reduction is only sound when one
 * member is provably the other's ancestor, in which case the intersection IS
 * the more-derived class. `conversion/build.ts` enumerates the widening from
 * `class-ref(MongoRuntimeError)` to `class-ref(MongoError)` that `previous ??
 * new MongoRuntimeError(...)` needs, and a widening is only sound in the
 * ancestor direction. Both live below the semantic layer and neither may
 * import `typescript`, so the answer is resolved once here and installed as a
 * policy, the same way `KeyedCollectionPolicy` and `DateDeclarationPolicy`
 * are.
 *
 * The CHECKER answers it, not the heritage syntax: `class D extends mixin(B)`
 * states no name to read, and `getBaseTypes` follows the same chain
 * assignability does. That also makes this agree with
 * `projection/classes.ts`'s own `base` link by construction -- that one is
 * read off the evaluated heritage value's carrier for the same reason, so the
 * two never disagree about what a class extends, they only differ in how far
 * they follow it (one link versus the whole chain).
 *
 * Interfaces a class `implements` are deliberately absent. This states class
 * INHERITANCE -- shared storage and a shared struct base -- and an
 * implemented interface shares neither; `records.ts` emits `struct D : B` for
 * the base only. Claiming an interface here would license an upcast to a
 * carrier no C++ base subobject backs.
 */
export const classHeritageOf = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  files: readonly ts.SourceFile[],
  // `Object.setPrototypeOf(C.prototype, B.prototype)` makes `B` the class `C`
  // inherits from exactly as `extends B` would for member lookup and
  // `instanceof`; see `prototype-reparenting.ts` for when that is modelled.
  reparentedBaseOf: (node: ts.ClassLikeDeclaration) => ts.ClassLikeDeclaration | null = () => null
): ReadonlyMap<DeclarationId, readonly DeclarationId[]> => {
  const declarationOf = (type: ts.Type): { readonly node: ts.ClassLikeDeclaration; readonly id: DeclarationId } | null => {
    const symbol = type.getSymbol()
    const node = symbol?.declarations?.find((candidate) => ts.isClassLike(candidate))
    if (!node || !ts.isClassLike(node)) return null
    return { node, id: identities.declarationIdOf(node) }
  }

  const heritage = new Map<DeclarationId, readonly DeclarationId[]>()
  const active = new Set<DeclarationId>()

  const ancestorsOf = (node: ts.ClassLikeDeclaration, id: DeclarationId): readonly DeclarationId[] => {
    const known = heritage.get(id)
    if (known) return known
    // A cycle is not expressible in TypeScript, but a malformed or partially
    // resolved program can still present one, and answering the empty chain
    // for the node already being walked keeps this total rather than
    // recursing until the stack runs out.
    if (active.has(id)) return []
    active.add(id)
    const symbol = checker.getSymbolAtLocation(node.name ?? node)
    const declared = symbol ? checker.getDeclaredTypeOfSymbol(symbol) : null
    const chain: DeclarationId[] = []
    const syntacticBase = node.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression
    const aliasedBase = syntacticBase ? transparentConstClassAliasTarget(checker, syntacticBase) : null
    const aliasedSymbol = aliasedBase ? checker.getSymbolAtLocation(aliasedBase) : undefined
    const aliasedDeclaration = aliasedSymbol ? identities.declarationOfSymbol(aliasedSymbol) : null
    if (aliasedDeclaration && ts.isClassLike(aliasedDeclaration)) {
      const baseId = identities.declarationIdOf(aliasedDeclaration)
      chain.push(baseId)
      for (const further of ancestorsOf(aliasedDeclaration, baseId)) if (!chain.includes(further)) chain.push(further)
    }
    const reparented = reparentedBaseOf(node)
    if (reparented) {
      const baseId = identities.declarationIdOf(reparented)
      chain.push(baseId)
      for (const further of ancestorsOf(reparented, baseId)) if (!chain.includes(further)) chain.push(further)
    }
    for (const base of declared?.isClassOrInterface() ? checker.getBaseTypes(declared) : []) {
      const resolved = declarationOf(base)
      if (!resolved) continue
      if (!chain.includes(resolved.id)) chain.push(resolved.id)
      for (const further of ancestorsOf(resolved.node, resolved.id)) {
        if (!chain.includes(further)) chain.push(further)
      }
    }
    active.delete(id)
    heritage.set(id, chain)
    return chain
  }

  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isClassLike(node)) ancestorsOf(node, identities.declarationIdOf(node))
      ts.forEachChild(node, visit)
    }
    visit(file)
  }

  return heritage
}
