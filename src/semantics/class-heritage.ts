import ts from 'typescript'
import type { DeclarationId } from '../identity/ids.js'
import type { IdentityTable, SpecializationPath } from './normalize/identities.js'
import type { SpecializationCensus } from './normalize/specialization.js'
import { heritageCopyOf } from './normalize/structural-generics.js'
import { classHeritageTarget } from './class-alias.js'

/**
 * Which classes each class INHERITS FROM, transitively -- the one fact two
 * separate carrier questions both need and neither can answer on its own.
 *
 * `representation/derive.ts` reduces `T & DerivedOperation` -- what
 * `operation instanceof DerivedOperation` narrows a `T extends
 * Operation` parameter to -- and a reduction is only sound when one
 * member is provably the other's ancestor, in which case the intersection IS
 * the more-derived class. `conversion/build.ts` enumerates the widening from
 * `class-ref(RuntimeError)` to `class-ref(LibError)` that `previous ??
 * new RuntimeError(...)` needs, and a widening is only sound in the
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
    const aliasedBase = syntacticBase ? classHeritageTarget(checker, syntacticBase) : null
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

/** One ancestor of a class copy: the ancestor's root declaration and the copy of it inherited, `null` for a non-generic one. */
export interface ClassCopyAncestor {
  readonly declaration: DeclarationId
  readonly ordinal: number | null
}

/**
 * `classHeritageOf`'s chain for each COPY of a class, naming which copy of
 * every generic ancestor that copy derives from.
 *
 * `classHeritageOf` names roots, and a root is the whole answer while a class
 * has one layout. Once a generic base's copies differ in layout
 * (`SpecializationCensus.copiesMayDifferInLayout`) its root owns no struct:
 * `Derived<{ a: string }>` derives from `Base<{ a: string }>`'s copy, and the
 * upcast its receiver takes into a method `Base` declares
 * (`conversion/build.ts`'s class-ref pairs) is only licensed when the
 * derived carrier's ancestors name that copy. The copy is the one the
 * `extends` clause names under the derived copy's substitution
 * (`heritageCopyOf`) -- the same site the derived copy's struct resolves its
 * superclass through, so the carrier and the struct cannot disagree.
 *
 * Keyed by the class's root declaration, then by the copy's ordinal, or
 * `null` for a class outside every copy (a non-generic `class App extends
 * Base<string>`) and for a generic class the program instantiates exactly
 * once. Only chains naming at least one copy are published; the rest are
 * `classHeritageOf`'s answer already. A class nested inside another generic
 * is left to that answer too: its copies are reached through a path this
 * root-level walk does not enumerate.
 */
