import ts from 'typescript'
import type { DeclarationId } from '../identity/ids.js'
import type { IdentityTable } from './normalize/identities.js'

/**
 * Every class that `implements` an interface, for an interface at least one
 * class in the program implements.
 *
 * JavaScript has no interfaces. An `interface` states what may be READ out of
 * a slot; nothing ever constructs one, so nothing is ever *of* that type -- a
 * slot typed by an interface holds whatever object the program put there. When
 * the program declares which classes are that interface's implementations,
 * those classes are the only objects any such slot can hold, and the slot's
 * storage is therefore ONE of them: the class itself when there is one, the
 * tagged sum of them when there are several.
 *
 * Carrying the interface instead is not merely wide, it is WRONG in a way no
 * amount of boxing fixes: a class's methods are free functions taking the
 * instance, not storage, while an interface's method members are storage. So
 * the interface's struct has `gea::CallableObject` members nothing can fill,
 * the class instance does not assign into it, and -- worst -- a call written
 * `slot.method(...)` never reaches the class's method at all, so the census
 * never walks it and NO BODY IS EMITTED. hono is the measured case:
 * `HonoBase.router` is a `Router<[H, RouterRoute]>` and `PatternRouter` is the
 * only implementation `hono/tiny` contains; carried as the interface, the
 * emitted program had no `add` and no `match` anywhere in it. The full `hono`
 * entry holds a `SmartRouter` over a `RegExpRouter` and a `TrieRouter` -- three
 * implementations of the one interface -- and the same slot is then a real
 * sum with real dispatch. A union of class carriers already dispatches a
 * member call per arm (`test/runtime/class-union-slot-method-dispatch.ts`),
 * so the sum is the honest carrier rather than a refusal.
 *
 * ## What it refuses, and why each refusal is the whole point
 *
 * - An interface implemented by no class. There is nothing to answer with.
 * - An interface with no METHOD member. A pure data interface is a shape an
 *   object literal satisfies as readily as a class does, and this rule's
 *   premise -- that only the classes can inhabit it -- does not hold there.
 *   `Router` declares `add` and `match`, which is what makes it a behaviour
 *   rather than a record.
 * - A class whose `implements` clause this cannot resolve to exactly one
 *   interface declaration.
 *
 * The `implements` clause is read SYNTACTICALLY, unlike `classHeritageOf`'s
 * checker-answered `extends` walk, and deliberately: this states what the
 * AUTHOR declared to be the implementations of a named contract. Structural
 * satisfaction is a different question with a different answer (every object
 * literal of the right shape satisfies `Router`), and answering it here would
 * make the rule fire on data interfaces it must not touch.
 *
 * Classes are listed in source order, first file first, so the sum's arm
 * order -- and with it the emitted output -- is a function of the program.
 */
export const interfaceImplementorsOf = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  files: readonly ts.SourceFile[]
): ReadonlyMap<DeclarationId, readonly DeclarationId[]> => {
  const claims = new Map<DeclarationId, DeclarationId[]>()

  const interfaceOf = (
    node: ts.ExpressionWithTypeArguments
  ): { readonly id: DeclarationId; readonly declaration: ts.InterfaceDeclaration } | null => {
    const symbol = checker.getSymbolAtLocation(ts.isIdentifier(node.expression) ? node.expression : node)
    const target = symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol
    const declarations = target?.declarations
    const sole = declarations && declarations.length === 1 ? declarations[0] : undefined
    if (!sole || !ts.isInterfaceDeclaration(sole)) return null
    return { id: identities.declarationIdOf(sole), declaration: sole }
  }

  const declaresAMethod = (declaration: ts.InterfaceDeclaration): boolean =>
    declaration.members.some((member) => ts.isMethodSignature(member))

  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isClassLike(node)) {
        for (const clause of node.heritageClauses ?? []) {
          if (clause.token !== ts.SyntaxKind.ImplementsKeyword) continue
          for (const typeNode of clause.types) {
            const resolved = interfaceOf(typeNode)
            if (!resolved || !declaresAMethod(resolved.declaration)) continue
            const claimed = identities.declarationIdOf(node)
            const existing = claims.get(resolved.id)
            if (existing === undefined) claims.set(resolved.id, [claimed])
            else if (!existing.includes(claimed)) existing.push(claimed)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }

  return claims
}
