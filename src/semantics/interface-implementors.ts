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
 * never walks it and NO BODY IS EMITTED. The measured shape:
 * a field `router: Router<T>` whose only implementation in the program is one
 * class; carried as the interface, the emitted program had no `add` and no
 * `match` anywhere in it. A program that composes several implementations of
 * the one interface makes the same slot a real sum with real dispatch. A union of class carriers already dispatches a
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
            if (!resolved) continue
            const claimed = identities.declarationIdOf(node)
            const seen = new Set<DeclarationId>()
            // Implementing a derived contract also implements its bases. A
            // direct-clause-only census loses that class when the value flows
            // through a base interface, falsely narrowing its carrier to a
            // different class that happened to name the base directly.
            const claim = (contract: typeof resolved): void => {
              if (seen.has(contract.id)) return
              seen.add(contract.id)
              if (declaresAMethod(contract.declaration)) {
                const existing = claims.get(contract.id)
                if (existing === undefined) claims.set(contract.id, [claimed])
                else if (!existing.includes(claimed)) existing.push(claimed)
              }
              for (const heritage of contract.declaration.heritageClauses ?? []) {
                for (const base of heritage.types) {
                  const parent = interfaceOf(base)
                  if (parent) claim(parent)
                }
              }
            }
            claim(resolved)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }

  // Classes the program STORES into a slot typed by the interface: see
  // `interfaceFlowImplementorsOf` below.
  for (const [declaration, classes] of interfaceFlowImplementorsOf(checker, files)) {
    const id = identities.declarationIdOf(declaration)
    const existing = claims.get(id) ?? []
    for (const claimed of classes) {
      const claimedId = identities.declarationIdOf(claimed)
      if (!existing.includes(claimedId)) existing.push(claimedId)
    }
    claims.set(id, existing)
  }

  return claims
}

/**
 * Classes the program STORES into a slot typed by an interface, for an
 * interface nothing but class instances ever enters. An internal
 * `interface WithState { s: { state: string }; emit(...) }` is no class's
 * declared contract -- several classes each pass `this` to one shared
 * `transition(target, next)` that writes `target.s.state`. Carried as the
 * interface's own struct, every call rebuilt a fresh `{ s: { state } }` out of
 * the instance and the write landed in the copy: the object never left its
 * initial state, and the next operation that checked it failed.
 *
 * This is the whole-program form of the `implements` rule above, so it keeps
 * that rule's premise honest: EVERY value the program writes into such a
 * slot is examined (by the checker's contextual type, which is what makes a
 * position a slot of that type), and a single one that is not a class
 * instance -- an object literal, an `any`, another interface -- withdraws the
 * interface entirely. The interface must declare a method (the rule above's
 * reason) and take no type parameters.
 */
export const interfaceFlowImplementorsOf = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[]
): ReadonlyMap<ts.InterfaceDeclaration, readonly ts.ClassLikeDeclaration[]> => {
  const declaresAMethod = (declaration: ts.InterfaceDeclaration): boolean =>
    declaration.members.some((member) => ts.isMethodSignature(member))
  const candidates = new Map<ts.Symbol, ts.InterfaceDeclaration>()
  for (const file of files) {
    if (file.isDeclarationFile) continue
    const collect = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node) && !node.typeParameters && declaresAMethod(node)) {
        const symbol = checker.getSymbolAtLocation(node.name)
        if (symbol && symbol.declarations?.length === 1) candidates.set(symbol, node)
      }
      ts.forEachChild(node, collect)
    }
    collect(file)
  }
  const result = new Map<ts.InterfaceDeclaration, ts.ClassLikeDeclaration[]>()
  if (candidates.size === 0) return result
  const poisoned = new Set<ts.Symbol>()
  const flowed = new Map<ts.Symbol, ts.ClassLikeDeclaration[]>()
  const candidateOf = (type: ts.Type): ts.Symbol | undefined => {
    const symbol = type.getSymbol()
    return symbol !== undefined && candidates.has(symbol) ? symbol : undefined
  }
  const interfaceSymbolsOf = (type: ts.Type): ts.Symbol[] =>
    (type.isUnion() ? type.types : [type]).flatMap((member) => {
      const symbol = candidateOf(member)
      return symbol ? [symbol] : []
    })
  const absent = ts.TypeFlags.Null | ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Never
  const classesOf = (type: ts.Type): readonly ts.ClassLikeDeclaration[] | null => {
    const found: ts.ClassLikeDeclaration[] = []
    for (const member of type.isUnion() ? type.types : [type]) {
      if (member.flags & absent || candidateOf(member)) continue
      const constraint = member.isTypeParameter() ? checker.getBaseConstraintOfType(member) : member
      const symbol = constraint?.getSymbol()
      const declaration = symbol && symbol.flags & ts.SymbolFlags.Class ? symbol.declarations?.find(ts.isClassLike) : undefined
      if (!declaration) return null
      found.push(declaration)
    }
    return found
  }
  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isExpression(node) && !(node.parent && ts.isParenthesizedExpression(node.parent))) {
        const contextual = checker.getContextualType(node)
        const slots = contextual ? interfaceSymbolsOf(contextual) : []
        if (slots.length > 0) {
          const classes = classesOf(checker.getTypeAtLocation(node))
          for (const slot of slots) {
            if (classes === null) {
              poisoned.add(slot)
              continue
            }
            const known = flowed.get(slot) ?? []
            for (const declaration of classes) if (!known.includes(declaration)) known.push(declaration)
            flowed.set(slot, known)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  for (const [symbol, classes] of flowed) if (!poisoned.has(symbol) && classes.length > 0) result.set(candidates.get(symbol)!, classes)
  return result
}
