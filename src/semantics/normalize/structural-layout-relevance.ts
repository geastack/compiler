import ts from 'typescript'

/**
 * Which of a generic class or interface's own type parameters actually reach
 * a STORED value.
 *
 * `structural.ts`'s `buildDeclaredShape` folds every one of a declared type's
 * ARGUMENTS into its structural key (`class-instance:${declaration}:${
 * typeArguments.join(',')}`), because in general two different arguments mean
 * two different physical layouts. That is correct for `Context<E,...>`,
 * whose `env: E['Env']` field genuinely differs in C++ type per `E`. It
 * is NOT correct for a type parameter that participates only in a method's
 * overload/return-type composition and never in an instance field's own
 * type: a `Router<E,S,Path>` that names `S` inside
 * `get!: Handler<E,'get',S,Path>`, where `Handler` is a pure call-signature
 * bag with no data field of its own, so no C++ struct anywhere actually
 * stores a value shaped by `S`. Folding it into the key anyway mints one
 * `Router` specialization per distinct registration call in the program --
 * a generic method whose recursion is self-similar across them, and the census walks each copy
 * again, which is the shape of the stack overflow this module exists to cut
 * off at the root.
 *
 * The test is deliberately NOT "does the parameter appear, textually, in a
 * member's type" -- `S` appears that way too, nested inside
 * `Handler`'s own argument list, and a syntactic-appearance test
 * cannot tell that occurrence apart from `E`'s in `E['Env']`. It is
 * whether the parameter reaches a storage position, followed through nested
 * generic references: a member typed `Other<Args>` propagates relevance only
 * through the positions of `Other` that `Other`'s OWN fields (computed by
 * this same analysis, recursively) actually store into.
 *
 * `HandlerInterface` is safe to fold NOT because it is "a member with call
 * signatures" -- an earlier version of this module tested exactly that, at
 * the top of `typeMentionsParameter`, and it was wrong: `derive.ts`'s
 * `function` representation carries a real `abi` that DOES vary by the
 * callable's own signature, so a genuinely STORED callable field --
 * `class Emitter<T> { listener: (v: T) => void }`, an ordinary observer/
 * event-handler idiom -- physically differs in C++ type across `T`, exactly
 * like a data field does. Blanket-exempting "any member typed as callable"
 * let two `Emitter<T>` instantiations that differ only through `listener`
 * collapse onto one shared, wrong shape (`structural.ts`'s `buildDeclaredShape`
 * runs once per folded key; whichever instantiation reaches it first wins for
 * every later one). By the time a `ts.Type` has call signatures, a pure
 * method-signature bag and a stored callback value are the same shape --
 * `HandlerInterface` and a hypothetical `interface OnChange<T> { (v: T): void
 * }` used as `onChange: OnChange<T>` are indistinguishable at that level --
 * so the type-shape question is the wrong one to ask.
 *
 * `HandlerInterface` is safe for a narrower, decidable reason this module
 * already has the machinery for: it is a NAMED declared interface, and
 * walking ITS OWN members (the identical recursive question this module asks
 * of every other named generic reference, `Other<Args>` above) finds zero
 * `PropertyDeclaration`/`PropertySignature` members to prove any of its own
 * type parameters relevant -- HandlerInterface's members are all bare
 * `CallSignatureDeclaration`s, a third AST kind this module's member loop
 * was never asking about either way. So the fix is not a new callable
 * special case; it is the ABSENCE of one: an anonymous callable-typed
 * member -- no declared interface/class backing it, nothing this module can
 * recurse into -- now falls straight through to the same "not modeled, so
 * not trusted" default every other unrecognized shape gets, below.
 *
 * The residual gap this narrower reasoning leaves, named honestly rather than
 * hidden: a genuinely-NAMED, call-signature-only interface used as directly
 * STORED data (`onChange: OnChange<T>`, not `HandlerInterface`'s own
 * invoke-only usage) still folds its type parameters as not-relevant, the
 * same way `HandlerInterface` correctly does, because this module has no
 * whole-program fact distinguishing "reached only by invocation" from
 * "stored, read back, passed around" for a member it can already prove has
 * no OWN data fields. Closing that would need a use-site (escape) census this
 * module does not have; the common real-world idiom for a stored callback --
 * an inline function-type annotation, `(v: T) => void` -- is the anonymous
 * case above and is NOT affected by this gap.
 *
 * Fails closed at every turn: an ambient (`.d.ts`) declaration with no stated
 * storage fields keeps every parameter relevant (`Promise`, `Array`, `Map`,
 * ... already have dedicated derivation in `representation/derive.ts`, which
 * reads `shape.typeArguments` directly). An ambient class that does state its
 * fields can be analyzed from those declarations just like a source class;
 * this is what lets a library's declarations prove that some type parameters
 * occur only through call-signature-only interfaces. The standard library's
 * own no-default-lib declarations remain conservative even when they expose a
 * descriptive property such as `Set.size`: their native carrier can store a
 * type parameter that no declared JavaScript field names. A declaration
 * mid-computation (a genuine cycle -- a class naming
 * itself through a field, say) answers "every parameter relevant" for that
 * reentrant call rather than guessing at a fixed point. Any type shape this
 * module does not model (a conditional type, a mapped type, an anonymous
 * object type with no declaration to recurse into, an anonymous callable
 * type) is treated as though it might mention the parameter. An unproven
 * parameter keeps forking exactly as it does today.
 */