export const classCopyHeritageOf = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  specializations: SpecializationCensus,
  files: readonly ts.SourceFile[],
  heritage: ReadonlyMap<DeclarationId, readonly DeclarationId[]>
): ReadonlyMap<DeclarationId, ReadonlyMap<number | null, readonly ClassCopyAncestor[]>> => {
  const chainOf = (start: ts.ClassLikeDeclaration, path: SpecializationPath): readonly ClassCopyAncestor[] | null => {
    const chain: ClassCopyAncestor[] = []
    let node = start
    let current = path
    for (let depth = 0; depth < 32; depth += 1) {
      const next = heritageCopyOf(identities.declarationOfSymbol, specializations, identities.prefixFor, node, current)
      const step = next?.[next.length - 1]
      if (next && step && ts.isClassLike(step.owner)) {
        chain.push({ declaration: identities.declarationIdOf(step.owner), ordinal: step.ordinal })
        node = step.owner
        current = next
        continue
      }
      // A base that is no copy: a non-generic class continues the walk at its
      // own root, anything else ends it with the root chain beyond it.
      const expression = node.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]?.expression
      const symbol = expression ? checker.getSymbolAtLocation(expression) : undefined
      const base = symbol ? identities.declarationOfSymbol(symbol) : null
      if (base && ts.isClassLike(base) && !specializations.isGeneric(base)) {
        chain.push({ declaration: identities.declarationIdOf(base), ordinal: null })
        node = base
        current = []
        continue
      }
      for (const ancestor of heritage.get(identities.declarationIdOf(node)) ?? [])
        if (!chain.some((known) => known.declaration === ancestor)) chain.push({ declaration: ancestor, ordinal: null })
      break
    }
    return chain.some((ancestor) => ancestor.ordinal !== null) ? chain : null
  }
  const insideGeneric = (node: ts.Node): boolean => {
    for (let parent = node.parent; parent; parent = parent.parent) if (specializations.isGeneric(parent as ts.Declaration)) return true
    return false
  }

  const published = new Map<DeclarationId, Map<number | null, readonly ClassCopyAncestor[]>>()
  const publish = (node: ts.ClassLikeDeclaration, ordinal: number | null, chain: readonly ClassCopyAncestor[] | null): void => {
    if (!chain) return
    const id = identities.declarationIdOf(node)
    const known = published.get(id) ?? new Map<number | null, readonly ClassCopyAncestor[]>()
    known.set(ordinal, chain)
    published.set(id, known)
  }
  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isClassLike(node) && node.heritageClauses && !insideGeneric(node)) {
        if (!specializations.isGeneric(node)) publish(node, null, chainOf(node, []))
        else {
          const copies = specializations.specializationsOf(node)
          for (const copy of copies) {
            const chain = chainOf(node, [{ owner: node, ordinal: copy.ordinal }])
            publish(node, copy.ordinal, chain)
            if (copies.length === 1) publish(node, null, chain)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return published
}

/**
 * The native-collection members each class's family redeclares, keyed by the
 * classes whose instances therefore may not be held as the bare native
 * collection they extend (`class-ref.nativeBaseOverridden`).
 *
 * A class extending `Map` that redeclares one of `Map`'s own members --
 * `CaseInsensitiveMap`'s `get`, `set`, `has`, `delete` -- answers that member
 * through its own method only while the value is typed as the class. Stored
 * into a slot of the collection's carrier, the member is the runtime
 * collection's, and the override is silently skipped. So the redeclaring class
 * is marked, and so is every class it inherits from: a value typed as an
 * ancestor may be an instance of the redeclaring class. A class merely BETWEEN
 * one and the native base inherits the mark through that same ancestor walk.
 */
export const nativeCollectionOverridesOf = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  files: readonly ts.SourceFile[],
  heritage: ReadonlyMap<DeclarationId, readonly DeclarationId[]>
): ReadonlyMap<DeclarationId, ReadonlySet<string>> => {
  const collectionMembersOf = (declared: ts.Type, depth: number): ReadonlySet<ts.__String> | null => {
    if (depth > 32 || !declared.isClassOrInterface()) return null
    for (const base of checker.getBaseTypes(declared)) {
      const symbol = base.getSymbol()
      const declarations = symbol?.declarations ?? []
      if (declarations.some(ts.isClassLike)) {
        const target = (base as ts.TypeReference).target ?? base
        const found = collectionMembersOf(target, depth + 1)
        if (found) return found
        continue
      }
      if (!symbol || !nativeCollectionInterfaceNames.has(symbol.name)) continue
      if (declarations.length === 0 || !declarations.every((node) => node.getSourceFile().hasNoDefaultLib)) continue
      return new Set(checker.getPropertiesOfType(base).map((property) => property.escapedName))
    }
    return null
  }
  const overridden = new Map<DeclarationId, Set<string>>()
  const mark = (id: DeclarationId, names: readonly string[]): void => {
    const existing = overridden.get(id) ?? new Set<string>()
    for (const name of names) existing.add(name)
    overridden.set(id, existing)
  }
  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isClassLike(node)) {
        const symbol =
          checker.getSymbolAtLocation(node.name ?? node) ?? (node.name ? undefined : checker.getTypeAtLocation(node).getSymbol())
        const declared = symbol ? checker.getDeclaredTypeOfSymbol(symbol) : null
        const members = declared ? collectionMembersOf(declared, 0) : null
        if (members) {
          const redeclared = node.members.flatMap((member) => {
            if (ts.isConstructorDeclaration(member) || ts.isClassStaticBlockDeclaration(member)) return []
            if (ts.canHaveModifiers(member) && ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword))
              return []
            const memberSymbol = member.name ? checker.getSymbolAtLocation(member.name) : undefined
            return memberSymbol !== undefined && members.has(memberSymbol.escapedName) ? [String(memberSymbol.escapedName)] : []
          })
          if (redeclared.length > 0) {
            const id = identities.declarationIdOf(node)
            mark(id, redeclared)
            for (const ancestor of heritage.get(id) ?? []) mark(ancestor, redeclared)
          }
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return overridden
}

// `Promise` joins the collections: a subclass redeclaring `then` would be
// skipped by every native settlement that reads the instance as its promise.
const nativeCollectionInterfaceNames: ReadonlySet<string> = new Set(['Map', 'Set', 'WeakMap', 'WeakSet', 'Promise'])

/**
 * The classes whose instances may not be held as the bare intrinsic `Error`
 * they extend (`class-ref.nativeBaseOverridden`), because some class in the
 * family answers one of the error's own properties differently.
 *
 * Held as `gea::runtime::Error`, `name` and `message` are the error's own
 * fields, and a subclass accessor over them is skipped. One override is
 * answered rather than refused: a `get name()` / `get message()` that returns
 * a string constant, declared by the family's root -- the class extending
 * `Error` itself -- and re-declared anywhere below it. A library whose every
 * error class is one (`override get name(): string { return 'LibError'; }`)
 * is the shape, and
 * construction writes the most-derived constant into the error's field
 * through the root's dispatch (`emit-callable.ts`'s `emitSuperInitialize`),
 * so the field and the getter agree for the object's whole life. Anything
 * else over those members -- a computed getter, a setter, `stack`/`cause`, a
 * `toString` the runtime's own stringification would skip -- marks the class,
 * every class it inherits from, and every class that inherits it.
 */
export const nativeErrorOverridesOf = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  files: readonly ts.SourceFile[],
  heritage: ReadonlyMap<DeclarationId, readonly DeclarationId[]>
): ReadonlySet<DeclarationId> => {
  const extendsNativeErrorDirectly = (declared: ts.Type): boolean | null => {
    if (!declared.isClassOrInterface()) return null
    for (const base of checker.getBaseTypes(declared)) {
      const symbol = base.getSymbol()
      const declarations = symbol?.declarations ?? []
      if (declarations.some(ts.isClassLike)) return false
      if (
        symbol &&
        nativeErrorInterfaceNames.has(symbol.name) &&
        declarations.length > 0 &&
        declarations.every((node) => node.getSourceFile().hasNoDefaultLib)
      )
        return true
    }
    return null
  }
  const constantStringGetter = (member: ts.ClassElement): boolean => {
    if (!ts.isGetAccessorDeclaration(member) || member.body?.statements.length !== 1) return false
    const statement = member.body.statements[0]!
    return (
      ts.isReturnStatement(statement) &&
      statement.expression !== undefined &&
      (ts.isStringLiteral(statement.expression) || ts.isNoSubstitutionTemplateLiteral(statement.expression))
    )
  }
  const errorClasses = new Map<DeclarationId, ts.ClassLikeDeclaration>()
  const roots = new Set<DeclarationId>()
  for (const file of files) {
    const visit = (node: ts.Node): void => {
      if (ts.isClassLike(node)) {
        const symbol =
          checker.getSymbolAtLocation(node.name ?? node) ?? (node.name ? undefined : checker.getTypeAtLocation(node).getSymbol())
        const declared = symbol ? checker.getDeclaredTypeOfSymbol(symbol) : null
        const direct = declared ? extendsNativeErrorDirectly(declared) : null
        if (direct !== null) {
          const id = identities.declarationIdOf(node)
          errorClasses.set(id, node)
          if (direct) roots.add(id)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  const inFamily = (id: DeclarationId): boolean => roots.has(id) || (heritage.get(id) ?? []).some((ancestor) => roots.has(ancestor))
  const rootOf = (id: DeclarationId): DeclarationId | undefined =>
    roots.has(id) ? id : (heritage.get(id) ?? []).find((ancestor) => roots.has(ancestor))
  const rootGetters = (root: DeclarationId): ReadonlySet<string> => {
    const node = errorClasses.get(root)
    return new Set(
      (node?.members ?? []).flatMap((member) =>
        constantStringGetter(member) && member.name && ts.isIdentifier(member.name) ? [member.name.text] : []
      )
    )
  }
  const origins = new Set<DeclarationId>()
  for (const [id, node] of errorClasses) {
    if (!inFamily(id)) continue
    const root = rootOf(id)
    const answered = root === undefined ? new Set<string>() : rootGetters(root)
    const redeclares = node.members.some((member) => {
      if (ts.isConstructorDeclaration(member) || ts.isClassStaticBlockDeclaration(member) || ts.isPropertyDeclaration(member)) return false
      if (ts.canHaveModifiers(member) && ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword))
        return false
      const name = member.name && (ts.isIdentifier(member.name) || ts.isStringLiteral(member.name)) ? member.name.text : null
      if (name === null || !nativeErrorOwnMembers.has(name)) return false
      const setter = node.members.some(
        (other) => ts.isSetAccessorDeclaration(other) && other.name !== undefined && ts.isIdentifier(other.name) && other.name.text === name
      )
      return !(constantStringGetter(member) && !setter && answered.has(name))
    })
    if (redeclares) origins.add(id)
  }
  const marked = new Set<DeclarationId>()
  for (const origin of origins) {
    marked.add(origin)
    for (const ancestor of heritage.get(origin) ?? []) marked.add(ancestor)
  }
  for (const id of errorClasses.keys()) if ((heritage.get(id) ?? []).some((ancestor) => origins.has(ancestor))) marked.add(id)
  return marked
}

const nativeErrorInterfaceNames: ReadonlySet<string> = new Set([
  'Error',
  'EvalError',
  'RangeError',
  'ReferenceError',
  'SyntaxError',
  'TypeError',
  'URIError'
])
const nativeErrorOwnMembers: ReadonlySet<string> = new Set(['name', 'message', 'stack', 'cause', 'toString'])
