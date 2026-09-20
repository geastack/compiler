import ts from 'typescript'
import type { SpecializationPath } from './identities.js'
import type { SpecializationCensus } from './specialization.js'

/**
 * What a monomorphized copy's members actually hold, read off the copy's own
 * instantiated spelling instead of derived by substituting a parameter.
 *
 * Substitution rewrites a BARE type parameter and nothing else. That is all it
 * can do -- the public checker API offers no way to instantiate a type, a gap
 * `specialization.ts`'s `induceFromHeritage` records for the same reason -- so a
 * member whose type merely *mentions* a parameter keeps the hole: `filter:
 * Filter<TSchema>`, `Promise<WithId<TSchema> | null>`, `AlternativeType<WithId<
 * TSchema>["_id"]>`. Every deferred conditional inside such a type stays
 * deferred, because a conditional is deferred exactly while its check type is
 * open, and representation then has no structure to lay out. On the mongodb
 * CMAP probe that one gap was 312 of 642 mandatory obligations, spread over five
 * copies of `Collection` whose fillings -- `Document`, `GridFSFile`,
 * `GridFSChunk`, `any`, `DataKey` -- were all recorded and all available.
 *
 * The instantiated spelling closes it without instantiating anything. A copy
 * minted from a type reference carries the type the checker resolved that
 * reference to (`Specialization.instantiated`), and reading a member off THAT
 * hands back the member's type with every conditional already evaluated,
 * because evaluating them is what instantiating meant. Pairing the
 * uninstantiated member against the instantiated one then yields a plain
 * type-to-type table, which is the one thing substitution could not build: an
 * answer for a composite.
 *
 * ## Why pairing by position is exact here
 *
 * Both sides come from the SAME symbol -- one read off the generic parent, one
 * off its instantiation -- so the instantiated member is the image of the
 * uninstantiated one under a single mapping. Signature `i` corresponds to
 * signature `i`, parameter `j` to parameter `j`, return to return. This is not
 * the situation `specialization.ts`'s `unifySignatures` guards against, where a
 * generic is paired against a concrete type *inferred from a call's arguments*
 * and nothing orders the two overload sets alike; here the order is the same
 * list, mapped.
 *
 * The counts are still checked at every level and the walk stops on any
 * mismatch, because instantiation can collapse a shape -- an overload set can
 * lose a signature to an argument that makes it identical to another, a union
 * arm can vanish -- and a pairing across a collapse would record an answer for
 * a type that is not its image.
 *
 * ## Why an OVERLOAD's parameters answer for the IMPLEMENTATION's
 *
 * `getTypeOfSymbolAtLocation` on an overloaded member publishes the overload
 * signatures and not the implementation, so the implementation's own parameter
 * declarations -- which is where `Collection.findOne`'s `filter: Filter<TSchema>
 * = {}` actually is -- have no instantiated signature of their own to read.
 * They do not need one. The table is keyed by the OPEN TYPE, and the checker
 * interns types: the implementation's annotation and the overload's are one
 * `ts.Type` object whenever they are the same written type, so the entry the
 * overload records is the entry the implementation looks up. Where the two
 * annotations genuinely differ they are different objects and no entry is
 * found, which is the honest answer.
 */
export interface InstantiatedMembers {
  /** The instantiated image of an open type under the copies this view is inside, or `null` when none is known. */
  readonly through: (type: ts.Type) => ts.Type | null
}

export const emptyInstantiatedMembers: InstantiatedMembers = { through: () => null }

/** How deep the pairing walk goes before it stops. A member type nested past this is not worth a table entry. */
const pairingDepth = 6

const memberNameOf = (member: ts.ClassElement | ts.TypeElement): string | null => {
  const name = member.name
  if (!name) return null
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return null
}

const isStatic = (member: ts.Node): boolean =>
  ts.canHaveModifiers(member) && (ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword) ?? false)

/**
 * The declarations whose types this table pairs: the members a generic
 * class or interface declares.
 *
 * A STATIC is excluded. The instantiated spelling of a class reference is the
 * INSTANCE type, so its property table holds instance members; a static read
 * off it is simply absent, and asking would either answer nothing or -- worse,
 * for a name a class declares both ways -- answer with the wrong one.
 */
const membersOf = (declaration: ts.Declaration): readonly (ts.ClassElement | ts.TypeElement)[] => {
  if (ts.isClassLike(declaration)) return declaration.members.filter((member) => !isStatic(member))
  if (ts.isInterfaceDeclaration(declaration)) return declaration.members
  return []
}