const cache = new WeakMap<ts.Node, ReadonlySet<number>>()
const inProgress = new WeakSet<ts.Node>()

const allIndices = (count: number): ReadonlySet<number> => new Set(Array.from({ length: count }, (_, index) => index))

/** Flags whose bearer is a leaf value no type parameter could hide inside -- worth naming explicitly so it does not fall through to the conservative "unmodeled" answer below. */
const leafFlags =
  ts.TypeFlags.StringLike |
  ts.TypeFlags.NumberLike |
  ts.TypeFlags.BooleanLike |
  ts.TypeFlags.BigIntLike |
  ts.TypeFlags.ESSymbolLike |
  ts.TypeFlags.Null |
  ts.TypeFlags.Undefined |
  ts.TypeFlags.Void |
  ts.TypeFlags.Never |
  ts.TypeFlags.Any |
  ts.TypeFlags.Unknown

const isDeclaredGenericOwner = (node: ts.Node): node is ts.ClassLikeDeclaration | ts.InterfaceDeclaration =>
  ts.isClassLike(node) || ts.isInterfaceDeclaration(node)

type StorageMember = ts.PropertyDeclaration | ts.PropertySignature | ts.ParameterDeclaration | ts.MethodSignature

/**
 * The members that are instance state, which is a wider set than the
 * `PropertyDeclaration`/`PropertySignature` pair this module first asked for.
 *
 * A CONSTRUCTOR PARAMETER PROPERTY (`constructor(readonly bag: Bag<T>) {}`)
 * is a field declared in parameter position; the member loop never saw one,
 * so a class whose only state was declared that way proved no parameter
 * relevant at all and every instantiation folded onto one anchor.
 *
 * A METHOD SIGNATURE on an interface is a stored callable, not a call
 * convention the way a bare `CallSignatureDeclaration` is: `interface
 * Sink<T> { take?(handle: Handle<T>): void }` is a record with a `take`
 * field, and `derive.ts`'s `function` representation carries an `abi` that
 * varies with `Handle<T>`'s own carrier. That only became observable once a
 * generic class could split: with `Handle<Uint8Array>` and `Handle<unknown>`
 * two physical classes, `Sink`'s one erased record holds whichever
 * convention was derived first and the other copy's read of `take` has
 * nothing to convert through. A class METHOD is deliberately not here -- it
 * dispatches statically and occupies no slot in the instance.
 */
const storageMembersOf = (declaration: ts.ClassLikeDeclaration | ts.InterfaceDeclaration): readonly StorageMember[] => [
  ...declaration.members.filter(
    (member): member is ts.PropertyDeclaration | ts.PropertySignature | ts.MethodSignature =>
      ts.isPropertyDeclaration(member) || ts.isPropertySignature(member) || ts.isMethodSignature(member)
  ),
  ...declaration.members
    .filter(ts.isConstructorDeclaration)
    .flatMap((constructor) => constructor.parameters.filter((parameter) => ts.getModifiers(parameter)?.length))
]

/** Class state, not instance state -- a static holds no value shaped by an instantiation's arguments. */
const isStaticMember = (member: StorageMember): boolean =>
  (ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined)?.some((one) => one.kind === ts.SyntaxKind.StaticKeyword) === true

