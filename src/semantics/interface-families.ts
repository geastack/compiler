import ts from 'typescript'
import type { DeclarationId } from '../identity/ids.js'
import type { IdentityTable } from './normalize/identities.js'
import { mergedDeclarationOf } from './normalize/merged-declaration.js'

// `GEA_ADOPT_DEBUG=<file substring>`: why each object literal in matching files was or was not adopted into a family.
const adoptionDebug = process.env.GEA_ADOPT_DEBUG

/**
 * One interface family: the source interfaces an `extends` graph connects.
 *
 * `members` is in source order, so the layout `structural.ts` builds from it
 * lists fields the way the program's own text first declares them; `key` is
 * the family's stable identity, the id of its first member.
 */
export interface InterfaceFamily extends InterfaceFamilyGroup {
  readonly key: DeclarationId
  readonly members: readonly ts.InterfaceDeclaration[]
  /**
   * Anonymous all-optional object types the program intersects a member with
   * (`ReadOptions & WithSignal`), laid out into the family as optional fields
   * -- see `absorbIntersectionParts`.
   */
  readonly absorbed: readonly ts.Type[]
  /**
   * Types a spread copies into a family literal under a key the literal's own
   * type does not name but the family lays out -- see `widenBySpreadExcess`.
   */
  readonly excess: ReadonlyMap<string, readonly ts.Type[]>
}

