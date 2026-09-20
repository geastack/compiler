import ts from 'typescript'
import type { ProgramReachability } from './reachability.js'
import { physicalOverloadTypeAt } from './structural-declarations.js'

/**
 * Which type a type parameter is actually bound to, program-wide.
 *
 * A type parameter has no carrier. `T` is not a thing a value can be stored as
 * -- it is a hole an instantiation fills -- so representation refuses it, and
 * that refusal is correct. What is missing is the instantiation: a generic
 * function's body is compiled once here, with `T` still a hole, when the
 * language says the body exists once *per instantiation*.
 *
 * Full monomorphization compiles a generic body once per distinct type-argument
 * tuple, minting a separate identity for each copy. This census is the first
 * half of that, and it answers the case that turns out to dominate real
 * programs: a generic instantiated at exactly ONE type across the whole program.
 * A framework's `mount<RootComponent extends Component>` is instantiated once,
 * by the one application that calls it; a `Store<State>` is instantiated by the
 * one state type the app declares. When the binding is unique there is nothing
 * to duplicate -- the body has one meaning -- so substituting it is exact rather
 * than an approximation, and no second identity is needed.
 *
 * When a parameter is bound to two different types, this census says so by
 * answering `null`, and representation refuses exactly as it did before. That
 * refusal is then honest about what is missing -- body duplication -- instead of
 * being a blanket refusal of every generic in the program.
 *
 * Erasing to the constraint instead was considered and is wrong here. Java
 * erases `T extends Component` to `Component` because every reference is a
 * pointer to a heap object with a shared header; a `class-ref` carrier in this
 * compiler is a flat struct with the fields of exactly that class, so "erase to
 * the base" would hand a caller a struct of the wrong size and shape. Erasure
 * is not a weaker version of monomorphization here; it is a different, unsound
 * thing.
 *
 * One more source counts as a binding, at lower priority than a genuine one:
 * a type parameter's OWN constraint, which is what a caller who never
 * supplies an explicit argument resolves to (`mount<RootComponent extends
 * Component>` binds `Component`'s parameter to `GeaElement` for every
 * program, since every program calls `mount`). That default is recorded
 * separately from a genuine call/type-reference site and consulted only when
 * NO genuine site exists anywhere reachable -- so a program with one real
 * instantiation resolves to that real one despite the ever-present default,
 * and a program with none (most apps reach `Component` only through
 * `ReactiveComponent<E> extends Component<E>`, itself parameterized) still
 * resolves, instead of coming up empty. See `censusInstantiations`'s
 * `bindings` map and the `unique` loop for the two-bucket mechanics.
 */

export interface InstantiationCensus {
  /**
   * The one type this parameter is bound to everywhere, or `null` when it is
   * bound to none or to more than one.
   */
  readonly bindingOf: (declaration: ts.Declaration) => ts.Type | null
}

/** A function that records one parameter/binding pair, into whichever bucket its caller chose. */
type RecordFn = (parameter: ts.Type, bound: ts.Type) => void

/** A census that knows nothing, for a caller that has not run the walk. */
export const emptyInstantiationCensus: InstantiationCensus = { bindingOf: () => null }

/**
 * Whether this type is itself a hole.
 *
 * Binding one parameter to another -- `class ReactiveComponent<E> extends
 * Component<E>` binds `Component`'s parameter to `ReactiveComponent`'s -- says
 * nothing about what either one finally is, and recording it would let a
 * substitution resolve to a second hole. The chain is worth following one day;
 * recording it as an answer today would be a wrong one.
 */
const isHole = (type: ts.Type): boolean => (type.flags & ts.TypeFlags.TypeParameter) !== 0

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
 *
 * ABSENCE is the exception, and it is not an exception to that argument: it is
 * outside it. `status?: U` has type `U | undefined`, but that `undefined` is
 * the OPTIONAL MODIFIER, not a declared alternative -- the program wrote one
 * type and a `?`. So `status?: U` against `status?: ContentfulStatusCode` is
 * `U | undefined` against `ContentfulStatusCode | undefined`, and refusing it
 * as an ambiguous union bound nothing for `U` at all, which is what left
 * hono's `c.json` generic uninstantiated. `withoutAbsence` strips exactly that
 * modifier and requires ONE type to remain on each side, so nothing is
 * aligned by position and no set is guessed; a union with two real arms still
 * declines. It is also the rule the checker itself used: TypeScript infers an
 * optional parameter from its non-`undefined` part.
 */
