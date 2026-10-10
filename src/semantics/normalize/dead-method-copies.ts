import ts from 'typescript'
import type { DeclarationId } from '../../identity/ids.js'
import type { ClassCopyAncestor } from '../class-heritage.js'
import type { IdentityTable, SpecializationPath } from './identities.js'
import type { SpecializationCensus } from './specialization.js'

/**
 * Which copies of an abstract generic class's method body no instance can run.
 *
 * `reachability.ts` opens an instance method by KEY, for every copy at once:
 * a live spelling of `handleOk` anywhere keeps `Operation.handleOk` in
 * the program. That is the right cut for a method with one body, and too
 * coarse for a generic class's method, which has one body PER COPY with a
 * different type in it. A
 *
 *   abstract class Operation<TResult> {
 *     handleOk(response: Response): TResult {
 *       return response.toObject(this.options) as TResult
 *     }
 *   }
 *
 * is inherited (or reached through `super.handleOk`) only by the operations
 * whose `TResult` is a document; every operation at `number`, `boolean`,
 * `string[]` or a cursor response overrides it and never calls up. The copies
 * at those fillings are therefore bodies no dispatch lands on -- and they are
 * exactly the ones where `as TResult` has no native meaning (a dictionary is
 * not a number), so censusing them refused the program over code that never
 * runs.
 *
 * A copy of `C.m` is dead when EVERY way the language reaches it is shut:
 *
 * - `C` is `abstract`, so no instance is a bare `C`. Every instance is some
 *   concrete descendant `X`, and a lookup of `m` on it stops at the first
 *   class from `X` up that gives `m` a runtime definition (a method or
 *   accessor with a body, a field with an initializer). Only a descendant
 *   whose lookup gets past every class below `C` reaches `C.m` -- and it
 *   reaches the copy of `C` its heritage chain names
 *   (`classCopyHeritageOf`, the same chain its struct is built from).
 * - `super.m` in a class whose nearest definition of `m` above it is `C`'s
 *   reaches `C.m` in the copy that class's chain names.
 * - Nothing reads the prototype of `C` or of a descendant (`X.prototype`,
 *   `Object.getPrototypeOf(x)`), which could hand `C.prototype.m` out
 *   without an instance lookup; a dynamic read cannot reach a class method at
 *   all (`emit-properties.ts` refuses a dynamic method key by name).
 *
 * Wherever an answer is not available -- a descendant whose chain names no
 * copy of `C`, a heritage that is not a straight chain, a class nested inside
 * another generic, a decorator -- every copy is live. The dead copy keeps its
 * DECLARATION: it is censused exactly as an `abstract` member is, so the key
 * still roots its dispatch family (`projection/dispatch.ts`) and every
 * override still lands in it.
 */
export interface DeadMethodCopies {
  readonly bodyIsDeadIn: (method: ts.MethodDeclaration, path: SpecializationPath) => boolean
}

export const noDeadMethodCopies: DeadMethodCopies = { bodyIsDeadIn: () => false }

const hasModifier = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some((modifier) => modifier.kind === kind) ?? false)

const hasDecorators = (node: ts.Node): boolean => ts.canHaveDecorators(node) && (ts.getDecorators(node)?.length ?? 0) > 0

const memberNameText = (name: ts.PropertyName | undefined): string | null => {
  if (!name) return null
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return null
}

