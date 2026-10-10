import ts from 'typescript'

/**
 * One member of a linked-record family instance: the checker type the program
 * names it by, and the alias declaration whose literal body lists its fields.
 */
export interface RecordLinkMember {
  readonly type: ts.Type
  readonly declaration: ts.TypeAliasDeclaration
  /**
   * `family`: this member's link fields are left out of the merge -- they
   * name the family at the member's own home, not at this instance, and the
   * generic members already state the links here.
   */
  readonly links: 'own' | 'family'
}

export interface RecordLinkFamilyCensus {
  /** The instance's canonical type every member lays out as, or `type` itself. */
  readonly storageOf: (type: ts.Type) => ts.Type
  /** The members whose fields the canonical type's layout merges, or `null` for a type that is no instance's canonical. */
  readonly membersOf: (type: ts.Type) => readonly RecordLinkMember[] | null
  /** Whether a field type names nothing but family members (and `null`/`undefined`): a link. */
  readonly isLink: (type: ts.Type) => boolean
}

export const emptyRecordLinkFamilyCensus: RecordLinkFamilyCensus = {
  storageOf: (type) => type,
  membersOf: () => null,
  isLink: () => false
}

/**
 * Object-literal type aliases that are VIEWS of one linked object.
 *
 * A `List<T>` written as a circular doubly linked list is the shape:
 *
 *     type ListNode<T> = { value: T; next: ListNode<T> | HeadNode<T>; prev: ListNode<T> | HeadNode<T> }
 *     type HeadNode<T> = { value: null; next: ListNode<T>; prev: ListNode<T> }
 *     type EmptyNode   = { value: null; next: EmptyNode; prev: EmptyNode }
 *
 * The head is ONE object, allocated as `{ next: null, prev: null, value: null }
 * as unknown as EmptyNode`, held as `HeadNode<T> | EmptyNode`, whose links
 * point at `ListNode<T>` literals whose links point back at it. JavaScript
 * sees one kind of object, `{ next, prev, value }`; laid out as three structs
 * every `head.prev.next = node` stores one record into another's reference
 * field, which a copy cannot do without breaking identity and a
 * reinterpretation is not a conversion. This is the alias counterpart of
 * `interface-families.ts`: the layout follows the object, not the view.
 *
 * A family is the aliases a UNION TYPE written in the program connects, when
 * every non-nullish arm of it is a candidate and all of them name exactly the
 * same keys. Required as well, each the rule rather than a gap:
 *
 * - Candidates are source aliases to a type literal of plain property
 *   signatures. A method, accessor, index or call signature is behaviour or
 *   a different carrier, not a field of the one object.
 * - The family LINKS: some member's field names a member. Arms with one key
 *   set that never reference each other are several objects, and a union of
 *   them is an ordinary tagged union.
 * - No discriminant: a key every member declares as a distinct literal is a
 *   tag telling genuinely different kinds apart, which keep their own layouts.
 *
 * A generic family is laid out once per INSTANCE -- per list of type
 * arguments its generic members are instantiated at together, because
 * `value: T` is a different field for every copy of `List`. An instance's
 * members are found through their own links (`ListNode<Job>.next` is
 * `ListNode<Job> | HeadNode<Job>`), which is also the only place the checker
 * instantiated them, and an instance whose links do not reach every generic
 * member keeps its own layouts: the missing member's fields would be guessed.
 * Every member lays out as the instance's first generic member, whose body
 * merges them all, so a copy's view and the checker's concrete instantiation
 * (`ListNode<T>` under `T = Job`, `ListNode<Job>`) intern as one anchor.
 *
 * A non-generic member (`EmptyNode`) joins the instance its unions pair it
 * with -- the one written in the generic body, which each copy's view then
 * substitutes -- and the family is dropped when they pair it with two: one
 * alias cannot be two layouts. Its own links are left out of the merge
 * (`links: 'family'`), since they name the family at that home rather than
 * at the instance being laid out.
 */