export interface InterfaceFamilyCensus {
  /** The family an interface declaration (by its canonical declaration id) belongs to, or `null` for a lone one. */
  readonly familyOf: (declaration: DeclarationId) => InterfaceFamily | null
  readonly families: readonly InterfaceFamily[]
  /** The member a non-member family view is laid out as (`InterfaceFamilyGroups.viewMemberOf`). */
  readonly viewMemberOf?: (type: ts.Type) => ts.Type | null
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
 *   taint follows `extends` downward. The one exception is a lib
 *   key-remapping alias over a candidate (`Omit<I, 'k'>`, `Pick`, `Partial`,
 *   `Required`, `Readonly`): that base is `I`'s own members, so the edge is
 *   to `I`; so is an alias of a source object literal, or of an
 *   intersection of admissible bases (`heritageCandidatesOf` below).
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
  const groups = interfaceFamilyGroupsOf(checker, files)
  const families: InterfaceFamily[] = []
  const familyOfDeclaration = new Map<DeclarationId, InterfaceFamily>()
  for (const group of groups.families) {
    const first = group.members[0]
    if (!first) continue
    const family: InterfaceFamily = { key: identities.declarationIdOf(first), ...group }
    families.push(family)
    for (const member of group.members) familyOfDeclaration.set(identities.declarationIdOf(member), family)
  }
  families.sort((left, right) => (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
  return { familyOf: (declaration) => familyOfDeclaration.get(declaration) ?? null, families, viewMemberOf: groups.viewMemberOf }
}

/** One family as the checker sees it -- `InterfaceFamily` without the identity key. */
export interface InterfaceFamilyGroup {
  readonly members: readonly ts.InterfaceDeclaration[]
  readonly absorbed: readonly ts.Type[]
  readonly excess: ReadonlyMap<string, readonly ts.Type[]>
}

export interface InterfaceFamilyGroups {
  readonly families: readonly InterfaceFamilyGroup[]
  /**
   * The family a type is a VIEW of: a member itself, or an intersection of
   * members of one family with source object literals naming only the
   * family's keys (`ReadOptions & WithSignal`, `ReadOptions & { mode?:
   * never }`) -- every such value is one object of the family's layout.
   */
  readonly familyViewOf: (type: ts.Type) => InterfaceFamilyGroup | null
  /** Every key the family's layout holds: its members' and its absorbed partners'. */
  readonly keysOf: (family: InterfaceFamilyGroup) => ReadonlySet<string>
  /**
   * For a type that is a family view without being a member -- an object
   * literal the family ADOPTED (`adoptFlowingLiterals`), or a member seen
   * through `Omit`/`Pick`/`Partial`/`Required`/`Readonly` -- the member whose
   * layout, the family's one layout, it is.
   */
  readonly viewMemberOf: (type: ts.Type) => ts.Type | null
}

// Declarations alone decide the answer; a census that runs before the
// identity table exists (`override-field-arms.ts`, asked from the parameter
// census) and the one keyed by it read the same groups.
const groupsByChecker = new WeakMap<ts.TypeChecker, WeakMap<readonly ts.SourceFile[], InterfaceFamilyGroups>>()

/**
 * The family census on declarations alone -- see `interfaceFamiliesOf`, which
 * is this keyed by `DeclarationId`. A member is known by its canonical
 * declaration, the one `identities.ts`'s `declarationOfSymbol` anchors an
 * interface on (`mergedDeclarationOf` of the alias-resolved symbol).
 */
export const interfaceFamilyGroupsOf = (checker: ts.TypeChecker, files: readonly ts.SourceFile[]): InterfaceFamilyGroups => {
  let byFiles = groupsByChecker.get(checker)
  if (!byFiles) {
    byFiles = new WeakMap()
    groupsByChecker.set(checker, byFiles)
  }
  const cached = byFiles.get(files)
  if (cached) return cached
  const groups = collectInterfaceFamilyGroups(checker, files)
  byFiles.set(files, groups)
  return groups
}

const collectInterfaceFamilyGroups = (checker: ts.TypeChecker, files: readonly ts.SourceFile[]): InterfaceFamilyGroups => {
  interface Candidate {
    readonly declaration: ts.InterfaceDeclaration
    readonly type: ts.Type
  }
  const candidates = new Map<ts.InterfaceDeclaration, Candidate>()

  /** The canonical declaration an interface symbol is known by -- merged declarations share it. */
  const canonicalOf = (symbol: ts.Symbol): ts.InterfaceDeclaration | null => {
    const target = (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol
    const declaration = mergedDeclarationOf(target)
    if (!declaration || !ts.isInterfaceDeclaration(declaration)) return null
    // A source interface merged with an ambient one (`interface Node` beside
    // lib.dom's) is the ambient one's: the host owns that layout.
    if ((target.declarations ?? []).some((one) => one.getSourceFile().isDeclarationFile)) return null
    return declaration
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
        if (symbol && canonical && !candidates.has(canonical)) {
          const type = checker.getDeclaredTypeOfSymbol(symbol)
          const plain =
            type.getCallSignatures().length === 0 &&
            type.getConstructSignatures().length === 0 &&
            checker.getIndexInfosOfType(type).length === 0 &&
            !declaresAnAccessor(symbol) &&
            !unconstrainedParameter(canonical)
          if (plain) candidates.set(canonical, { declaration: canonical, type })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  // A base spelled through a lib key-remapping alias -- `extends Omit<I, 'k'>`,
  // `Pick<I, ...>`, `Partial<I>`, `Required<I>`, `Readonly<I>`, nested any way
  // -- is a VIEW of `I`'s members, not a different kind of object: it names a
  // subset of `I`'s keys, or `I`'s keys with other optionality. The member's
  // own fields are what the checker resolves through the alias
  // (`getPropertiesOfType`, which `familyLayoutOf` reads), and the family
  // layout is the union over members anyway, so the edge is to `I` itself.
  // Tainting it instead split a whole options tree -- where every options
  // interface descends from `BaseOptions extends Omit<SerializeOptions,
  // 'index'>` -- into one struct per interface, and every hand-off of one
  // options object to a function naming another became a field-by-field copy:
  // identity lost, and thousands of inline copies of one record.
  const keyRemappingAliases = new Set(['Omit', 'Pick', 'Partial', 'Required', 'Readonly'])
  const isLibAlias = (symbol: ts.Symbol): boolean =>
    (symbol.declarations ?? []).length > 0 &&
    (symbol.declarations ?? []).every((declaration) => declaration.getSourceFile().isDeclarationFile)
  //
  // Two more bases are fields and nothing else: an alias of an object type
  // literal the program declares (`ListOptions extends ..., WithSignal`, with
  // `WithSignal = { signal?: AbortSignal }`), which gives the member those
  // fields and connects it to nothing; and an alias of an intersection of such
  // bases (`IndexOptions = CursorOptions & { flag?: boolean }`), whose
  // candidate parts are the edges. The
  // member's own property list already holds every field either brings.
  // The answer is the edges, or `null` for a base the family cannot own.
  const heritageCandidatesOf = (base: ts.Type): readonly ts.InterfaceDeclaration[] | null => {
    const symbol = base.getSymbol()
    const canonical = symbol ? canonicalOf(symbol) : null
    if (canonical && candidates.has(canonical)) return [canonical]
    const alias = base.aliasSymbol
    const source = base.aliasTypeArguments?.[0]
    if (alias && source && keyRemappingAliases.has(alias.getName()) && isLibAlias(alias)) return heritageCandidatesOf(source)
    if (isSourceObjectLiteral(checker, base)) return []
    if (base.isIntersection()) {
      const edges: ts.InterfaceDeclaration[] = []
      for (const part of base.types) {
        const through = heritageCandidatesOf(part)
        if (through === null) return null
        edges.push(...through)
      }
      return edges
    }
    return null
  }

  // The `extends` edges, as the checker resolves them: `getBaseTypes` covers
  // every merged declaration and every instantiated base
  // (`EndOfFileToken extends Token<SyntaxKind.EndOfFileToken>` reaches
  // `Token`), and a base that is not a candidate taints the whole subtree.
  const bases = new Map<ts.InterfaceDeclaration, readonly ts.InterfaceDeclaration[]>()
  const tainted = new Set<ts.InterfaceDeclaration>()
  for (const candidate of candidates.values()) {
    const resolved: ts.InterfaceDeclaration[] = []
    for (const base of candidate.type.isClassOrInterface() ? checker.getBaseTypes(candidate.type) : []) {
      const through = heritageCandidatesOf(base)
      if (through !== null) resolved.push(...through)
      else tainted.add(candidate.declaration)
    }
    bases.set(candidate.declaration, resolved)
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
  const parent = new Map<ts.InterfaceDeclaration, ts.InterfaceDeclaration>()
  const find = (id: ts.InterfaceDeclaration): ts.InterfaceDeclaration => {
    const up = parent.get(id) ?? id
    if (up === id) return id
    const root = find(up)
    parent.set(id, root)
    return root
  }
  const unite = (left: ts.InterfaceDeclaration, right: ts.InterfaceDeclaration): void => {
    const a = find(left)
    const b = find(right)
    if (a !== b) parent.set(a, b)
  }
  for (const [id, own] of bases) {
    if (tainted.has(id)) continue
    for (const base of own) unite(id, base)
  }

  const groups = new Map<ts.InterfaceDeclaration, ts.InterfaceDeclaration[]>()
  for (const candidate of candidates.values()) {
    if (tainted.has(candidate.declaration)) continue
    const root = find(candidate.declaration)
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
  const families: InterfaceFamilyGroup[] = []
  const familyOfDeclaration = new Map<ts.InterfaceDeclaration, InterfaceFamilyGroup>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    const family: InterfaceFamilyGroup = { members: [...group].sort(byPosition), absorbed: [], excess: new Map() }
    families.push(family)
    for (const member of group) familyOfDeclaration.set(member, family)
  }
  const familyOfType = (type: ts.Type): InterfaceFamilyGroup | null => {
    const symbol = type.getSymbol()
    const canonical = symbol ? canonicalOf(symbol) : null
    return canonical ? (familyOfDeclaration.get(canonical) ?? null) : null
  }
  // An interface no `extends` connects to another is not a family -- its
  // layout is its own and nothing above needs a group for it -- but a literal
  // flowing into a slot it types is laid out exactly as an adopted literal
  // is: as the interface's own struct, instead of at its own shape and then
  // copied into the interface's at the store. So a literal may adopt a lone
  // interface through a family of one, minted here and known ONLY to the
  // adoption map: `familyOfType` never answers it for the interface itself,
  // and the interface's layout is untouched.
  // `opts: Options | OptionsClass | undefined = { w: value }` is the
  // measured case (`Options` extends nothing).
  const loneFamilies = new Map<ts.InterfaceDeclaration, InterfaceFamilyGroup>()
  const loneFamilyOf = (type: ts.Type): InterfaceFamilyGroup | null => {
    const symbol = type.getSymbol()
    const canonical = symbol ? canonicalOf(symbol) : null
    if (canonical === null || !candidates.has(canonical) || tainted.has(canonical) || familyOfDeclaration.has(canonical)) return null
    if (canonical.typeParameters !== undefined || type.isClassOrInterface() === false) return null
    let family = loneFamilies.get(canonical)
    if (family === undefined) {
      family = { members: [canonical], absorbed: [], excess: new Map() }
      loneFamilies.set(canonical, family)
    }
    return family
  }
  const memberKeys = new Map<InterfaceFamilyGroup, ReadonlySet<string>>()
  const memberKeysOf = (family: InterfaceFamilyGroup): ReadonlySet<string> => {
    let found = memberKeys.get(family)
    if (!found) {
      const collected = new Set<string>()
      for (const member of family.members) {
        const symbol = checker.getSymbolAtLocation(member.name)
        if (symbol)
          for (const property of checker.getPropertiesOfType(checker.getDeclaredTypeOfSymbol(symbol))) collected.add(property.getName())
      }
      found = collected
      memberKeys.set(family, found)
    }
    return found
  }
  // A member spelled through a lib key-remapping alias (`Omit<AbstractCursorOptions,
  // 'readPreference'>`) is a view of the member, as it is as an `extends` base.
  const familyThroughAliasOf = (type: ts.Type): InterfaceFamilyGroup | null => {
    const own = familyOfType(type)
    if (own !== null) return own
    const alias = type.aliasSymbol
    const source = type.aliasTypeArguments?.[0]
    return alias && source && keyRemappingAliases.has(alias.getName()) && isLibAlias(alias) ? familyThroughAliasOf(source) : null
  }
  absorbIntersectionParts(checker, files, familyThroughAliasOf, memberKeysOf)
  const keysOf = (family: InterfaceFamilyGroup): ReadonlySet<string> => {
    const keys = new Set(memberKeysOf(family))
    for (const absorbed of family.absorbed) for (const property of checker.getPropertiesOfType(absorbed)) keys.add(property.getName())
    return keys
  }
  // A program alias of such a view -- `type RemoveOptions =
  // Omit<OperationOptions, 'raw'>` -- carries the PROGRAM's alias,
  // not `Omit`'s, so the remapping is read off the alias's declaration.
  const remappedNodeOf = (node: ts.TypeNode, remapped: boolean): InterfaceFamilyGroup | null => {
    if (ts.isParenthesizedTypeNode(node)) return remappedNodeOf(node.type, remapped)
    if (!ts.isTypeReferenceNode(node)) return null
    const referenced = checker.getSymbolAtLocation(node.typeName)
    const symbol = referenced && (referenced.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(referenced) : referenced
    const source = node.typeArguments?.[0]
    if (symbol && source && keyRemappingAliases.has(symbol.getName()) && isLibAlias(symbol))
      return familyOfType(checker.getTypeFromTypeNode(source)) ?? remappedNodeOf(source, true)
    const aliased = symbol?.declarations?.find(ts.isTypeAliasDeclaration)
    if (aliased && !aliased.getSourceFile().isDeclarationFile && !aliased.typeParameters) return remappedNodeOf(aliased.type, remapped)
    return remapped ? familyOfType(checker.getTypeFromTypeNode(node)) : null
  }
  const remappedViewOf = (type: ts.Type): InterfaceFamilyGroup | null => {
    if (type.isUnionOrIntersection() || familyOfType(type) !== null) return null
    const direct = familyThroughAliasOf(type)
    if (direct !== null) return direct
    const declaration = type.aliasSymbol?.declarations?.find(ts.isTypeAliasDeclaration)
    if (!declaration || declaration.getSourceFile().isDeclarationFile || declaration.typeParameters) return null
    return remappedNodeOf(declaration.type, false)
  }
  const familyViewOf = (type: ts.Type): InterfaceFamilyGroup | null => {
    if (!type.isIntersection()) return familyOfType(type) ?? remappedViewOf(type)
    let found: InterfaceFamilyGroup | null = null
    const literals: ts.Type[] = []
    for (const part of type.types) {
      // A part may itself be a remapped view:
      // `ServerOptions = Omit<RequestOptions, ...> & { context } & WithSignal`.
      // Refused, an options-building function's literal took a shape of its own, every option
      // key its spread source carries landed in that shape's expando one
      // `nativeDynamicSet` at a time, and `conn.command` rebuilt the family
      // record from it again -- per operation.
      const own = familyOfType(part) ?? remappedViewOf(part)
      if (own !== null) {
        if (found !== null && found !== own) return null
        found = own
      } else if (isSourceObjectLiteral(checker, part)) literals.push(part)
      else return null
    }
    if (found === null) return null
    const keys = keysOf(found)
    return literals.every((literal) => checker.getPropertiesOfType(literal).every((property) => keys.has(property.getName())))
      ? found
      : null
  }
  widenBySpreadExcess(checker, files, familyViewOf, memberKeysOf)
  // An intersection view's own literal part may admit `null` where every
  // member declares the key non-nullable: `ServerOptions`' `{
  // returnFieldSelector?: Document | null }` over `OpQueryOptions`'
  // `returnFieldSelector?: Document`, and get_more stores `null` there. Laid
  // out as the family, the family's field must carry it, so the declared type
  // joins that key's union as a spread's excess does.
  const includesNull = (type: ts.Type): boolean =>
    (type.isUnion() ? type.types : [type]).some((member) => (member.flags & ts.TypeFlags.Null) !== 0)
  const nullableIn = (family: InterfaceFamilyGroup, key: string): boolean =>
    family.members.some((member) => {
      const property = checker.getPropertyOfType(checker.getTypeAtLocation(member), key)
      return property !== undefined && includesNull(checker.getTypeOfSymbolAtLocation(property, member))
    }) || (family.excess.get(key) ?? []).some(includesNull)
  const literalPartsOf = (type: ts.IntersectionType): ts.Type[] =>
    type.types.filter((part) => familyOfType(part) === null && remappedViewOf(part) === null && isSourceObjectLiteral(checker, part))
  const visitAliases = (node: ts.Node): void => {
    if (ts.isTypeAliasDeclaration(node) && !node.typeParameters) {
      const type = checker.getTypeAtLocation(node.name)
      const family = type.isIntersection() ? familyViewOf(type) : null
      if (family !== null && type.isIntersection()) {
        const excess = family.excess as Map<string, ts.Type[]>
        for (const part of literalPartsOf(type))
          for (const property of checker.getPropertiesOfType(part)) {
            const declared = checker.getTypeOfSymbolAtLocation(property, node)
            if (!includesNull(declared) || nullableIn(family, property.getName())) continue
            const held = excess.get(property.getName()) ?? []
            if (!held.includes(declared)) held.push(declared)
            excess.set(property.getName(), held)
          }
      }
    }
    ts.forEachChild(node, visitAliases)
  }
  for (const file of files) if (!file.isDeclarationFile) visitAliases(file)
  // Whether a family carries everything an intersection view's literal parts
  // declare, `null` included -- the view is then the family's own layout.
  const intersectionViewHeld = (type: ts.IntersectionType, family: InterfaceFamilyGroup): boolean =>
    literalPartsOf(type).every((part) =>
      checker.getPropertiesOfType(part).every((property) => {
        const key = property.getName()
        const declared = checker.getTypeOfSymbol(property)
        const present = checker.getNonNullableType(declared)
        return (
          ((present.flags & ts.TypeFlags.Never) !== 0 || familyHolds(checker, family, key, present)) &&
          (!includesNull(declared) || nullableIn(family, key))
        )
      })
    )
  const adopted = adoptFlowingLiterals(checker, files, (type) => familyViewOf(type) ?? loneFamilyOf(type), keysOf)
  const adoptedFamilyOf = (type: ts.Type): InterfaceFamilyGroup | null => {
    const symbol = objectLiteralSymbolOf(checker, type)
    return symbol ? (adopted.get(symbol) ?? null) : null
  }
  const layoutMember = new Map<InterfaceFamilyGroup, ts.Type | null>()
  const viewMemberOf = (type: ts.Type): ts.Type | null => {
    // An intersection view (`ServerOptions = Omit<RequestOptions, ...> &
    // { context } & WithSignal`) too: adopting only the literal left the
    // function returning it typed as a record of its own, so every operation
    // converted the family record into that shape and back.
    const viewed = type.isIntersection() ? familyViewOf(type) : null
    const family =
      adoptedFamilyOf(type) ??
      remappedViewOf(type) ??
      (viewed !== null && type.isIntersection() && intersectionViewHeld(type, viewed) ? viewed : null)
    if (family === null) return null
    if (!layoutMember.has(family)) {
      const member = family.members.find((declaration) => declaration.typeParameters === undefined)
      const symbol = member ? checker.getSymbolAtLocation(member.name) : undefined
      layoutMember.set(family, symbol ? checker.getDeclaredTypeOfSymbol(symbol) : null)
    }
    return layoutMember.get(family) ?? null
  }
  return {
    families,
    familyViewOf: (type) => familyViewOf(type) ?? (viewMemberOf(type) === null ? null : adoptedFamilyOf(type)),
    keysOf,
    viewMemberOf
  }
}

/** An anonymous object type literal the program declares, with no signature and no index: fields and nothing else. */
const isSourceObjectLiteral = (checker: ts.TypeChecker, type: ts.Type): boolean => {
  if ((type.flags & ts.TypeFlags.Object) === 0 || ((type as ts.ObjectType).objectFlags & ts.ObjectFlags.Anonymous) === 0) return false
  const declarations = type.getSymbol()?.declarations ?? []
  if (declarations.length === 0 || !declarations.every(ts.isTypeLiteralNode)) return false
  if (declarations.some((declaration) => declaration.getSourceFile().isDeclarationFile)) return false
  return (
    checker.getIndexInfosOfType(type).length === 0 && type.getCallSignatures().length === 0 && type.getConstructSignatures().length === 0
  )
}

/**
 * The optional-only object types the program intersects a family member with,
 * absorbed into that family's layout.
 *
 * A program can pass its options as `ReadOptions & WithSignal`,
 * `RequestOptions & WithSignal`, `OperationOptions & WithSignal` -- where
 * `WithSignal = { signal?: AbortSignal }` -- and hand the same object on to
 * functions naming the bare member. The intersection names a field the family does not declare, so it
 * interned as its own record, and every hand-off between the two spellings
 * was a field-by-field copy of a large options object: identity lost, and
 * the operations' redeclared `options` slot (`override-field-arms.ts`) became
 * a union whose every read converted between the two. The object is still one
 * object: laying `signal` out in the family, optional behind a presence bit
 * like every field some member leaves out, makes the intersection
 * `structural.ts`'s `narrowedFamilyMemberOf` case -- a view adding nothing the
 * family does not hold.
 *
 * Only literals whose ADDED fields are optional. A required field the family
 * lacks would be a field every object of the family then claims, and a brand
 * is a different type; both keep the general intersection path. The family's other fields
 * keep their requiredness: `familyLayoutOf` counts only interface members.
 */
const absorbIntersectionParts = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  familyOfType: (type: ts.Type) => InterfaceFamilyGroup | null,
  memberKeysOf: (family: InterfaceFamilyGroup) => ReadonlySet<string>
): void => {
  const visit = (node: ts.Node): void => {
    if (ts.isIntersectionTypeNode(node)) {
      const type = checker.getTypeFromTypeNode(node)
      if (type.isIntersection()) {
        let family: InterfaceFamilyGroup | null = null
        const literals: ts.Type[] = []
        let admissible = true
        for (const part of type.types) {
          const own = familyOfType(part)
          if (own) {
            if (family !== null && family !== own) admissible = false
            family = own
          } else if (isSourceObjectLiteral(checker, part)) literals.push(part)
          else admissible = false
        }
        // A key the family already lays out may be restated required
        // (`InternalOptions = Omit<BaseOptions, 'mode'> & { mode: Mode;
        // flag?: boolean }`); only a key the literal ADDS must be optional.
        const members = family === null ? null : memberKeysOf(family)
        const addsOnlyOptional = (literal: ts.Type): boolean => {
          const properties = checker.getPropertiesOfType(literal)
          return (
            properties.length > 0 &&
            properties.every((property) => members?.has(property.getName()) === true || (property.flags & ts.SymbolFlags.Optional) !== 0)
          )
        }
        if (admissible && family !== null && literals.every(addsOnlyOptional)) {
          const absorbed = family.absorbed as ts.Type[]
          for (const literal of literals) if (!absorbed.includes(literal)) absorbed.push(literal)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  for (const file of files) if (!file.isDeclarationFile) visit(file)
}

/**
 * Whether some member's own declaration of `key` already holds a `type` value
 * as it is. A `query: Query<T>` spread into a view is a `Bag` (an interface
 * with an `any` string index), which `ListOptions.query` holds; widening that
 * slot made it a union of two indexed object carriers no dynamic read can
 * choose between. An `any` string index takes every object in the checker,
 * but only an object that is itself indexed is held by it: a
 * `Promise<Metadata>` spread under `StreamOptions.metadata?: Bag` is not a
 * dictionary, so that slot widens.
 */
const declarationHolds = (checker: ts.TypeChecker, family: InterfaceFamilyGroup, key: string, type: ts.Type): boolean =>
  family.members.some((member) => {
    const property = checker.getPropertyOfType(checker.getTypeAtLocation(member), key)
    if (property === undefined) return false
    const declared = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(property, member))
    if (!checker.isTypeAssignableTo(type, declared)) return false
    const indexed = (candidate: ts.Type): boolean => checker.getIndexInfosOfType(candidate).length > 0
    return !indexed(declared) || (type.flags & ts.TypeFlags.Object) === 0 || indexed(type)
  })

/**
 * The family's fields widened by what spreads put there.
 *
 * A family's layout is the union of every member's fields, so a literal typed
 * as one member has a slot for a key only ANOTHER member declares -- typed as
 * that member says. A spread is not checked for excess properties:
 * `const opts: RequestOptions = { ...options, raw: false }` copies
 * `ConnectionOptions.id` (`number | '<tag>'`) into an object whose layout
 * holds `StreamOptions.id?: Id`. The copy is an own
 * property of the object like any other, and the layout's slot for it is the
 * only place the object has for that key (a declared name is never an
 * expando), so the slot's carrier must admit what the program stores there:
 * the source property's type joins the field's union.
 *
 * Keys the literal's own type names are the checker's to reconcile and are
 * not touched; nor are keys no member declares, which a copy stores on the
 * expando.
 */
const widenBySpreadExcess = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  familyViewOf: (type: ts.Type) => InterfaceFamilyGroup | null,
  namesOf: (family: InterfaceFamilyGroup) => ReadonlySet<string>
): void => {
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node) && node.properties.some(ts.isSpreadAssignment)) {
      const view = checker.getContextualType(node)
      const family = view ? familyViewOf(view) : null
      if (view && family) {
        const excess = family.excess as Map<string, ts.Type[]>
        for (const spread of node.properties) {
          if (!ts.isSpreadAssignment(spread)) continue
          const source = checker.getNonNullableType(checker.getTypeAtLocation(spread.expression))
          for (const property of checker.getPropertiesOfType(source)) {
            const key = property.getName()
            if (checker.getPropertyOfType(view, key) !== undefined || !namesOf(family).has(key)) continue
            const type = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(property, spread))
            if (declarationHolds(checker, family, key, type)) continue
            const held = excess.get(key) ?? []
            if (!held.includes(type)) held.push(type)
            excess.set(key, held)
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  for (const file of files) if (!file.isDeclarationFile) visit(file)
}

/** The symbol of an object literal EXPRESSION's type -- fresh, regular or widened, all share it -- or `null`. */
const objectLiteralSymbolOf = (checker: ts.TypeChecker, type: ts.Type): ts.Symbol | null => {
  // Widening (`session: 's'` to `string`) mints a type that keeps only the
  // literal's symbol, not its `ObjectLiteral` flag.
  const flags = (type as ts.ObjectType).objectFlags
  if ((type.flags & ts.TypeFlags.Object) === 0 || (flags & (ts.ObjectFlags.ObjectLiteral | ts.ObjectFlags.Anonymous)) === 0) return null
  const symbol = type.getSymbol()
  const declarations = symbol?.declarations ?? []
  if (!symbol || declarations.length === 0) return null
  if (!declarations.every((declaration) => ts.isObjectLiteralExpression(declaration) && !declaration.getSourceFile().isDeclarationFile))
    return null
  if (checker.getIndexInfosOfType(type).length > 0 || type.getCallSignatures().length > 0 || type.getConstructSignatures().length > 0)
    return null
  return symbol
}

/**
 * Object literals the program builds for a family's view, laid out in the
 * family's one layout from the moment they are allocated.
 *
 * A program can assemble most operation options as a literal somewhere else
 * than the constructor that takes them: `const options = { ...this.findOptions,
 * ...this.cursorOptions, session }` then `new Operation(ns, query,
 * options)`, or `resolveOptions(undefined, { ...resolveBaseOptions(options),
 * timeout })`, whose generic result IS the literal's type. Laid out as its
 * own record, each such literal entered the operations' redeclared `options`
 * slot (`override-field-arms.ts`) as one more arm, and every read of the slot
 * dispatched over twenty records, each viewed field by field into the
 * family's large struct: hundreds of megabytes of emitted C++. The literal is the options
 * object; nothing but the family ever holds it as that record.
 *
 * Adopted where a value of the literal's type meets a family view as its
 * contextual type -- an argument, an annotated initializer, an assignment, a
 * return -- and every key it names is one the family lays out, holding a value
 * some declaration of that key already takes (`familyHolds`). A literal two
 * families both claim is adopted by neither.
 */
const adoptFlowingLiterals = (
  checker: ts.TypeChecker,
  files: readonly ts.SourceFile[],
  familyViewOf: (type: ts.Type) => InterfaceFamilyGroup | null,
  keysOf: (family: InterfaceFamilyGroup) => ReadonlySet<string>
): ReadonlyMap<ts.Symbol, InterfaceFamilyGroup> => {
  const adopted = new Map<ts.Symbol, InterfaceFamilyGroup>()
  const contested = new Set<ts.Symbol>()
  const presentOf = (type: ts.Type): readonly ts.Type[] =>
    (type.isUnion() ? type.types : [type]).filter((member) => (member.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0)
  // A union slot adopts too, when exactly one of its present members is a
  // family and every other is something a literal can never be -- a class
  // (an instance has an identity a literal lacks) or a primitive.
  // `opts: Settings | SettingsClass | undefined = { w }` allocated the
  // literal at its own shape and then copied it into the settings record at
  // the store, one struct per call.
  const soleFamilyOf = (views: readonly ts.Type[]): InterfaceFamilyGroup | null => {
    let family: InterfaceFamilyGroup | null = null
    for (const view of views) {
      const own = familyViewOf(view)
      if (own !== null) {
        if (family !== null && family !== own) return null
        family = own
        continue
      }
      const primitive =
        ts.TypeFlags.StringLike | ts.TypeFlags.NumberLike | ts.TypeFlags.BooleanLike | ts.TypeFlags.BigIntLike | ts.TypeFlags.ESSymbolLike
      const classLike = ((view.getSymbol()?.flags ?? 0) & ts.SymbolFlags.Class) !== 0 && !isSourceObjectLiteral(checker, view)
      if ((view.flags & primitive) === 0 && !classLike) return null
    }
    return family
  }
  const offer = (expression: ts.Expression): void => {
    // The checker hands the slot's contextual type through to the operands
    // of these forms, and the literal that lands in the slot is one of them:
    // `inherit ?? {}`, `flag ? {} : options`, `(options || {})`.
    if (ts.isParenthesizedExpression(expression)) return offer(expression.expression)
    if (ts.isConditionalExpression(expression)) {
      offer(expression.whenTrue)
      offer(expression.whenFalse)
      return
    }
    if (
      ts.isBinaryExpression(expression) &&
      (expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        expression.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    ) {
      offer(expression.left)
      offer(expression.right)
      return
    }
    const contextual = checker.getContextualType(expression)
    const views = contextual ? presentOf(contextual) : []
    const family = views.length === 1 ? familyViewOf(views[0]!) : views.length > 1 ? soleFamilyOf(views) : null
    const debugAdoption =
      adoptionDebug !== undefined && ts.isObjectLiteralExpression(expression) && expression.getSourceFile().fileName.includes(adoptionDebug)
    const where = debugAdoption
      ? `${expression.getSourceFile().fileName}:${expression.getSourceFile().getLineAndCharacterOfPosition(expression.getStart()).line + 1}`
      : ''
    if (debugAdoption && family === null)
      console.error(`[ADOPT] ${where} no-family contextual=${contextual ? checker.typeToString(contextual).slice(0, 160) : 'none'}`)
    if (family === null) return
    for (const value of presentOf(checker.getTypeAtLocation(expression))) {
      const symbol = objectLiteralSymbolOf(checker, value)
      if (symbol === null || contested.has(symbol)) continue
      const held = adopted.get(symbol)
      if (held !== undefined) {
        if (held !== family) {
          adopted.delete(symbol)
          contested.add(symbol)
        }
        continue
      }
      const keys = keysOf(family)
      const fits = checker.getPropertiesOfType(value).every((property) => {
        const key = property.getName()
        if (!keys.has(key)) {
          if (debugAdoption) console.error(`[ADOPT] ${where} key-not-in-family ${key}`)
          return false
        }
        const type = checker.getNonNullableType(checker.getTypeOfSymbolAtLocation(property, expression))
        const holds = familyHolds(checker, family, key, type)
        if (!holds && debugAdoption) console.error(`[ADOPT] ${where} type-not-held ${key}: ${checker.typeToString(type).slice(0, 160)}`)
        return holds
      })
      if (debugAdoption) console.error(`[ADOPT] ${where} fits=${fits}`)
      if (fits) adopted.set(symbol, family)
    }
  }
  const visit = (node: ts.Node): void => {
    if ((ts.isCallExpression(node) || ts.isNewExpression(node)) && node.arguments) for (const argument of node.arguments) offer(argument)
    else if (ts.isVariableDeclaration(node) && node.type && node.initializer) offer(node.initializer)
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) offer(node.right)
    else if (ts.isReturnStatement(node) && node.expression) offer(node.expression)
    ts.forEachChild(node, visit)
  }
  for (const file of files) if (!file.isDeclarationFile) visit(file)
  return adopted
}

/** Whether the family's layout already holds a `type` value under `key`: a member's declaration, an absorbed partner's, or a widened excess. */
const familyHolds = (checker: ts.TypeChecker, family: InterfaceFamilyGroup, key: string, type: ts.Type): boolean => {
  if (declarationHolds(checker, family, key, type)) return true
  for (const absorbed of family.absorbed) {
    const property = checker.getPropertyOfType(absorbed, key)
    if (property && checker.isTypeAssignableTo(type, checker.getNonNullableType(checker.getTypeOfSymbol(property)))) return true
  }
  return (family.excess.get(key) ?? []).some((excess) => checker.isTypeAssignableTo(type, excess))
}
