import ts from 'typescript'
import type { DeclarationId } from '../identity/ids.js'
import type { IdentityTable } from './normalize/identities.js'

/**
 * One interface family: the source interfaces an `extends` graph connects.
 *
 * `members` is in source order, so the layout `structural.ts` builds from it
 * lists fields the way the program's own text first declares them; `key` is
 * the family's stable identity, the id of its first member.
 */
export interface InterfaceFamily {
  readonly key: DeclarationId
  readonly members: readonly ts.InterfaceDeclaration[]
}

export interface InterfaceFamilyCensus {
  /** The family an interface declaration (by its canonical declaration id) belongs to, or `null` for a lone one. */
  readonly familyOf: (declaration: DeclarationId) => InterfaceFamily | null
  readonly families: readonly InterfaceFamily[]
}

export const emptyInterfaceFamilyCensus: InterfaceFamilyCensus = { familyOf: () => null, families: [] }

/**
 * The interfaces this program's `extends` edges connect, so that every view
 * of one object is ONE layout.
 *
 * JavaScript has no interfaces, and a program full of them still allocates
 * one kind of thing: tsc's `Node` is 300 interfaces -- `Statement`,
 * `Expression`, `Identifier`, `SourceFile`, ... -- every one of them a VIEW
 * of the same object `function Node(kind, pos, end)` allocated, written
 * through `as Mutable<Identifier>` casts and read back through `Statement`
 * parameters. Laying each interface out as its own struct gives one object
 * 300 incompatible C++ types, and the program's every `Identifier -> Node`
 * assignment becomes a conversion nothing can install: a copy would break
 * identity (`a === b`, a later write through the other view) and a
 * reinterpretation is not a conversion at all. On the tsc self-compile that
 * was the single largest family in the census after monomorphization landed:
 * 1,757 `native-record-ref -> native-record-ref` binding reads plus their
 * return, optional and union forms.
 *
 * So the layout follows the OBJECT, not the view: every interface a family
 * connects derives to one struct holding the union of the family's fields,
 * with a field required only where every member declares it required and
 * carried behind a presence bit otherwise -- exactly what an object of that
 * family may or may not own at runtime. The layout itself is built by
 * `structural.ts` (`familyBodyOf`), where the member types can be interned;
 * this census only answers WHICH declarations are one family.
 *
 * What is NOT a member, and why each exclusion is the rule rather than a
 * gap:
 *
 * - An interface in a declaration file. Its layout is a host protocol's, and
 *   the host owns it.
 * - An interface extending anything that is not itself a member candidate --
 *   `Array<T>` (`arrayHeritageShapeOf` lays that out as an array), a class,
 *   a type alias, an ambient interface. Its layout includes the base's
 *   members, which the family cannot own, and so do its descendants': the
 *   taint follows `extends` downward.
 * - An interface with a call or construct signature (a callable, laid out as
 *   one), an index signature (a dictionary) or an accessor member (a body,
 *   not storage).
 * - A generic interface whose type parameter has no constraint that names a
 *   type: the family's field for `value: T` would have to be `unknown`, and
 *   a boxed slot in every object of the family is the defect this compiler
 *   exists to avoid. A constrained one (`Token<TKind extends SyntaxKind>`)
 *   is fine: its field is the constraint, which is what the union over every
 *   instantiation is anyway (`structural.ts`'s type-parameter fallback).
 *
 * A family of ONE is no family: its single member keeps the body its own
 * declaration states, exactly as before this census existed.
 */