export const createInstantiatedMembers = (checker: ts.TypeChecker, specializations: SpecializationCensus) => {
  // Keyed by declaration and ordinal, not by the asking view: a copy's member
  // types are a property of the copy, and every path that passes through it
  // asks the same question. `null` marks a copy with no instantiated spelling,
  // so the miss is paid once.
  const tables = new Map<ts.Declaration, (Map<ts.Type, ts.Type> | null)[]>()

  /**
   * Whether `type` has a hole in it at all -- a type parameter, or one of the
   * deferred forms that only a parameter keeps open.
   *
   * This is the admission test for a table entry, and without it the walk
   * records an answer for CLOSED types too. That is not a harmless extra row:
   * `through` is asked before every other question in `structural.ts`'s
   * `translate`, so one wrong row redefines that type for the whole copy.
   * hono's `PatternRouter<T>` produced exactly that -- `string` paired against
   * `[T, ParamIndexMap]` through a positional walk whose two sides did not
   * correspond -- and every `string` in the copy then translated as that
   * tuple, which surfaced four functions away as `parts.join('')` refusing to
   * ToString its elements.
   *
   * A closed type needs no image: it already IS its own instantiation, and the
   * table exists only to answer for the ones that are not.
   */
  const isOpen = (type: ts.Type, depth: number, seen: Set<ts.Type>, owner: ts.Declaration): boolean => {
    // `Instantiable` is the checker's own name for exactly this: a type
    // parameter, a conditional, an indexed access, a `keyof`, a substitution
    // or a template-literal mapping -- every form that is unresolved only
    // while something it names is open. Open in THIS copy's parameters,
    // though, not in any parameter at all: see `isCopyHole`.
    if (type.flags & ts.TypeFlags.Instantiable) return isCopyHole(type, owner, depth)
    // A primitive, a literal or an enum member has no structure to hold a
    // hole and no image other than itself. Its apparent members are the
    // global interface's (`Number`, `String`), which is where the walk below
    // used to wander -- `number.toString(): string`, `string.concat(...:
    // string[])`, `string[].map<U>` -- and come back "open" on `map`'s own
    // `U`, so that `number` itself was recorded as a key.
    if ((type.flags & (ts.TypeFlags.Object | ts.TypeFlags.UnionOrIntersection)) === 0) return false
    if (depth > pairingDepth || seen.has(type)) return false
    seen.add(type)
    if (type.isUnionOrIntersection()) return type.types.some((one) => isOpen(one, depth + 1, seen, owner))
    for (const argument of type.aliasTypeArguments ?? []) if (isOpen(argument, depth + 1, seen, owner)) return true
    const reference = type as ts.TypeReference
    if (reference.target !== undefined) {
      for (const argument of checker.getTypeArguments(reference)) if (isOpen(argument, depth + 1, seen, owner)) return true
    }
    for (const property of type.getProperties()) {
      const at = property.valueDeclaration ?? property.declarations?.[0]
      if (at && isOpen(checker.getTypeOfSymbolAtLocation(property, at), depth + 1, seen, owner)) return true
    }
    for (const signature of [...type.getCallSignatures(), ...type.getConstructSignatures()]) {
      if (isOpen(signature.getReturnType(), depth + 1, seen, owner)) return true
      for (const parameter of signature.parameters) {
        const at = parameter.valueDeclaration ?? parameter.declarations?.[0]
        if (at && isOpen(checker.getTypeOfSymbolAtLocation(parameter, at), depth + 1, seen, owner)) return true
      }
    }
    return false
  }

  /**
   * Whether an instantiable type is gated on a parameter THIS copy fills.
   *
   * A type parameter is a hole of the copy when the copy's own declaration,
   * or one enclosing it, writes it -- and when a class, interface or alias
   * does, since those are filled by the reference the copy was minted from.
   * A parameter some OTHER signature writes is not: `Array<string>.map<U>`,
   * reached through a closed member's apparent type, is instantiated by the
   * checker at each call and never by this copy. Counting it recorded
   * `number => T["pos"]` for `setTextRange`'s copy inside `update<T>` -- the
   * copy's own `T` image read through a closed key -- and every `number` in
   * that copy then translated as the indexed access, whose walk re-entered
   * `number` and refused it as self-referential: tsc's `Node.pos`, `id` and
   * the whole `Mutable<Node>` family.
   *
   * The composite forms are walked through the checker's own public fields
   * to the parameters they are gated on; a form this does not know stays
   * open, which is the old answer and the safe one.
   */
  const isCopyHole = (type: ts.Type, owner: ts.Declaration, depth: number): boolean => {
    if (depth > pairingDepth) return true
    const flags = type.flags
    if (flags & ts.TypeFlags.TypeParameter) return parameterBelongsToCopy(type as ts.TypeParameter, owner)
    if (flags & ts.TypeFlags.IndexedAccess) {
      const access = type as ts.IndexedAccessType
      return isCopyHole(access.objectType, owner, depth + 1) || isCopyHole(access.indexType, owner, depth + 1)
    }
    if (flags & ts.TypeFlags.Conditional) {
      const conditional = type as ts.ConditionalType
      return isCopyHole(conditional.checkType, owner, depth + 1) || isCopyHole(conditional.extendsType, owner, depth + 1)
    }
    if (flags & ts.TypeFlags.Index) return isCopyHole((type as ts.IndexType).type, owner, depth + 1)
    if (flags & ts.TypeFlags.StringMapping) return isCopyHole((type as ts.StringMappingType).type, owner, depth + 1)
    if (flags & ts.TypeFlags.Substitution) return isCopyHole((type as ts.SubstitutionType).baseType, owner, depth + 1)
    if (flags & ts.TypeFlags.TemplateLiteral) return (type as ts.TemplateLiteralType).types.some((one) => isCopyHole(one, owner, depth + 1))
    if (type.isUnionOrIntersection()) return type.types.some((one) => isCopyHole(one, owner, depth + 1))
    return (flags & ts.TypeFlags.Instantiable) !== 0
  }

  /**
   * `isOpen` as `pair` asks it: depth 0, a fresh `seen`. With those two fixed
   * the answer is a function of the type and the owner alone, and the walk
   * behind it is the expensive part of building a table -- every property and
   * every signature parameter of the type, each through the checker, six
   * levels down. hono asked it for the same closed member types (`Response`,
   * `Promise<...>`, `Headers`) once per signature position that mentioned
   * them, and paid the whole walk every time; on `hono-hello` that was the
   * single largest checker cost in the frontend. Remembered per owner because
   * `isCopyHole` reads the owner.
   */
  const openness = new Map<ts.Declaration, Map<ts.Type, boolean>>()
  const isOpenFor = (type: ts.Type, owner: ts.Declaration): boolean => {
    let known = openness.get(owner)
    if (!known) openness.set(owner, (known = new Map()))
    const remembered = known.get(type)
    if (remembered !== undefined) return remembered
    const answer = isOpen(type, 0, new Set(), owner)
    known.set(type, answer)
    return answer
  }

  /**
   * Whether `pair` would record anything for `open` at this depth: the three
   * tests `pair` itself makes before it touches the closed side, lifted out so
   * a caller can make them BEFORE it reads the closed side at all.
   *
   * Reading the closed side is what costs. A closed member's type on the
   * instantiated parent is minted by instantiating the member's declared type
   * under the copy's arguments, and for hono's overload sets that is the
   * conditional-and-intersection machinery of `HandlerInterface` evaluated per
   * overload, per verb -- only for `pair` to look at the open side first and
   * return, because the open side had no hole. The open side is read off the
   * generic parent and is cheap; asking it first skips the instantiation for
   * every member that was never going to be paired.
   */
  const admits = (open: ts.Type, into: Map<ts.Type, ts.Type>, depth: number, owner: ts.Declaration): boolean =>
    depth <= pairingDepth && !into.has(open) && isOpenFor(open, owner)

  const parameterBelongsToCopy = (parameter: ts.TypeParameter, owner: ts.Declaration): boolean => {
    const declared = parameter.getSymbol()?.declarations?.[0]
    if (!declared || !ts.isTypeParameterDeclaration(declared)) return true
    const holder = declared.parent
    if (!ts.isFunctionLike(holder)) return true
    for (let ancestor: ts.Node | undefined = owner; ancestor !== undefined; ancestor = ancestor.parent) if (ancestor === holder) return true
    return false
  }

  const pair = (
    open: ts.Type,
    closed: ts.Type,
    into: Map<ts.Type, ts.Type>,
    depth: number,
    seen: Set<ts.Type>,
    owner: ts.Declaration
  ): void => {
    if (open === closed || !admits(open, into, depth, owner)) return
    // The open side is admitted because it has a genuine hole (`admits` already
    // proved that), so a closed image of `any`/`unknown` here is never the
    // checker reporting a real instantiation -- it is either the checker's own
    // internal error-recovery type surfacing through the public API with no
    // way to tell it apart from a real `any` (observed on
    // `ReadableStreamDefaultController.enqueue`: the class carries an implicit
    // polymorphic `this` type argument alongside `R`, and asking for a member's
    // type at the open declaration's location while only `R` is closed makes
    // `getTypeOfSymbolAtLocation` fail internally and hand back `errorType`,
    // which prints and flag-tests identically to `any`), or a genuine `any`/
    // `unknown` binding that ordinary substitution already resolves the same
    // way `through` would have. Recording it here is strictly worse than not
    // recording it: `through` is asked before every other question in
    // `translate`, so one wrong row collapses every occurrence of the open
    // type in this copy to `any` -- exactly this method's ABI blocker. Refusing
    // the entry falls back to substitution, which is the same answer when the
    // image genuinely is any/unknown, and the correct signature otherwise.
    if ((closed.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return
    into.set(open, closed)
    // Deliberately NOT cut short at `depth === pairingDepth`, although every
    // child below is refused at `depth + 1` and the cut would be exact. On hono
    // 83% of the signatures this walk touches are those leaves, and skipping
    // them saved two seconds here -- then cost ten downstream: the types the
    // leaves resolve are the ones `translate`, representation and lowering go
    // on to ask the checker for, and resolving them on this walk, top-down
    // through the instantiation, is several times cheaper than resolving them
    // from the queries those phases make. Measured 2026-09-16: normalization
    // 3.9s -> 10.7s, lowering 0.9s -> 3.5s, same graph to the operation.
    // A union is its ARMS and nothing else. Its properties and its call
    // signatures are synthesized by the checker from every arm at once, so
    // they are not the "one declared list, mapped" correspondence the walk
    // below relies on: the synthesized `push` of `[[T, Params][]] | [[T,
    // ParamIndexMap][], ParamStash]` carries a parameter built out of both
    // arms, and pairing it positionally against the instantiated union's
    // synthesized `push` recorded `[T, Params][] => [[H, RouterRoute],
    // ParamIndexMap][]` -- hono's `PatternRouter.match`, whose `[handlers]`
    // then had the wrong tuple element and matched neither arm of its own
    // declared result. The arms themselves are matched safely, so nothing is
    // lost by stopping here.
    if (open.isUnion() || closed.isUnion()) {
      if (open.isUnion() && closed.isUnion()) pairArms(open.types, closed.types, into, depth, seen, owner)
      return
    }
    if (open.isIntersection() && closed.isIntersection()) pairArms(open.types, closed.types, into, depth, seen, owner)
    // The ARGUMENTS of a reference, so `Promise<WithId<TSchema>>` records an
    // entry for `WithId<TSchema>` too. The target is checked, not just the
    // count: two references of the same arity to different generics have
    // nothing to do with each other, and a positional pairing across them
    // would record an answer for an unrelated type.
    const openReference = open as ts.TypeReference
    const closedReference = closed as ts.TypeReference
    if (openReference.target && openReference.target === closedReference.target) {
      const openArguments = checker.getTypeArguments(openReference)
      const closedArguments = checker.getTypeArguments(closedReference)
      if (openArguments.length === closedArguments.length) {
        for (let index = 0; index < openArguments.length; index += 1) {
          const one = openArguments[index]
          const other = closedArguments[index]
          if (one && other) pair(one, other, into, depth + 1, seen, owner)
        }
      }
    }
    // Members BY NAME. A record's own fields are where the remaining holes sit
    // once the signature positions are paired -- mongodb's `Filter<TSchema>` is
    // a mapped type whose every property is a `Condition<WithId<TSchema>[P]>` --
    // and a name is an exact correspondence rather than a position, so nothing
    // has to be assumed about ordering or about a collapse.
    for (const property of open.getProperties()) {
      const at = property.valueDeclaration ?? property.declarations?.[0]
      if (!at) continue
      const openMember = checker.getTypeOfSymbolAtLocation(property, at)
      if (!admits(openMember, into, depth + 1, owner)) continue
      const counterpart = checker.getPropertyOfType(closed, property.getName())
      if (!counterpart) continue
      pair(openMember, checker.getTypeOfSymbolAtLocation(counterpart, at), into, depth + 1, seen, owner)
    }
    pairSignatures(open.getCallSignatures(), closed.getCallSignatures(), into, depth, seen, owner)
    pairSignatures(open.getConstructSignatures(), closed.getConstructSignatures(), into, depth, seen, owner)
  }

  /**
   * A union's arms, matched by IDENTITY and then by elimination -- never by
   * position.
   *
   * The checker orders a union's members by internal type id, and an
   * instantiated arm is a freshly interned type whose id bears no relation to
   * the one it replaced, so the two lists are routinely in different orders.
   * hono's `PatternRouter<T>` produced exactly that: an open
   * `ArrayIterator<[T, ParamIndexMap]> | ArrayIterator<string> |
   * ArrayIterator<[T, Params]>` against a closed list whose `Params` arm had
   * moved to the front. Pairing those by position records an answer relating
   * two types that are not each other's image, and because `through` is asked
   * before every other question in `translate`, one such row redefines that
   * type for the whole copy -- surfacing four functions away as
   * `parts.join('')` refusing to ToString its elements.
   *
   * A CLOSED arm identifies itself: it has no hole, so instantiation left it
   * alone and the same `ts.Type` object appears on both sides. Striking those
   * off leaves the open arms and their images. Only a one-to-one leftover is
   * unambiguous, so that is the only case that records anything; anything else
   * is a collapse or a genuine ambiguity, and the honest answer is no entry.
   */
  const pairArms = (
    open: readonly ts.Type[],
    closed: readonly ts.Type[],
    into: Map<ts.Type, ts.Type>,
    depth: number,
    seen: Set<ts.Type>,
    owner: ts.Declaration
  ): void => {
    const remaining = [...closed]
    const unmatched: ts.Type[] = []
    for (const arm of open) {
      const at = remaining.indexOf(arm)
      if (at >= 0) remaining.splice(at, 1)
      else unmatched.push(arm)
    }
    const sole = unmatched.length === 1 ? unmatched[0] : undefined
    const image = remaining.length === 1 ? remaining[0] : undefined
    if (sole && image) pair(sole, image, into, depth + 1, seen, owner)
  }

  const pairSignatures = (
    open: readonly ts.Signature[],
    closed: readonly ts.Signature[],
    into: Map<ts.Type, ts.Type>,
    depth: number,
    seen: Set<ts.Type>,
    owner: ts.Declaration
  ): void => {
    if (open.length !== closed.length) return
    for (let index = 0; index < open.length; index += 1) {
      const left = open[index]
      const right = closed[index]
      if (!left || !right) continue
      const openReturn = left.getReturnType()
      if (admits(openReturn, into, depth + 1, owner)) pair(openReturn, right.getReturnType(), into, depth + 1, seen, owner)
      if (left.parameters.length !== right.parameters.length) continue
      for (let position = 0; position < left.parameters.length; position += 1) {
        const leftParameter = left.parameters[position]
        const rightParameter = right.parameters[position]
        const at = leftParameter?.valueDeclaration ?? leftParameter?.declarations?.[0]
        if (!leftParameter || !rightParameter || !at) continue
        const openParameter = checker.getTypeOfSymbolAtLocation(leftParameter, at)
        if (!admits(openParameter, into, depth + 1, owner)) continue
        pair(openParameter, checker.getTypeOfSymbolAtLocation(rightParameter, at), into, depth + 1, seen, owner)
      }
    }
  }

  const build = (declaration: ts.Declaration, ordinal: number): Map<ts.Type, ts.Type> | null => {
    const copy = specializations.specializationsOf(declaration)[ordinal]
    if (!copy) return null
    const closedParent = copy.instantiated
    const signatures = copy.instantiatedSignature
    if (!closedParent && !signatures) return null
    const table = new Map<ts.Type, ts.Type>()
    if (signatures) pairSignatures([signatures[0]], [signatures[1]], table, 0, new Set(), declaration)
    if (!closedParent) return table
    for (const member of membersOf(declaration)) {
      const name = memberNameOf(member)
      if (name === null) continue
      const openSymbol = checker.getSymbolAtLocation(member.name as ts.Node)
      if (!openSymbol) continue
      const openMember = checker.getTypeOfSymbolAtLocation(openSymbol, member)
      if (!admits(openMember, table, 0, declaration)) continue
      const closedSymbol = checker.getPropertyOfType(closedParent, name)
      if (!closedSymbol) continue
      pair(openMember, checker.getTypeOfSymbolAtLocation(closedSymbol, member), table, 0, new Set(), declaration)
    }
    return table
  }

  const tableFor = (declaration: ts.Declaration, ordinal: number): Map<ts.Type, ts.Type> | null => {
    const known = tables.get(declaration) ?? []
    const remembered = known[ordinal]
    if (remembered !== undefined) return remembered
    const built = build(declaration, ordinal)
    known[ordinal] = built
    tables.set(declaration, known)
    return built
  }

  /**
   * Innermost copy first, for the reason `createPathBinding` searches that way:
   * the nearest enclosing instantiation is the one in scope.
   */
  return (path: SpecializationPath): InstantiatedMembers => {
    if (path.length === 0) return emptyInstantiatedMembers
    return {
      through: (type) => {
        for (let index = path.length - 1; index >= 0; index -= 1) {
          const step = path[index]
          if (!step) continue
          const answer = tableFor(step.owner, step.ordinal)?.get(type)
          if (answer) return answer
        }
        return null
      }
    }
  }
}