export const deadMethodCopiesOf = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  specializations: SpecializationCensus,
  files: readonly ts.SourceFile[],
  heritage: ReadonlyMap<DeclarationId, readonly DeclarationId[]>,
  copyHeritage: ReadonlyMap<DeclarationId, ReadonlyMap<number | null, readonly ClassCopyAncestor[]>>
): DeadMethodCopies => {
  const classes = new Map<DeclarationId, ts.ClassLikeDeclaration>()
  const superReads: ts.Node[] = []
  const prototypeReads: ts.Expression[] = []
  // A class whose `extends` names no class declaration (`extends Ctor`, a
  // parameter typed `typeof URLSearchParams`) inherits from whatever value
  // arrives there: its chain is unknown, so it may descend from any class
  // whose instances its base type admits. Kept as that base instance type.
  const opaqueBases: ts.Type[] = []
  const insideGeneric = (node: ts.Node): boolean => {
    for (let parent = node.parent; parent; parent = parent.parent) if (specializations.isGeneric(parent as ts.Declaration)) return true
    return false
  }
  for (const file of files) {
    if (file.isDeclarationFile) continue
    const visit = (node: ts.Node): void => {
      if (ts.isClassLike(node)) {
        classes.set(identities.declarationIdOf(node), node)
        const base = node.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression
        if (base) {
          let symbol = checker.getSymbolAtLocation(base)
          if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol)
          const declared = symbol?.declarations?.some(
            (declaration) => ts.isClassLike(declaration) || ts.isInterfaceDeclaration(declaration)
          )
          if (!declared) {
            const constructed = checker.getTypeAtLocation(base).getConstructSignatures()[0]?.getReturnType()
            opaqueBases.push(constructed ?? checker.getAnyType())
            if (process.env['GEA_DEAD_METHOD_COPIES_DEBUG']) {
              process.stderr.write(
                `[DEAD-COPY-OPAQUE] ${file.fileName}:${file.getLineAndCharacterOfPosition(base.getStart()).line + 1} ${base.getText()}\n`
              )
            }
          }
        }
      }
      if (
        (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
        node.expression.kind === ts.SyntaxKind.SuperKeyword
      ) {
        superReads.push(node)
      }
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'prototype') prototypeReads.push(node.expression)
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === 'getPrototypeOf' &&
        node.arguments[0] !== undefined
      ) {
        prototypeReads.push(node.arguments[0])
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }

  const idOfType = (type: ts.Type): DeclarationId | null => {
    const node = type.getSymbol()?.declarations?.find((declaration) => ts.isClassLike(declaration))
    return node && ts.isClassLike(node) ? identities.declarationIdOf(node) : null
  }

  // The class `node` is inside, as far as `super` is concerned: arrows and
  // their bodies inherit it, any other function does not.
  const homeClassOf = (node: ts.Node): ts.ClassLikeDeclaration | null => {
    for (let parent = node.parent; parent; parent = parent.parent) {
      if (ts.isClassLike(parent)) return parent
      if (ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isObjectLiteralExpression(parent)) return null
    }
    return null
  }

  const definesAtRuntime = (node: ts.ClassLikeDeclaration, key: string): boolean =>
    node.members.some((member) => {
      if (hasModifier(member, ts.SyntaxKind.StaticKeyword) || memberNameText(member.name) !== key) return false
      if (ts.isMethodDeclaration(member) || ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member)) {
        return member.body !== undefined
      }
      if (ts.isPropertyDeclaration(member)) return !hasModifier(member, ts.SyntaxKind.DeclareKeyword) && member.initializer !== undefined
      return false
    })

  // `heritage` lists every ancestor, nearest first; a straight chain is one
  // where each ancestor's own list is the rest of it. Anything else (a
  // re-parented prototype, an interface merged beside a class) has no single
  // lookup order to reason about.
  const straightChainOf = (id: DeclarationId): readonly DeclarationId[] | null => {
    const chain = heritage.get(id) ?? []
    for (const [index, ancestor] of chain.entries()) {
      const rest = heritage.get(ancestor) ?? []
      if (rest.length !== chain.length - index - 1 || rest.some((one, at) => one !== chain[index + 1 + at])) return null
    }
    return chain
  }

  // The copies of `owner` that `from`'s copies reach, or `null` when some copy
  // of `from` names no copy of it.
  const copiesReachedFrom = (from: DeclarationId, owner: DeclarationId): readonly number[] | null => {
    const published = copyHeritage.get(from)
    if (!published || published.size === 0) return null
    const reached: number[] = []
    for (const chain of published.values()) {
      const step = chain.find((ancestor) => ancestor.declaration === owner)
      if (!step || step.ordinal === null) return null
      reached.push(step.ordinal)
    }
    return reached
  }

  // The key a `super` read names: its text, `null` for a symbol (which is
  // never a method's string key), `'unknown'` for a key only known at run time.
  const superKeyOf = (read: ts.Node): string | null | 'unknown' => {
    if (ts.isPropertyAccessExpression(read)) return read.name.text
    if (!ts.isElementAccessExpression(read)) return 'unknown'
    const type = checker.getTypeAtLocation(read.argumentExpression)
    if (type.isStringLiteral()) return type.value
    if (type.flags & ts.TypeFlags.ESSymbolLike) return null
    return 'unknown'
  }

  const liveCopies = new Map<ts.MethodDeclaration, ReadonlySet<number> | 'every'>()
  const liveCopiesOf = (method: ts.MethodDeclaration): ReadonlySet<number> | 'every' => {
    const known = liveCopies.get(method)
    if (known !== undefined) return known
    const every = (site: string): 'every' => {
      if (process.env['GEA_DEAD_METHOD_COPIES_DEBUG']) process.stderr.write(`[DEAD-COPY-WHY] ${memberNameText(method.name)} ${site}\n`)
      return 'every'
    }
    const compute = (): ReadonlySet<number> | 'every' => {
      const owner = method.parent
      const key = memberNameText(method.name)
      if (key === null || !ts.isClassDeclaration(owner) || owner.name === undefined) return every('unnamed member')
      const ownerSymbol = checker.getSymbolAtLocation(owner.name)
      const ownerInstance = ownerSymbol ? checker.getDeclaredTypeOfSymbol(ownerSymbol) : null
      if (ownerInstance === null) return every('owner type')
      for (const base of opaqueBases) {
        if (base.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown) || checker.isTypeAssignableTo(ownerInstance, base))
          return every('opaque heritage admits the owner')
      }
      if (!hasModifier(owner, ts.SyntaxKind.AbstractKeyword) || hasDecorators(owner) || hasDecorators(method))
        return every('owner not abstract or decorated')
      if (hasModifier(method, ts.SyntaxKind.StaticKeyword) || method.body === undefined || insideGeneric(owner))
        return every('static, bodiless or nested')
      if (!specializations.isGeneric(owner) || specializations.isGeneric(method)) return every('not a copy')
      const ownerId = identities.declarationIdOf(owner)
      const descends = (id: DeclarationId): boolean => id === ownerId || (heritage.get(id) ?? []).includes(ownerId)
      for (const read of prototypeReads) {
        const type = checker.getTypeAtLocation(read)
        const direct = idOfType(type)
        const constructed = type.getConstructSignatures()[0]?.getReturnType()
        const instance = constructed ? idOfType(constructed) : null
        if ((direct !== null && descends(direct)) || (instance !== null && descends(instance))) return every('prototype read')
      }
      const live = new Set<number>()
      const reach = (from: DeclarationId): boolean => {
        const reached = copiesReachedFrom(from, ownerId)
        if (reached === null) return false
        for (const ordinal of reached) live.add(ordinal)
        return true
      }
      for (const [id, node] of classes) {
        if (id === ownerId || !(heritage.get(id) ?? []).includes(ownerId)) continue
        const chain = straightChainOf(id)
        if (chain === null) return every('descendant chain not straight')
        const below = [id, ...chain.slice(0, chain.indexOf(ownerId))]
        const shadowed = below.some((one) => {
          const declaration = classes.get(one)
          return declaration !== undefined && definesAtRuntime(declaration, key)
        })
        if (below.some((one) => !classes.has(one))) return every('descendant chain leaves the program')
        if (!shadowed && !hasModifier(node, ts.SyntaxKind.AbstractKeyword) && !reach(id)) return every('descendant chain names no copy')
      }
      for (const read of superReads) {
        const name = superKeyOf(read)
        if (name === 'unknown') return every('computed super key')
        if (name !== key) continue
        const home = homeClassOf(read)
        if (home === null) return every('super outside a class')
        const homeId = identities.declarationIdOf(home)
        const chain = straightChainOf(homeId)
        if (chain === null) return every('super home chain not straight')
        const target = chain.find((one) => {
          const declaration = classes.get(one)
          return declaration !== undefined && definesAtRuntime(declaration, key)
        })
        if (target === ownerId && !reach(homeId)) return every('super home chain names no copy')
      }
      return live
    }
    const answer = compute()
    liveCopies.set(method, answer)
    return answer
  }

  return {
    bodyIsDeadIn: (method, path) => {
      const owner = method.parent
      if (!ts.isClassDeclaration(owner)) return false
      const subject = identities.genericSubjectOf(owner)
      const step = [...path].reverse().find((one) => one.owner === subject)
      if (step === undefined) return false
      const live = liveCopiesOf(method)
      const dead = live !== 'every' && !live.has(step.ordinal)
      if (process.env['GEA_DEAD_METHOD_COPIES_DEBUG']) {
        process.stderr.write(
          `[DEAD-COPY] ${owner.name?.text ?? '<anonymous>'}.${memberNameText(method.name)}@${step.ordinal} ` +
            `live=${live === 'every' ? 'every' : [...live].join(',')} dead=${dead}\n`
        )
      }
      return dead
    }
  }
}