/**
 * Whether `type` structurally contains `parameter` in a position that would
 * make a value of `type` actually carry one -- the recursive half of this
 * module's own question, asked about one field's type rather than a whole
 * declaration's.
 */
const typeMentionsParameter = (checker: ts.TypeChecker, type: ts.Type, parameter: ts.Type, depth: number): boolean => {
  if (type === parameter) return true
  if (depth > 40) return true // a recursion this deep is not one this analysis trusts itself to have modeled correctly -- fail closed rather than risk never returning.
  if ((type.flags & leafFlags) !== 0) return false
  if (type.isUnion() || type.isIntersection())
    return type.types.some((member) => typeMentionsParameter(checker, member, parameter, depth + 1))
  if (checker.isArrayType(type) || checker.isTupleType(type)) {
    const elements = checker.getTypeArguments(type as ts.TypeReference) ?? []
    return elements.some((element) => typeMentionsParameter(checker, element, parameter, depth + 1))
  }
  if ((type.flags & ts.TypeFlags.IndexedAccess) !== 0) {
    const indexed = type as ts.IndexedAccessType
    return (
      typeMentionsParameter(checker, indexed.objectType, parameter, depth + 1) ||
      typeMentionsParameter(checker, indexed.indexType, parameter, depth + 1)
    )
  }
  // Deliberately NO blanket exemption for "this member's type has call
  // signatures" here -- see the top-of-file comment for why that shape
  // question cannot tell `HandlerInterface` (a pure method-signature bag,
  // safe to fold) apart from a genuinely STORED callable field (not safe:
  // `derive.ts`'s `function` representation carries an `abi` that varies by
  // signature, so a class field of a differently-signatured callable is a
  // differently-typed C++ field). A callable reached through a NAMED
  // declared interface/class still falls into the recursion just below,
  // exactly like any other `Other<Args>` reference, and answers correctly
  // for `HandlerInterface` on its own merits: it has zero
  // `PropertyDeclaration`/`PropertySignature` members (only bare call
  // signatures), so `layoutRelevantParameterIndices` finds nothing proving
  // any of its type parameters relevant, with no special case required. An
  // ANONYMOUS callable type -- no declared owner to recurse into, the
  // common shape for a real stored callback field (`(v: T) => void`) --
  // now falls through to this function's own fail-closed default at the
  // bottom instead.
  const symbol = type.getSymbol()
  const declaration = symbol?.declarations?.[0]
  if (declaration && isDeclaredGenericOwner(declaration)) {
    const typeArguments = checker.getTypeArguments(type as ts.TypeReference) ?? []
    if (typeArguments.length === 0) return false
    const relevant = layoutRelevantParameterIndices(checker, declaration)
    return typeArguments.some((argument, index) => relevant.has(index) && typeMentionsParameter(checker, argument, parameter, depth + 1))
  }
  // A function-type ANNOTATION -- `(v: T) => void`, the ordinary spelling for
  // a stored callback field -- is not an unmodeled shape. Its parameters and
  // its result are written down right here, so the module's own question has
  // a precise answer instead of a guess: `Emitter<T> { listener: (v: T) =>
  // void }` still proves `T` relevant, now THROUGH the parameter that carries
  // it, while `describe = (): string => ...` -- a callable field naming no
  // type parameter at all -- stops forcing one physical copy of its class per
  // instantiation. That mattered once physical class identity started
  // following this analysis: `return-type-mints-no-copy.ts`'s `Chain<T>`
  // stores only `value: number` and such a callable, so a blanket "might
  // mention T" here split it into two structs whose fields are identical,
  // and the fluent `tag(): Chain<T[]>` then had to convert between them.
  // Only a FUNCTION-LIKE declaration qualifies -- the written `(v: T) => void`
  // annotation and equally the arrow whose inferred type a field initializer
  // gives it (`describe = (): string => ...`, which has no annotation at all)
  // -- and only while the type carries no properties of its own beside its
  // signatures. An anonymous object type of any other provenance keeps the
  // conservative answer below.
  if (declaration && ts.isFunctionLike(declaration) && type.getProperties().length === 0) {
    const signatures = [...type.getCallSignatures(), ...type.getConstructSignatures()]
    if (signatures.length > 0)
      return signatures.some((signature) => {
        const slots = signature.getParameters().map((slot) => slot.valueDeclaration)
        if (slots.some((slot) => slot === undefined)) return true
        return (
          slots.some(
            (slot) => slot !== undefined && typeMentionsParameter(checker, checker.getTypeAtLocation(slot), parameter, depth + 1)
          ) || typeMentionsParameter(checker, signature.getReturnType(), parameter, depth + 1)
        )
      })
  }
  // An object type WRITTEN as a literal -- `type Abortable = { signal?:
  // AbortSignal }`, an inline `{ value: T }` -- spells out every member it
  // has, so its members answer exactly as a field's declared type does, the
  // alias's own arguments already substituted into them. The fail-closed
  // default below said "mentions every parameter" for it instead, and an
  // abstract `Operation<TResult>` -- whose only field touching such a
  // literal is `options: Options & Abortable` -- was therefore "storing"
  // `TResult`: one layout per result type, and every subclass instance
  // refused at each call into the `any` copy that
  // `execute<T extends Operation>` names.
  // A callable literal keeps the conservative answer: its signatures are not
  // modeled here.
  if (
    declaration &&
    (ts.isTypeLiteralNode(declaration) || ts.isObjectLiteralExpression(declaration)) &&
    type.getCallSignatures().length === 0 &&
    type.getConstructSignatures().length === 0
  )
    return (
      type.getProperties().some((property) => typeMentionsParameter(checker, checker.getTypeOfSymbol(property), parameter, depth + 1)) ||
      checker.getIndexInfosOfType(type).some((index) => typeMentionsParameter(checker, index.type, parameter, depth + 1))
    )
  // A conditional type, a mapped type, an anonymous object type with no
  // declaration to recurse into, ... -- not modeled, so not trusted.
  return true
}