/**
 * A type with the absence its OPTIONALITY contributes removed -- or `null` when
 * what remains is not a single type.
 *
 * `undefined`, `null` and `void` are what a `?` modifier and a
 * `strictNullChecks` widening add; they are not arms the program chose between.
 * A type that is not a union, or one whose non-absent arms are more than one,
 * is returned unchanged / `null` respectively, so the caller can tell "nothing
 * to strip" from "stripped, and ambiguous".
 */
const absenceFlags = ts.TypeFlags.Undefined | ts.TypeFlags.Null | ts.TypeFlags.Void

const withoutAbsence = (type: ts.Type): ts.Type | null => {
  if (!type.isUnion()) return type
  const present = type.types.filter((arm) => (arm.flags & absenceFlags) === 0)
  if (present.length === type.types.length) return type
  return present.length === 1 ? (present[0] ?? null) : null
}

const unify = (
  checker: ts.TypeChecker,
  generic: ts.Type,
  concrete: ts.Type,
  depth: number,
  record: (parameter: ts.Type, bound: ts.Type) => void
): void => {
  if (depth > 8) return
  if (generic === concrete) return
  if (isHole(generic)) {
    record(generic, concrete)
    return
  }
  const genericPresent = withoutAbsence(generic)
  const concretePresent = withoutAbsence(concrete)
  if (genericPresent !== generic || concretePresent !== concrete) {
    if (genericPresent !== null && concretePresent !== null) {
      unify(checker, genericPresent, concretePresent, depth + 1, record)
    }
    return
  }
  const genericReference = generic as ts.TypeReference
  const concreteReference = concrete as ts.TypeReference
  if (
    (generic.flags & ts.TypeFlags.Object) !== 0 &&
    (concrete.flags & ts.TypeFlags.Object) !== 0 &&
    genericReference.target !== undefined &&
    genericReference.target === concreteReference.target
  ) {
    const generics = genericReference.typeArguments ?? []
    const concretes = concreteReference.typeArguments ?? []
    for (let index = 0; index < Math.min(generics.length, concretes.length); index += 1) {
      const left = generics[index]
      const right = concretes[index]
      if (left && right) unify(checker, left, right, depth + 1, record)
    }
    return
  }
  unifySignatures(checker, generic.getCallSignatures(), concrete.getCallSignatures(), depth, record)
  unifySignatures(checker, generic.getConstructSignatures(), concrete.getConstructSignatures(), depth, record)
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
  record: (parameter: ts.Type, bound: ts.Type) => void
): void => {
  const generic = generics[0]
  const concrete = concretes[0]
  if (generics.length !== 1 || concretes.length !== 1 || !generic || !concrete) return
  unify(checker, generic.getReturnType(), concrete.getReturnType(), depth + 1, record)
  // `this` IS a parameter, and the only one `Signature.parameters` leaves out.
  // See `specialization.ts`'s twin of this walk for the generic that needs it;
  // the two must bind the same holes or the census and the type table disagree
  // about which copies exist.
  const genericThis = (generic as ts.Signature & { readonly thisParameter?: ts.Symbol }).thisParameter
  const concreteThis = (concrete as ts.Signature & { readonly thisParameter?: ts.Symbol }).thisParameter
  if (genericThis && concreteThis) {
    const genericThisType = typeOfParameter(checker, genericThis)
    const concreteThisType = typeOfParameter(checker, concreteThis)
    if (genericThisType && concreteThisType) unify(checker, genericThisType, concreteThisType, depth + 1, record)
  }
  for (let index = 0; index < Math.min(generic.parameters.length, concrete.parameters.length); index += 1) {
    const left = generic.parameters[index]
    const right = concrete.parameters[index]
    if (!left || !right) continue
    const leftType = typeOfParameter(checker, left)
    const rightType = typeOfParameter(checker, right)
    if (leftType && rightType) unify(checker, leftType, rightType, depth + 1, record)
  }
}

/** A parameter symbol's declared type, or `null` when the symbol has no declaration to read it at. */
const typeOfParameter = (checker: ts.TypeChecker, parameter: ts.Symbol): ts.Type | null => {
  const at = parameter.valueDeclaration ?? parameter.declarations?.[0]
  return at ? checker.getTypeOfSymbolAtLocation(parameter, at) : null
}

