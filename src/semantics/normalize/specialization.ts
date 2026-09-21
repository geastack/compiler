import ts from 'typescript'
import { genericFunctionChoiceMembersOf } from './generic-function-choice.js'
import type { ProgramReachability } from './reachability.js'
import type { NamespacePathCensus } from './namespace-paths.js'
import { layoutRelevantParameterIndices, parametersInInstanceStorage } from './structural-layout-relevance.js'
import { isAmbientDeclaration } from '../ambient.js'

/**
 * Monomorphization: one copy of a generic body per distinct instantiation.
 *
 * A type parameter has no carrier. `T` is not a thing a value can be stored as
 * -- it is a hole an instantiation fills -- so representation refuses it, and
 * that refusal is correct. What is wrong is compiling the body *once* with the
 * hole still open, because the language says a generic body exists once per
 * instantiation and each of those has different types in it.
 *
 * Erasing to the constraint instead was considered and is wrong here. Java
 * erases `T extends Component` to `Component` because every reference is a
 * pointer to a heap object with a shared header; a `class-ref` carrier in this
 * compiler is a flat struct with the fields of exactly that class, so "erase to
 * the base" hands a caller a struct of the wrong size and shape. Erasure is not
 * a weaker monomorphization here, it is a different and unsound thing.
 *
 * This module answers only the enumeration question -- which instantiations the
 * program makes -- and answers it before anything is normalized, because the
 * census has to know how many copies of each body to emit before it emits any.
 * Substituting the bindings is the structural layer's job, and minting the
 * copies is the census's.
 *
 * A specialization is identified by an ORDINAL, not by the spelling of its type
 * arguments. `Store<AppState>` is `s0` because it is the first instantiation of
 * `Store` the deterministic walk reaches, exactly as a node is identified by its
 * position in that same walk. A key built from the argument's name would put a
 * declaration's spelling into an identity, which is the one thing identities
 * here may never carry.
 */

/** One instantiation of one generic declaration: what each of its type parameters is filled with. */
export interface Specialization {
  /** Position among this declaration's instantiations, in deterministic walk order. */
  readonly ordinal: number
  /** The type filling each of the declaration's type parameters, in declaration order. */
  readonly arguments: readonly ts.Type[]
  /**
   * This instantiation as the CHECKER spells it -- `Collection<Document>`, not
   * `Collection` plus a filling to apply.
   *
   * The public checker API cannot instantiate a type (this module's
   * `induceFromHeritage` records the same gap), so the only instantiated
   * spelling available is one the program itself wrote and the checker already
   * resolved. A copy minted from a type reference has exactly that; one induced
   * through a heritage clause or inferred from a call's arguments does not, and
   * answers `null`.
   *
   * It is what makes a MEMBER of a generic answerable. Substituting a parameter
   * only ever rewrites a bare `T`, so a member type that merely mentions one --
   * `filter: Filter<TSchema>`, `Awaited<WithId<TSchema>>` -- keeps the hole and
   * every deferred conditional inside it stays deferred. Read the member off
   * this type instead (`getPropertyOfType`, then the member's own signature)
   * and the checker hands back the instantiated type with those conditionals
   * already evaluated, because evaluating them is what instantiating meant.
   */
  readonly instantiated: ts.Type | null
  /**
   * The uninstantiated signature this copy came from paired with the one the
   * checker resolved the call to, for a copy minted from a CALL rather than
   * from a type reference.
   *
   * The same fact as `instantiated`, for the other half of the generics. A
   * call site has no instantiated TYPE to read members off -- the callee is a
   * function, not a parent -- but it does have the very thing `instantiated`
   * exists to supply: an image of the open shape with every parameter filled,
   * which `getResolvedSignature` already computed to type-check the call.
   * Pairing the two gives a generic FUNCTION's parameter and return types the
   * same answer a generic CLASS's members get.
   */
  readonly instantiatedSignature: readonly [ts.Signature, ts.Signature] | null
  /** The filling for one type-parameter declaration, or `null` when this specialization does not bind it. */
  readonly bindingOf: (parameter: ts.Declaration) => ts.Type | null
  /**
   * What this copy's own instantiation filled an OPEN composite type with:
   * `T[]` -> `string[]`, `Mutable<T>` -> `Mutable<VariableDeclaration>`. Read
   * from the checker's resolved signature of the call that minted the copy,
   * paired against the generic one, so every type the copy's frame writes
   * with a hole inside has the checker's own closed spelling beside it. A
   * bare parameter is `bindingOf`'s question; this answers the shapes built
   * around one, which the public checker API cannot instantiate on request.
   * `null` for a copy minted by substitution or heritage, which had no call.
   */
  readonly fillingOf: (open: ts.Type) => ts.Type | null
}

export interface SpecializationCensus {
  /**
   * Every instantiation of this generic declaration, or an empty list when the
   * program instantiates it none -- a generic nothing uses has no body worth
   * copying, and emitting an uninstantiated copy would put the open hole back.
   */
  readonly specializationsOf: (declaration: ts.Declaration) => readonly Specialization[]
  /** Whether this declaration is one the census specializes at all. */
  readonly isGeneric: (declaration: ts.Declaration) => boolean
  /**
   * The instantiation a particular site makes, so a call or a heritage clause
   * can name the copy it reaches rather than the generic it was written against.
   *
   * `substitute` is what the *asking* copy binds a type parameter to, and it is
   * what makes this answer honest for a site written inside another generic.
   * `class ReactiveComponent<Root> extends Component<Root> {}` names one copy of
   * `Component` per copy of `ReactiveComponent`, so the ordinal is a property of
   * the site *and* of the copy asking -- never of the node alone. Storing one
   * ordinal on the node would answer every copy with whichever was seen first,
   * which is the same shape of defect `copyKeyOf` exists to prevent one level
   * up. Asking with no substitution is the root scope's own question; a site
   * whose fillings are still holes after substitution answers `null`, because an
   * open hole names no copy.
   */
  readonly specializationAt: (
    node: ts.Node,
    substitute?: (type: ts.Type) => ts.Type
  ) => { readonly declaration: ts.Declaration; readonly ordinal: number } | null
  /**
   * The copies a call through a CHOICE of generic functions reaches -- one
   * per member of the set the callee's type is (`genericFunctionSetMembersOf`,
   * model/structural-types.ts) -- in the same substitution discipline as
   * `specializationAt`. `null` when the call is not through such a set or any
   * member's copy is still open in the asking copy.
   */
  readonly setSpecializationsAt: (
    node: ts.Node,
    substitute?: (type: ts.Type) => ts.Type
  ) => readonly { readonly declaration: ts.Declaration; readonly ordinal: number }[] | null
  /**
   * The copy an INSTANTIATED class or interface type names -- `Box<number>`
   * read off a receiver expression -- in the same substitution discipline as
   * `specializationAt`: the type's own arguments, substituted by the asking
   * copy, looked up among the tuples this census minted. `null` for a type
   * that is not an instantiation of a censused generic, or whose arguments
   * are still holes after substitution.
   *
   * What lets a use site OUTSIDE a class reach the copy its receiver is an
   * instance of: `numbers.pick('a')` with `numbers: Box<number>` runs
   * `pick`'s frame in `Box<number>`'s copy, not the root's.
   */
  readonly specializationOfInstance: (
    type: ts.Type,
    substitute?: (type: ts.Type) => ts.Type
  ) => { readonly declaration: ts.Declaration; readonly ordinal: number } | null
  /**
   * Whether a class's copies can be more than one physical layout: two copies
   * whose layout-RELEVANT fillings (`layoutRelevantParameterIndices`) are
   * different checker types.
   *
   * Copies are deduped by the identity of their fillings (the checker interns
   * types), so this is answered without translating a single type -- which
   * is the point: structural ids are spelled into struct names, and a class
   * every one of whose copies agrees on its relevant fillings (hono's
   * `Hono<E,S,BasePath>` across every route registration) must be typed
   * exactly as it was before any class had two layouts. Two different
   * objects can still be one physical layout (`Carrier<'a' | 'b'>` beside
   * `Carrier<string>`); the deriver's `physicalClassDeclarationOf` decides
   * that on the fillings' representations, and this only says whether it has
   * a question. `false` for an ambient class -- its instances belong to a
   * host protocol keyed on the root -- and for a generic with one copy.
   */
  readonly copiesMayDifferInLayout: (declaration: ts.Declaration) => boolean
  /**
   * For a class whose copies must NOT split (`copiesMayDifferInLayout` is
   * false) but whose layout-relevant fillings still differ, the fillings the
   * one shared struct is built from: the copy every other copy is assignable
   * TO, which is the most specific one.
   *
   * Without this the collapse is dishonest. The instance side keys its anchor
   * on the written fillings, so `ReadableStream<any>` and
   * `ReadableStream<Uint8Array>` are two structural shapes -- and they then
   * map to ONE physical class, whose field carriers come from whichever
   * anchor happened to complete first. When that is the `any` copy the struct
   * stores `dynamic` and every read in the concrete copy refuses, because
   * `dynamic -> typed-array(uint8)` is a narrowing no target installs. Naming
   * the most specific copy instead makes every other copy's read a WIDENING,
   * which is licensed, and gives the collapse one anchor rather than two
   * sharing a struct by accident of ordering.
   *
   * `null` when the class may split, when its copies already agree, or when
   * no copy is assignable to all the others -- there is no honest single
   * layout then, and the caller keeps what it wrote.
   */
  readonly canonicalLayoutFillings: (declaration: ts.Declaration) => readonly ts.Type[] | null
}

export const emptySpecializationCensus: SpecializationCensus = {
  specializationsOf: () => [],
  isGeneric: () => false,
  specializationAt: () => null,
  setSpecializationsAt: () => null,
  specializationOfInstance: () => null,
  copiesMayDifferInLayout: () => false,
  canonicalLayoutFillings: () => null
}

const typeParametersOf = (declaration: ts.Declaration): readonly ts.TypeParameterDeclaration[] => {
  const withParameters = declaration as ts.Declaration & { readonly typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }
  return withParameters.typeParameters ?? []
}

/**
 * The declaration whose type parameters a node's value actually writes down.
 *
 * `function identity<T>(x: T): T {}` and `const identity = <T>(x: T): T => x`
 * are the same declaration written two ways -- both name a generic function,
 * both are instantiated per call site -- and this census keys specializations
 * on the node that CARRIES the type parameters, which for the second spelling
 * is the arrow function rather than the variable declaration naming it.
 *
 * Every consumer that asks "which copy does this declaration belong to" has to
 * ask about the same node, or the two halves disagree: `census.ts` forks the
 * walk here, and `identities.ts`'s `useSitePath` resolves a name to a copy
 * here. When only one of them hopped, the arrow forked per copy while the
 * declaration holding it stayed at the root path -- and the binding recorded
 * there cited an allocation that exists only inside a copy.
 */
export const genericSubjectOf = (node: ts.Declaration, targetOfName?: (name: ts.Identifier) => ts.Declaration | null): ts.Declaration => {
  if (!ts.isVariableDeclaration(node) || node.initializer === undefined) return node
  if (ts.isFunctionLike(node.initializer)) return node.initializer as ts.Declaration
  if (!targetOfName || !ts.isIdentifier(node.initializer)) return node
  // An ANNOTATED binding is a cell of the annotation's own type, not a second
  // name for the generic: `const nodeVisitor: NodeVisitor = visitNode` holds
  // one closure over the constraints, converted into the annotation's
  // convention, and calls through it are calls through that cell. Hopping it
  // left the program with no cell at all for the name its reads cite.
  if (node.type !== undefined) return node
  // `const jsxs = jsx` -- a generic named as a VALUE. The two names denote one
  // function, and the copies belong to whichever declaration writes the type
  // parameters, so the alias has to fork with its target rather than hold a
  // value of its own. It cannot hold one: `auto f = jsx;` is ill-formed C++
  // when `jsx` is a template, whatever instantiations exist elsewhere.
  //
  // ONE hop, and only to a generic FUNCTION. Chaining would need a cycle guard
  // for no case anyone writes, and widening it to any generic declaration
  // reaches `const S = Set` -- a generic CLASS, which is bound through a host
  // protocol keyed on its own root and breaks when a copy answers for it.
  const target = targetOfName(node.initializer)
  if (!target) return node
  const subject =
    ts.isVariableDeclaration(target) && target.initializer !== undefined && ts.isFunctionLike(target.initializer)
      ? (target.initializer as ts.Declaration)
      : target
  return ts.isFunctionLike(subject) && typeParametersOf(subject).length > 0 ? subject : node
}

/** Whether this type is itself a hole. Binding one parameter to another resolves nothing, so such a pairing is not an instantiation. */
const isHole = (type: ts.Type): boolean => (type.flags & ts.TypeFlags.TypeParameter) !== 0