/**
 * The set of type-parameter POSITIONS (0-based, declaration order) that
 * `declaration`'s own instance fields prove reach storage. See this module's
 * top-of-file comment for the rule and its fail-closed defaults.
 */
const storageCache = new WeakMap<ts.Declaration, ReadonlySet<number>>()
const storageInProgress = new WeakSet<ts.Declaration>()

export const layoutRelevantParameterIndices = (
  checker: ts.TypeChecker,
  declaration: ts.ClassLikeDeclaration | ts.InterfaceDeclaration
): ReadonlySet<number> => {
  const typeParameters = declaration.typeParameters
  if (!typeParameters || typeParameters.length === 0) return new Set()
  const cached = cache.get(declaration)
  if (cached) return cached
  const storageMembers = storageMembersOf(declaration)
  if (declaration.getSourceFile().hasNoDefaultLib) {
    // `Set<T>` is the measured case: its standard-library declaration exposes
    // `size: number` but no field mentioning T, while the native collection
    // carrier stores T as its key. Default-library declarations describe
    // JavaScript behavior rather than a C++ layout, so their own fields cannot
    // prove a generic parameter physically irrelevant.
    return allIndices(typeParameters.length)
  }
  if (declaration.getSourceFile().isDeclarationFile && storageMembers.length === 0) {
    // A pure call-signature interface has no instance storage of its own. It
    // is the declared form of a callable convention, so its generic arguments
    // cannot change an enclosing record's field layout. Other ambient shapes
    // with no stated fields (Promise, Map, host objects) remain conservative:
    // their native carrier may depend on arguments not visible in the .d.ts
    // member list.
    if (
      ts.isInterfaceDeclaration(declaration) &&
      declaration.members.length > 0 &&
      declaration.members.every(ts.isCallSignatureDeclaration)
    )
      return new Set()
    return allIndices(typeParameters.length)
  }
  if (inProgress.has(declaration)) return allIndices(typeParameters.length) // reentrant: a genuine cycle, answered without caching so the OUTER call still computes the real fixed point.
  inProgress.add(declaration)
  try {
    // Neither of the two `getTypeAtLocation` calls in this block is a census
    // candidate. Both ask about a DECLARATION's own generic-parameter algebra
    // -- `parameter` is a `TypeParameterDeclaration` (its "type" is the type
    // variable `T` itself, an identity to compare against, never a runtime
    // value), and `member` is a class/interface field's ANNOTATED type, asked
    // for the sole purpose of testing whether that annotation structurally
    // mentions `T`. This whole module answers a question about a
    // DECLARATION's shape, not about any expression's held value, so there is
    // no node here a parameter/return/local census could ever have an opinion
    // on -- see `parameter-bindings.ts`'s own domain (call-site/write-set
    // evidence for an expression) versus this file's (type-parameter
    // propagation through declared field types).
    const parameterTypes = typeParameters.map((parameter) => checker.getTypeAtLocation(parameter))
    const relevant = new Set<number>()
    for (const member of storageMembers) {
      if (ts.canHaveModifiers(member) && ts.getModifiers(member)?.some((modifier) => modifier.kind === ts.SyntaxKind.StaticKeyword))
        continue
      const propertyType = checker.getTypeAtLocation(member)
      parameterTypes.forEach((parameterType, index) => {
        if (!relevant.has(index) && typeMentionsParameter(checker, propertyType, parameterType, 0)) relevant.add(index)
      })
    }
    // A parameter that reaches storage through the HERITAGE clause is as
    // relevant as one a field names. `interface NodeArray<T> extends
    // ReadonlyArray<T>, ReadonlyTextRange` declares no field mentioning `T`,
    // and its layout is the array `structural.ts`'s `arrayHeritageShapeOf`
    // builds from that very `T` -- so folding `T` keyed every instantiation
    // to ONE anchor, `NodeArray<any>`, whose body carried whichever element
    // the first instantiation had. A `for`-`of` over an `ArrayBindingPattern`'s
    // elements then read `OmittedExpression`s as the `BindingElement`s of the
    // `ObjectBindingPattern` interned before it, caught only by the emitter's
    // cursor-element guard. The base is asked the same way a field's declared
    // type is, so a default-library base (every standard array) keeps every
    // argument, and a source base answers with its own proven positions.
    for (const clause of declaration.heritageClauses ?? []) {
      for (const base of clause.types) {
        const baseType = checker.getTypeFromTypeNode(base)
        parameterTypes.forEach((parameterType, index) => {
          if (!relevant.has(index) && typeMentionsParameter(checker, baseType, parameterType, 0)) relevant.add(index)
        })
      }
    }
    cache.set(declaration, relevant)
    return relevant
  } finally {
    inProgress.delete(declaration)
  }
}