/** A declaration's own `typeParameters`, or none when it declares none. */
const typeParametersOf = (declaration: ts.Declaration): readonly ts.TypeParameterDeclaration[] => {
  const withParameters = declaration as ts.Declaration & { readonly typeParameters?: ts.NodeArray<ts.TypeParameterDeclaration> }
  return withParameters.typeParameters ?? []
}

/**
 * Every instantiation the program makes, collected before anything is
 * normalized.
 *
 * Two sources, and they are different questions. A *call* instantiates a
 * generic signature, and the checker has already inferred its arguments -- so
 * the resolved signature paired against the generic one it came from is the
 * whole answer. A *type reference* instantiates a generic declaration directly,
 * including through a default (`class Home extends Component` is
 * `Component<unknown>`), and there the type's own arguments are the answer with
 * nothing to unify.
 *
 * The walk covers the program's own files, not its declaration files: an
 * instantiation is something a program does, and a `.d.ts` states types without
 * ever performing one.
 */
// Every `checker.getTypeAtLocation` / `Signature.getReturnType()` /
// `checker.getTypeOfSymbolAtLocation` call below (in `unify`, `unifySignatures`,
// `typeOfParameter`, `genericSignatureOf`, `fromOverloadedPhysicalCallee`,
// `fromTypeReference`, and the `visit` walk) is answering "what did the
// LANGUAGE resolve this generic/call/heritage site to", not "what does this
// node hold" -- there is no `censusedTypeAt` question to ask here. This runs
// BEFORE the parameter/return/local/field binding census exists at all
// (`frontend.ts`'s `runFrontend` computes `instantiations` and
// `specializations` first, specifically because the fixpoint below needs the
// generic/specialization answers as an input, not the other way round -- see
// this file's own header and `specialization.ts`'s: "answers it before
// anything is normalized, because the census has to know how many copies of
// each body to emit before it emits any"). So converting a site here is not
// merely risky, as the mission brief warns for generic-instantiation code --
// there is no census instance in scope to convert it TO. Left as direct
// checker calls, verified by reading `frontend.ts`'s call order.
export const censusInstantiations = (
  checker: ts.TypeChecker,
  sourceFiles: readonly ts.SourceFile[],
  reachable: ProgramReachability
): InstantiationCensus => {
  /**
   * Two buckets per parameter, not one. `genuine` is a real instantiation --
   * a call, `new`, or type reference the program actually writes. `defaults`
   * is what a type parameter's OWN constraint resolves to when nothing else
   * fills it in -- `mount<RootComponent extends Component>` binds
   * `Component`'s parameter to `GeaElement` this way for every program, since
   * every program calls `mount`.
   *
   * That default is not a rival answer to a genuine binding; it is the
   * fallback for when there is no genuine one. A program with one genuine
   * instantiation (`class App extends Component<GeaCanvasElement>`) plus the
   * ever-present default must resolve to the genuine one, not be refused as
   * "bound to two types" -- and a program with NO genuine instantiation
   * anywhere (most apps reach `Component` only through `ReactiveComponent`,
   * itself parameterized, so the chain never binds `Component`'s own
   * parameter to a concrete type) must still resolve, to the default, rather
   * than come up empty just because the default is no longer being
   * miscounted as a second genuine site.
   */
  const bindings = new Map<ts.Symbol, { genuine: ts.Type[]; defaults: ts.Type[] }>()

  /** The symbol-keyed half of `recordInto`, reusable by a caller that already has a `ts.Symbol` rather than the hole `ts.Type` `unify` produces one. */
  const recordSymbolInto = (bucket: 'genuine' | 'defaults', symbol: ts.Symbol, bound: ts.Type): void => {
    if (isHole(bound)) return
    const entry = bindings.get(symbol) ?? { genuine: [], defaults: [] }
    const list = entry[bucket]
    if (!list.includes(bound)) list.push(bound)
    bindings.set(symbol, entry)
  }
  const recordInto =
    (bucket: 'genuine' | 'defaults'): RecordFn =>
    (parameter, bound) => {
      const symbol = parameter.getSymbol()
      if (symbol) recordSymbolInto(bucket, symbol, bound)
    }
  const record = recordInto('genuine')
  const recordDefault = recordInto('defaults')

  /**
   * The uninstantiated signature a call was resolved from.
   *
   * `Signature.target` is where the checker keeps this, and it is not public
   * API, so the generic is recovered the way a reader would: from the callee's
   * own type. A callee whose type carries exactly one signature and that
   * signature declares type parameters is the generic this call instantiated.
   * More than one signature is an overload set, where which one was selected is
   * precisely what is not recoverable from position, so those are skipped.
   */
  const genericSignatureOf = (node: ts.CallLikeExpression): ts.Signature | null => {
    const callee = ts.isTaggedTemplateExpression(node)
      ? node.tag
      : ts.isJsxOpeningLikeElement(node)
        ? node.tagName
        : ts.isCallOrNewExpression(node)
          ? node.expression
          : null
    if (!callee) return null
    const type = checker.getTypeAtLocation(callee)
    const signatures = ts.isNewExpression(node) ? type.getConstructSignatures() : type.getCallSignatures()
    const only = signatures[0]
    if (signatures.length !== 1 || !only) return null
    return only.getTypeParameters()?.length ? only : null
  }

  /**
   * A call through a callee whose DECLARED type is an overload set but whose
   * physical value is one generic function literal -- the shape
   * `genericSignatureOf` above correctly refuses (`signatures.length !== 1`),
   * because which overload a call selected is not recoverable from the
   * callee's declared type alone.
   *
   * `c.json(...)` (hono's `context.ts`) is exactly this: `json` is annotated
   * `JSONRespond`, an interface with two overloaded generic call signatures,
   * so the callee's type never carries one signature. But the type parameter
   * that actually needs a binding belongs to neither overload -- it belongs
   * to the one arrow function literal `json` was initialized with.
   * `structural-declarations.ts`'s `physicalOverloadTypeAt` already reads
   * that narrower truth for the property's own STORAGE type; this asks it of
   * the callee's declaration to find the same literal.
   *
   * The checker's resolved signature for the call is still one of the
   * interface's two overloads (`resolved.getDeclaration()` names a
   * `CallSignatureDeclaration` inside `JSONRespond`, not the arrow), so the
   * fillings are read off THAT overload's own uninstantiated form --
   * `checker.getSignatureFromDeclaration` recovers it -- and then re-keyed
   * onto the arrow's OWN type parameters by position. Sound because the
   * interface overload and the literal satisfying it declare the same number
   * of type parameters in the same order: TypeScript already proved the
   * literal assignable to the overload it was assigned under, which is what
   * let the program typecheck at all. Recorded as a GENUINE binding, exactly
   * as an ordinary call would be -- this is one, just read through an extra
   * layer of indirection the declared type hides.
   */
  const fromOverloadedPhysicalCallee = (node: ts.CallLikeExpression, resolved: ts.Signature): void => {
    if (!ts.isCallOrNewExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return
    const callee = node.expression
    const symbol = checker.getSymbolAtLocation(callee)
    const declaration = symbol?.valueDeclaration ?? symbol?.declarations?.[0]
    if (!declaration) return
    const physical = physicalOverloadTypeAt(checker, declaration)
    if (!physical) return
    const physicalSignatures = physical.getCallSignatures()
    const physicalSignature = physicalSignatures[0]
    if (physicalSignatures.length !== 1 || !physicalSignature) return
    const owner = physicalSignature.getDeclaration()
    const ownerParameters = owner ? typeParametersOf(owner) : []
    if (!owner || ownerParameters.length === 0) return
    const resolvedDeclaration = resolved.getDeclaration()
    const uninstantiated = resolvedDeclaration ? checker.getSignatureFromDeclaration(resolvedDeclaration) : undefined
    if (!uninstantiated || uninstantiated === resolved) return
    const interfaceParameters = uninstantiated.getTypeParameters() ?? []
    if (interfaceParameters.length !== ownerParameters.length) return
    const bound = new Map<ts.Symbol, ts.Type>()
    unifySignatures(checker, [uninstantiated], [resolved], 0, (parameter, filling) => {
      const parameterSymbol = parameter.getSymbol()
      if (parameterSymbol && !bound.has(parameterSymbol) && !isHole(filling)) bound.set(parameterSymbol, filling)
    })
    for (let index = 0; index < interfaceParameters.length; index += 1) {
      const interfaceSymbol = interfaceParameters[index]?.getSymbol()
      const ownSymbol = checker.getSymbolAtLocation(ownerParameters[index]!.name)
      const filling = interfaceSymbol && bound.get(interfaceSymbol)
      if (filling && ownSymbol) recordSymbolInto('genuine', ownSymbol, filling)
    }
  }

  const fromCall = (node: ts.CallLikeExpression): void => {
    const resolved = checker.getResolvedSignature(node)
    if (!resolved) return
    const generic = genericSignatureOf(node)
    if (generic && generic !== resolved) {
      unifySignatures(checker, [generic], [resolved], 0, record)
      return
    }
    fromOverloadedPhysicalCallee(node, resolved)
  }

  const fromTypeReference = (type: ts.Type, into: RecordFn = record): void => {
    const reference = type as ts.TypeReference
    const parameters = reference.target?.typeParameters
    const args = reference.typeArguments
    if (!parameters || !args) return
    for (let index = 0; index < Math.min(parameters.length, args.length); index += 1) {
      const parameter = parameters[index]
      const bound = args[index]
      if (parameter && bound) into(parameter, bound)
    }
  }

  const visit = (node: ts.Node): void => {
    // A PRUNED member is not reached either, and the statement-level rule
    // below cannot say so -- a dead method lives inside a live class
    // declaration, so `forEachChild` walks into it. The same guard the
    // specialization census carries, for the same reason it states.
    if (reachable.memberIsPruned(node)) return
    // A type parameter's own bound is not a USE of the generic it names in
    // the way a call or a class heritage clause is: `<R extends Component>`
    // states what `R` may be substituted with, and `mount`'s own body only
    // ever touches `R`, never `Component` directly -- so this is never a
    // second genuine instantiation site standing beside a real one. But it
    // IS the fallback every caller who never overrides `R` resolves to, and
    // most apps never do (they reach `Component` only through
    // `ReactiveComponent<E> extends Component<E>`, where `E` is itself a
    // hole this census correctly never chases). Recorded as a DEFAULT
    // (`recordDefault`, a separate bucket from genuine bindings below) so it
    // settles a parameter with no genuine instantiation anywhere, without
    // ever manufacturing a false second binding beside a real one -- which is
    // what recording it as a genuine site used to do.
    if (ts.isTypeParameterDeclaration(node)) {
      if (node.constraint) fromTypeReference(checker.getTypeAtLocation(node.constraint), recordDefault)
      return
    }
    if (ts.isCallOrNewExpression(node) || ts.isTaggedTemplateExpression(node) || ts.isJsxOpeningLikeElement(node)) fromCall(node)
    if (ts.isExpressionWithTypeArguments(node) || ts.isTypeReferenceNode(node) || ts.isNewExpression(node)) {
      fromTypeReference(checker.getTypeAtLocation(node))
    }
    ts.forEachChild(node, visit)
  }
  // Whole-program still means whole *program*: a call site this compilation
  // does not reach is not a call site, so counting one would let dead code
  // decide that a live generic has two bindings and must be refused.
  for (const file of sourceFiles) for (const statement of reachable.statementsOf(file)) visit(statement)

  const unique = new Map<ts.Declaration, ts.Type>()
  for (const [symbol, entry] of bindings) {
    const declaration = symbol.declarations?.[0]
    if (!declaration) continue
    // More than one GENUINE binding means the body really does have more
    // than one meaning, and substituting either would compile one call's
    // program for the other call. That is the case body duplication exists
    // for, and until it exists the honest answer is the refusal
    // representation already gives -- unchanged from before defaults existed
    // as a separate bucket.
    if (entry.genuine.length > 1) continue
    if (entry.genuine.length === 1) {
      unique.set(declaration, entry.genuine[0]!)
      continue
    }
    // Zero genuine instantiations anywhere reachable: the default a type
    // parameter's own constraint resolves to is not a competing second
    // answer here, it is the ONLY answer on offer, exactly as if the
    // language itself had filled the hole. More than one distinct default
    // (two differently-constrained generics disagreeing on this parameter)
    // is exactly as ambiguous as two genuine sites, so it is refused the
    // same way.
    if (entry.defaults.length === 1) unique.set(declaration, entry.defaults[0]!)
  }

  return { bindingOf: (declaration) => unique.get(declaration) ?? null }
}