/**
 * Whether a filling still has a hole ANYWHERE inside it.
 *
 * `isHole` alone asks only about the top: `AbstractCursor<WithId<TSchema>>`
 * passes it, because `WithId<TSchema>` is an object type and not a parameter.
 * The instantiation it describes is not one the program makes, though -- it is
 * one copy of `Collection<TSchema>`'s own body writing down a reference whose
 * argument is still open -- and minting a copy for it puts back exactly the
 * state monomorphization exists to remove: a body walked with a parameter
 * nothing in that copy binds. mongodb's `AbstractCursor` had seven copies and
 * one of them was `WithId<TSchema>`; every `TSchema` inside it reached
 * representation with no carrier.
 *
 * The check is the deep one because the shallow one cannot tell the two apart,
 * and the copy a program really does make -- `AbstractCursor<WithId<Document>>`,
 * from a call the checker itself already resolved -- is recorded from that
 * call, not from this reference.
 */
const containsHole = (type: ts.Type, depth = 0): boolean => {
  if (isHole(type)) return true
  if (depth > 6) return false
  if (type.isUnionOrIntersection()) return type.types.some((one) => containsHole(one, depth + 1))
  // BOTH argument lists, always. An instantiated ANONYMOUS type -- a mapped
  // alias like tsc's `Mutable<T>`, an inline object or function type -- has a
  // `target` (the open anonymous type it was instantiated from) and NO
  // `typeArguments`, so choosing one list by the presence of `target` read an
  // empty list for it and called `Mutable<T>` closed. `setTextRange(updated,
  // original)` inside `update<T extends Node>` then minted ONE copy of
  // `setTextRange`, over the open `Mutable<T>`, instead of one per copy of
  // `update` -- 171 tsc self-compile rows, every one a callee whose carrier
  // was the constraint image while the call wanted the instantiation.
  const reference = type as ts.TypeReference
  const args = [...(reference.typeArguments ?? []), ...(type.aliasTypeArguments ?? [])]
  return args.some((one) => containsHole(one, depth + 1))
}

/**
 * The declaration whose body a set of type parameters belongs to.
 *
 * A type parameter's own declaration is a `TypeParameter` node whose parent is
 * the generic. That parent is what gets copied, so it is what a specialization
 * is recorded against.
 */
/**
 * A filling that is not a layout: `any`, or one still mentioning a type
 * parameter.
 *
 * `containsHole` walks type ARGUMENTS, so it sees `Box<T>` but not `I["out"]`
 * -- an indexed access keeps its parameter in `objectType`, and a conditional
 * keeps one in each branch. hono records `HonoRequest<any, I["out"]>` as a
 * copy through exactly that gap: `P` was substituted and `I` was not.
 *
 * Such a copy states no layout, so it cannot be EVIDENCE of one either -- it
 * must neither force copies apart nor be the shape they are folded onto. It is
 * deliberately not routed through `containsHole` itself, which decides whether
 * a copy is recorded at all: `Context.req` is declared `HonoRequest<P, I['out']>`
 * and dropping that copy leaves the field with no censused carrier.
 */
const openFilling = (type: ts.Type | undefined, depth = 0): boolean => {
  if (type === undefined) return false
  if ((type.flags & (ts.TypeFlags.Any | ts.TypeFlags.TypeParameter)) !== 0) return true
  if (depth > 6) return false
  if (type.isUnionOrIntersection()) return type.types.some((one) => openFilling(one, depth + 1))
  if ((type.flags & ts.TypeFlags.IndexedAccess) !== 0) {
    const indexed = type as ts.IndexedAccessType
    return openFilling(indexed.objectType, depth + 1) || openFilling(indexed.indexType, depth + 1)
  }
  if ((type.flags & ts.TypeFlags.Conditional) !== 0) {
    const conditional = type as ts.ConditionalType
    return openFilling(conditional.checkType, depth + 1) || openFilling(conditional.extendsType, depth + 1)
  }
  if ((type.flags & ts.TypeFlags.Index) !== 0) return openFilling((type as ts.IndexType).type, depth + 1)
  if ((type.flags & ts.TypeFlags.Substitution) !== 0) return openFilling((type as ts.SubstitutionType).baseType, depth + 1)
  const reference = type as ts.TypeReference
  return [...(reference.typeArguments ?? []), ...(type.aliasTypeArguments ?? [])].some((one) => openFilling(one, depth + 1))
}

const ownerOf = (parameter: ts.TypeParameterDeclaration | undefined): ts.Declaration | null => {
  const parent = parameter?.parent
  if (!parent) return null
  // Only the kinds whose body or shape is actually copied. A `JSDocTemplateTag`
  // or an `infer` position also parents a type parameter and neither names
  // something a specialization can be recorded against.
  return ts.isClassLike(parent) || ts.isInterfaceDeclaration(parent) || ts.isTypeAliasDeclaration(parent) || ts.isFunctionLike(parent)
    ? (parent as ts.Declaration)
    : null
}

/**
 * Pair a generic type with the instantiated one the checker produced from it,
 * recording what each parameter was filled with.
 *
 * This walks the two types in lockstep rather than reading the checker's
 * internal type mapper, which is not public API. The shapes are congruent by
 * construction -- one *is* the other with holes filled -- so the walk is a
 * structural comparison with no inference in it: at every position where the
 * generic side is a hole, the concrete side is that hole's filling.
 *
 * Unions and intersections are deliberately not walked. `T | string` against
 * `number | string` has no unique alignment -- the arms are a set, not a
 * sequence -- and picking one would record a binding the language never made.
 */
const carriesAbsence = (type: ts.Type): boolean =>
  type.isUnion() && type.types.some((arm) => (arm.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) !== 0)

/**
 * A union with its absence arms removed. Spelled by hand rather than through
 * `getNonNullableType`: for an UNCONSTRAINED parameter the checker spells
 * `NonNullable<T>` as the intersection `T & {}`, which `isHole` does not
 * recognise -- so `maybe<T>(value: T | undefined): T | undefined` bound `T`
 * nowhere, minted no copy, and every direct call of it was refused at lowering
 * as a generic set with no closed family. A constrained `U extends string`
 * survives `getNonNullableType` as itself, which is the only reason hono's
 * `c.json` shape ever bound. One present arm is that arm; several fall back to
 * the checker's spelling, which for a closed type is the union of them.
 */
const presentOf = (checker: ts.TypeChecker, type: ts.Type): ts.Type => {
  if (!type.isUnion()) return type
  const present = type.types.filter((arm) => (arm.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)) === 0)
  const sole = present.length === 1 ? present[0] : undefined
  return sole ?? checker.getNonNullableType(type)
}

const unify = (
  checker: ts.TypeChecker,
  generic: ts.Type,
  concrete: ts.Type,
  depth: number,
  record: (parameter: ts.Type, bound: ts.Type) => void,
  recordPair: ((open: ts.Type, closed: ts.Type) => void) | null = null
): void => {
  if (depth > 8 || generic === concrete) return
  if (isHole(generic)) {
    record(generic, concrete)
    return
  }
  // A composite with a hole inside, beside the closed type the checker built
  // for it: the pair a copy answers `fillingOf` from.
  if (recordPair && containsHole(generic)) recordPair(generic, concrete)
  // An OPTIONALITY MARKER is not content. `status?: U` is read as `U |
  // undefined` and its instantiation as `ContentfulStatusCode | undefined`:
  // one arm on the left, many on the right, so the positional union walk
  // below declines and `U` binds nothing. TypeScript contributes that
  // `undefined` on BOTH sides for the `?`, so it belongs to neither union's
  // content -- dropping it from both restores the congruence the walk needs.
  // hono's `c.json({ hello: 'world' })` is exactly this shape, and `U`
  // failing to bind discarded the ENTIRE instantiation, `T` included, which
  // is what left `Context.json` an uninitialized field.
  //
  // Only when both sides carry it. A lone `undefined` on the concrete side is
  // a hole's filling, not a marker.
  if (carriesAbsence(generic) && carriesAbsence(concrete)) {
    const genericPresent = presentOf(checker, generic)
    const concretePresent = presentOf(checker, concrete)
    if (genericPresent !== generic || concretePresent !== concrete) {
      unify(checker, genericPresent, concretePresent, depth + 1, record, recordPair)
      return
    }
  }
  // The marker COLLAPSED under instantiation. `T | undefined` with `T` bound
  // to `undefined` is one member, `undefined`, and the checker does infer
  // exactly that: tsc's `return toSearchResult(/*value*/ undefined)` resolves
  // to `(value: undefined): SearchResult<undefined>`. A generic union whose
  // only present arm is a hole, against a concrete type carrying no absence,
  // is that collapse -- the whole concrete type is the hole's filling
  // (`unknown` and `any` absorb the marker the same way). Nothing else reaches
  // here: an optional parameter or a `| undefined` return keeps its marker
  // under every non-absorbing filling.
  if (carriesAbsence(generic) && !carriesAbsence(concrete)) {
    const sole = presentOf(checker, generic)
    if (isHole(sole)) {
      record(sole, concrete)
      return
    }
  }
  // Two instantiations of one generic type ALIAS. The alias's arguments are
  // not `typeArguments` (see the reference branch below) but the checker
  // keeps them as `aliasTypeArguments`, positionally against the alias's own
  // parameters -- `SearchResult<T>` against `SearchResult<undefined>` names
  // `T`'s filling directly, where walking into the aliased object literal's
  // members would not (members are not walked here). Read before the
  // reference branch so an alias over a reference still pairs by the alias.
  if (
    generic.aliasSymbol !== undefined &&
    generic.aliasSymbol === concrete.aliasSymbol &&
    generic.aliasTypeArguments !== undefined &&
    concrete.aliasTypeArguments !== undefined
  ) {
    for (let index = 0; index < Math.min(generic.aliasTypeArguments.length, concrete.aliasTypeArguments.length); index += 1) {
      const left = generic.aliasTypeArguments[index]
      const right = concrete.aliasTypeArguments[index]
      if (left && right) unify(checker, left, right, depth + 1, record, recordPair)
    }
    return
  }
  const genericReference = generic as ts.TypeReference
  const concreteReference = concrete as ts.TypeReference
  const genericArguments = genericReference.typeArguments
  const concreteArguments = concreteReference.typeArguments
  if (
    (generic.flags & ts.TypeFlags.Object) !== 0 &&
    (concrete.flags & ts.TypeFlags.Object) !== 0 &&
    genericReference.target !== undefined &&
    genericReference.target === concreteReference.target &&
    // Only when the arguments are actually READABLE here. Two instantiations
    // of a generic type ALIAS share a `target` exactly as two references to a
    // generic interface do, but an alias's arguments live in the mapper the
    // checker instantiated it with, not in `typeArguments` -- so this branch
    // matched, found an empty argument list, and returned having unified
    // nothing. hono's `ErrorHandler<E>` against `ErrorHandler<any>` is that
    // shape, and stopping there is why `compose<E>` was recorded with `E`
    // bound by nothing. Falling through to the signature walk below reaches
    // the same hole the long way, through `Context<E>` in the parameter list.
    genericArguments !== undefined &&
    concreteArguments !== undefined
  ) {
    for (let index = 0; index < Math.min(genericArguments.length, concreteArguments.length); index += 1) {
      const left = genericArguments[index]
      const right = concreteArguments[index]
      if (left && right) unify(checker, left, right, depth + 1, record, recordPair)
    }
    return
  }
  // A UNION on both sides, member for member. `onError?: ErrorHandler<E>` is
  // read as `ErrorHandler<E> | undefined`, and a union carries no call
  // signature of its own -- so without this the hole inside it was never
  // reached, and hono's `compose<E>` was called twice with `E` bound by
  // nothing at all: no instantiation was recorded, `compose` was registered
  // as a generic with no copies, and `census.ts` walks one of those NOT AT
  // ALL. The whole of `compose.ts` published a single `module-evaluate`, and
  // emission refused the read as a declaration this program never introduces.
  //
  // Paired POSITIONALLY, and only when the counts match. The concrete union
  // is an instantiation of the generic one, so the checker's own member order
  // corresponds -- but a member can collapse under instantiation (`T |
  // undefined` with `T` bound to `undefined` is one member), and a pairing
  // across a collapse would bind a hole to a member that is not its own.
  if (generic.isUnion() && concrete.isUnion() && generic.types.length === concrete.types.length) {
    for (let index = 0; index < generic.types.length; index += 1) {
      const left = generic.types[index]
      const right = concrete.types[index]
      if (left && right) unify(checker, left, right, depth + 1, record, recordPair)
    }
    return
  }
  unifySignatures(checker, generic.getCallSignatures(), concrete.getCallSignatures(), depth, record, recordPair)
  unifySignatures(checker, generic.getConstructSignatures(), concrete.getConstructSignatures(), depth, record, recordPair)
}