/**
 * The parameter positions this class keeps in MUTABLE storage of its own.
 *
 * Folding two copies of a class onto one layout is only sound where the
 * folded-away filling cannot be stored. `class Queue<R> { private items: R[] }`
 * held at `unknown` and at `Uint8Array` is one struct storing `Uint8Array[]`
 * the moment the copies fold, and the `unknown` copy then pushes a string into
 * it -- measured, and it aborts at runtime reading the value back out
 * ("an assertion out of a dynamic value ... is not of the declared type").
 * A position listed here must never be folded; those copies are genuinely two
 * layouts and split.
 *
 * `readonly` is NOT an exclusion, though it reads like one. A readonly field
 * is still WRITTEN, by the constructor, with whatever that copy was handed:
 * `class Handle<T> { constructor(readonly bag: Bag<T>) {} }` folded onto its
 * `Uint8Array` copy declares the field `Bag<Uint8Array>` and the `unknown`
 * copy's own constructor then stores a `Bag<unknown>` in it. Only `static`
 * is excluded -- that is class state, shaped by no instantiation.
 *
 * A BASE's storage is this class's storage. `class ReadableStreamBYOBReader<R>
 * extends ReadableStreamDefaultReader<R>` declares no member at all: the
 * `stream_` field that actually carries `R` is the base's. Reading only this
 * declaration's own members answered "stores nothing", so its copies folded
 * onto the byte one and `getReader` on an `unknown` stream constructed a
 * reader whose inherited field was typed at the other stream class.
 */
