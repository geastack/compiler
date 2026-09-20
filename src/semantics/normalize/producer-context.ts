import type { AbsentGlobalCensus } from './absent-globals.js'
import type { ArgumentsObjectCensus } from './arguments-objects.js'
import type { NamespacePathCensus } from './namespace-paths.js'
import type { CollectionBindingCensus } from './collection-bindings.js'
import type { ObjectBagCensus } from './object-bag-bindings.js'
import type { ParameterBindingCensus } from './parameter-bindings.js'
import type { UnresolvableNameCensus } from './unresolvable-names.js'
import type { GlobalHostMutationTaint } from './global-host-mutations.js'
import type { PrototypeReparentingCensus } from '../prototype-reparenting.js'
import type ts from 'typescript'
import type { DeclarationId, StructuralTypeId } from '../../identity/ids.js'
import type { StructuralTypeTable } from '../model/structural-type-table.js'
import type { HostProtocolBinding } from '../host-protocols.js'
import type { KeyedCollectionFamily } from '../../representation/policies.js'
import type { IdentityTable, SpecializationPath } from './identities.js'
import type { SpecializationCensus } from './specialization.js'
import type { StructuralMapper } from './structural.js'
import type { EvaluationOrdinals, OrdinalCounter } from './producers/mint.js'
import type { ReturnBindingCensus } from './return-bindings.js'
import type { ReassignedBindingCensus } from './reassigned-bindings.js'
import type { HostMethodBinding } from '../host-methods.js'
import type { CommonJsRequireCensus } from './commonjs-require.js'
import type { CommonJsModuleRecordCensus } from './commonjs-module-record.js'

/**
 * What every family producer is given.
 *
 * The context is the complete set of questions a producer may ask. It is
 * deliberately small: a producer that needs something not in here needs a new
 * primitive, and having to widen this interface is the signal that says so.
 *
 * Both counters are shared across every producer on purpose, and they answer
 * different questions. `ordinals` disambiguates the nth operation minted from
 * one (node, family) pair -- it is how a compound assignment's get and set share
 * one node and still get two identities.
 *
 * `evaluationOrdinals` is deliberately *not* the general answer to "when does
 * this run": that is `CensusCandidate.evaluationOrdinal`, because only the walk
 * sees document order, and a counter incremented as producers publish records
 * which family ran first, not which operation runs first. This counter covers
 * the one case the walk cannot: an operation a producer places in a caller it
 * synthesized itself -- a class body, a module region -- where the census
 * assigned no candidate and so no position exists to read.
 *
 * Either counter kept per producer would hand two different operations the same
 * identity as soon as two families published for one caller, silently merging
 * them into one.
 */