/**
 * One signature list against another.
 *
 * Only a single-signature pair is walked. An overloaded type's signatures are
 * not ordered by anything the instantiation preserves, so aligning the nth with
 * the nth would pair a generic's second overload with a concrete's second for
 * no reason beyond position.
 */
const unifySignatures = (
  checker: ts.TypeChecker,
  generics: readonly ts.Signature[],
  concretes: readonly ts.Signature[],
  depth: number,
  record: (parameter: ts.Type, bound: ts.Type) => void,
  recordPair: ((open: ts.Type, closed: ts.Type) => void) | null = null
): void => {
  const generic = generics[0]
  const concrete = concretes[0]
  if (generics.length !== 1 || concretes.length !== 1 || !generic || !concrete) return
  unify(checker, generic.getReturnType(), concrete.getReturnType(), depth + 1, record, recordPair)
  // `this` IS a parameter -- ECMA-262 gives it a binding in the function
  // environment like any other -- and it is the only one `Signature.parameters`
  // leaves out. A generic whose type parameter appears ONLY there was therefore
  // never bound by this walk. hono's `export function match<R extends
  // Router<T>, T>(this: R, method: string, path: string)` is the case: `T` is
  // bound from the return type and `R` stayed open, so `fromValueUse` saw one
  // of two parameters filled, minted no copy, and `RegExpRouter`'s field
  // initializer `match: typeof match<Router<T>, T> = match` then read the ROOT
  // declaration -- which the program never introduces, because a generic this
  // program defines is recorded per copy and never at the root, and emission
  // refused the read by name.
  //
  // `thisParameter` is not on the public `Signature`, so it is reached the same
  // guarded way `structural-array-element.ts` reaches `getUnionType`.
  const genericThis = (generic as ts.Signature & { readonly thisParameter?: ts.Symbol }).thisParameter
  const concreteThis = (concrete as ts.Signature & { readonly thisParameter?: ts.Symbol }).thisParameter
  if (genericThis && concreteThis) {
    const genericThisType = typeOfParameter(checker, genericThis)
    const concreteThisType = typeOfParameter(checker, concreteThis)
    if (genericThisType && concreteThisType) unify(checker, genericThisType, concreteThisType, depth + 1, record, recordPair)
  }
  for (let index = 0; index < Math.min(generic.parameters.length, concrete.parameters.length); index += 1) {
    const left = generic.parameters[index]
    const right = concrete.parameters[index]
    if (!left || !right) continue
    const leftType = typeOfParameter(checker, left)
    const rightType = typeOfParameter(checker, right)
    if (leftType && rightType) unify(checker, leftType, rightType, depth + 1, record, recordPair)
  }
}

/** A parameter symbol's declared type, or `null` when the symbol has no declaration to read it at. */
const typeOfParameter = (checker: ts.TypeChecker, parameter: ts.Symbol): ts.Type | null => {
  const at = parameter.valueDeclaration ?? parameter.declarations?.[0]
  return at ? checker.getTypeOfSymbolAtLocation(parameter, at) : null
}