export const parametersInInstanceStorage = (
  checker: ts.TypeChecker,
  declaration: ts.ClassLikeDeclaration | ts.InterfaceDeclaration
): ReadonlySet<number> => {
  const typeParameters = declaration.typeParameters
  if (!typeParameters || typeParameters.length === 0) return new Set()
  const cached = storageCache.get(declaration)
  if (cached) return cached
  // A cycle answers "every parameter stored" for the reentrant call only, so
  // the outer one still computes the real set -- the same fail-closed shape
  // `layoutRelevantParameterIndices` uses.
  if (storageInProgress.has(declaration)) return allIndices(typeParameters.length)
  storageInProgress.add(declaration)
  try {
    const parameterTypes = typeParameters.map((parameter) => checker.getTypeAtLocation(parameter))
    const stored = new Set<number>()
    const prove = (type: ts.Type): void => {
      parameterTypes.forEach((parameterType, index) => {
        if (!stored.has(index) && typeMentionsParameter(checker, type, parameterType, 0)) stored.add(index)
      })
    }
    for (const member of storageMembersOf(declaration)) {
      if (isStaticMember(member)) continue
      prove(checker.getTypeAtLocation(member))
    }
    for (const clause of declaration.heritageClauses ?? []) {
      // `implements` states a contract, not a field. Only what a value
      // physically inherits can carry a parameter into this instance.
      if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue
      for (const base of clause.types) {
        const baseType = checker.getTypeFromTypeNode(base)
        const baseDeclaration = baseType.getSymbol()?.declarations?.[0]
        const baseArguments = checker.getTypeArguments(baseType as ts.TypeReference) ?? []
        if (baseDeclaration === undefined || !isDeclaredGenericOwner(baseDeclaration) || baseArguments.length === 0) {
          // Not a declaration this module can open -- an ambient base, a
          // mapped or conditional base. Whatever it stores is unknown, so
          // every parameter reaching it is treated as reaching storage.
          prove(baseType)
          continue
        }
        const baseStored = parametersInInstanceStorage(checker, baseDeclaration)
        baseArguments.forEach((argument, index) => {
          if (baseStored.has(index)) prove(argument)
        })
      }
    }
    storageCache.set(declaration, stored)
    return stored
  } finally {
    storageInProgress.delete(declaration)
  }
}

/** One copy of a generic class, as far as `storedDataDiffers` needs to read it. */
export interface StoredCopy {
  readonly arguments: readonly ts.Type[]
}

/**
 * Whether two copies of a class, differing at a stored position where one of
 * them is filled with a bare `any`, would actually write DIFFERENT DATA into
 * one shared struct -- the question `parametersInInstanceStorage` only
 * answers by the parameter's name.
 *
 * A parameter can reach storage without reaching any datum a copy writes.
 * A `Context<E>` may store `E` only as `env: E['Env']` (the unchecked
 * top at both `any` and a default `BlankEnv`), as callables (`#fallback:
 * Handler<E>`, `set`/`get` arrow fields), and through `Context` itself.
 * Splitting it on the parameter's name made a dispatcher's `Context`
 * (built at `any`) a different C++ type from the one every user handler is
 * compiled for (`BlankEnv`) -- the program hands one to the other on every
 * call, so the split has no honest conversion at all. Where the copies
 * DO write different data -- `class CaseInsensitiveMap<V = any> extends
 * Map<string, V>` at `any` and at `unknown[]`, whose base stores `V` itself
 * -- the answer is still `true` and they split.
 *
 * Member by member, the two copies' types agree when they are the same type,
 * when both are the unchecked or checked top (a dynamic slot either way),
 * when both are callables (a stored callable crosses between conventions
 * through an adapter, never by reinterpreting a datum), or when both name
 * this very class (coinductively: the fold being asked about makes them one
 * struct). Anything the census cannot spell per copy fails closed.
 */