export const recordLinkFamiliesOf = (checker: ts.TypeChecker, files: readonly ts.SourceFile[]): RecordLinkFamilyCensus => {
  interface Candidate {
    readonly declaration: ts.TypeAliasDeclaration
    readonly keys: string
    readonly generic: boolean
  }
  const candidates = new Map<ts.TypeAliasDeclaration, Candidate>()
  const candidateOf = (declaration: ts.Declaration | undefined): Candidate | null => {
    if (!declaration || !ts.isTypeAliasDeclaration(declaration)) return null
    const known = candidates.get(declaration)
    if (known) return known
    if (declaration.getSourceFile().isDeclarationFile || !ts.isTypeLiteralNode(declaration.type)) return null
    const names: string[] = []
    for (const member of declaration.type.members) {
      if (!ts.isPropertySignature(member) || !member.type) return null
      if (!ts.isIdentifier(member.name) && !ts.isStringLiteral(member.name)) return null
      names.push(member.name.text)
    }
    if (names.length === 0) return null
    const candidate: Candidate = { declaration, keys: [...names].sort().join('\0'), generic: (declaration.typeParameters?.length ?? 0) > 0 }
    candidates.set(declaration, candidate)
    return candidate
  }
  const aliasDeclarationOf = (node: ts.TypeNode): ts.Declaration | undefined => {
    if (!ts.isTypeReferenceNode(node)) return undefined
    const symbol = checker.getSymbolAtLocation(node.typeName)
    const target = symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0 ? checker.getAliasedSymbol(symbol) : symbol
    return target?.declarations?.find(ts.isTypeAliasDeclaration)
  }
  const nullish = (node: ts.TypeNode): boolean =>
    node.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isLiteralTypeNode(node) && node.literal.kind === ts.SyntaxKind.NullKeyword)

  interface Pairing {
    readonly members: readonly { readonly candidate: Candidate; readonly type: ts.Type }[]
  }
  const pairings: Pairing[] = []
  for (const file of files) {
    if (file.isDeclarationFile) continue
    const visit = (node: ts.Node): void => {
      if (ts.isUnionTypeNode(node)) {
        const arms = node.types.filter((arm) => !nullish(arm))
        const members = arms.flatMap((arm) => {
          const candidate = candidateOf(aliasDeclarationOf(arm))
          return candidate ? [{ candidate, type: checker.getTypeFromTypeNode(arm) }] : []
        })
        const keys = members[0]?.candidate.keys
        if (
          members.length >= 2 &&
          members.length === arms.length &&
          members.every((member) => member.candidate.keys === keys) &&
          new Set(members.map((member) => member.candidate)).size >= 2
        ) {
          pairings.push({ members })
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  if (pairings.length === 0) return emptyRecordLinkFamilyCensus

  // Union-find over the declarations the pairings connect.
  const parent = new Map<Candidate, Candidate>()
  const find = (candidate: Candidate): Candidate => {
    const up = parent.get(candidate) ?? candidate
    if (up === candidate) return candidate
    const root = find(up)
    parent.set(candidate, root)
    return root
  }
  for (const pairing of pairings) {
    const first = pairing.members[0]!.candidate
    for (const member of pairing.members) {
      const a = find(first)
      const b = find(member.candidate)
      if (a !== b) parent.set(a, b)
    }
  }
  const families = new Map<Candidate, Candidate[]>()
  for (const candidate of candidates.values()) {
    const root = find(candidate)
    const family = families.get(root)
    if (family) family.push(candidate)
    else families.set(root, [candidate])
  }

  const byPosition = (left: Candidate, right: Candidate): number => {
    const leftFile = left.declaration.getSourceFile().fileName
    const rightFile = right.declaration.getSourceFile().fileName
    if (leftFile !== rightFile) return leftFile < rightFile ? -1 : 1
    return left.declaration.pos - right.declaration.pos
  }

  interface Family {
    readonly members: readonly Candidate[]
    readonly generics: readonly Candidate[]
    readonly canonical: Candidate
    readonly declarations: ReadonlySet<ts.TypeAliasDeclaration>
  }
  const familyOfDeclaration = new Map<ts.TypeAliasDeclaration, Family>()
  /** Where a plain member lives: the generic members' written arguments it is paired with. */
  const homeOfPlain = new Map<ts.TypeAliasDeclaration, ts.Type>()
  for (const [root, unsorted] of families) {
    if (unsorted.length < 2) continue
    const members = [...unsorted].sort(byPosition)
    const declarations = new Set(members.map((candidate) => candidate.declaration))
    if (!linksWithin(members, declarations, aliasDeclarationOf) || discriminated(members)) continue
    const generics = members.filter((candidate) => candidate.generic)
    const arity = generics[0]?.declaration.typeParameters?.length ?? 0
    if (generics.some((candidate) => candidate.declaration.typeParameters?.length !== arity)) continue
    const canonical = generics[0] ?? members[0]!
    // The one argument list each plain member is paired with; two lists
    // would ask one alias for two layouts.
    const homes = new Map<Candidate, readonly ts.Type[]>()
    const homeTypes = new Map<Candidate, ts.Type>()
    let broken = false
    for (const pairing of pairings) {
      if (find(pairing.members[0]!.candidate) !== root) continue
      const written = pairing.members.filter((member) => member.candidate.generic)
      const argumentLists = written.map((member) => member.type.aliasTypeArguments ?? [])
      const first = argumentLists[0] ?? []
      if (argumentLists.some((list) => !sameArguments(list, first))) {
        broken = true
        break
      }
      for (const member of pairing.members) {
        if (member.candidate.generic) continue
        const home = homes.get(member.candidate)
        if (home !== undefined && !sameArguments(home, first)) {
          broken = true
          break
        }
        homes.set(member.candidate, first)
        const anchor = written[0]?.type
        if (anchor && !homeTypes.has(member.candidate)) homeTypes.set(member.candidate, anchor)
      }
      if (broken) break
    }
    if (broken) continue
    const family: Family = { members, generics, canonical, declarations }
    for (const candidate of members) familyOfDeclaration.set(candidate.declaration, family)
    for (const [candidate, anchor] of homeTypes) homeOfPlain.set(candidate.declaration, anchor)
  }
  if (familyOfDeclaration.size === 0) return emptyRecordLinkFamilyCensus

  const declarationOfType = (type: ts.Type): ts.TypeAliasDeclaration | undefined =>
    type.aliasSymbol?.declarations?.find(ts.isTypeAliasDeclaration)

  /**
   * The generic members of one family written at one argument list, found
   * through the members' own fields -- the links are what make them one
   * object, and they are also the only place the checker has instantiated
   * the siblings (`ListNode<Job>.next` is `ListNode<Job> | HeadNode<Job>`).
   */
  const instanceClosure = new Map<ts.Type, ReadonlyMap<Candidate, ts.Type>>()
  const siblingsOf = (family: Family, start: ts.Type): ReadonlyMap<Candidate, ts.Type> => {
    const cached = instanceClosure.get(start)
    if (cached) return cached
    const argumentsOf = start.aliasTypeArguments ?? []
    const found = new Map<Candidate, ts.Type>()
    const visit = (type: ts.Type): void => {
      const declaration = declarationOfType(type)
      const candidate = declaration ? family.generics.find((one) => one.declaration === declaration) : undefined
      if (!candidate || found.has(candidate) || !sameArguments(type.aliasTypeArguments ?? [], argumentsOf)) return
      found.set(candidate, type)
      for (const property of type.getProperties()) {
        const value = checker.getTypeOfSymbol(property)
        for (const arm of value.isUnion() ? value.types : [value]) visit(arm)
      }
    }
    visit(start)
    for (const type of found.values()) instanceClosure.set(type, found)
    return found
  }

  const canonicalOf = (type: ts.Type): ts.Type | null => {
    const declaration = declarationOfType(type)
    const family = declaration ? familyOfDeclaration.get(declaration) : undefined
    if (!declaration || !family) return null
    if (family.generics.length === 0) {
      // A family of plain aliases is one layout, laid out as its first member.
      const symbol = checker.getSymbolAtLocation(family.canonical.declaration.name)
      return symbol ? checker.getDeclaredTypeOfSymbol(symbol) : null
    }
    const start = family.generics.some((one) => one.declaration === declaration) ? type : homeOfPlain.get(declaration)
    if (!start) return null
    const siblings = siblingsOf(family, start)
    // An instance whose links do not reach every generic member has a
    // member whose fields would be guessed; it keeps its own layouts.
    if (!family.generics.every((candidate) => siblings.has(candidate))) return null
    return siblings.get(family.canonical) ?? null
  }

  return {
    storageOf: (type) => canonicalOf(type) ?? type,
    membersOf: (type) => {
      const declaration = declarationOfType(type)
      const family = declaration ? familyOfDeclaration.get(declaration) : undefined
      if (!family || family.canonical.declaration !== declaration || canonicalOf(type) !== type) return null
      const siblings = family.generics.length === 0 ? null : siblingsOf(family, type)
      return family.members.flatMap((candidate): RecordLinkMember[] => {
        if (candidate.generic) {
          const sibling = siblings?.get(candidate)
          return sibling ? [{ type: sibling, declaration: candidate.declaration, links: 'own' }] : []
        }
        const symbol = checker.getSymbolAtLocation(candidate.declaration.name)
        const own = symbol ? checker.getDeclaredTypeOfSymbol(symbol) : undefined
        if (!own) return []
        // A plain member's links name the family at ITS home arguments, which
        // need not be this instance's: they are the family's links, which the
        // generic members already state at this one.
        return [{ type: own, declaration: candidate.declaration, links: family.generics.length === 0 ? 'own' : 'family' }]
      })
    },
    isLink: (type) => {
      const arms = (type.isUnion() ? type.types : [type]).filter((arm) => (arm.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) === 0)
      return (
        arms.length > 0 &&
        arms.every((arm) => {
          const declaration = declarationOfType(arm)
          return declaration !== undefined && familyOfDeclaration.has(declaration)
        })
      )
    }
  }
}

const sameArguments = (left: readonly ts.Type[], right: readonly ts.Type[]): boolean =>
  left.length === right.length && left.every((argument, index) => argument === right[index])

/** Whether some member's field names a member of the family -- the links that make the arms one object. */
const linksWithin = (
  family: readonly { readonly declaration: ts.TypeAliasDeclaration }[],
  inFamily: ReadonlySet<ts.TypeAliasDeclaration>,
  aliasDeclarationOf: (node: ts.TypeNode) => ts.Declaration | undefined
): boolean => {
  const names = (node: ts.Node): boolean => {
    if (ts.isTypeNode(node) && ts.isTypeReferenceNode(node)) {
      const declaration = aliasDeclarationOf(node)
      if (declaration && ts.isTypeAliasDeclaration(declaration) && inFamily.has(declaration)) return true
    }
    return ts.forEachChild(node, names) ?? false
  }
  return family.some(({ declaration }) =>
    ts.isTypeLiteralNode(declaration.type)
      ? declaration.type.members.some((member) => ts.isPropertySignature(member) && member.type !== undefined && names(member.type))
      : false
  )
}

/** Whether a key every member declares as a pairwise-distinct non-null literal tells the members apart. */
const discriminated = (family: readonly { readonly declaration: ts.TypeAliasDeclaration }[]): boolean => {
  const literalsByKey = new Map<string, string[]>()
  for (const { declaration } of family) {
    if (!ts.isTypeLiteralNode(declaration.type)) return false
    for (const member of declaration.type.members) {
      if (!ts.isPropertySignature(member) || !member.type || !member.name) continue
      const name = ts.isIdentifier(member.name) || ts.isStringLiteral(member.name) ? member.name.text : null
      if (name === null) continue
      const literal = member.type
      const text = ts.isLiteralTypeNode(literal) && literal.literal.kind !== ts.SyntaxKind.NullKeyword ? literal.literal.getText() : null
      const list = literalsByKey.get(name) ?? []
      list.push(text ?? '')
      literalsByKey.set(name, list)
    }
  }
  for (const texts of literalsByKey.values()) {
    if (texts.length === family.length && texts.every((text) => text !== '') && new Set(texts).size === texts.length) return true
  }
  return false
}