// Every `checker.getTypeAtLocation` / `Signature.getReturnType()` /
// `checker.getTypeOfSymbolAtLocation` call below (`unify`, `unifySignatures`,
// `typeOfParameter`, `induceFromHeritage`, `genericSignatureOf`, `fromCall`,
// `fromTypeReference`, the `visit` walk) answers "what did the LANGUAGE
// resolve this generic/heritage/call site to", not "what does this node
// hold" -- there is no census question to ask. This module's own header says
// why directly: it "answers it before anything is normalized, because the
// census has to know how many copies of each body to emit before it emits
// any". `frontend.ts`'s `runFrontend` computes `instantiations` and
// `specializations` first, ahead of the parameter/return/local/field binding
// fixpoint those two feed -- so at every site below, no census instance
// exists yet to convert a checker call to. Left as direct checker calls,
// verified by reading `frontend.ts`'s call order. See the matching note in
// `instantiation.ts`.
export const censusSpecializations = (
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  reachable: ProgramReachability,
  namespacePaths: NamespacePathCensus
): SpecializationCensus => {
  // Per generic declaration: the instantiations seen so far, each a tuple of
  // the types filling its parameters, in declaration order. Tuples are compared
  // by the identity of the types in them -- the checker interns types, so two
  // spellings of one type are one object and dedupe without a key.
  const tuples = new Map<ts.Declaration, ts.Type[][]>()
  // A site records the fillings it was *written* with, holes included, rather
  // than the ordinal they resolved to. `Base<T>` inside `Mid<T>` denotes a
  // different copy of `Base` in every copy of `Mid`, so no single ordinal
  // belongs to the node; it is looked up when the site is read, from fillings
  // the asking copy has substituted for itself.
  const sites = new Map<ts.Node, { declaration: ts.Declaration; fillings: readonly ts.Type[] }>()
  // The same, for a call through a choice of generic functions: one site per
  // member, all keyed by the one call node. See `setSpecializationsAt`.
  const setSites = new Map<ts.Node, { declaration: ts.Declaration; fillings: readonly ts.Type[] }[]>()

  // The checker's own spelling of each recorded instantiation, by ordinal, for
  // the copies that have one. Kept beside `tuples` rather than in it so the
  // tuple stays the identity -- two sites spelling one instantiation are one
  // copy, and whichever of them was seen first supplies the spelling.
  const spellings = new Map<ts.Declaration, (ts.Type | null)[]>()
  // The same, for a copy minted from a call: the open signature beside the one
  // the checker resolved that call to.
  const signaturePairs = new Map<ts.Declaration, (readonly [ts.Signature, ts.Signature] | null)[]>()
  // The same, for the composite fillings a call-minted copy's frame closes: see `Specialization.fillingOf`.
  const compositeFillings = new Map<ts.Declaration, (ReadonlyMap<ts.Type, ts.Type> | null)[]>()
  /**
   * A spelling for a copy that MAY NOT EXIST, held against its tuple.
   *
   * A call's resolved return type is a spelling the checker has already
   * computed for an instantiation the program makes -- `db.collection<DataKey>(
   * ...)` really does produce `Collection<DataKey>` -- and that spelling is the
   * one thing `structural-instantiated-member.ts` needs to read a copy's
   * members with the hole closed. What it is NOT is evidence that a copy should
   * EXIST. A method on a generic class names its own class in its return type
   * (`Hono.get` returns `Hono<E, S, MergePath<...>, ...>`), so minting from one
   * manufactures a copy per call site that nothing in the program instantiates:
   * three of hono's own class-property arrows lost their carriers to copies
   * minted exactly that way, and a program that certified stopped certifying.
   *
   * So the spelling waits here, keyed by the tuple rather than by an ordinal,
   * and `tupleOrdinal` claims it if and when a site that really does
   * instantiate mints that copy. Order-independent by construction, which
   * matters: the copy `db.collection<DataKey>` returns is minted by the
   * fixpoint round AFTER this census sees the call, so a back-fill that only
   * wrote to existing ordinals would answer nothing at all.
   */
  const deferredSpellings = new Map<ts.Declaration, { tuple: readonly ts.Type[]; instantiated: ts.Type }[]>()
  /**
   * Per ordinal: does anything in the program actually MINT this copy?
   *
   * A written `Token<unknown>` in `string | Token<unknown> | null` states a
   * type a value may be viewed AT; `new Token<number>()` states a value that
   * exists. Only the second is a layout. The distinction is invisible while
   * one class serves every filling and decisive once copies can split: made a
   * separate struct, the union arm stops admitting the only value that ever
   * reaches it ("a dynamic value admitted by no union arm", measured on
   * `stated-open-union-preserves-closed-arms.ts`), while folding a copy the
   * program really does construct and write through corrupts it instead
   * (`generic-class-at-a-top-type-and-a-concrete-type.ts`). Two programs of
   * the same shape needing opposite answers is what says the shape is not
   * the question -- provenance is.
   *
   * `true` wins over `false`: one construction site is enough, and every path
   * but a bare type-reference annotation counts as one.
   */
  const constructions = new Map<ts.Declaration, boolean[]>()

  const deferredSpellingFor = (declaration: ts.Declaration, tuple: readonly ts.Type[]): ts.Type | null =>
    deferredSpellings.get(declaration)?.find((entry) => entry.tuple.length === tuple.length && entry.tuple.every((t, i) => t === tuple[i]))
      ?.instantiated ?? null

  const tupleOrdinal = (
    declaration: ts.Declaration,
    tuple: readonly ts.Type[],
    instantiated: ts.Type | null = null,
    signatures: readonly [ts.Signature, ts.Signature] | null = null,
    fillings: ReadonlyMap<ts.Type, ts.Type> | null = null,
    constructs = true
  ): number => {
    const minted = constructions.get(declaration) ?? []
    const seen = tuples.get(declaration) ?? []
    const spelled = spellings.get(declaration) ?? []
    const paired = signaturePairs.get(declaration) ?? []
    const filled = compositeFillings.get(declaration) ?? []
    const existing = seen.findIndex((candidate) => candidate.length === tuple.length && candidate.every((t, i) => t === tuple[i]))
    // A spelling this site does not carry may still have been computed for this
    // exact tuple somewhere the program never instantiated from; see
    // `deferredSpellings`.
    const spelling = instantiated ?? deferredSpellingFor(declaration, tuple)
    if (existing >= 0) {
      if (spelling && !spelled[existing]) {
        spelled[existing] = spelling
        spellings.set(declaration, spelled)
      }
      if (signatures && !paired[existing]) {
        paired[existing] = signatures
        signaturePairs.set(declaration, paired)
      }
      if (fillings && !filled[existing]) {
        filled[existing] = fillings
        compositeFillings.set(declaration, filled)
      }
      if (constructs && !minted[existing]) {
        minted[existing] = true
        constructions.set(declaration, minted)
      }
      return existing
    }
    minted.push(constructs)
    constructions.set(declaration, minted)
    seen.push([...tuple])
    tuples.set(declaration, seen)
    spelled.push(spelling)
    spellings.set(declaration, spelled)
    paired.push(signatures)
    signaturePairs.set(declaration, paired)
    filled.push(fillings)
    compositeFillings.set(declaration, filled)
    return seen.length - 1
  }

  /**
   * Note that a copy already recorded is MINTED, not merely named.
   *
   * The walk order decides which site sees a tuple first, and an annotation
   * frequently wins: `(handle: Handle<Uint8Array>) => ...` is written below
   * the `new Handle<T>(this)` that actually builds one, but that `new` is
   * still open at the time and only closes in the fixpoint below -- which
   * skips a tuple it already has. Without this the construction fact is lost
   * to the order of two lines.
   */
  const markConstructed = (declaration: ts.Declaration, ordinal: number): void => {
    const minted = constructions.get(declaration) ?? []
    if (minted[ordinal] === true) return
    minted[ordinal] = true
    constructions.set(declaration, minted)
  }

  /** The copy whose arguments are exactly these, or `null` when the program makes no such instantiation. */
  const ordinalOfArguments = (declaration: ts.Declaration, args: readonly ts.Type[]): number | null => {
    const seen = tuples.get(declaration) ?? []
    const found = seen.findIndex((candidate) => candidate.length === args.length && candidate.every((t, index) => t === args[index]))
    return found >= 0 ? found : null
  }

  /**
   * The instantiations one recorded instantiation induces through its heritage.
   *
   * `class ReactiveComponent<Root> extends Component<Root> {}` spells no
   * concrete argument anywhere, so the syntactic walk sees a hole and records
   * nothing for `Component`. The program instantiates it all the same -- once
   * per copy of `ReactiveComponent` -- and answering "no copies" is not a
   * conservative answer here, it is a wrong one: `census.ts` walks a generic
   * with no copies *not at all*, so the base publishes no class evaluation, no
   * instance carrier and no construct convention, and every derived class whose
   * heritage resolves to it finds nothing published. Enumeration has to be
   * closed under what a recorded copy induces, not stop at what one source line
   * spells out.
   *
   * Only a filling this copy itself binds is substituted. `extends
   * Base<Wrapper<T>>` leaves the hole *inside* an argument, and filling that
   * needs a type instantiated -- something the public checker API does not
   * offer -- so nothing is recorded and the base stays honestly uninstantiated.
   */
  const induceFromHeritage = (declaration: ts.Declaration, bound: ReadonlyMap<ts.Symbol, ts.Type>, depth: number): void => {
    if (depth > 8 || !ts.isClassLike(declaration)) return
    const base = declaration.heritageClauses?.find((clause) => clause.token === ts.SyntaxKind.ExtendsKeyword)?.types[0]
    if (!base) return
    const reference = checker.getTypeAtLocation(base) as ts.TypeReference
    const parameters = reference.target?.typeParameters
    const args = reference.typeArguments
    if (!parameters || !args) return
    const owner = ownerOf(parameters[0]?.getSymbol()?.declarations?.[0] as ts.TypeParameterDeclaration | undefined)
    if (!owner) return
    const induced = new Map<ts.Symbol, ts.Type>()
    for (let index = 0; index < Math.min(parameters.length, args.length); index += 1) {
      const symbol = parameters[index]?.getSymbol()
      const filling = args[index]
      if (!symbol || !filling) return
      const hole = filling !== undefined && isHole(filling) ? filling.getSymbol() : null
      const resolved = hole ? bound.get(hole) : filling
      if (!resolved || containsHole(resolved)) return
      induced.set(symbol, resolved)
    }
    recordTuple(owner, induced, null, depth + 1)
  }

  /** Record one instantiation, given the owner and the fillings keyed by parameter symbol. */
  const recordTuple = (
    declaration: ts.Declaration,
    bound: ReadonlyMap<ts.Symbol, ts.Type>,
    at: ts.Node | null,
    depth = 0,
    instantiated: ts.Type | null = null,
    signatures: readonly [ts.Signature, ts.Signature] | null = null,
    spellingOnly = false,
    fillings: ReadonlyMap<ts.Type, ts.Type> | null = null,
    collect: ((tuple: readonly ts.Type[]) => void) | null = null,
    constructs = true
  ): void => {
    const parameters = typeParametersOf(declaration)
    if (parameters.length === 0) return
    const tuple: ts.Type[] = []
    // Inference does not report a filling for a defaulted type parameter when
    // the caller omits every value argument that mentions it. That absence is
    // not an open hole: the declaration itself says what the language fills
    // there. `Context.json<T, U = ContentfulStatusCode>(object: T, status?: U)`
    // is the measured case -- the call binds T from `object`, omits `status`,
    // and therefore reaches the declared default for U. Requiring inference
    // evidence for both discarded the entire specialization, so census walked
    // no method body and the generated class had no `json` implementation.
    //
    // Defaults are resolved in declaration order. A direct reference to an
    // earlier parameter (`U = T`) can therefore reuse that earlier filling.
    // A composite default that still contains a hole stays open and is refused
    // by the existing deep `containsHole` check below; inventing a checker
    // instantiation for it would exceed the public API this pass deliberately
    // confines itself to.
    const resolved = new Map(bound)
    for (const parameter of parameters) {
      const symbol = checker.getSymbolAtLocation(parameter.name)
      let filling = symbol ? resolved.get(symbol) : undefined
      if (!filling && parameter.default) {
        const statedDefault = checker.getTypeFromTypeNode(parameter.default)
        const defaultSymbol = isHole(statedDefault) ? statedDefault.getSymbol() : undefined
        filling = isHole(statedDefault) ? (defaultSymbol ? resolved.get(defaultSymbol) : undefined) : statedDefault
      }
      // A position this site binds with nothing at all is not a partial
      // instantiation, it is no instantiation: nothing downstream could fill
      // it, so neither the tuple nor the site is worth recording.
      if (!filling) return
      tuple.push(filling)
      if (symbol) resolved.set(symbol, filling)
    }
    // The site is recorded whether or not its fillings are concrete. A hole
    // here is a parameter of some *enclosing* generic, and the copy that
    // encloses this one substitutes it when it reads the site back. Only a
    // concrete tuple mints a copy, because a copy with the hole still open is
    // the state monomorphization exists to remove.
    if (at) sites.set(at, { declaration, fillings: tuple })
    if (collect) collect(tuple)
    if (tuple.some((filling) => containsHole(filling))) return
    // A spelling with no instantiating site behind it is REMEMBERED, never
    // recorded: it says how a copy would be spelled, not that the program makes
    // one. See `deferredSpellings`.
    if (spellingOnly) {
      if (!instantiated) return
      const held = deferredSpellings.get(declaration) ?? []
      if (!held.some((entry) => entry.tuple.length === tuple.length && entry.tuple.every((t, i) => t === tuple[i]))) {
        held.push({ tuple: [...tuple], instantiated })
        deferredSpellings.set(declaration, held)
      }
      const existing = ordinalOfArguments(declaration, tuple)
      if (existing !== null) tupleOrdinal(declaration, tuple, instantiated, signatures, fillings, constructs)
      return
    }
    tupleOrdinal(declaration, tuple, instantiated, signatures, fillings, constructs)
    induceFromHeritage(declaration, resolved, depth)
  }

  // Keyed by the instantiation itself: every mention of `RegExpRouter<[H,
  // RouterRoute]>` resolves to the one type object, and resolving a
  // reference's members is not free.
  const memberFillings = new Map<ts.Type, ReadonlyMap<ts.Type, ts.Type> | null>()

  /**
   * The composite fillings a copy minted from a written type REFERENCE closes.
   *
   * `Specialization.fillingOf` is the one authority `filledBy` here and
   * `createPathSubstitution` (structural-generics.ts) close a composite hole
   * from. A copy minted from a CALL gets those pairs for free: the checker
   * built the resolved signature beside the open one and `unifySignatures`
   * walks the two in lockstep. A class copy is minted here instead, from a
   * reference that pairs only the type ARGUMENTS -- so a composite spelled
   * over the class's own parameter had no image, every call inside the body
   * whose instantiation mentions one stayed open, and `specializationAt`
   * answered nothing for it. The callee then read as the generic function's
   * OPEN type: a `generic-function-set` with no closed family for
   * `ir/lower-invocation.ts` to dispatch over. hono's
   * `findMiddleware(middleware[m], path)` inside `RegExpRouter<T>.add`, whose
   * `T` binds to `HandlerWithMetadata<T>` rather than to `T`, is that shape.
   *
   * The reference's own members ARE the images the checker already built for
   * this exact instantiation, so pairing each against the target's is the same
   * lockstep walk, reading members instead of parameters.
   *
   * The open side comes from the TARGET, never from the member's declaration:
   * an inherited member's declaration spells the BASE's parameter, while the
   * body that reads it spells the derived class's, and those are different
   * type objects. `Hono<E, S, BasePath>.router` is `HonoBase`'s field seen
   * through `Hono`'s own parameters, and that is what the constructor writes.
   *
   * Only a source-declared CLASS is walked. Interfaces and aliases hold no
   * bodies, so no site inside one can need a filling, and a lib class
   * (`Map<string, number>`) would cost a full member resolution to answer for
   * a body this compilation never walks.
   */
  /**
   * `containsHole`, followed through call and construct SIGNATURES.
   *
   * `containsHole` reads a type's own type arguments and stops: a member whose
   * type is a FUNCTION mentioning the class's parameter -- `add(key: string,
   * value: T): void`, `match: typeof match<Router<T>, T>` -- has no type
   * arguments of its own, so it read as closed and `memberFillingsOf` skipped
   * it. The composite pairs those members are the only source of are then
   * missing from the copy, and `filledBy` answers `null` for exactly the hole
   * the fixpoint needed: hono's `RegExpRouter<T>` never minted the copy of
   * `match` its own field initializer names, and emission refused the read as a
   * declaration the program never introduces.
   *
   * Used ONLY as the member walk's admission gate, where a wider answer can
   * only add pairs. `containsHole` itself stays as it is: it also gates whether
   * a TUPLE is concrete enough to mint a copy, and widening it there would
   * withhold copies that are minted today.
   */
  const mentionsHoleThroughSignatures = (type: ts.Type, depth = 0): boolean => {
    if (containsHole(type, depth)) return true
    if (depth > 4) return false
    const parameterMentions = (parameter: ts.Symbol): boolean => {
      const at = parameter.valueDeclaration ?? parameter.declarations?.[0]
      return at !== undefined && mentionsHoleThroughSignatures(checker.getTypeOfSymbolAtLocation(parameter, at), depth + 1)
    }
    for (const signature of [...type.getCallSignatures(), ...type.getConstructSignatures()]) {
      if (mentionsHoleThroughSignatures(signature.getReturnType(), depth + 1)) return true
      const receiver = (signature as ts.Signature & { readonly thisParameter?: ts.Symbol }).thisParameter
      if (receiver && parameterMentions(receiver)) return true
      if (signature.parameters.some(parameterMentions)) return true
    }
    return false
  }

  const memberFillingsOf = (
    owner: ts.Declaration,
    target: ts.GenericType,
    reference: ts.TypeReference
  ): ReadonlyMap<ts.Type, ts.Type> | null => {
    if (!ts.isClassLike(owner) || owner.getSourceFile().isDeclarationFile) return null
    const held = memberFillings.get(reference)
    if (held !== undefined) return held
    const declared = new Map<string, ts.Symbol>()
    for (const property of checker.getPropertiesOfType(target)) declared.set(String(property.escapedName), property)
    const pairs = new Map<ts.Type, ts.Type>()
    for (const property of checker.getPropertiesOfType(reference)) {
      const open = declared.get(String(property.escapedName))
      if (!open) continue
      const openType = checker.getTypeOfSymbol(open)
      if (!mentionsHoleThroughSignatures(openType)) continue
      unify(
        checker,
        openType,
        checker.getTypeOfSymbol(property),
        0,
        () => undefined,
        (composite, closed) => {
          if (!pairs.has(composite)) pairs.set(composite, closed)
        }
      )
    }
    const answer = pairs.size > 0 ? pairs : null
    memberFillings.set(reference, answer)
    return answer
  }

  /**
   * A type reference the program writes -- or, with `node` null, one it makes
   * without writing (a call's own resolved return type).
   *
   * `node` is what `sites` is keyed by, and only a WRITTEN reference has one to
   * be keyed by. A call node is already the key of the callee's own
   * instantiation (`fromCall`), so re-keying it here would silently replace
   * that entry -- the same collision `fromImplementation` passes `null` to
   * avoid.
   *
   * `spellingOnly` is the other half of that distinction: a written reference
   * is a program STATING an instantiation, and a call's return type is only the
   * checker naming one, which may or may not be a copy the program makes. See
   * `deferredSpellings`.
   */
  const fromTypeReference = (node: ts.Node | null, type: ts.Type, spellingOnly = false): void => {
    const reference = type as ts.TypeReference
    const target = reference.target as ts.GenericType | undefined
    const parameters = target?.typeParameters
    const args = reference.typeArguments
    if (!target || !parameters || !args) return
    const owner = ownerOf(parameters[0]?.getSymbol()?.declarations?.[0] as ts.TypeParameterDeclaration | undefined)
    if (!owner) return
    const bound = new Map<ts.Symbol, ts.Type>()
    for (let index = 0; index < Math.min(parameters.length, args.length); index += 1) {
      const parameter = parameters[index]
      const filling = args[index]
      const symbol = parameter?.getSymbol()
      if (symbol && filling) bound.set(symbol, filling)
    }
    // A reference that is its own target's open self (`Box<T>` written inside
    // `Box`'s own body) closes nothing, and a still-open argument records no
    // copy below at all -- neither is worth a member walk.
    const closes = args.some((argument, index) => argument !== parameters[index]) && !args.some((argument) => containsHole(argument))
    // A bare `TypeReferenceNode` is the one shape here that states no value.
    // The same function also receives the `NewExpression` that constructs one
    // and the `ExpressionWithTypeArguments` of a heritage clause, whose copy
    // every instance of the derived class really does contain.
    const constructs = node === null || !ts.isTypeReferenceNode(node)
    recordTuple(
      owner,
      bound,
      node,
      0,
      type,
      null,
      spellingOnly,
      closes ? memberFillingsOf(owner, target, reference) : null,
      null,
      constructs
    )
  }

  /** The expression a call-like node reaches its callee through. */
  const calleeExpressionOf = (node: ts.CallLikeExpression): ts.Node | null =>
    ts.isTaggedTemplateExpression(node)
      ? node.tag
      : ts.isJsxOpeningLikeElement(node)
        ? node.tagName
        : ts.isCallOrNewExpression(node)
          ? node.expression
          : null

  /**
   * The uninstantiated signature a call was resolved from.
   *
   * `Signature.target` is where the checker keeps this and it is not public
   * API, so the generic is recovered the way a reader would: from the callee's
   * own type. A callee whose type carries exactly one signature and that
   * signature declares type parameters is the generic this call instantiated.
   *
   * An OVERLOAD SET is recovered by declaration identity instead of being
   * skipped. An instantiated signature keeps the declaration of the overload
   * it came from, so the overload the checker selected is the one member of
   * the set that was declared at the same node -- a fact the checker states,
   * not a guess from argument position. Skipping the whole set instead is what
   * left hono's `c.json({ hello: 'world' })` recording no instantiation at
   * all: `JSONRespond` declares two generic call signatures, so the call that
   * every hono program makes bound nothing.
   */
  const genericSignatureOf = (node: ts.CallLikeExpression, resolved: ts.Signature | undefined): ts.Signature | null => {
    const callee = calleeExpressionOf(node)
    if (!callee) return null
    const type = checker.getTypeAtLocation(callee)
    const signatures = ts.isNewExpression(node) ? type.getConstructSignatures() : type.getCallSignatures()
    const declaration = resolved?.getDeclaration()
    const selected =
      signatures.find((signature) => declaration !== undefined && signature.getDeclaration() === declaration) ??
      (signatures.length === 1 ? signatures[0] : undefined)
    if (!selected) return null
    return selected.getTypeParameters()?.length ? selected : null
  }

  /**
   * The generic FUNCTION that implements the declared generic signature a call
   * resolved to, when the two are different declarations.
   *
   * `json: JSONRespond = <T, U>(object: T, ...) => ...` (hono's `Context`)
   * writes the signature twice: once as the field's declared type, which is
   * what every call site resolves against, and once as the arrow that provides
   * the body. Only the first is reachable from the call, so the arrow was
   * `isGeneric` with zero copies -- and `census.ts` walks such a declaration
   * NOT AT ALL. The field initializer then had no operations, and its body
   * emitted `return;` from a function whose convention returns a callable:
   * every hono program's `c.json` was an uninitialized field, invisible until
   * clang rejected the return.
   *
   * The mapping is POSITIONAL, which is what "this function implements that
   * signature" means -- TypeScript's own assignability check for a
   * generic-to-generic assignment relates the parameters in order, and it has
   * already accepted this program. A count that disagrees is not a mapping
   * this can guess, so it records nothing.
   */
  const implementationOfCallee = (node: ts.CallLikeExpression): ts.Declaration | null => {
    const callee = calleeExpressionOf(node)
    if (!callee) return null
    const value = checker.getSymbolAtLocation(callee)?.valueDeclaration
    if (!value || !(ts.isPropertyDeclaration(value) || ts.isVariableDeclaration(value)) || !value.initializer) return null
    const initializer = value.initializer
    if (!ts.isFunctionLike(initializer)) return null
    return typeParametersOf(initializer as ts.Declaration).length > 0 ? (initializer as ts.Declaration) : null
  }

  /** Record the implementation's own copy of an instantiation recorded for the signature it implements. */
  const fromImplementation = (node: ts.CallLikeExpression, declaredOwner: ts.Declaration, bound: ReadonlyMap<ts.Symbol, ts.Type>): void => {
    const implementation = implementationOfCallee(node)
    if (!implementation || implementation === declaredOwner) return
    const declared = typeParametersOf(declaredOwner)
    const implemented = typeParametersOf(implementation)
    if (declared.length !== implemented.length) return
    const mapped = new Map<ts.Symbol, ts.Type>()
    for (let index = 0; index < declared.length; index += 1) {
      const from = declared[index]
      const to = implemented[index]
      const filling = from ? bound.get(checker.getSymbolAtLocation(from.name) as ts.Symbol) : undefined
      const symbol = to ? checker.getSymbolAtLocation(to.name) : undefined
      if (!filling || !symbol) return
      mapped.set(symbol, filling)
    }
    // `at` is deliberately `null`: the call site already maps to the DECLARED
    // signature's instantiation, and a second entry for the same node would
    // silently replace it. Nothing resolves a name to the implementation
    // through the call -- the field's own carrier is what the call reaches.
    recordTuple(implementation, mapped, null)
  }

  /**
   * The declaration whose BODY a call resolved against, when the signature
   * the checker selected is one of an overload set's declared overloads.
   *
   * A call to `some(xs)` resolves to the first of `some`'s two signature-only
   * declarations, so its `getDeclaration()` is a node with no body -- and a
   * copy minted on that node is a copy of nothing: `census.ts` walks only
   * declarations with bodies, so the implementation stayed "generic with no
   * copies", walked not at all, while every call named an ordinal the body
   * never had. TypeScript's own `core.ts` writes `some`, `find`, `every`,
   * `filter`, `map` and `findIndex` this way, and together they were the
   * largest families still reaching representation with a naked type
   * parameter after namespaces became paths.
   *
   * The implementation is the one runtime function
   * (FunctionDeclarationInstantiation runs once for the whole set, and
   * `identities.ts`'s `valueDeclarationOfSymbol` already names it for every
   * read), so it is the one declaration copies can belong to. The fillings
   * are recovered by unifying the implementation's OWN signature against the
   * resolved one: the resolved overload's parameters are the implementation's
   * in order (TypeScript has already checked the implementation is compatible
   * with each overload), so the implementation's `T` binds where the
   * overload's did.
   */
  const implementationOf = (declaration: ts.Declaration): ts.Declaration => {
    if (!(ts.isFunctionDeclaration(declaration) || ts.isMethodDeclaration(declaration)) || declaration.body !== undefined)
      return declaration
    const name = ts.getNameOfDeclaration(declaration)
    const symbol = name ? checker.getSymbolAtLocation(name) : undefined
    const implementation = symbol
      ?.getDeclarations()
      ?.find((candidate) => (ts.isFunctionDeclaration(candidate) || ts.isMethodDeclaration(candidate)) && candidate.body !== undefined)
    return implementation ?? declaration
  }

  /**
   * The generic source functions a call's callee is a CHOICE among, or `null`.
   *
   * `setOriginal(updated, original)` where `const setOriginal = cond ?
   * identity : setOriginalNode`: the callee's type is a union of two open
   * generic function types, and the checker resolved the call to a signature
   * it combined from both. Neither member is the callee; the cell holds one
   * of them, decided at runtime, and every member must have the copy this
   * call instantiates. The same predicate `structural.ts`'s
   * `genericSourceFunctionOf` states for the VALUE's shape, asked here of the
   * call: module-level function declarations with a body, at least two.
   */
  const genericSetMembersOf = (node: ts.CallLikeExpression): readonly ts.FunctionDeclaration[] | null =>
    ts.isCallExpression(node) ? genericFunctionChoiceMembersOf(checker, node.expression) : null

  const fromCall = (node: ts.CallLikeExpression): void => {
    const resolved = checker.getResolvedSignature(node)
    const setMembers = resolved ? genericSetMembersOf(node) : null
    if (resolved && setMembers) {
      // Every member unifies its OWN signature against the one signature the
      // checker resolved the call to: the combined signature's parameters are
      // each member's, positionally (TypeScript's `combineUnionParameters`),
      // so the fillings each member binds are the ones this call supplies.
      const recorded: { declaration: ts.Declaration; fillings: readonly ts.Type[] }[] = []
      for (const member of setMembers) {
        const open = checker.getSignatureFromDeclaration(member)
        if (!open) continue
        const bound = new Map<ts.Symbol, ts.Type>()
        const pairs = new Map<ts.Type, ts.Type>()
        unifySignatures(
          checker,
          [open],
          [resolved],
          0,
          (parameter, filling) => {
            const symbol = parameter.getSymbol()
            if (symbol && !bound.has(symbol)) bound.set(symbol, filling)
          },
          (composite, closed) => {
            if (!pairs.has(composite)) pairs.set(composite, closed)
          }
        )
        recordTuple(member, bound, null, 0, null, null, false, pairs, (tuple) => recorded.push({ declaration: member, fillings: tuple }))
      }
      // A member whose tuple this call does not bind is a member with no copy
      // here, and a dispatch missing one arm is not a dispatch: the site is
      // recorded only when every member has one.
      if (recorded.length === setMembers.length) setSites.set(node, recorded)
      return
    }
    const generic = genericSignatureOf(node, resolved)
    if (!generic || !resolved || generic === resolved) return
    const declared = generic.getDeclaration()
    if (!declared) return
    const owner = implementationOf(declared)
    let open = generic
    if (owner !== declared) {
      const implementation = checker.getSignatureFromDeclaration(owner as ts.SignatureDeclaration)
      // An implementation with no type parameters of its own is one function
      // however many generic overloads it answers for: nothing to mint.
      if (!implementation || (implementation.getTypeParameters()?.length ?? 0) === 0) return
      open = implementation
    }
    const bound = new Map<ts.Symbol, ts.Type>()
    const pairs = new Map<ts.Type, ts.Type>()
    unifySignatures(
      checker,
      [open],
      [resolved],
      0,
      (parameter, filling) => {
        const symbol = parameter.getSymbol()
        if (symbol && !bound.has(symbol)) bound.set(symbol, filling)
      },
      (composite, closed) => {
        if (!pairs.has(composite)) pairs.set(composite, closed)
      }
    )
    // No signature pair for a copy minted through an overload: the resolved
    // signature is the OVERLOAD's frame instantiated, not the implementation's
    // -- `some<T>(array, predicate?)` resolved through `some(array, predicate)`
    // pairs the optional parameter with a required one, and
    // `structural-instantiated-member.ts` would read that pair back as the
    // copy's parameter type, dropping the optionality the body relies on. The
    // tuple binds the implementation's `T` exactly, and that is the whole of
    // what such a copy needs.
    recordTuple(owner, bound, node, 0, null, owner === declared ? [open, resolved] : null, false, pairs)
    // A call's resolved return type can name an instantiation the program
    // makes, already spelled by the checker -- and that spelling is the one
    // thing `structural-instantiated-member.ts` needs to read a copy's members
    // with the hole closed.
    //
    // Without this, a generic returned by a generic FUNCTION gets its copy
    // minted by the fixpoint round below, which substitutes the fillings into
    // the site and records them with no image at all: `Collection@4`
    // (`tuple=[DataKey]`, from `db.collection<DataKey>(...)` in
    // `client_encryption.ts`) was the only one of the mongodb probe's five
    // `Collection` copies without one, and every `AlternativeType` still
    // deferred on that probe -- 43 of 452 mandatory obligations, the largest
    // single root -- was in that copy. The four minted from a written
    // `Collection<X>` annotation carried an image and resolved.
    //
    // SPELLING ONLY, and that distinction is the whole of it. A return type is
    // the checker naming an instantiation, not the program stating one, and a
    // method on a generic class names its own class back (`Hono.get` returns
    // `Hono<E, S, MergePath<...>, ...>`) -- so minting from it manufactures a
    // copy per call site that nothing instantiates. That regressed hono from
    // certified to six unmet obligations: three class-property arrows whose
    // carriers only exist in the copies the program really makes. The spelling
    // waits in `deferredSpellings` for a site that mints, which is what the
    // mongodb case needs anyway: `Collection@4` is minted by the fixpoint round
    // BELOW this, so a back-fill that only wrote to existing ordinals would
    // have answered nothing there either.
    fromTypeReference(null, resolved.getReturnType(), true)
    fromImplementation(node, owner, bound)
  }

  /**
   * A generic callable's type parameters filled with their CONSTRAINTS -- the
   * one instantiation a generic used as a VALUE can have.
   *
   * `memoizeOne(<T extends JSDocType>(kind: T["kind"]) => ...)` (TypeScript's
   * `nodeFactory.ts`) passes a generic arrow to a higher-order function. No
   * call fills that arrow's `T`: the checker propagates it into
   * `memoizeOne`'s result (`<T extends JSDocType>(arg: T["kind"]) => ...`),
   * and a later call through that result infers `T` from an argument that
   * cannot name it and lands on the constraint. The value is ONE closure at
   * runtime, so it cannot be one body per instantiation the way a called
   * generic is; it can only be the body every instantiation shares, which is
   * the body over the constraints. `structural.ts` gives an unbound
   * callable-owned parameter the same answer, so the copy and every mention
   * of the value's type agree.
   *
   * A constraint that still names a hole (`Children extends NodeArray<Child>`)
   * is no filling: `null`, and the value stays honestly uninstantiated.
   */
  const constraintBindingsOf = (declaration: ts.Declaration): ReadonlyMap<ts.Symbol, ts.Type> | null => {
    const bound = new Map<ts.Symbol, ts.Type>()
    for (const parameter of typeParametersOf(declaration)) {
      const symbol = checker.getSymbolAtLocation(parameter.name)
      if (!symbol) return null
      const constraint = checker.getBaseConstraintOfType(checker.getDeclaredTypeOfSymbol(symbol)) ?? checker.getUnknownType()
      if (containsHole(constraint)) return null
      bound.set(symbol, constraint)
    }
    return bound
  }

  /**
   * The generic source callable a VALUE position denotes, or `null` when the
   * position is not a value use of one.
   *
   * A callee is not a value use -- `fromCall` fills its hole from the call.
   * Neither is an arm of a generic-function CHOICE (`cond ? identity :
   * setOriginalNode`): that binding is a set dispatched per call
   * (`genericSetMembersOf`), and a constraint copy minted for each arm would be
   * a second, unrelated copy the set's own sites never name.
   */
  const valueUseSubjectOf = (node: ts.Expression): ts.Declaration | null => {
    const parent = node.parent
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
      // A binding, field or literal property INITIALIZED with a generic arrow
      // is the arrow named: its copies come from the calls made through that
      // name (`genericSubjectOf`, `implementationOfCallee`), one per
      // instantiation. A constraint copy minted here as well was the one the
      // initializer then cited -- measured: `respond: Respond = <T extends
      // object>(value: T) => ...` handed `box.respond({ hello })` a closure
      // over `{}` and the call refused the conversion to its own copy.
      if (
        (ts.isVariableDeclaration(parent) || ts.isPropertyDeclaration(parent) || ts.isPropertyAssignment(parent)) &&
        parent.initializer === node
      ) {
        return null
      }
      return typeParametersOf(node).length > 0 ? node : null
    }
    // A namespace-qualified name is the REFERENCE, not a property read:
    // `namespace-paths.ts` is the one authority that says so, and the whole
    // `State.enter` access is what denotes the declaration -- exactly what a
    // bare `enter` written inside the namespace body would denote. Without
    // this the value use was never recorded, the name kept the generic's OPEN
    // type, and `representation/derive.ts` carried it as a
    // `generic-function-set` tag in a position whose cell holds a callable:
    // `test/runtime/generic-state-function-array.ts` refused the conversion
    // from the tag to `function-value-dispatch`, while the same program
    // written with bare identifiers compiled and ran.
    const qualifiedMember = ts.isPropertyAccessExpression(node) ? namespacePaths.memberSymbolOf(node) : null
    if (!ts.isIdentifier(node) && qualifiedMember === null) return null
    if (
      (ts.isCallExpression(parent) || ts.isNewExpression(parent) || ts.isTaggedTemplateExpression(parent)) &&
      calleeExpressionOf(parent) === node
    )
      return null
    // `const alias = doubler` is an ALIAS of the generic, not a value made from
    // it: `genericSubjectOf` hops the alias to its target so the alias's own
    // calls mint the target's copies. A constraint copy minted here instead
    // read the alias as one closure over `unknown` -- measured: `alias(7)`
    // refused `function-value-dispatch((dynamic) -> array-object(dynamic))
    // -> function-value-dispatch((scalar(number)) -> array-object(number))`.
    if (ts.isVariableDeclaration(parent) && parent.initializer === node && parent.type === undefined) return null
    if ((parent as { readonly name?: ts.Node }).name === node && !ts.isPropertyAccessExpression(parent)) return null
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return null
    if (ts.isExportSpecifier(parent) || ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent))
      return null
    if (ts.isTypeOfExpression(parent) || ts.isDecorator(parent) || ts.isJsxOpeningLikeElement(parent) || ts.isJsxClosingElement(parent))
      return null
    for (let ancestor: ts.Node | undefined = parent; ancestor !== undefined; ancestor = ancestor.parent) {
      if (ts.isTypeNode(ancestor) || ts.isTypeQueryNode(ancestor)) return null
      if (ts.isStatement(ancestor) || ts.isSourceFile(ancestor)) break
    }
    let top: ts.Node = node
    while (
      top.parent !== undefined &&
      (ts.isParenthesizedExpression(top.parent) ||
        ts.isConditionalExpression(top.parent) ||
        ts.isAsExpression(top.parent) ||
        ts.isNonNullExpression(top.parent) ||
        ts.isSatisfiesExpression(top.parent) ||
        (ts.isBinaryExpression(top.parent) &&
          (top.parent.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
            top.parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)))
    ) {
      top = top.parent
    }
    if (genericFunctionChoiceMembersOf(checker, top)) return null
    let symbol = qualifiedMember ?? checker.getSymbolAtLocation(node)
    if (symbol && (symbol.flags & ts.SymbolFlags.Alias) !== 0) symbol = checker.getAliasedSymbol(symbol)
    const value = symbol?.valueDeclaration
    if (!value || value.getSourceFile().isDeclarationFile) return null
    if (ts.isFunctionDeclaration(value)) {
      const implementation = implementationOf(value)
      return ts.isFunctionDeclaration(implementation) && implementation.body !== undefined && typeParametersOf(implementation).length > 0
        ? implementation
        : null
    }
    if (ts.isVariableDeclaration(value) && value.initializer !== undefined && ts.isFunctionLike(value.initializer)) {
      const initializer = value.initializer as ts.Declaration
      return typeParametersOf(initializer).length > 0 ? initializer : null
    }
    return null
  }

  /**
   * A generic callable used as a VALUE rather than called: the copy that
   * value is.
   *
   * Two cases, told apart by what the checker did at the use. When the
   * contextual type is a plain signature the checker instantiated the generic
   * in context -- `binarySearch(array, insert, identity, compare)` reads
   * `identity` as `(x: T) => T` over the CALLER's `T` -- and that instantiation
   * is recorded exactly as a call's would be, keyed on this node so
   * `useSitePath` resolves the name to it. When the type at the use still
   * carries the callable's own parameters (a generic arrow handed to a
   * higher-order function, a generic function passed where the parameter's
   * type is itself generic), nothing instantiated it and the copy is the one
   * over the constraints (`constraintBindingsOf`).
   */
  const fromValueUse = (node: ts.Expression): void => {
    const subject = valueUseSubjectOf(node)
    if (!subject) return
    const open = checker.getSignatureFromDeclaration(subject as ts.SignatureDeclaration)
    if (!open) return
    const signatures = checker.getTypeAtLocation(node).getCallSignatures()
    const instantiated = signatures.length === 1 ? signatures[0] : undefined
    if (instantiated && instantiated !== open && (instantiated.getTypeParameters()?.length ?? 0) === 0) {
      const bound = new Map<ts.Symbol, ts.Type>()
      const pairs = new Map<ts.Type, ts.Type>()
      unifySignatures(
        checker,
        [open],
        [instantiated],
        0,
        (parameter, filling) => {
          const symbol = parameter.getSymbol()
          if (symbol && !bound.has(symbol)) bound.set(symbol, filling)
        },
        (composite, closed) => {
          if (!pairs.has(composite)) pairs.set(composite, closed)
        }
      )
      recordTuple(subject, bound, node, 0, null, [open, instantiated], false, pairs)
      return
    }
    // Nothing instantiated it. When the position's CONTEXTUAL type is itself
    // a generic signature (`emitNodeList(emit, ...)` over `EmitFunction = <T
    // extends Node>(node: T, ...) => void`), the value's parameters unify with
    // that type's own -- holes a function type owns -- and the fixpoint below
    // fills them from the instantiation the program makes of that type
    // (`fromCall` records one per call through a value of it): the cell then
    // holds a copy of `emit` over exactly the `T` its reads are typed with.
    // A type instantiated more than one way, or never, leaves the site open
    // and `closeOpenValueUses` mints the constraint copy instead.
    const contextual = checker.getContextualType(node)
    const contextualSignatures = contextual?.getCallSignatures() ?? []
    const contextualSignature = contextualSignatures.length === 1 ? contextualSignatures[0] : undefined
    // A generic handed to a PARAMETER DEFAULT is left open by the checker even
    // though the position states exactly one signature: `same: Same<T> =
    // equateValues` reads `equateValues` as its own `<T>(a: T, b: T) => boolean`
    // with `Same<T>` only as the contextual type. The same value written into an
    // annotated binding in the body IS instantiated, so the first branch catches
    // that one and this position fell through to the constraint copy -- a closure
    // over `unknown` that no copy of the enclosing generic could then accept.
    //
    // The contextual signature here owns no parameters of its own: every hole in
    // it belongs to the ENCLOSING generic, which is exactly the filling
    // `recordTuple` records without minting (`sites`), for the enclosing copy to
    // substitute when it reads the site back. This is tsc's `contains`,
    // `binarySearch` and `sortAndDeduplicate` family, whose defaulted
    // `EqualityComparer<T>`/`Comparer<T>` parameters are the largest single root
    // in its self-compile.
    if (contextualSignature && (contextualSignature.getTypeParameters()?.length ?? 0) === 0 && contextualSignature !== open) {
      const bound = new Map<ts.Symbol, ts.Type>()
      const pairs = new Map<ts.Type, ts.Type>()
      unifySignatures(
        checker,
        [open],
        [contextualSignature],
        0,
        (parameter, filling) => {
          const symbol = parameter.getSymbol()
          if (symbol && !bound.has(symbol)) bound.set(symbol, filling)
        },
        (composite, closed) => {
          if (!pairs.has(composite)) pairs.set(composite, closed)
        }
      )
      if (bound.size === typeParametersOf(subject).length) {
        recordTuple(subject, bound, node, 0, null, [open, contextualSignature], false, pairs)
        return
      }
    }
    if (contextualSignature && (contextualSignature.getTypeParameters()?.length ?? 0) > 0) {
      const bound = new Map<ts.Symbol, ts.Type>()
      const pairs = new Map<ts.Type, ts.Type>()
      unifySignatures(
        checker,
        [open],
        [contextualSignature],
        0,
        (parameter, filling) => {
          const symbol = parameter.getSymbol()
          if (symbol && !bound.has(symbol)) bound.set(symbol, filling)
        },
        (composite, closed) => {
          if (!pairs.has(composite)) pairs.set(composite, closed)
        }
      )
      if (bound.size === typeParametersOf(subject).length) {
        recordTuple(subject, bound, node, 0, null, null, false, pairs)
        return
      }
    }
    // A generic referenced as a VALUE inside its OWN body denotes the copy that
    // is running -- recursion names itself. tsc's `Debug` family is written
    // this way throughout: `checkDefined` hands `stackCrawlMark ||
    // checkDefined` to `assertIsDefined`, which hands `stackCrawlMark ||
    // assertIsDefined` to `fail`. Answering the constraint copy there made
    // every copy's own read refuse the conversion from a closure over
    // `unknown` to its own frame -- 265 rows in `debug.ts`, the largest
    // single-file root in tsc's self-compile.
    //
    // The fillings are the enclosing generic's OWN parameters, so the site
    // stays open and `specializationAt` substitutes it per copy exactly as
    // any other enclosing hole (`fillsFromEnclosingCopy`).
    if (enclosesNode(subject, node)) {
      const parameters = typeParametersOf(subject)
      const own = new Map<ts.Symbol, ts.Type>()
      for (const parameter of parameters) {
        const symbol = checker.getSymbolAtLocation(parameter.name)
        if (symbol) own.set(symbol, checker.getDeclaredTypeOfSymbol(symbol))
      }
      if (own.size === parameters.length) {
        recordTuple(subject, own, node)
        return
      }
    }
    const bound = constraintBindingsOf(subject)
    if (bound) recordTuple(subject, bound, node)
  }

  /**
   * The function TYPES whose parameters a site's fillings still name, each
   * instantiated exactly one way by the program -- the one case a hole a
   * type owns has a single answer. See `fromValueUse`.
   */
  const holeOwnerOf = (hole: ts.Type): ts.Declaration | null =>
    ownerOf(hole.getSymbol()?.declarations?.[0] as ts.TypeParameterDeclaration | undefined)

  const uniquelyInstantiatedTypeOwnersOf = (fillings: readonly ts.Type[]): readonly ts.Declaration[] => {
    const owners: ts.Declaration[] = []
    for (const filling of fillings) {
      if (!isHole(filling)) continue
      const owner = holeOwnerOf(filling)
      if (!owner || owners.includes(owner)) continue
      if (!(
        ts.isFunctionTypeNode(owner) ||
        ts.isConstructorTypeNode(owner) ||
        ts.isCallSignatureDeclaration(owner) ||
        ts.isConstructSignatureDeclaration(owner)
      ))
        continue
      if ((tuples.get(owner)?.length ?? 0) === 1) owners.push(owner)
    }
    return owners
  }

  /** Whether `node` sits inside `declaration` -- the self-reference test in `fromValueUse`. */
  const enclosesNode = (declaration: ts.Declaration, node: ts.Node): boolean => {
    for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent)
      if (current === declaration) return true
    return false
  }

  /**
   * Whether every hole in a site's fillings belongs to an enclosing generic
   * this program instantiates -- the case the read resolves per copy through
   * `specializationAt`'s `substitute`, rather than one the constraints close.
   */
  const fillsFromEnclosingCopy = (node: ts.Node, fillings: readonly ts.Type[]): boolean => {
    const enclosing = enclosingGenericsOf(node)
    return fillings.every((filling) => {
      if (!containsHole(filling)) return true
      if (!isHole(filling)) return false
      const owner = holeOwnerOf(filling)
      return owner !== null && enclosing.includes(owner) && (tuples.get(owner)?.length ?? 0) > 0
    })
  }

  /**
   * A value use still open after the fixpoint -- its contextual type's holes
   * had no single instantiation to fill them from -- becomes the copy over
   * the constraints: one closure, the only thing the value can be.
   */
  const closeOpenValueUses = (): void => {
    for (const [node, site] of sites) {
      if (!(ts.isIdentifier(node) || ts.isArrowFunction(node) || ts.isFunctionExpression(node))) continue
      if (!ts.isFunctionLike(site.declaration)) continue
      if (!site.fillings.some((filling) => containsHole(filling))) continue
      if (site.fillings.some((filling) => !isHole(filling) && containsHole(filling))) continue
      // ⛔ A hole an ENCLOSING generic owns is not an open value use: the
      // fixpoint above leaves those sites open ON PURPOSE, because there is one
      // site and one substitution per enclosing copy, made when that copy reads
      // the site back. Closing them here re-keyed the site to a single closure
      // over the constraints and threw the per-copy answer away -- measured on
      // a generic passed as a defaulted parameter (`same: Same<T> =
      // equateValues`), where every copy of the enclosing function then refused
      // the conversion from a closure over `any` to its own comparer.
      if (fillsFromEnclosingCopy(node, site.fillings)) continue
      const bound = constraintBindingsOf(site.declaration)
      if (bound) recordTuple(site.declaration, bound, node)
    }
  }

  const declared = new Set<ts.Declaration>()
  // Whether a declaration *writes down* type parameters is a property of the
  // declaration alone, so this half stays whole-program even though the
  // instantiation half below does not. `isGeneric` is what `census.ts`'s walk
  // and `producers/declaration-lifecycle.ts`'s `namesUninstantiatedGeneric`
  // both read to tell "generic with no copies" from "not generic", and
  // answering the second for a declaration reachability happens not to walk
  // turns an elided `export * from` into one that mints an operation carried
  // by the open hole. Measured, before this was split out: four
  // `unresolved-reaches-materialization` violations in each of seven corpus
  // programs, every one an export of a generic that program never calls.
  const declareVisit = (node: ts.Node): void => {
    if (typeParametersOf(node as ts.Declaration).length > 0) declared.add(node as ts.Declaration)
    ts.forEachChild(node, declareVisit)
  }
  for (const file of sourceFiles) declareVisit(file)
  const visit = (node: ts.Node): void => {
    // A PRUNED member is a site this compilation does not reach either, and
    // statement-level reachability cannot say so: a dead method lives inside a
    // live class declaration, so `forEachChild` walks straight into it.
    //
    // `mongodb-connection-string-url`'s `typedSearchParams<T extends
    // Record<string, any>>()` is the case, and it is the shape to expect:
    // its body is the type-only trick `(false as true) && new
    // (caseInsenstiveURLSearchParams<keyof T & string>(URLSearchParams))()`,
    // written to name a type and never to run. Nothing spells the method, so
    // reachability prunes it -- and this walk minted copies of a LIVE generic
    // from it anyway, filled with `keyof T & string` for a `T` that, having no
    // call site, no copy and no default, can never be closed. Every method of
    // those copies then carried an unresolved intersection: 56 of the mongodb
    // probe's 516 mandatory obligations, all from one method nothing calls.
    if (reachable.memberIsPruned(node)) return
    if (ts.isCallOrNewExpression(node) || ts.isTaggedTemplateExpression(node) || ts.isJsxOpeningLikeElement(node)) fromCall(node)
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isIdentifier(node) || ts.isPropertyAccessExpression(node))
      fromValueUse(node)
    if (ts.isExpressionWithTypeArguments(node) || ts.isTypeReferenceNode(node) || ts.isNewExpression(node)) {
      fromTypeReference(node, checker.getTypeAtLocation(node))
    }
    ts.forEachChild(node, visit)
  }
  // An instantiation, unlike a declaration, is a *use*: a call site this
  // compilation does not reach fills no hole in anything.
  for (const file of sourceFiles) for (const statement of reachable.statementsOf(file)) visit(statement)

  /**
   * The generic declarations a node is written INSIDE, innermost first --
   * exactly the scopes whose copies can fill a hole this node spells.
   */
  const enclosingGenericsOf = (node: ts.Node): readonly ts.Declaration[] => {
    const owners: ts.Declaration[] = []
    for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
      if (declared.has(current as ts.Declaration)) owners.push(current as ts.Declaration)
    }
    return owners
  }

  /**
   * What one copy of an enclosing generic fills a site's argument with, or
   * `null` when it fills nothing this can act on.
   *
   * Only a filling that IS a hole the copy itself binds is substituted -- the
   * same limit `induceFromHeritage` states, for the same reason. A hole nested
   * inside an argument (`inner<Wrapper<T>>`) would need a type instantiated,
   * which the public checker API does not offer, so it stays honestly
   * uninstantiated rather than becoming a guess.
   */
  const filledBy = (filling: ts.Type, owner: ts.Declaration, tuple: readonly ts.Type[]): ts.Type | null => {
    if (!containsHole(filling)) return filling
    if (!isHole(filling)) {
      // `inner(items)` with `items: T[]` inside `outer<T>`: the hole is inside
      // the argument, and only the checker can build `string[]` -- which it
      // already did, for the call that minted this copy of `outer`, in the
      // resolved signature `fillingOf` reads. A copy with no call behind it
      // answers nothing and the site stays honestly uninstantiated.
      const ordinal = ordinalOfArguments(owner, tuple)
      const image = ordinal === null ? undefined : compositeFillings.get(owner)?.[ordinal]?.get(filling)
      return image !== undefined && !containsHole(image) ? image : null
    }
    const parameter = filling.getSymbol()?.declarations?.[0]
    if (!parameter || !ts.isTypeParameterDeclaration(parameter)) return null
    const index = typeParametersOf(owner).indexOf(parameter)
    const bound = index >= 0 ? tuple[index] : undefined
    return bound !== undefined && !containsHole(bound) ? bound : null
  }

  /**
   * Close the enumeration under SUBSTITUTION, not just under what one source
   * line spells out.
   *
   * `outer<T>(op: T) { inner(op) }` instantiates `inner` once per copy of
   * `outer`, but the syntactic walk sees the site written with a HOLE and
   * records no tuple for it -- so `inner` had no copies, `census.ts` walked its
   * body not at all, and the call's callee carried a signature over a naked
   * type parameter that `derive.ts` correctly refuses. Answering "no copies"
   * there is not conservative, it is wrong, for the identical reason
   * `induceFromHeritage` states about a base class: this is that same closure
   * for a CALL rather than a heritage clause, and the two exist because
   * enumeration has to be closed under what a recorded copy induces.
   *
   * Repeated to a fixed point because the induction chains: `a` calls `b`
   * calls `c`, and `c`'s copies only become minteable once `b` has some. It
   * terminates because a substitution can only ever produce a tuple built from
   * types some copy ALREADY binds, so the reachable set is finite; the round
   * cap is a fail-safe against a future substitution rule that grows a type
   * rather than replacing one, never the thing that makes this stop.
   */
  const openSites = function* (): Generator<readonly [ts.Node, { declaration: ts.Declaration; fillings: readonly ts.Type[] }]> {
    yield* sites
    for (const [node, members] of setSites) for (const site of members) yield [node, site] as const
  }
  for (let round = 0; round < 8; round += 1) {
    let minted = false
    for (const [node, site] of openSites()) {
      if (!site.fillings.some((filling) => containsHole(filling))) continue
      const parameters = typeParametersOf(site.declaration)
      // A value use whose holes a uniquely instantiated function TYPE owns
      // has ONE answer, so the site itself is re-keyed to it (`at` is the
      // node): the reference then resolves to that copy through
      // `specializationAt` exactly as a call's does. An enclosing generic's
      // holes are the other way round -- one site, one substitution per
      // enclosing copy -- and those sites stay open below on purpose.
      const typeOwners = uniquelyInstantiatedTypeOwnersOf(site.fillings)
      if (typeOwners.length > 0) {
        let fillings: readonly (ts.Type | null)[] = site.fillings
        for (const owner of typeOwners) {
          const tuple = tuples.get(owner)?.[0]
          if (!tuple) continue
          fillings = fillings.map((filling) =>
            filling !== null && isHole(filling) && holeOwnerOf(filling) === owner ? filledBy(filling, owner, tuple) : filling
          )
        }
        if (fillings.length === parameters.length && !fillings.some((filling) => filling === null || containsHole(filling))) {
          const bound = new Map<ts.Symbol, ts.Type>()
          parameters.forEach((parameter, index) => {
            const symbol = checker.getSymbolAtLocation(parameter.name)
            const filling = fillings[index]
            if (symbol && filling) bound.set(symbol, filling)
          })
          const existing = ordinalOfArguments(site.declaration, fillings as ts.Type[])
          const fresh = existing === null
          if (existing !== null) markConstructed(site.declaration, existing)
          recordTuple(site.declaration, bound, node)
          if (fresh) minted = true
          continue
        }
      }
      for (const owner of enclosingGenericsOf(node)) {
        for (const tuple of tuples.get(owner) ?? []) {
          const substituted = site.fillings.map((filling) => filledBy(filling, owner, tuple))
          if (substituted.length !== parameters.length || substituted.some((filling) => filling === null)) continue
          const already = ordinalOfArguments(site.declaration, substituted as ts.Type[])
          if (already !== null) {
            markConstructed(site.declaration, already)
            continue
          }
          const bound = new Map<ts.Symbol, ts.Type>()
          parameters.forEach((parameter, index) => {
            const symbol = checker.getSymbolAtLocation(parameter.name)
            const filling = substituted[index]
            if (symbol && filling) bound.set(symbol, filling)
          })
          // Through `recordTuple` rather than `tupleOrdinal` so a class copy
          // minted here induces its own heritage exactly as a syntactic one
          // does; `at` is null because the SITE is already recorded, with the
          // holes its own copy substitutes when it reads them back.
          recordTuple(site.declaration, bound, null)
          minted = true
        }
      }
    }
    if (!minted) break
  }
  closeOpenValueUses()

  const built = new Map<ts.Declaration, Specialization[]>()
  // Every declaration that *writes down* type parameters is one this census
  // specializes, including the ones the program instantiates none. "Generic
  // with no copies" and "not generic" are different answers, and only the first
  // one lets the census walk decide to walk a body not at all: a generic whose
  // hole nothing fills has no meaning to walk, exactly as a C++ template nobody
  // instantiates emits nothing. Registering it with an empty list is what makes
  // `isGeneric` able to say so; `specializationsOf` still answers `[]`, which is
  // what it answered before.
  for (const declaration of declared) built.set(declaration, [])
  for (const [declaration, seen] of tuples) {
    const parameters = typeParametersOf(declaration)
    built.set(
      declaration,
      seen.map((tuple, ordinal) => ({
        ordinal,
        arguments: tuple,
        instantiated: spellings.get(declaration)?.[ordinal] ?? null,
        instantiatedSignature: signaturePairs.get(declaration)?.[ordinal] ?? null,
        bindingOf: (parameter: ts.Declaration) => {
          const index = parameters.indexOf(parameter as ts.TypeParameterDeclaration)
          return index >= 0 ? (tuple[index] ?? null) : null
        },
        fillingOf: (open: ts.Type) => compositeFillings.get(declaration)?.[ordinal]?.get(open) ?? null
      }))
    )
  }

  /** Whether the program mints this copy at all, rather than only naming it. See `constructions`. */
  const isConstructed = (declaration: ts.Declaration, ordinal: number): boolean => constructions.get(declaration)?.[ordinal] ?? true
  const copiesMayDiffer = new Map<ts.Declaration, boolean>()
  const canonicalFillings = new Map<ts.Declaration, readonly ts.Type[] | null>()
  /**
   * The copy a site of a NON-splitting class resolves to: its canonical one.
   *
   * Canonicalising only the instance ANCHOR leaves the class one struct with
   * several method copies, and a body still typed at the wider filling then
   * reads the canonical field and refuses -- `ReadableStream`'s `any` copy
   * reading a `typed-array` `queue_`. One layout is one set of bodies, so a
   * class that must not split resolves every site to the same copy.
   */
  const canonicalOrdinalOf = (declaration: ts.Declaration, ordinal: number): number => {
    const canonical = census.canonicalLayoutFillings(declaration)
    if (canonical === null) return ordinal
    const copies = built.get(declaration) ?? []
    const found = copies.find(
      (copy) => copy.arguments.length === canonical.length && copy.arguments.every((one, index) => one === canonical[index])
    )
    return found?.ordinal ?? ordinal
  }
  const census: SpecializationCensus = {
    // A class that must not split has ONE layout, so every copy of it is
    // typed at the canonical fillings. Without this the wider copy keeps its
    // own bodies, and those read the canonical field and refuse -- the
    // `unknown` copy of `ReadableStream` reading a `typed-array` `queue_`.
    //
    // The copies are REWRITTEN, not dropped. A copy is also what induces the
    // instantiations its body reaches, so deleting one deletes those: folding
    // `Context`'s `[any, any, {}]` away took `new HonoRequest(...)` with it,
    // and `HonoRequest` -- never instantiated anywhere else with closed
    // fillings -- stopped being censused at all, leaving a class the program
    // constructs with no constructor object.
    specializationsOf: (declaration) => {
      const copies = built.get(declaration) ?? []
      const canonical = copies.length < 2 ? null : census.canonicalLayoutFillings(declaration)
      if (canonical === null) return copies
      const chosen = copies.find(
        (copy) => copy.arguments.length === canonical.length && copy.arguments.every((one, index) => one === canonical[index])
      )
      if (chosen === undefined) return copies
      // The canonical copy WHOLE, not just its `arguments`: a member's type is
      // read off `instantiated`, and its parameters substitute through
      // `fillingOf`, so rewriting the argument list alone left the wider
      // copy's bodies exactly as they were.
      //
      // Each copy keeps its own ORDINAL. Collapsing those onto the canonical
      // one lowered the same body twice and the IR builder threw ("block ...
      // is already terminated by a branch operation"); dropping the entries
      // instead left `HonoRequest` never censused and so with no constructor
      // object to build. One entry per instantiation, all naming one layout.
      return copies.map((copy) => (copy === chosen ? copy : { ...chosen, ordinal: copy.ordinal }))
    },
    isGeneric: (declaration) => built.has(declaration),
    specializationOfInstance: (type, substitute) => {
      const symbol = type.getSymbol()
      const declaration = symbol?.declarations?.find((one) => ts.isClassLike(one) || ts.isInterfaceDeclaration(one))
      if (!declaration || !built.has(declaration)) return null
      const parameters = typeParametersOf(declaration)
      if (parameters.length === 0) return null
      const written = (checker.getTypeArguments(type as ts.TypeReference) ?? []).slice(0, parameters.length)
      if (written.length !== parameters.length) return null
      const resolved = substitute ? written.map(substitute) : written
      if (resolved.some((filling) => containsHole(filling))) return null
      const ordinal = ordinalOfArguments(declaration, resolved)
      return ordinal === null ? null : { declaration, ordinal: canonicalOrdinalOf(declaration, ordinal) }
    },
    copiesMayDifferInLayout: (declaration) => {
      const known = copiesMayDiffer.get(declaration)
      if (known !== undefined) return known
      const answer = (() => {
        if (!ts.isClassLike(declaration) || isAmbientDeclaration(declaration)) return false
        const copies = built.get(declaration) ?? []
        const [first, ...rest] = copies
        if (first === undefined || rest.length === 0) return false
        const layoutRelevant = layoutRelevantParameterIndices(checker, declaration)
        const fillings = [first, ...rest].map((copy) => copy.arguments.filter((_, index) => layoutRelevant.has(index)))
        const sameFillings = (left: readonly ts.Type[], right: readonly ts.Type[]): boolean =>
          left.length === right.length && left.every((one, index) => one === right[index])
        if (fillings.every((right) => sameFillings(fillings[0] ?? [], right))) return false
        // Two copies may be separate STRUCTS only if the program can never put
        // one where the other is declared. TypeScript's own assignability is
        // that question: `Token<number>` is assignable to `Token<unknown>`, so
        // `new Sink(new Token<number>())` against a parameter typed
        // `string | Token<unknown> | null` is legal TypeScript that must keep
        // working -- and it cannot if the two copies are different C++ types
        // with no conversion between them. Measured: splitting them compiled
        // and then aborted at runtime with "a dynamic value admitted by no
        // union arm" (`stated-open-union-preserves-closed-arms.ts`). So a
        // class with ANY pair of assignment-compatible copies keeps its one
        // shared layout, exactly as before copies could split at all --
        // `number` and `string` flow into each other in neither direction, so
        // `Box<number>` and `Box<string>` still split.
        // A position the class keeps in MUTABLE storage cannot be shared. The
        // assignability shortcut below exists so copies the program passes
        // into each other keep one layout, but it cannot apply here: one
        // struct would store one copy's field type while the other copy still
        // writes its own, which is a runtime abort rather than a refusal.
        // `ReadableStream<R>`'s `private queue_: R[]`, held at `unknown` and
        // at `Uint8Array`, is the measured case -- these really are two
        // layouts, and the deriver keys them apart on their representations.
        const stored = parametersInInstanceStorage(checker, declaration)
        // Indexed against each copy's FULL argument list: `fillings` above is
        // already filtered down to the relevant positions.
        // A difference involving `any` does NOT force the split. `any` is
        // TypeScript's UNCHECKED top: a program that writes it has already
        // opted out of the guarantee, and hono's `Context` -- held at
        // `[any, any, {}]` and `[BlankEnv, any, {}]` -- is passed between
        // those copies on exactly that licence. `unknown` is the CHECKED top
        // and carries no such licence, so `ReadableStream<unknown>` beside
        // `ReadableStream<Uint8Array>` still splits, which is the pair whose
        // fold aborted at runtime.
        // Only copies the program MINTS can conflict over a shared field: a
        // copy that exists solely as an annotation holds no value to be
        // written through it. That is what tells `ReadableStream<unknown>`,
        // which `TransformStream` really does construct and enqueue into,
        // apart from the `Token<unknown>` arm of a union that only ever
        // receives a `Token<number>`.
        const written = copies.filter((copy) => isConstructed(declaration, copy.ordinal)).map((copy) => copy.arguments)
        if (
          [...layoutRelevant]
            .filter((index) => stored.has(index))
            .some((index) =>
              written.some((left) =>
                written.some((right) => left[index] !== right[index] && !openFilling(left[index]) && !openFilling(right[index]))
              )
            )
        )
          return true
        const flowsInto = (source: readonly ts.Type[], target: readonly ts.Type[]): boolean =>
          source.length === target.length &&
          source.every((one, index) => {
            const other = target[index]
            return other !== undefined && (one === other || checker.isTypeAssignableTo(one, other))
          })
        for (let index = 0; index < fillings.length; index += 1)
          for (let other = index + 1; other < fillings.length; other += 1) {
            const left = fillings[index] ?? []
            const right = fillings[other] ?? []
            if (sameFillings(left, right)) continue
            if (flowsInto(left, right) || flowsInto(right, left)) return false
          }
        return true
      })()
      copiesMayDiffer.set(declaration, answer)
      return answer
    },
    canonicalLayoutFillings: (declaration) => {
      const known = canonicalFillings.get(declaration)
      if (known !== undefined) return known
      canonicalFillings.set(declaration, null)
      const answer = (() => {
        if (!ts.isClassLike(declaration) || isAmbientDeclaration(declaration)) return null
        // Only a class that must NOT split has one shared struct to name.
        if (census.copiesMayDifferInLayout(declaration)) return null
        const copies = built.get(declaration) ?? []
        if (copies.length < 2) return null
        const layoutRelevant = layoutRelevantParameterIndices(checker, declaration)
        if (layoutRelevant.size === 0) return null
        // Full argument lists, so a caller can index them with the written
        // ordinal; only the layout-relevant positions are compared.
        const fillings = copies.map((copy) => copy.arguments)
        const minted = copies.map((copy) => isConstructed(declaration, copy.ordinal))
        const first = fillings[0]
        if (first === undefined) return null
        const relevant = (list: readonly ts.Type[]): readonly ts.Type[] => list.filter((_, index) => layoutRelevant.has(index))
        const sameFillings = (left: readonly ts.Type[], right: readonly ts.Type[]): boolean =>
          left.length === right.length && left.every((one, index) => one === right[index])
        if (fillings.every((right) => sameFillings(relevant(first), relevant(right)))) return null
        // The most specific copy is the one assignable TO every other, index
        // by index: `Uint8Array` into `any`, `number` into `unknown`. Reads in
        // the wider copies then widen out of the struct, which is licensed.
        //
        // A copy is folded away only where it is a TOP type. `any` and
        // `unknown` are not layouts, they are the absence of one: both carry
        // the `dynamic(declared-any-never-narrowed)` representation, which is
        // the carrier that cannot share a struct with a concrete one. Every
        // other difference is a real layout question and is left to the
        // deriver, which groups copies on their fillings' representations.
        //
        // Measured on hono, whose entire build has six classes with more than
        // one copy:
        //   ReadableStream  0:[unknown]        1,2:[Uint8Array]
        //   Context         0:[any, any, {}]   1:[BlankEnv, any, {}]
        //   HonoRequest     0:["/", {}]        1:[any, I["out"]]
        // The first two fold onto their concrete copy. `HonoRequest` has no
        // candidate -- copy 1 differs at a position where copy 0 is NOT top --
        // so it keeps what it had. Restricting this to `any` alone left
        // `ReadableStream` broken; widening it to plain assignability folded
        // `Chain<number>` onto `Chain<3>`, which are both concrete, agree on
        // representation, and each need their own method bodies -- that cost
        // `generic-method-under-a-later-class-copy.ts` its emission.
        const topType = (type: ts.Type | undefined): boolean =>
          type !== undefined && ((type.flags & ts.TypeFlags.Unknown) !== 0 || openFilling(type))
        // Two copies can spell one type as two checker objects -- hono holds
        // `ReadableStream<Uint8Array>` twice, through two `ArrayBufferLike`
        // instantiations -- so identity alone found no candidate that
        // absorbed all three copies. Mutual assignability between two
        // NON-top types is the same type for layout; it is not the loose
        // test that folded `Chain<number>` onto `Chain<3>`, because a literal
        // flows into its widening and not back.
        const sameType = (one: ts.Type, target: ts.Type): boolean =>
          one === target ||
          (!topType(one) && !topType(target) && checker.isTypeAssignableTo(one, target) && checker.isTypeAssignableTo(target, one))
        const absorbs = (candidate: readonly ts.Type[], other: readonly ts.Type[]): boolean =>
          // A copy nothing constructs is a VIEW of whatever value reaches it,
          // so the layout it names is whichever one is really there.
          minted[fillings.indexOf(other)] === false ||
          [...layoutRelevant].every((index) => {
            const one = candidate[index]
            const target = other[index]
            if (one === undefined || target === undefined) return false
            return sameType(one, target) || (topType(target) && !topType(one))
          })
        const differs = (candidate: readonly ts.Type[]): boolean =>
          fillings.some((other) => [...layoutRelevant].some((index) => candidate[index] !== other[index]))
        // And never at a position the class keeps in MUTABLE storage. Folding
        // there gives one struct a field typed at the concrete copy while the
        // wider copy still writes whatever its own filling allows -- measured
        // as a runtime abort, not a refusal, which is strictly worse than the
        // refusal it replaces. Those copies are two layouts and split.
        const stored = parametersInInstanceStorage(checker, declaration)
        const foldable = (candidate: readonly ts.Type[]): boolean =>
          ![...layoutRelevant].some(
            (index) =>
              stored.has(index) &&
              fillings.some(
                (other, at) =>
                  minted[at] === true && other[index] !== candidate[index] && !openFilling(other[index]) && !openFilling(candidate[index])
              )
          )
        // The chosen layout must be one the program actually builds.
        return (
          fillings.find(
            (candidate, at) =>
              minted[at] === true && differs(candidate) && foldable(candidate) && fillings.every((other) => absorbs(candidate, other))
          ) ?? null
        )
      })()
      canonicalFillings.set(declaration, answer)
      return answer
    },
    specializationAt: (node, substitute) => {
      const site = sites.get(node)
      if (!site) return null
      const resolved = substitute ? site.fillings.map(substitute) : site.fillings
      // A filling still open after the asking copy substituted is a hole this
      // program never fills at this site, and an unfilled hole names no copy.
      if (resolved.some((filling) => containsHole(filling))) return null
      const ordinal = ordinalOfArguments(site.declaration, resolved)
      return ordinal === null ? null : { declaration: site.declaration, ordinal: canonicalOrdinalOf(site.declaration, ordinal) }
    },
    setSpecializationsAt: (node, substitute) => {
      const members = setSites.get(node)
      if (!members) return null
      const copies: { declaration: ts.Declaration; ordinal: number }[] = []
      for (const site of members) {
        const resolved = substitute ? site.fillings.map(substitute) : site.fillings
        if (resolved.some((filling) => containsHole(filling))) return null
        const ordinal = ordinalOfArguments(site.declaration, resolved)
        if (ordinal === null) return null
        copies.push({ declaration: site.declaration, ordinal: canonicalOrdinalOf(site.declaration, ordinal) })
      }
      return copies
    }
  }
  return census
}