export const interfaceFamiliesOf = (
  checker: ts.TypeChecker,
  identities: IdentityTable,
  files: readonly ts.SourceFile[]
): InterfaceFamilyCensus => {
  interface Candidate {
    readonly id: DeclarationId
    readonly declaration: ts.InterfaceDeclaration
    readonly type: ts.Type
  }
  const candidates = new Map<DeclarationId, Candidate>()

  /** The canonical declaration an interface symbol is known by -- merged declarations share it. */
  const canonicalOf = (symbol: ts.Symbol): { readonly id: DeclarationId; readonly declaration: ts.InterfaceDeclaration } | null => {
    const target = (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol
    const declaration = identities.declarationOfSymbol(target)
    if (!declaration || !ts.isInterfaceDeclaration(declaration)) return null
    // A source interface merged with an ambient one (`interface Node` beside
    // lib.dom's) is the ambient one's: the host owns that layout.
    if ((target.declarations ?? []).some((one) => one.getSourceFile().isDeclarationFile)) return null
    return { id: identities.declarationIdOf(declaration), declaration }
  }

  const unconstrainedParameter = (declaration: ts.InterfaceDeclaration): boolean =>
    (declaration.typeParameters ?? []).some((parameter) => {
      const symbol = checker.getSymbolAtLocation(parameter.name)
      const type = symbol ? checker.getDeclaredTypeOfSymbol(symbol) : null
      const constraint = type ? checker.getBaseConstraintOfType(type) : undefined
      return constraint === undefined || (constraint.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)) !== 0
    })

  const declaresAnAccessor = (symbol: ts.Symbol): boolean =>
    (symbol.declarations ?? []).some(
      (declaration) =>
        ts.isInterfaceDeclaration(declaration) &&
        declaration.members.some((member) => ts.isGetAccessorDeclaration(member) || ts.isSetAccessorDeclaration(member))
    )

  for (const file of files) {
    if (file.isDeclarationFile) continue
    const visit = (node: ts.Node): void => {
      if (ts.isInterfaceDeclaration(node)) {
        const symbol = checker.getSymbolAtLocation(node.name)
        const canonical = symbol ? canonicalOf(symbol) : null
        if (symbol && canonical && !candidates.has(canonical.id)) {
          const type = checker.getDeclaredTypeOfSymbol(symbol)
          const plain =
            type.getCallSignatures().length === 0 &&
            type.getConstructSignatures().length === 0 &&
            checker.getIndexInfosOfType(type).length === 0 &&
            !declaresAnAccessor(symbol) &&
            !unconstrainedParameter(canonical.declaration)
          if (plain) candidates.set(canonical.id, { id: canonical.id, declaration: canonical.declaration, type })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }

  // The `extends` edges, as the checker resolves them: `getBaseTypes` covers
  // every merged declaration and every instantiated base
  // (`EndOfFileToken extends Token<SyntaxKind.EndOfFileToken>` reaches
  // `Token`), and a base that is not a candidate taints the whole subtree.
  const bases = new Map<DeclarationId, readonly DeclarationId[]>()
  const tainted = new Set<DeclarationId>()
  for (const candidate of candidates.values()) {
    const resolved: DeclarationId[] = []
    for (const base of candidate.type.isClassOrInterface() ? checker.getBaseTypes(candidate.type) : []) {
      const symbol = base.getSymbol()
      const canonical = symbol ? canonicalOf(symbol) : null
      if (canonical && candidates.has(canonical.id)) resolved.push(canonical.id)
      else tainted.add(candidate.id)
    }
    bases.set(candidate.id, resolved)
  }
  let grew = true
  while (grew) {
    grew = false
    for (const [id, own] of bases) {
      if (tainted.has(id) || !own.some((base) => tainted.has(base))) continue
      tainted.add(id)
      grew = true
    }
  }

  // Union-find over the untainted edges.
  const parent = new Map<DeclarationId, DeclarationId>()
  const find = (id: DeclarationId): DeclarationId => {
    const up = parent.get(id) ?? id
    if (up === id) return id
    const root = find(up)
    parent.set(id, root)
    return root
  }
  const unite = (left: DeclarationId, right: DeclarationId): void => {
    const a = find(left)
    const b = find(right)
    if (a !== b) parent.set(a, b)
  }
  for (const [id, own] of bases) {
    if (tainted.has(id)) continue
    for (const base of own) unite(id, base)
  }

  const groups = new Map<DeclarationId, ts.InterfaceDeclaration[]>()
  for (const candidate of candidates.values()) {
    if (tainted.has(candidate.id)) continue
    const root = find(candidate.id)
    const group = groups.get(root)
    if (group) group.push(candidate.declaration)
    else groups.set(root, [candidate.declaration])
  }

  const byPosition = (left: ts.InterfaceDeclaration, right: ts.InterfaceDeclaration): number => {
    const leftFile = left.getSourceFile().fileName
    const rightFile = right.getSourceFile().fileName
    if (leftFile !== rightFile) return leftFile < rightFile ? -1 : 1
    return left.pos - right.pos
  }
  const families: InterfaceFamily[] = []
  const familyOfDeclaration = new Map<DeclarationId, InterfaceFamily>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const members = [...group].sort(byPosition)
    const first = members[0]
    if (!first) continue
    const family: InterfaceFamily = { key: identities.declarationIdOf(first), members }
    families.push(family)
    for (const member of members) familyOfDeclaration.set(identities.declarationIdOf(member), family)
  }
  families.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))

  return { familyOf: (declaration) => familyOfDeclaration.get(declaration) ?? null, families }
}