export const storedDataDiffers = (
  checker: ts.TypeChecker,
  declaration: ts.ClassLikeDeclaration,
  index: number,
  left: StoredCopy,
  right: StoredCopy
): boolean => {
  const typeParameters = declaration.typeParameters
  const parameter = typeParameters?.[index]
  if (parameter === undefined) return true
  const parameterType = checker.getTypeAtLocation(parameter)
  const isTop = (type: ts.Type): boolean => (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0
  const isSelf = (type: ts.Type): boolean => (type.getSymbol()?.declarations ?? []).some((one) => one === declaration)
  const callable = (type: ts.Type): boolean =>
    !type.isUnionOrIntersection() && checker.getSignaturesOfType(type, ts.SignatureKind.Call).length > 0
  const agree = (a: ts.Type, b: ts.Type, depth: number): boolean => {
    if (a === b) return true
    if (depth > 12) return false
    if (isTop(a) || isTop(b)) return isTop(a) && isTop(b)
    if (isSelf(a) && isSelf(b)) return true
    if (callable(a) && callable(b)) return true
    if (a.isUnion() || b.isUnion()) {
      const armsOf = (type: ts.Type): readonly ts.Type[] => (type.isUnion() ? type.types : [type])
      const leftArms = armsOf(a)
      const rightArms = armsOf(b)
      return (
        leftArms.length === rightArms.length &&
        leftArms.every((arm) => rightArms.some((other) => agree(arm, other, depth + 1))) &&
        rightArms.every((arm) => leftArms.some((other) => agree(arm, other, depth + 1)))
      )
    }
    const leftTarget = (a as ts.TypeReference).target
    const rightTarget = (b as ts.TypeReference).target
    if (leftTarget !== undefined && leftTarget === rightTarget) {
      const leftArguments = checker.getTypeArguments(a as ts.TypeReference)
      const rightArguments = checker.getTypeArguments(b as ts.TypeReference)
      return (
        leftArguments.length === rightArguments.length &&
        leftArguments.every((one, at) => {
          const other = rightArguments[at]
          return other !== undefined && agree(one, other, depth + 1)
        })
      )
    }
    return false
  }
  // Each member's OPEN type read through both copies' fillings. The census
  // has the checker's instantiated spelling for only some copies (a copy
  // minted by `new Context(...)` inside another generic has none), so the
  // fillings are substituted here, by the few forms a stored member takes;
  // any other form fails closed.
  const parameterTypes = (typeParameters ?? []).map((one) => checker.getTypeAtLocation(one))
  const differing = parameterTypes.filter((_, at) => left.arguments[at] !== right.arguments[at])
  const resolveIndexed = (object: ts.Type, key: string): ts.Type | null => {
    if (isTop(object)) return object
    const property = checker.getPropertyOfType(object, key)
    // The checker instantiates a missing key of a constrained parameter to
    // `unknown` (`BlankEnv['Bindings']`); a missing key is the checked top.
    return property === undefined ? checker.getUnknownType() : checker.getTypeOfSymbol(property)
  }
  const agreeUnder = (open: ts.Type, depth: number): boolean => {
    if (!differing.some((one) => typeMentionsParameter(checker, open, one, 0))) return true
    if (depth > 12) return false
    const at = parameterTypes.indexOf(open)
    if (at >= 0) {
      const leftFilling = left.arguments[at]
      const rightFilling = right.arguments[at]
      return leftFilling !== undefined && rightFilling !== undefined && agree(leftFilling, rightFilling, 0)
    }
    if (open.isUnionOrIntersection()) return open.types.every((one) => agreeUnder(one, depth + 1))
    if (callable(open)) return true
    if ((open.flags & ts.TypeFlags.IndexedAccess) !== 0) {
      const indexed = open as ts.IndexedAccessType
      const objectAt = parameterTypes.indexOf(indexed.objectType)
      if (objectAt < 0 || !indexed.indexType.isStringLiteral()) return false
      const leftObject = left.arguments[objectAt]
      const rightObject = right.arguments[objectAt]
      if (leftObject === undefined || rightObject === undefined) return false
      const leftType = resolveIndexed(leftObject, indexed.indexType.value)
      const rightType = resolveIndexed(rightObject, indexed.indexType.value)
      return leftType !== null && rightType !== null && agree(leftType, rightType, 0)
    }
    if (isSelf(open)) return true
    const target = (open as ts.TypeReference).target
    if (target !== undefined) return checker.getTypeArguments(open as ts.TypeReference).every((one) => agreeUnder(one, depth + 1))
    return false
  }
  for (const member of storageMembersOf(declaration)) {
    if (isStaticMember(member)) continue
    const open = checker.getTypeAtLocation(member)
    if (!typeMentionsParameter(checker, open, parameterType, 0)) continue
    if (!agreeUnder(open, 0)) return true
  }
  // A base that carries the parameter carries whatever the base stores of
  // it. Only a base argument that IS the parameter can be compared by the
  // copies' own fillings; anything built over it fails closed.
  for (const clause of declaration.heritageClauses ?? []) {
    if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue
    for (const base of clause.types) {
      const baseType = checker.getTypeFromTypeNode(base)
      if (!typeMentionsParameter(checker, baseType, parameterType, 0)) continue
      const baseArguments = checker.getTypeArguments(baseType as ts.TypeReference) ?? []
      if (baseArguments.some((argument) => argument !== parameterType && typeMentionsParameter(checker, argument, parameterType, 0)))
        return true
      const leftFilling = left.arguments[index]
      const rightFilling = right.arguments[index]
      if (leftFilling === undefined || rightFilling === undefined || !agree(leftFilling, rightFilling, 0)) return true
    }
  }
  return false
}