export interface ProducerContext {
  /** Declaration provenance from the one ts.Program; callers must not infer library ownership from names or paths. */
  readonly isStandardLibraryDeclaration?: (declaration: ts.Declaration) => boolean
  readonly hostMethodOf?: (node: ts.PropertyAccessExpression | ts.ElementAccessExpression) => HostMethodBinding | null
  /**
   * The finite set of property-name texts a computed key can evaluate to,
   * proven closed forward from every closed caller
   * (`normalize/flow/computed-key-set.ts`'s `computedKeySetOf`) and verified
   * against the SEALED host-mutation census's own obligations -- never the
   * optimistic, mid-fixed-point answer that census's own re-run loop takes as
   * a working assumption. `null` means "not proven" (the key stays fully
   * dynamic), which a caller must treat exactly as if this hook did not
   * exist: this is an upper-bound narrowing, and publishing an unproven guess
   * to make a boxing number move would be the exact defect this field exists
   * to avoid. See `producers/properties.ts`'s one call site.
   */
  readonly computedKeyTextsOf?: (key: ts.Expression) => readonly string[] | null
  /** A settled proof that a numeric element read misses every reachable class-family slot. */
  readonly numericIndexAbsenceProvenAt?: (receiver: ts.Expression, key: ts.Expression) => boolean
  /** A settled proof that a NAMED property read misses every instance of a closed object-literal record -- see `closedLiteralMemberAbsenceProven`. */
  readonly closedLiteralMemberAbsenceProvenAt?: (receiver: ts.Expression, name: string) => boolean
  readonly checker: ts.TypeChecker
  readonly identities: IdentityTable
  readonly types: StructuralMapper
  /**
   * Whether EVERY file in this build evaluates strict regardless of its own
   * syntax. That is `alwaysStrict` (implied by `strict`), which makes tsc parse
   * strict and emit a `'use strict'` prologue into each file -- and nothing
   * else. The `module` setting is NOT this fact: under `module: ESNext` a file
   * with no import and no export is a Script, not a Module, and is strict only
   * if `alwaysStrict` or a prologue says so. `isStrictContext` decides the
   * per-file half.
   */
  readonly buildIsStrict: boolean
  readonly table: StructuralTypeTable
  readonly ordinals: OrdinalCounter
  readonly evaluationOrdinals: EvaluationOrdinals
  /**
   * The specialization this producer instance is running under -- the same
   * value `identities`/`types` were already narrowed to
   * (`identities.forSpecialization(path)`/`types.forSpecialization(path)`,
   * `frontend.ts`'s own per-candidate rebind), exposed as data because one
   * question needs the raw path and not just a view already bound to it:
   * `identities.prefixFor(declaration, path)`, asked about a declaration
   * that is NOT the one this producer instance's candidate belongs to.
   *
   * `producers/shared.ts`'s `resolvedCalleeSignatureType` is the one caller
   * today. A callee's own declared type is a property of the CALLEE's
   * declaration, not the caller's -- resolving it through the caller's
   * `types` unfiltered mints a nominal class reached inside it under the
   * caller's own specialization frame whenever that class happens to be the
   * SAME declaration as the frame's owner, purely because `identities.ts`'s
   * `contains` is (correctly, and by design -- see `structural.ts`'s
   * `isSelfReference`) self-inclusive. `parseBody(this, options)` inside
   * `HonoRequest.parseBody`'s own body is the concrete case: `parseBody`'s
   * declared parameter type names `HonoRequest`, which is not `HonoRequest`'s
   * own body reaching itself, but `body.ts`'s unrelated parameter type
   * happening to collide in NAME with the enclosing method's class while
   * `this` walk is inside `HonoRequest`'s copy 0 -- and it must not mint
   * `HonoRequest@0` for that reason alone.
   *
   * `producers/invocations.ts`'s `buildSelectedSignature` tried the same
   * narrowing for a `SelectedSignature`'s `thisParameter`/`parameters`/
   * `returnType` and it was reverted: `returnType` there must stay in
   * lockstep with the call EXPRESSION's own separately-computed result type
   * (`context.types.typeAt(node)` at that file's own call-expression
   * producer), and narrowing only one of the two authorities produced a
   * NEW disagreement `validateInvocationResult` correctly caught --
   * one app's `index.tsx` stopped certifying. Do not reapply that
   * change without also reconciling the invocation-result side.
   *
   * The deeper diagnosis, recorded for whoever reconciles it: the question
   * `buildSelectedSignature` needs to ask is not "does the declaration sit
   * inside the caller's frame" (what `prefixFor` alone answers). A resolved
   * signature's RETURN type can carry real, call-dependent generic
   * substitution that this collapse-to-canonical narrowing has no way to
   * tell apart from the `HonoRequest.parseBody`-style name collision above.
   * `hono-base.ts`'s `Object.assign(this, optionsWithoutStrict)`
   * (`Object.assign<T, U>`, `T`/`U` inferred from the call's own arguments)
   * and `this.router.match(method, path)` (`Router<T>.match`, `T` fixed by
   * the RECEIVER `this.router`'s own concrete instantiation, not by
   * anything `match`'s declaration itself states) are both cases where the
   * substituted type arguments originate OUTSIDE the callee's declaration
   * -- from the call site's arguments or receiver -- so interning the
   * result through the callee's canonical frame mints a fresh identity for
   * a class the caller's own frame already has a name for, instead of
   * reusing it: the same disagreement shape as that regression, by a
   * different route. The `HonoRequest.parseBody` case this field's own
   * fix handles carries no substitution at all -- `HonoRequest | Request`
   * is a plain, unconditional union annotation, not a generic instantiation
   * -- which is exactly why narrowing is safe for a callee's own VALUE type
   * (`resolvedCalleeSignatureType`'s `plain`) but is not, in general, safe
   * for a RETURN type that a real substitution touched. A correct fix would
   * have to tell "this signature was substituted from the call site" apart
   * from "this declaration merely collides in name," not assume the second
   * whenever `prefixFor` collapses -- and until someone builds and measures
   * that test, `returnType` (and, by the same argument, any parameter type
   * a real substitution reaches) should keep resolving through the
   * caller's own `types`, unfiltered, exactly as this field's `path` was
   * never threaded into `buildSelectedSignature` to begin with. (Verified
   * 2026-09-03: on a fresh build of the live tree, `hono-base.ts:171`/`:419`
   * raised zero producer failures, and `producers/invocations.ts` carried no
   * uncommitted change -- the two disagreements this paragraph describes as
   * a HAZARD were never actually observed at HEAD. The hypothesis, unconfirmed,
   * is that `resolvedCalleeSignatureType`'s own fix above closed them as a
   * side effect, by making the callee expression's own interning agree with
   * the invocation-result side it used to diverge from. The reasoning above
   * still holds as the reason not to reapply the `buildSelectedSignature`
   * narrowing blind; it no longer describes an active symptom.)
   */
  readonly path: SpecializationPath
  /**
   * The whole-program census of which declarations are generic and what each
   * is instantiated at. Whole-program by construction -- which declarations
   * are generic and how many distinct type-argument tuples they are called
   * with is a fact about the entire program, not about one copy of it -- so,
   * unlike `identities`/`types`, this is never re-derived per specialization
   * path; every producer instance, in every copy, shares the one census.
   */
  readonly specializations: SpecializationCensus
  /**
   * The ambient host-protocol census (`semantics/host-protocols.ts`): which
   * declared types this program's own declarations say a host owns.
   *
   * Populated before any producer runs (`frontend.ts` calls
   * `hostProtocolBindings`/`ambientHostBindings` before `normalizeProgram`),
   * so every producer sees the complete, sealed census -- never a partial one
   * that would depend on walk order. Needed by `calleeAwareTypeAt`
   * (`producers/shared.ts`): a bound declaration's protocol identity must
   * survive being read as a call's callee, the same way it survives being
   * read anywhere else, or the callee and a plain member-access read of the
   * same declaration select two representations for one cell.
   */
  readonly hostProtocols: ReadonlyMap<DeclarationId, HostProtocolBinding>
  /** Ambient singleton bindings authenticated by complete host declaration identity. */
  readonly hostSingletonBindings: ReadonlySet<DeclarationId>
  /** Ambient namespace roots authenticated by complete host declaration identity. */
  readonly hostNamespaceBindings: ReadonlySet<DeclarationId>
  /** Host-global properties whose direct binding identity is invalidated by a whole-program write/delete/definition. */
  readonly globalHostMutationTaint: GlobalHostMutationTaint
  /** The `Object.setPrototypeOf(C.prototype, B.prototype)` calls modelled as `C` inheriting from `B`. */
  readonly prototypeReparentings: PrototypeReparentingCensus
  /**
   * The structural types `--dynamic-fallback` boxes, sealed before any
   * producer runs (`frontend.ts`'s `dynamicFallbackTypes`).
   *
   * Empty without the flag, which is the only state most producers ever see.
   * It is here for the guards whose PREMISE is the native carrier: an instance
   * of a pre-`class` constructor function has no prototype chain -- unless
   * `prototypeMutatedConstructorTypes` marked it, in which case the instance
   * is a real `DynamicObject` whose chain `Value::construct` links, and a
   * prototype member read finds exactly what the language says it finds. A
   * guard that fires there would refuse a capability this program HAS.
   */
  readonly dynamicFallbackTypes: ReadonlySet<StructuralTypeId>
  /** Checker-authenticated CommonJS wrapper declarations. */
  readonly commonJsBindings: ReadonlyMap<DeclarationId, 'require' | 'exports' | 'module'>
  /** Reserved wrapper declarations that failed exact host provenance verification. */
  readonly commonJsProvenanceFailures: ReadonlySet<DeclarationId>
  /** The shared snapshot proof used by both program discovery and CommonJS invocation admission. */
  readonly commonJsRequire: CommonJsRequireCensus
  /** Source-local proof for the one CommonJS record shape eligible for native lowering. */
  readonly commonJsModuleRecords: CommonJsModuleRecordCensus
  /** A host build's exact loader-spelling to canonical builtin-registry mapping. */
  readonly builtinModuleNameOf: (specifier: string) => string | null
  /** The host-stated implementation source for one canonical builtin registry name. */
  readonly builtinModuleSourceOf: (name: string) => string | null
  /** The Program host's authoritative runtime-module resolver for static CommonJS specifiers. */
  readonly runtimeModuleTargetOf: (specifier: string, containingFile: string, mode: 'import' | 'require') => string | null
  /** The Program's canonical source-file object for that resolver's target path. */
  readonly sourceFileOf: (fileName: string) => ts.SourceFile | null
  /**
   * Which ambient globals an installed host declares it does NOT provide.
   *
   * Read by `contributeVariableDeclaration` for one question: whether to mint
   * an EXTERNAL binding. An ambient declaration is external because some host
   * defines it, and a host that has said it does not is exactly the case where
   * that stops being true -- emitting `extern` for it declares a symbol no
   * object file defines, which compiles and never links.
   *
   * The same census the structural mapper answers the value's TYPE from, shared
   * by reference rather than re-derived, so the cell's storage class and its
   * carrier can never disagree about whether the value is there.
   */
  readonly absentGlobals: AbsentGlobalCensus
  /**
   * Which identifiers are the magic `arguments` binding, and the shape of
   * each one's value (`normalize/arguments-objects.ts`).
   *
   * Two readers that must agree, which is why it is a census threaded from
   * the frontend rather than a checker question asked twice: the reference
   * producer PUBLISHES an `arguments` site's value from it, and
   * `citeExpressionResult` PREDICTS the result that publication carries. A
   * disagreement between the two is not an error anywhere -- it is a withheld
   * citation, which silently takes the whole enclosing function's operations
   * with it.
   */
  readonly argumentsObjects: ArgumentsObjectCensus
  /**
   * Which value-position names resolve to no binding at all
   * (`normalize/unresolvable-names.ts`).
   *
   * The same two-readers-must-agree shape as `argumentsObjects` directly
   * above, and threaded for the same reason: the reference producer PUBLISHES
   * an unresolvable name's value and `citeExpressionResult` PREDICTS it, and a
   * disagreement is a silent withholding rather than an error.
   */
  readonly unresolvableNames: UnresolvableNameCensus
  /**
   * Which module-local `function`/`class` bindings their declaring file
   * writes to (`normalize/reassigned-bindings.ts`), walked once per file.
   * The invocation producer reads it at every bare-identifier call to grant
   * or withhold an `exact` target.
   */
  readonly reassignedBindings: ReassignedBindingCensus
  /**
   * Which property accesses are source-namespace paths (`Debug.log`) or
   * namespace-qualified members (`Debug.assert`) -- `namespace-paths.ts`. The
   * census, the reference producer, the write producers and the citation
   * rule all read this one answer.
   */
  readonly namespacePaths: NamespacePathCensus
  /**
   * Which declarations are the standard `Map`/`Set`/`WeakMap`/`WeakSet`
   * interfaces (`semantics/host-protocols.ts`'s
   * `keyedCollectionDeclarationsOf`).
   *
   * Read by the iteration producers to decide whether a `for`-`of` source
   * takes the native-cursor path -- the same question `isPlainArrayType`
   * answers for an array, asked of a shape whose answer is a declaration
   * identity rather than a shape kind. It has to come from the frontend
   * rather than be re-resolved here for the reason every identity in this
   * compiler is threaded rather than recomputed: `representation/derive.ts`
   * selects the collection CARRIER from this same census, and a producer that
   * resolved `Set` independently could skip the `@@iterator` lookup for a
   * declaration the deriver did not recognise -- or the reverse, which is a
   * silently unlowered loop.
   */
  readonly keyedCollections: ReadonlyMap<DeclarationId, KeyedCollectionFamily>
  /**
   * The whole-program census of what K/(V) a bare `new Map()`/`new Set()`/
   * `new WeakMap()`/`new WeakSet()` allocation, owning declaration, or later
   * read actually stores (`normalize/collection-bindings.ts`).
   *
   * Already the authority `structural.ts`'s `typeAt` substitutes into this
   * call's own published result (`inferredCollectionTypeArgumentsAt`,
   * `structural-array-element.ts`) -- threaded here as well so
   * `producers/invocations.ts`'s `collectionConstructResultOverride` can ask
   * the identical question `typeAt` just asked, rather than re-deriving "did
   * this construct's K/V get narrowed" from a shape comparison. The two
   * readers must agree for the same reason `argumentsObjects`/
   * `unresolvableNames` above do: a call whose result this census bound and a
   * call this census left alone must declare the divergence in lockstep, or
   * `validateInvocationResult` fires for a disagreement neither reader
   * caused.
   */
  readonly collections: CollectionBindingCensus
  /**
   * The object-bag census, for the one question only a producer can license:
   * a call that RETURNS a bag.
   *
   * `structural.ts`'s `typeAt` publishes the bag as the call's own type
   * (`bagShapeTypeAt` via `callResultShapeAt`), while `buildSelectedSignature`
   * still derives the callee's declared return -- `any`, since nothing in the
   * source states it. Two answers for one call is a WITHHOLDING unless a
   * reason is declared, and `bagResultOverride` is where this one is.
   */
  readonly bags: ObjectBagCensus
  /**
   * The composed parameter-binding census, for the ONE producer that has to
   * ask a parameter declaration what it holds rather than reading a type off
   * a node the mapper already answered: `contributeDefaultedParameter`.
   *
   * `structural-parts.ts`'s `parameterOf` (the published ABI slot) opens with
   * `parameters.typeAt(declaration)`, and `structural.ts`'s `typeAt` reaches
   * the same answer for every body-side read through
   * `structural-layout-type.ts`'s guarded census fallback. The binding that
   * INITIALIZES the cell those two read through asked
   * `checker.getTypeAtLocation` directly -- deliberately, so that the two
   * spellings of an ANNOTATED default (`p: number | undefined = 0` versus
   * `p = 0`) reach one shape -- and for an UNANNOTATED default that answer is
   * the initializer's own type. `{}` for `options = {}`. Three authorities,
   * one parameter, and the cell was the one holding `{}` while its slot and
   * every read held the real record. This is the same three-authority shape
   * `parameter-slot.ts`'s own header records for rest parameters, resolved
   * the same way: give all three the same source.
   */
  readonly parameters: ParameterBindingCensus
  /**
   * The declaration identity of the standard `Generator<T, TReturn, TNext>`
   * interface, or `null` when this compilation's `lib` installs none.
   *
   * Read by the iteration producers for exactly the reason `keyedCollections`
   * above is: `representation/derive.ts`'s `GeneratorDeclarationPolicy`
   * carries a value of that type as the native cursor `iterator(T)`, so a
   * `for`-`of` over one must skip the `@@iterator` lookup -- and a producer
   * that resolved `Generator` independently could disagree with the deriver
   * about which declaration that is.
   */
  readonly generatorDeclaration: DeclarationId | null
  /** The standard `AsyncGenerator<T, TReturn, TNext>` declaration -- the same cursor question one level out; see `asyncGeneratorDeclarationOf`. */
  readonly asyncGeneratorDeclaration: DeclarationId | null
  /** The standard `MapIterator<T>` declaration returned by `Map.prototype.entries()`. */
  readonly mapIteratorDeclaration: DeclarationId | null
  /**
   * What every unannotated JS function actually returns (`return-bindings.ts`),
   * for a producer that wants it directly rather than through
   * `context.types.typeAt` -- see the "not yet the load-bearing seam" note
   * below.
   *
   * Optional, and unlike every other whole-program census on this interface,
   * NOT the primary way this census reaches a producer today. The primary
   * seam is `return-bindings.ts`'s own `withReturnBindings`, which composes
   * this census with the `ParameterBindingCensus` `structural.ts` already
   * threads into `layoutTypeAt` (`structural-layout-type.ts`) -- the same
   * path `parameters` (that census) already takes, so a call site this
   * census resolves is answered through the SAME node `context.types.typeAt`
   * already asks, with no producer needing to know this field exists. Wiring
   * `withReturnBindings` in at its one call site is a `frontend.ts` change
   * (`const parameters = censusParameterBindings(...)` becomes
   * `withReturnBindings(checker, files, censusParameterBindings(...))`) that
   * this module's own ownership boundary does not include, so this field is
   * threaded here, populated, and left unconsumed until a producer or
   * `frontend.ts` is edited to use one path or the other -- never both, or a
   * call site the composed census resolves and a producer resolves
   * independently could disagree about its own result's carrier.
   */
  readonly returns?: ReturnBindingCensus
}
