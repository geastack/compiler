import type { PackageSource } from './package-sources.js'
import type { CommonJsWrapperDeclaration, HostNativeTypeDeclaration, HostOwnedDeclaration } from '../plugins/model.js'
import { anyKeyedWriteTypes, prototypeMutatedConstructorTypes, proxyFallbackTypes } from './dynamic-fallback.js'
import ts from 'typescript'
import { structuralShapeKey } from './model/structural-types.js'
import { resolveHostMethod, type HostMethodBindingTable } from './host-methods.js'
import type { DeclarationId, FunctionId, NodeId, OperationFamily, RegionId, StructuralTypeId } from '../identity/ids.js'
import type { DiagnosticEvidence, DiagnosticLocation } from '../diagnostics/model.js'
import type { TypedArrayElementDomain } from '../representation/model.js'
import type { KeyedCollectionFamily, RegExpDeclarationKind, StandardBufferKind } from '../representation/policies.js'
import { componentId, positionKeyOfDeclaration, positionKeyOfNode, regionId } from '../identity/ids.js'
import type { SemanticGraph } from './model/graph.js'
import { createStructuralTypeTable } from './model/structural-type-table.js'
import { censusProgram } from './normalize/census.js'
import type { FamilyProducer } from './normalize/contribution.js'
import { createIdentityTable, rootSpecialization, type IdentityTable } from './normalize/identities.js'
import { gatingEdges } from './normalize/gating.js'
import { normalizeProgram } from './normalize/normalize.js'
import type { ProducerContext } from './normalize/producer-context.js'
import { createEvaluationOrdinals, createOrdinalCounter } from './normalize/producers/mint.js'
import { intrinsicPropertyCallOf } from './normalize/intrinsic-property-call.js'
import { createStructuralMapper, type ClassCopyKey } from './normalize/structural.js'
import { censusDeclaredMembers } from './normalize/structural-declarations.js'
import { bodyReadsThis } from './normalize/structural-receiver.js'
import { censusInstantiations } from './normalize/instantiation.js'
import { censusSpecializations } from './normalize/specialization.js'
import { censusAbsentGlobals, platformDeclarationTest, type AbsentGlobalCensus } from './normalize/absent-globals.js'
import { censusDeadTypeofGuards, type DeadTypeofGuardCensus } from './normalize/dead-typeof-guards.js'
import { censusArgumentsObjects } from './normalize/arguments-objects.js'
import { censusUnresolvableNames } from './normalize/unresolvable-names.js'
import { censusGlobalHostMutations } from './normalize/global-host-mutations.js'
import { HostMutationTaint } from './normalize/host-mutation-keys.js'
import { createCensusComputedKeysOf } from './normalize/host-mutation-computed-keys.js'
import { closedCallableAuthorityOf } from './normalize/flow/callable-reach.js'
import {
  attachDeferredIntrinsicProtocolLedger,
  createDeferredIntrinsicProtocolLedger,
  failedIntrinsicProtocolRequirements,
  intrinsicProtocolRequirementKind
} from './normalize/deferred-intrinsic-protocols.js'
import { prototypeKeyQuerySignature } from './normalize/host-mutation-keys.js'
import { explainIntrinsicProtocolFailure } from './normalize/intrinsic-prototype.js'
import { isAmbientDeclaration } from './ambient.js'
import { createReassignedBindingCensus } from './normalize/reassigned-bindings.js'
import { createCommonJsRequireCensus } from './normalize/commonjs-require.js'
import { censusCommonJsModuleRecords } from './normalize/commonjs-module-record.js'
import { censusNamespacePaths } from './normalize/namespace-paths.js'
import { numericIndexAbsenceProven, closedLiteralMemberAbsenceProven } from './normalize/derived-expression-type.js'
import {
  censusParameterBindings,
  emptyParameterBindingCensus,
  indexParameterBindingProgram,
  type ParameterBindingCensus
} from './normalize/parameter-bindings.js'
import { composeReturnBindings } from './normalize/return-bindings.js'
import type { ReturnBindingCensus } from './normalize/return-bindings.js'
import { withLocalBindings } from './normalize/local-bindings.js'
import { withFieldBindings } from './normalize/field-bindings.js'
import { censusCollectionBindings, type CollectionBindingCensus } from './normalize/collection-bindings.js'
import { censusObjectBagBindings, emptyObjectBagCensus, type ObjectBagCensus } from './normalize/object-bag-bindings.js'
import { indexValueFlow } from './normalize/flow/value-flow.js'
import type { ValueFlowIndex } from './normalize/flow/model.js'
import { attachClosedScriptScope, attachStatedModuleSet, type ClosedScriptScope, type StatedModuleSet } from './normalize/flow/targets.js'
import { censusRefusalCounts, type CensusRefusal } from './normalize/census-refusal.js'
import { createCellPolicyRegistry, defaultCellEvidencePolicies, buildCellFactsTable, publishCellFacts } from './normalize/cells/index.js'
import type { CellFactsPublication } from './normalize/cells/index.js'
import type { StructuralDisagreement, StructuralFormViolation } from './normalize/structural-rules.js'
import { settleBindingCensus, type RoundCensus } from './normalize/binding-fixpoint.js'
import { withJsDocTypeNames } from './normalize/jsdoc-type-names.js'
import {
  censusReachability,
  fileEvaluates,
  moduleEvaluationOrder,
  nodeIsReachable,
  type ProgramReachability
} from './normalize/reachability.js'
import { createProgram, defaultCompilerOptions } from './program.js'
import { createFrontendTiming } from './frontend-timing.js'
import type { DiagnosticSourcePreparationAudit } from './diagnostic-source-preparation.js'
// The ambient host-protocol census -- what this program's own declarations
// say a host owns -- lives in its own module purely for the architecture
// gate's 800-line ceiling; see that file's own header comment.
import type { HostCensus, HostProtocolBinding, HostProtocolInput } from './host-protocols.js'
import { classHeritageOf } from './class-heritage.js'
import { constructorSlotSubclassesOf } from './constructor-slot-subclasses.js'
import { prototypeReparentingsOf } from './prototype-reparenting.js'
import { uninstantiableClassesOf } from './uninstantiable-classes.js'
import { interfaceImplementorsOf } from './interface-implementors.js'
import { interfaceFamiliesOf } from './interface-families.js'
import {
  ambientHostBindings,
  bindStandardClasses,
  dateDeclarationOf,
  stringObjectDeclarationOf,
  errorDeclarationsOf,
  functionDeclarationOf,
  generatorDeclarationOf,
  asyncGeneratorDeclarationOf,
  mapIteratorDeclarationOf,
  hostProtocolBindings,
  keyedCollectionDeclarationsOf,
  promiseDeclarationOf,
  regexpDeclarationsOf,
  standardBufferDeclarationsOf,
  typedArrayDeclarationsOf,
  typedArrayInstanceInterfaceNames,
  wellKnownSymbolDeclarationsOf
} from './host-protocols.js'

/**
 * The frontend boundary.
 *
 * This is the last place a TypeScript AST exists. Everything it returns is
 * target-neutral and sealed, so no later layer can reach back and answer a
 * question the frontend already answered differently.
 *
 * Producers are supplied by the caller rather than imported here, so installing
 * or withholding a family is an explicit decision visible at the call site --
 * and so a family with no producer is reported by the census instead of quietly
 * contributing nothing.
 */

export interface FrontendInput {
  /** Package checkouts prepared by the project loader; the compiler discovers their implementation entries. */
  readonly packageSources?: readonly PackageSource[]
  readonly declarationModules?: ReadonlySet<string>
  readonly dynamicFallback?: boolean
  readonly hostMethodBindings?: HostMethodBindingTable
  /** Exact host declarations eligible for checker-derived TypedArray inheritance. */
  readonly hostTypedArrayDeclarations?: readonly HostOwnedDeclaration[]
  readonly rootFileNames: readonly string[]
  /** The project file defining this program, or `null` to use this compiler's defaults alone. */
  readonly projectFileName?: string | null
  /** Built from the context once the program exists, so producers share one counter. */
  readonly producers: (context: ProducerContext) => readonly FamilyProducer[]
  /**
   * The declared type names the installed hosts own, to the type their runtime
   * carries values of each in (`PluginCapabilities.nativeTypes`).
   *
   * Supplied rather than known, for the same reason `producers` is: a compiler
   * that carried this table itself would be hand-maintaining one library's
   * object model inside a language compiler. Absent, nothing binds by name and
   * this file behaves exactly as it did.
   */
  readonly nativeTypes?: ReadonlyMap<string, string>
  /** Exact host-owned native type declarations; see `PluginCapabilities.nativeTypesByDeclaration`. */
  readonly nativeTypesByDeclaration?: ReadonlyMap<string, HostNativeTypeDeclaration>
  /** Exact host-owned singleton declarations; see `PluginCapabilities.hostSingletonDeclarations`. */
  readonly hostSingletonDeclarations?: ReadonlyMap<string, HostOwnedDeclaration>

  /**
   * The ambient global names the installed hosts declare they do NOT provide
   * (`PluginCapabilities.absentGlobals`, unioned).
   *
   * Supplied rather than known, for exactly the reason `nativeTypes` is: which
   * globals a target lacks is a fact about that target, and a compiler that
   * carried the list itself would be asserting something about the program's
   * environment that nothing in the program says. Absent, every ambient
   * declaration keeps the treatment it has today. See `absent-globals.ts` for
   * the silent miscompile this exists to stop.
   */
  readonly absentGlobals?: ReadonlySet<string>

  /**
   * The standard library class names the backend implements natively, whose
   * carrier it states in `nativeTypes` above -- see `bindStandardClasses`
   * (semantics/host-protocols.ts) and `coreNativeTypes`
   * (targets/cpp/host/core-globals.ts). Empty means the target implements no
   * standard-library class of its own, which is the honest default: nothing
   * here is derived from a name this file knows.
   */
  readonly standardClasses?: ReadonlySet<string>
  /**
   * Class member names an installed host reaches without the program spelling
   * them -- see `PluginCapabilities.reachedMemberKeys`, and
   * `reachability.ts`'s `hostReachedMemberKeys` for what the walk does with
   * them.
   */
  readonly hostReachedMemberKeys?: ReadonlySet<string>
  /**
   * The `hostFunctions` of every installed host whose programs take the host
   * mutation census's wildcard (`PluginCapabilities.refusesObjectPrototypeAbsenceProofs`).
   * When reachable code names one of them, the two absence proofs that rest
   * on an `Object.prototype` key obligation refuse up front, and the read
   * stays boxed instead of costing the program its certificate. Carried on
   * the deferred ledger, which is what both proofs consult.
   */
  readonly hostFunctionsRefusingObjectPrototypeAbsenceProofs?: ReadonlySet<string>
  /**
   * The global names the installed hosts own as PATHS rather than as values
   * (`PluginCapabilities.hostNamespaces.roots`). Nothing about one is a host
   * protocol: `Window@1` for `window` demands a native boundary no plugin can
   * state, because there is no value to carry.
   */
  readonly hostNamespaceRoots?: ReadonlySet<string>
  /** Exact declaration-owned namespace roots; configured names mask name-only admission. */
  readonly hostNamespaceRootDeclarations?: readonly HostOwnedDeclaration[]
  /**
   * Every dotted path an installed host states a member under
   * (`PluginCapabilities.hostNamespaces.methods`/`.properties`' own keys, e.g.
   * `navigator.mediaDevices.getUserMedia`), so a path with one of these as a
   * prefix is itself a namespace SEGMENT and not a value either -- the same
   * fact `hostNamespaceRoots` states for a bare top-level name, one level
   * deeper. Without this, a member reached only as `navigator.mediaDevices`
   * (never spelled by the program, only implied by `Navigator`'s own
   * declaration) was admitted as an ordinary host protocol needing its own
   * native boundary -- `MediaDevices@1` -- when the host states no carrier for
   * it and never will: `navigator.mediaDevices.getUserMedia(...)` is a path to
   * one free function, the same shape `Display.getBrightness()` already is,
   * and the emitter's own `isHostNamespacePath` (`targets/cpp/host-members.ts`)
   * already resolves an arbitrarily long path this way -- this is the frontend
   * learning the identical fact so preflight stops demanding a boundary the
   * path never needed.
   */
  readonly hostNamespacePaths?: ReadonlySet<string>
  /**
   * The type an installed host carries the one object behind each of its
   * namespace roots in (`PluginCapabilities.hostNamespaceRootTypes`), keyed by
   * the root's own name -- `window` -> `gea::host::WindowFacade`.
   *
   * `hostNamespaceRoots` above says a root has no value to carry *as a cell*:
   * nothing named `window` is materialized, and every use of it resolves to a
   * spelling. It does not say the root is nothing -- `gea::host::window` is one
   * real object the host holds -- and a carrier still has to be selected for
   * the reference and the binding read the program publishes for it. Without
   * this, the only answer available is the root's ambient DOM declaration, and
   * `Window & typeof globalThis` flattens into a struct no host implements.
   * Absent, nothing is recorded and every root derives exactly as it did.
   */
  readonly hostNamespaceRootTypes?: ReadonlyMap<string, string>
  /** Exact host-owned declarations that authenticate CommonJS wrapper state. */
  readonly commonJsGlobals?: ReadonlyMap<string, CommonJsWrapperDeclaration>
  /** Exact loader spellings a host build maps into its native builtin registry. */
  readonly commonJsBuiltinModules?: ReadonlyMap<string, string>
  /** Exact source implementation for each canonical runtime builtin. */
  readonly commonJsBuiltinModuleSources?: ReadonlyMap<string, string>
  /**
   * Rewrites the installed plugins perform on a file's text before this program
   * parses it (`PluginInstance.transformSource`), in installation order.
   *
   * Threaded rather than known, like `producers` and `nativeTypes`: what a
   * library's own syntax means is the library's to say, and the one place
   * saying it can still change what the checker sees is before the parse.
   */
  readonly sourceTransforms?: readonly ((input: { readonly fileName: string; readonly text: string }) => string | null)[]
  /**
   * Whether the roots are JavaScript that carries its own types in JSDoc.
   *
   * Stated as a fact about the INPUT, not as a compiler-options passthrough:
   * `allowJs`/`checkJs` is how TypeScript spells it, and that spelling belongs
   * here, in the one layer allowed to name `typescript` at all. A caller
   * outside `semantics/` can say what its sources are; it cannot say how the
   * checker should be configured, because then two authorities would decide
   * what a program means.
   *
   * `checkJs` travels with `allowJs` and is not separable. Admitting a `.js`
   * root without checking it makes every JSDoc annotation invisible: the file
   * still compiles, every function becomes implicitly `any`, and a program that
   * is fully typed at its source turns into a boxed one with no diagnostic
   * saying why. The gea build pipeline's vite bundle is exactly this shape --
   * plain JS whose types are JSDoc plus a generated `.d.ts` reference -- so the
   * unchecked reading is never the one a caller wants.
   */
  readonly javaScriptSources?: boolean
  /** File text this compilation uses instead of what is on disk -- see `ProgramInput.sourceOverlay`. */
  readonly sourceOverlay?: ReadonlyMap<string, string>
  /** How each file's own import specifiers resolve -- see `ProgramInput.moduleResolution`. */
  readonly moduleResolution?: ReadonlyMap<string, ReadonlyMap<string, string>>
  /** Whether the caller stated the module set -- see `ProgramInput.statedModuleSet`. */
  readonly statedModuleSet?: boolean
  /** Caller-stated classic-script lexical realm boundary; see `ProgramInput.closedScriptScope`. */
  readonly closedScriptScope?: boolean
}

export interface FrontendResult {
  readonly dynamicFallbackTypes: ReadonlySet<StructuralTypeId>
  /** Object types written with values their declared fields cannot hold (`anyKeyedWriteTypes`); boxed in every mode. */
  readonly dynamicWrittenTypes: ReadonlySet<StructuralTypeId>
  /** Exact source functions whose own mutable Function-object table requires fallback storage. */
  readonly dynamicFallbackCallables: ReadonlySet<FunctionId>
  readonly graph: SemanticGraph
  readonly sourcePreparations: readonly DiagnosticSourcePreparationAudit[]
  /**
   * Declared types that are host handles rather than program-defined records.
   *
   * Only the frontend can answer this, because only the frontend can ask the
   * checker. It is not a lookup table of known names: `JSX.Element` is
   * whatever the checked program's own JSX namespace resolves it to, and the
   * checker is what resolves it -- exactly as it decides intrinsic-vs-component
   * from a tag's first character. A different program declaring a different
   * `JSX` namespace binds a different declaration, and a program with no JSX
   * binds nothing.
   */
  readonly hostProtocols: ReadonlyMap<DeclarationId, HostProtocolBinding>
  /** Standard well-known symbols, kept by declaration identity after their keys normalize to `sym(declaration)`. */
  readonly wellKnownSymbols: ReadonlyMap<DeclarationId, string>
  /**
   * The ABI name a host defines a cell under, for every ambient value this
   * program reads but never introduces -- an imported `mount`, a global
   * `Math`, a `declare const` in a framework's declaration file.
   *
   * `projectBindingPlacements` turns these into `BindingStorage.kind ===
   * 'external'`, which is the same placement an in-file `declare const`
   * already gets through `BindingOperation.external`. The two routes exist
   * because only one of them can: an in-file declaration is a census
   * candidate and publishes an introduction, while a declaration in a
   * declaration file is never walked at all, so nothing publishes one for it.
   */
  readonly externalBindings: ReadonlyMap<DeclarationId, string>
  /** Ambient declarations the installed host authenticated as CommonJS wrapper parameters. */
  readonly commonJsBindings: ReadonlyMap<DeclarationId, 'require' | 'exports' | 'module'>
  /** Ambient values authenticated as host singletons by complete declaration identity. */
  readonly hostSingletonBindings: ReadonlySet<DeclarationId>
  /** Namespace roots authenticated by their complete checker declaration identity. */
  readonly hostNamespaceBindings: ReadonlySet<DeclarationId>
  /**
   * Which of those an installed host declared it does NOT provide, so the
   * projection places a cell rather than an `extern`. See `absent-globals.ts`.
   */
  readonly absentBindings: ReadonlySet<DeclarationId>
  /**
   * Operations that sit inside a `typeof X !== 'undefined' && x instanceof X`
   * guard's consequent, where `X` resolves by symbol to a host-declared-absent
   * ambient value. See `dead-typeof-guards.ts` for the exact shape matched and
   * why this cannot be answered from any operand's type.
   */
  readonly deadTypeofGuards: DeadTypeofGuardCensus
  /**
   * Where a node identity is in the source, or `null` for one this program
   * has no node for.
   *
   * ⛔ DISPLAY ONLY, and the reason it lives here rather than being recomputed
   * by a reporter: identities are ORDINALS from `identities.ts`'s own
   * deterministic walk, not positions, so the only honest way back to a line
   * number is that same walk -- and this is the layer that has it. A reporter
   * that guessed would print a plausible file and line for the wrong node,
   * which is worse than printing none.
   *
   * The index is built on the FIRST call and only then: a compilation with a
   * clean sweep never asks, and pays nothing.
   */
  readonly locationOfNode: (node: NodeId) => DiagnosticLocation | null
  /**
   * `locationOfNode`'s twin for a DeclarationId (and so, through
   * `declarationOfFunction`, a FunctionId) -- a stage past the frontend that
   * never had a `ts.Node` to mint a NodeId from, only the identity a
   * `function-object` allocation or a declaration census already published.
   * ⛔ DISPLAY ONLY, for the same reason `locationOfNode` is: resolved through
   * the SAME position index, never a second one.
   */
  readonly locationOfDeclaration: (declaration: DeclarationId) => DiagnosticLocation | null
  /** The source text of a node identity, through the same walk as `locationOfNode`, for display only. */
  readonly textOfNode: (node: NodeId) => string | null
  /**
   * The file each of those declarations lives in.
   *
   * The name a host defines a cell under is not always enough to say *which*
   * cell: one host can declare the same name in two of its own files, meaning
   * two different things by it (Apple's `installRootView`, in UIKit and in
   * AppKit). The declaration is what tells them apart, and the file is the
   * coordinate a host states its own tables in -- so this carries it, and a host
   * with no such pair never looks at it.
   */
  readonly externalBindingFiles: ReadonlyMap<DeclarationId, string>
  /**
   * Which of those declarations the STANDARD LIBRARY declares, from
   * `SourceFile.hasNoDefaultLib` -- see `HostCensus.standardLibrary` for the
   * whole of why the distinction is needed and why that flag is the authority
   * rather than a file-path match.
   */
  readonly standardLibraryBindings: ReadonlySet<DeclarationId>
  /**
   * This program's module bodies, in the order ECMA-262 evaluates them.
   *
   * A module body is a region like any other, but unlike a function it is not
   * called by anything in the program: it RUNS, once, when the module graph is
   * evaluated. Nothing downstream of here could recover the order -- the graph
   * records each body's contents and its identity, not the import edges that
   * decide which runs first -- so the frontend, which has the checker and can
   * resolve a specifier to a file, is the only place that can state it.
   *
   * A target needs it to emit a program ENTRY: a `main`-shaped function that
   * runs the modules in order. Without one an emitted program is a set of
   * bodies nothing calls.
   */
  readonly moduleOrder: readonly RegionId[]
  /**
   * The file each identity segment names, for every compiled (non-declaration)
   * source file: `f12` -> its `fileName`.
   *
   * Display evidence, not authority. The identities themselves carry only the
   * index (`identities.ts`), and nothing downstream may decide anything from
   * the name -- it exists so a target that lays a program out as one
   * translation unit per source file can NAME those units after the files
   * whose bodies they hold, which is the one thing an index cannot do.
   */
  readonly sourceFileNames: ReadonlyMap<string, string>
  /**
   * Declared types that are one of the eight standard TypedArray view
   * interfaces, keyed by the *instance* type's declaration and valued by the
   * element width/encoding that view stores -- `Uint8Array`'s declaration
   * maps to `'uint8'`, `Int32Array`'s to `'int32'`, and so on. See
   * `typedArrayElementBindings` for how this is found.
   */
  readonly typedArrayElements: ReadonlyMap<DeclarationId, TypedArrayElementDomain>
  /**
   * The declaration identity of the standard library's own `Promise<T>`
   * interface, or `null` if this compilation's `lib` does not install one.
   * See `promiseDeclarationOf` for how this is found independent of whether
   * the program's own text ever names `Promise`.
   */
  readonly promiseDeclaration: DeclarationId | null
  /**
   * The declaration identity of the standard library's own `Date` interface,
   * or `null` if this compilation's `lib` does not install one. See
   * `dateDeclarationOf`; resolved for the same reason `promiseDeclaration` is.
   */
  readonly dateDeclaration: DeclarationId | null
  /**
   * The declaration identity of the standard library's own `String` WRAPPER
   * OBJECT interface (`new String(x)`), or `null` if this compilation's `lib`
   * does not install one. See `stringObjectDeclarationOf`; resolved for the
   * same reason `dateDeclaration` is.
   */
  readonly stringObjectDeclaration: DeclarationId | null
  readonly errorDeclarations: ReadonlySet<DeclarationId>
  /**
   * The declaration identity of the bare `Function` interface -- what
   * `typeof x === 'function'` narrows to and what `Object.prototype.constructor`
   * is declared as -- or `null` if this compilation's `lib` does not install
   * one. See `functionDeclarationOf`, and `FunctionDeclarationPolicy`
   * (representation/policies.ts) for why it is carried dynamically rather than
   * as a host handle.
   */
  readonly functionDeclaration: DeclarationId | null
  /**
   * Which classes each class inherits from, transitively. See
   * `classHeritageOf` (class-heritage.ts) and `ClassHeritagePolicy`
   * (representation/policies.ts) for the two carrier questions that need it.
   */
  readonly classHeritage: ReadonlyMap<DeclarationId, readonly DeclarationId[]>
  /**
   * The derived classes the program stores into each base class's constructor
   * slot -- see `constructorSlotSubclassesOf` (constructor-slot-subclasses.ts).
   */
  readonly constructorSlotSubclasses: ReadonlyMap<DeclarationId, readonly DeclarationId[]>
  /** The classes no evaluation can instantiate -- see `uninstantiableClassesOf` (uninstantiable-classes.ts). */
  readonly uninstantiableClasses: ReadonlySet<DeclarationId>
  /**
   * The one class this program declares as each interface's implementation --
   * see `interfaceImplementorsOf` (interface-implementors.ts) and
   * `InterfaceImplementorPolicy` (representation/policies.ts). Resolved here,
   * beside `classHeritage`, for the same reason: it reads `implements`
   * clauses, and nothing below the semantic layer may import `typescript`.
   */
  readonly interfaceImplementors: ReadonlyMap<DeclarationId, readonly DeclarationId[]>
  /**
   * The declaration identity of the standard library's own `Generator<T,
   * TReturn, TNext>` interface -- what a `function*` returns -- or `null` if
   * this compilation's `lib` does not install one. See
   * `generatorDeclarationOf`, and `GeneratorDeclarationPolicy`
   * (representation/policies.ts) for why only this one interface and not
   * `IterableIterator`/`Iterator`.
   */
  readonly generatorDeclaration: DeclarationId | null
  /**
   * The declaration identity of the standard `AsyncGenerator<T, TReturn,
   * TNext>` interface -- what an `async function*` returns. Carried as the
   * same cursor `generatorDeclaration` is; see `asyncGeneratorDeclarationOf`.
   */
  readonly asyncGeneratorDeclaration: DeclarationId | null
  /** The standard `MapIterator<T>` returned by `Map.prototype.entries()`. */
  readonly mapIteratorDeclaration: DeclarationId | null
  /**
   * The declaration identity of each standard `Map`/`Set`/`WeakMap`/`WeakSet`
   * interface this compilation's `lib` installs, valued by which family it is.
   * See `keyedCollectionDeclarationsOf` for why this is resolved by name
   * lookup rather than through the ambient-value census -- and for why the
   * census's own `Map` protocol binding is not the answer.
   */
  readonly keyedCollections: ReadonlyMap<DeclarationId, KeyedCollectionFamily>
  /**
   * The declaration identity of each standard `RegExp`/`RegExpExecArray`/
   * `RegExpMatchArray` interface this compilation's `lib` installs, valued by
   * which role it plays. See `regexpDeclarationsOf` for why this is resolved by
   * name lookup rather than through the ambient-value census -- a regexp
   * LITERAL names `RegExp` nowhere -- and for why the census's own `RegExp`
   * protocol binding is not the answer.
   */
  readonly regexpDeclarations: ReadonlyMap<DeclarationId, RegExpDeclarationKind>
  /**
   * The declaration identity of the standard `ArrayBuffer` and `DataView`
   * interfaces this compilation's `lib` installs -- see
   * `standardBufferDeclarationsOf` for why this is resolved by name against
   * the standard library rather than found through the ambient-value census
   * (which reaches `ArrayBuffer` and binds it as an OPAQUE host protocol).
   */
  readonly standardBuffers: ReadonlyMap<DeclarationId, StandardBufferKind>
  /**
   * The structural type of every host namespace ROOT this program names, to
   * the C++ type the host carries that root's object in -- see
   * `HostCensus.namespaceRoots` for why this one census answer is keyed by
   * structural type rather than by declaration, and
   * `representation/policies.ts`'s `HostNamespaceRootPolicy` for what reads it.
   */
  readonly hostNamespaceRoots: ReadonlyMap<StructuralTypeId, string>
  /** Errors TypeScript itself reports, translated out of the checker's vocabulary. */
  readonly checkerDiagnostics: readonly DiagnosticEvidence[]
  /** Conditional inference requirements rejected by the final shared host census. */
  readonly intrinsicProtocolDiagnostics: readonly DiagnosticEvidence[]
  readonly uninstalledFamilies: readonly OperationFamily[]
  /**
   * What each write-discovery census bound and why it refused the rest.
   *
   * Every one of the six censuses already keeps this accounting -- each states
   * `boundCount` and a `refusals` map over its own reason vocabulary -- and
   * until now none of it left `semantics/`. The consequence was measurable: a
   * campaign whose whole object is "which cell had no answer" could see only
   * the SYNTACTIC shape of a boxed carrier from outside, and had to re-derive
   * the census's reason by rebuilding a `ts.Program` beside the compiler and
   * guessing. Ranking work by a guessed root is how two rounds went to the
   * wrong place (`docs/DEFECT-PATTERNS.md` section 8).
   *
   * Reported, not judged: a refusal is often the CORRECT answer (a cell whose
   * write set is genuinely open must stay dynamic), so a count here is a
   * question to ask, never a defect by itself.
   */
  readonly censusAccounting: ReadonlyMap<string, CensusAccounting>
  /**
   * The frontend's evidence-policy tables: the six write-discovery
   * censuses above (`parameters`/`returns`/`local`/`field` bindings, plus
   * `collections` and `bags`), restated as evidence policies over one shared
   * `CellFacts` table -- see `normalize/cells/`. Computed alongside the
   * existing composition from the SAME inputs (`identities`, the settled
   * `valueFlow`, the reachable program), published here, and read by NOTHING
   * downstream yet: `structural.ts`'s `typeAt` chain still answers every
   * question above exactly as it does today. `agreement` is the instrument
   * this phase's gate needs -- per program, how many declarations this table
   * answers identically to that chain, how many differently, and how many
   * neither answers nor can be compared (a collection/bag fact, whose domains
   * are not yet ported -- see `normalize/cells/policies/index.ts`'s own
   * header for exactly why). Phase 4.2: `table.refusals` restates each
   * `twoOwnerClaims` row as a typed `CellRefusal` (`normalize/cells/model.ts`)
   * -- still read by nothing downstream, same as the rest of this table.
   */
  readonly cellFacts: CellFactsPublication
  /**
   * Nodes for which two of `normalize/structural.ts`'s rules both had an
   * answer -- the frontend's own finding channel.
   *
   * Empty unless `GEA_STRUCTURAL_DISAGREEMENT` is set. Forwarded here rather
   * than left on the mapper for the same reason `cellFacts` is: a script that
   * only wants to know what the rule set disagrees about should not have to
   * reach into a specialization view to find out.
   */
  readonly structuralDisagreements: readonly StructuralDisagreement[]
  /**
   * The copies of every generic class whose copies can differ in layout --
   * `StructuralMapper.classCopies`, read once typing is done and forwarded
   * to the deriver as its `ClassCopyPolicy`.
   */
  readonly classCopies: ReadonlyMap<DeclarationId, readonly ClassCopyKey[]>
  /**
   * Rules that answered outside their declared forms -- the 4.3 port's own
   * gate. Empty unless `GEA_STRUCTURAL_FORM_AUDIT` is set; non-empty means a
   * `forms` list is a false claim and some rule is being skipped for a form it
   * can really answer for.
   */
  readonly structuralFormViolations: readonly StructuralFormViolation[]
  /**
   * Every write-discovery refusal, typed and carrying the cell it is about.
   *
   * `parameters` is the COMPOSED view, so its list already carries the return,
   * local, field and JSDoc layers it wraps; only the two censuses that are not
   * in that chain are concatenated beside it. `compiler.ts` folds this into
   * `CompileResult.refusals`, which is the point of the exercise: until now a
   * census refusal was a number in a side table, and no caller asking "what did
   * this compilation refuse" could see one (the frontend is replaced, not instrumented).
   */
  readonly censusRefusals: readonly CensusRefusal[]
}

/** One census's own accounting of what it answered and what it declined. */
export interface CensusAccounting {
  /** Declarations this census gave a type to. */
  readonly bound: number
  /**
   * Why the rest were declined, counted by refusal ROOT.
   *
   * DERIVED from the census's typed refusal list rather than maintained beside
   * it (`censusRefusalCounts`). A count kept in parallel with the refusals it
   * counts is free to drift from them, which is the two-authorities defect this
   * refactor removes, in miniature. Read `FrontendResult.censusRefusals` when
   * the question is WHICH cell rather than how many.
   */
  readonly refusals: ReadonlyMap<string, number>
}

/**
 * The synthetic component every pre-graph diagnostic belongs to.
 *
 * A checker error happens before any authority component exists, so it cannot
 * name a real one. Inventing a plausible-looking component id instead would let
 * a reader join these rows against the graph and get an answer that is wrong.
 */
const checkerComponent = componentId('op|checker|reference|0' as Parameters<typeof componentId>[0])

/**
 * Checker errors the reachability walk relies on being reported wherever they
 * occur. `reachability.ts` drops a statement whose only possible effect is a
 * temporal-dead-zone throw because TypeScript reports a same-file use before
 * declaration; a pruned statement carrying one of these would otherwise lose
 * the throw silently.
 */
const reachabilityPremiseDiagnosticCodes: ReadonlySet<number> = new Set([2448, 2449, 2450, 2454, 2474])

/** The innermost node of `file` whose span holds `position`. */
const nodeAtPosition = (file: ts.SourceFile, position: number): ts.Node => {
  let current: ts.Node = file
  for (;;) {
    const inner: ts.Node | undefined = ts.forEachChild(current, (child) =>
      child.getStart(file) <= position && position < child.getEnd() ? child : undefined
    )
    if (!inner) return current
    current = inner
  }
}

/**
 * Whether a checker error sits in code the program never runs.
 *
 * A package compiled from source is type-checked against the dependency
 * versions this build resolved, not the ones its authors built with:
 * `@hono/node-server`'s `upgradeWebSocket` handler assigns an object literal
 * to hono's `WSContext`, whose newer source declares `#init`. The handler is
 * pruned (`reachability.ts`, a closure factory nothing reads) and none of its
 * types reach the compiled program, so its error describes nothing this
 * compiler emits. A syntax error is never waived, and neither is anything
 * outside a compiled source file or among the premises above.
 */
const diagnosticIsInPrunedCode = (
  diagnostic: ts.Diagnostic,
  reachable: ProgramReachability,
  compiledFiles: ReadonlySet<ts.SourceFile>,
  syntactic: ReadonlySet<ts.Diagnostic>
): boolean => {
  const file = diagnostic.file
  if (!file || diagnostic.start === undefined || syntactic.has(diagnostic) || !compiledFiles.has(file)) return false
  if (reachabilityPremiseDiagnosticCodes.has(diagnostic.code)) return false
  return !nodeIsReachable(reachable, nodeAtPosition(file, diagnostic.start))
}

const translateDiagnostic = (diagnostic: ts.Diagnostic, ordinal: number): DiagnosticEvidence => {
  const file = diagnostic.file
  const position = file && diagnostic.start !== undefined ? file.getLineAndCharacterOfPosition(diagnostic.start) : null
  return {
    id: `checker/${diagnostic.code}/${ordinal}`,
    component: checkerComponent,
    operation: null,
    missingPrimitive: null,
    message: ts.flattenDiagnosticMessageText(diagnostic.messageText, ' '),
    // Display only: this location never decides whether anything compiles.
    location: file && position ? { file: file.fileName, line: position.line + 1, column: position.character + 1 } : null
  }
}

/**
 * The declaration identities an installed host denied.
 *
 * The projection places a cell for every ambient declaration the frontend's own
 * census reached, and turns each into an `extern`. A name a host has said it
 * does not provide still needs a cell -- a program that reads it must read
 * something -- but it must not be an `extern`, because no object file defines
 * it. This is the set that tells the two apart, derived from the one census
 * that also answers the value's TYPE, so a cell cannot be external in one place
 * and absent in another. See `absent-globals.ts`.
 */
/**
 * Whether every file in this build evaluates strict regardless of its own
 * syntax. `alwaysStrict` -- implied by `strict` -- is the whole answer: it makes
 * tsc parse each file in strict mode and write a `'use strict'` prologue into
 * the emitted output, so node runs it strict whether it is a Module or a Script.
 *
 * The `module` setting is NOT this fact, though it stood here as one. `module:
 * ESNext` says how a MODULE is emitted; it does not make a file with no import
 * and no export into a module, and such a file is a Script and sloppy unless
 * something else says otherwise. Reading the module setting here answered
 * "strict" for every script in an ESM build and "sloppy" for every file in a
 * `module: CommonJS` build that set `strict: true` -- wrong in both directions.
 * The per-file half (external module, `'use strict'` prologue, class body) is
 * `isStrictContext`'s, and it already had it.
 */
const buildIsAlwaysStrict = (options: ts.CompilerOptions): boolean => options.alwaysStrict ?? options.strict ?? false

const absentBindingIds = (absent: AbsentGlobalCensus, identities: IdentityTable): ReadonlySet<DeclarationId> => {
  const denied = new Set<DeclarationId>()
  for (const declaration of absent.declarations) denied.add(identities.declarationIdOf(declaration))
  return denied
}

/**
 * Whether reachable, non-declaration code spells any of `names` -- the
 * `hostFunctions` of a host whose programs take the census wildcard
 * (`FrontendInput.hostFunctionsRefusingObjectPrototypeAbsenceProofs`). The
 * built-in plugins are installed for every compile, so the host's statement
 * alone would refuse the proofs for programs that never touch it; naming one
 * of its functions is what makes a program that host's. A name suffices: the
 * host owns those spellings, and the emitter treats a call by name as a call
 * into it.
 */
const reachableCodeNamesAny = (files: readonly ts.SourceFile[], reachable: ProgramReachability, names: ReadonlySet<string>): boolean => {
  if (names.size === 0) return false
  const visit = (node: ts.Node): boolean => (ts.isIdentifier(node) && names.has(node.text)) || ts.forEachChild(node, visit) === true
  return files.some((file) => !file.isDeclarationFile && reachable.statementsOf(file).some(visit))
}

export const runFrontend = (input: FrontendInput): FrontendResult => {
  const timing = createFrontendTiming('phases')
  const compiled = createProgram({
    ...(input.packageSources ? { packageSources: input.packageSources } : {}),
    ...(input.declarationModules ? { declarationModules: input.declarationModules } : {}),
    rootFileNames: input.rootFileNames,
    options: input.javaScriptSources
      ? // `maxNodeModuleJsDepth` alongside `allowJs` for the reason `program.ts`'s
        // `javaScriptAdmission` states: its default is `0`, which refuses a vendor
        // `.js` body one `node_modules` hop out from the compiled roots -- which is
        // where every one of them is. The corpus's own generated projects have
        // carried both for the same reason.
        { ...defaultCompilerOptions, allowJs: true, checkJs: true, maxNodeModuleJsDepth: 100 }
      : defaultCompilerOptions,
    dynamicFallback: input.dynamicFallback ?? false,
    projectFileName: input.projectFileName ?? null,
    ...(input.sourceOverlay ? { sourceOverlay: input.sourceOverlay } : {}),
    ...(input.moduleResolution ? { moduleResolution: input.moduleResolution } : {}),
    commonJsGlobals: input.commonJsGlobals ?? new Map(),
    commonJsBuiltinModules: input.commonJsBuiltinModules ?? new Map(),
    commonJsBuiltinModuleSources: input.commonJsBuiltinModuleSources ?? new Map(),
    hostMethodBindings: input.hostMethodBindings ?? new Map(),
    ...(input.statedModuleSet ? { statedModuleSet: true } : {}),
    ...(input.closedScriptScope ? { closedScriptScope: true } : {}),
    sourceTransforms: input.sourceTransforms ?? []
  })
  timing.mark('program-and-diagnostics')
  const hostMethodBindings = input.hostMethodBindings ?? new Map()
  const table = createStructuralTypeTable()
  // What this compilation reaches from its own entry points, decided once and
  // read by every whole-program walk below. A project's file set is not its
  // module graph -- `include` names what a typechecker should see, and an
  // application's behaviour is what its entries import -- so a census that
  // walked the file set compiled a different program than the one that runs.
  // See `reachability.ts` for what it refuses to prune and why; nothing here
  // changes what a type *means*, only which declarations are censused.
  const reachable = censusReachability({
    checker: compiled.checker,
    files: compiled.sourceFiles,
    // A CommonJS module is not an ESM entry: it runs only from its record's
    // `require`, so it must not join `moduleEvaluationOrder`.  Its body still
    // has to be censused and lowered for that record to invoke, which is why
    // the Program boundary supplies these static targets separately.
    entries: [...compiled.entryFiles, ...compiled.commonJsSourceFiles],
    ...(input.hostReachedMemberKeys ? { hostReachedMemberKeys: input.hostReachedMemberKeys } : {})
  })
  // Instantiations are censused before anything is normalized, because the
  // answer is whole-program: which type a generic is instantiated at is decided
  // by every call site together, and a walk that learned it as it went would
  // give the first body it reached a different answer than the last.
  timing.mark('reachability')
  const instantiations = censusInstantiations(compiled.checker, compiled.sourceFiles, reachable)
  // Before the mapper, because the mapper is the one authority that answers a
  // node's type and this contradicts the checker at some of those nodes.
  // Which property accesses are source-namespace paths and which are
  // namespace-qualified members: a checker question asked once, read by the
  // census's family rule and by `citeExpressionResult`'s prediction of it.
  // See `normalize/namespace-paths.ts`.
  const namespacePaths = censusNamespacePaths(compiled.checker)
  const specializations = censusSpecializations(compiled.checker, compiled.sourceFiles, reachable, namespacePaths)
  timing.mark('instantiations-and-specializations')
  // Whole-program for the same reason instantiations are: which type an
  // unannotated parameter holds is decided by every call site together, and a
  // walk that learned it as it went would give the first body it reached a
  // different answer than the last. See `parameter-bindings.ts`.
  // Composed with the RETURN census, in that order: a return type is resolved
  // from expressions whose identifiers may be parameters this census bound, so
  // the parameter answers must be settled before the return walk consults them.
  // The reverse edge -- a bound return re-opening a parameter's own fixpoint --
  // is not taken here; `parameter-bindings.ts` runs its own looser return
  // resolution inside that fixpoint already, so what this adds is the strict
  // reading (recursion detected, disagreement refused, `as` casts stopped at),
  // not a first one. See `return-bindings.ts`.
  // Composed a third time, with the LOCAL-BINDING census: an unannotated
  // `let`/`var` cell with no initializer, filled in later by exactly the
  // writes the program makes to it. See `local-bindings.ts`'s own header
  // comment for why this needs to run after (and be given) the settled
  // parameter+return census rather than reopening either fixpoint.
  //
  // Run TWICE. `censusParameterBindings` used to be the one census with no
  // upstream at all -- `withReturnBindings`/`withLocalBindings` compose OVER
  // its output, but nothing ever composed back INTO it, so a call site's
  // argument was typed only from the checker's own evidence and this
  // parameter census's own internal fixpoint. A parameter whose call sites
  // pass an expression the RETURN or LOCAL census alone can type (`state`,
  // `extensions`, `m.elements`) stayed `any` forever, because by the time
  // those censuses learned it, the parameter census had already finished.
  //
  // A second round, given the first round's fully composed census as its
  // `upstream`, closes that gap: `parameter-bindings.ts`'s `known()` now
  // tries `upstream.typeAt(node)` wherever the checker's own answer is
  // unusable, ahead of its own machinery reconstructing one. See the commit
  // this landed in for the measured effect on the three.js app and the
  // check for whether a third round moves anything further.
  //
  // `withFieldBindings` sits LAST in each round, where its own header says it
  // belongs. A class field is the fourth storage position with no annotation
  // and a knowable answer, and it was the one still unread: three.js writes
  // `this.image`, `this.format`, `this.colorSpace` in a constructor and never
  // types them, so every `texture.format` read is `any` and every parameter
  // that receives one inherits it. That is what the boxed carriers in
  // `WebGLTextures.js` (4435) and `WebGLRenderer.js` (3982) are made of -- not
  // thousands of independent decisions, but one unread position cascading
  // through reads and member accesses (14349 `Identifier`, 6836
  // `PropertyAccessExpression` across the three.js app).
  // `withJsDocTypeNames` sits OUTERMOST, so a type the program STATED outranks
  // one inferred from an observed sample of call sites -- the same precedence a
  // TS annotation already has, which stops the call-site census outright. It is
  // last in the chain and first to answer.
  //
  // The RETURN census built inside the final round is kept, not rebuilt.
  // `producers/invocations.ts` reads a call's result through this composed
  // view and has to state the same call's CALLEE return from the same
  // authority; asking a second census would let the two settle differently.
  // See `composeReturnBindings`.
  // The array/collection census, FOR THIS ROUND -- computed from the PRIOR
  // round's settled parameter view (`upstream`; empty on round one, since
  // nothing is settled yet) and handed to every census the round runs below,
  // not only to `createStructuralMapper` after the whole fixpoint has
  // already finished with it. This closes the gap `hCALL`'s investigation
  // traced end to end: `findLightProbeGrid( volumes, object )`
  // (`WebGLRenderer.js`) returns `volumes[ 0 ]`, where `volumes`'s real
  // evidence is a module-scope `const lightProbeGridArray = []` filled by
  // `.push` elsewhere -- exactly what this census exists to type, and
  // exactly the shape `return-bindings.ts` (and, the same way,
  // `local-bindings.ts`/`field-bindings.ts`) could not reach before, because
  // this census ran only once, after the whole fixpoint had already
  // settled. See those modules' own `collections` parameter.
  //
  // Kept OUTSIDE `compose` (rather than recomputed after the loop below from
  // the fully-settled `parameters`) so the FINAL round's instance -- the one
  // every census in that round actually asked -- is the SAME instance
  // `createStructuralMapper` is built from below. A fresh third computation
  // over `parameters` would answer some nodes MORE precisely (round two's
  // own improvements would be visible to it) but would then disagree with
  // what round two's own return/local/field censuses actually consulted
  // while producing `parameters` in the first place -- two authorities over
  // one question, which this compiler treats as a defect wherever it is
  // found elsewhere and must not introduce here.
  // Beside the collection census, for the same reason and on the same terms:
  // the LAST round's bag census, so the structural mapper reads the identical
  // instance the round-two return/local censuses consulted while they produced
  // `parameters`.
  // One shared discovery walk per inference view, consumed by the binding
  // domains. Syntax stays fixed; receiver protocols can become known as the
  // prior census improves, so the index is refreshed inside `compose`.
  /**
   * The round's census answer for an expression the CHECKER types `any` --
   * `indexValueFlow`'s one census-dependent input, and the reason the index is
   * now built per round rather than once.
   *
   * A `.push`/`.set`/`.fill` receiver is admitted by its TYPE
   * (`isArrayReceiver` and friends), so a receiver nothing has typed yet
   * records no write at all: three's `WebGLShaderCache` fills
   * `materialShaders` and `WebGLPrograms` fills its `array` through receivers
   * the checker cannot type, and every element they hold sat at a push this
   * index did not state. 170 such receivers on the three.js app.
   *
   * `any`/`unknown` is filtered here rather than in the index so that a census
   * answer no better than the checker's cannot displace it.
   */
  const censusTypeVia =
    (upstream: ParameterBindingCensus) =>
    (expression: ts.Expression): ts.Type | null => {
      const stated = upstream.typeAt(expression)
      if (!stated || (stated.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) !== 0) return null
      return stated
    }
  // Round one has no census, so its index is byte-identical to the single one
  // this replaced; the last round's is what `bags` below reads, since that
  // census is composed against the settled `parameters` and must see the same
  // write edges the census that settled it saw.
  const intrinsicProtocols = createDeferredIntrinsicProtocolLedger({
    refuseObjectPrototypeAbsenceProofs: reachableCodeNamesAny(
      compiled.sourceFiles,
      reachable,
      input.hostFunctionsRefusingObjectPrototypeAbsenceProofs ?? new Set()
    )
  })
  const buildIsStrict = buildIsAlwaysStrict(compiled.program.getCompilerOptions())
  const baseValueFlow = indexValueFlow(compiled.checker, compiled.sourceFiles, reachable, undefined, undefined, undefined, buildIsStrict)
  attachDeferredIntrinsicProtocolLedger(baseValueFlow, intrinsicProtocols)
  // Only a caller that compiled a module graph has stated what the
  // application IS; without it `exportIsUnimported` answers false everywhere.
  const statedModules: StatedModuleSet | null = input.statedModuleSet
    ? { files: compiled.sourceFiles, entries: [...compiled.entryFiles, ...compiled.commonJsSourceFiles], reachable }
    : null
  if (statedModules) attachStatedModuleSet(baseValueFlow, statedModules)
  const scriptScope: ClosedScriptScope | null = input.closedScriptScope
    ? {
        files: new Set(
          compiled.sourceFiles.filter(
            (file) => !file.isDeclarationFile && !ts.isExternalModule(file) && !compiled.commonJsSourceFiles.includes(file)
          )
        )
      }
    : null
  if (scriptScope) attachClosedScriptScope(baseValueFlow, scriptScope)
  // The whole program, declarations included: the census authenticates the
  // wrapper names against the host's declaration file, and handed only the
  // implementation files it found no wrapper to authenticate against, so no
  // module ever proved its record (`nativeRecord` was never set).
  const commonJsModuleRecords = censusCommonJsModuleRecords(
    compiled.checker,
    compiled.program.getSourceFiles(),
    input.commonJsGlobals ?? new Map(),
    compiled.runtimeModuleTargetOf,
    compiled.sourceFileOf
  )
  // This index retains syntax and checker facts from the initial flow view.
  // Unlike receiver protocol recognition in `valueFlow`, those do not change
  // between inference rounds. Parameter call attribution may still improve
  // within each round without rediscovering its syntactic inputs.
  // Discovery belongs to one census: inference and reference citation consume
  // the same lexical frames and never enumerate arguments uses independently.
  const argumentsObjects = censusArgumentsObjects(compiled.checker, compiled.sourceFiles)
  const parameterIndex = indexParameterBindingProgram(compiled.checker, compiled.sourceFiles, reachable, baseValueFlow, argumentsObjects)
  /**
   * Everything a round of `compose` builds besides the parameter census it is
   * settled on -- returned rather than assigned to captured `let`s, so which
   * round's instance every consumer below reads is a fact of the code and not
   * of whichever write survived the loop (the frontend's evidence-policy tables).
   *
   * They travel together because they must be USED together: each was built by
   * one round from one upstream view, and the return/local/field censuses of
   * that round consulted these exact instances while producing its parameter
   * census. Pairing a collection census from one round with a flow index from
   * another is precisely the two-authorities defect this compiler treats as a
   * bug everywhere else.
   */
  interface RoundFacts {
    readonly returns: ReturnBindingCensus
    readonly collections: CollectionBindingCensus
    readonly bags: ObjectBagCensus
    readonly valueFlow: ValueFlowIndex
  }

  const compose = (upstream?: ParameterBindingCensus): RoundCensus<RoundFacts> => {
    // Round one has no census to refine the index with, and
    // `GEA_FLOW_CENSUS_OFF` pins every round to that same base -- which is what
    // makes the flag's arm comparable with the one it measures against.
    // Rebuilt every round on purpose: reusing the previous round's index when
    // the census answers it consulted are unchanged was tried and measured on
    // the three.js app (2026-09-14) -- no round ever qualified, because the answers
    // move until the very round that settles, and holding the previous index
    // alive across the boundary raised the peak from 7 GB to 11 GB.
    const valueFlow =
      upstream && !process.env['GEA_FLOW_CENSUS_OFF']
        ? indexValueFlow(
            compiled.checker,
            compiled.sourceFiles,
            reachable,
            censusTypeVia(upstream),
            upstream.callDeclarationAt,
            upstream.callTargetsAt,
            buildIsStrict,
            upstream.explicitThisAt
          )
        : baseValueFlow
    attachDeferredIntrinsicProtocolLedger(valueFlow, intrinsicProtocols)
    if (statedModules) attachStatedModuleSet(valueFlow, statedModules)
    if (scriptScope) attachClosedScriptScope(valueFlow, scriptScope)
    const collectionsThisRound = censusCollectionBindings(
      compiled.checker,
      compiled.sourceFiles,
      reachable,
      upstream ?? emptyParameterBindingCensus,
      valueFlow
    )
    // MOVED INSIDE the fixpoint, exactly as `collections` was, and the long
    // comment that used to sit below this loop explaining why it could not be
    // was WRONG. It argued that a bag's answer is an `ObjectBagShape` with no
    // `ts.Type` form, so no `ts.Type`-shaped resolver could ever consume one.
    // True of the SHAPE and false of the SLOTS: a member's and an index's
    // observed types are plain `ts.Type`s (`ObjectBagShape.members` and
    // `.index` hold them), which is what `slotTypeAt` hands back.
    //
    // The refusal that bought: three's `WebGLExtensions` caches every
    // extension in a `{}` and reads it straight back, so
    // `return extensions[ name ]` refused as `return-index-signature-absent`
    // while this census had already typed the index from the very next line's
    // `extensions[ name ] = extension`. Everything downstream of
    // `extensions.get( ... )` -- `WebGLUtils.convert`'s `extension`, the
    // largest single boxed declaration in the three.js build -- was dynamic
    // behind that one refusal.
    const bagsThisRound = process.env['GEA_BAG_OFF']
      ? emptyObjectBagCensus
      : censusObjectBagBindings(compiled.checker, compiled.sourceFiles, reachable, upstream ?? emptyParameterBindingCensus, valueFlow)
    const returnStage = composeReturnBindings(
      compiled.checker,
      compiled.sourceFiles,
      reachable,
      censusParameterBindings(
        compiled.checker,
        compiled.sourceFiles,
        reachable,
        upstream,
        // `GEA_PARAM_INDEX_OFF` hands the census no index, so it builds its
        // own -- which is what every round used to do. Kept the way
        // `GEA_BAG_OFF` and `GEA_FLOW_CENSUS_OFF` are kept: the arms of the
        // measurement that justified this have to stay runnable from one
        // build, or the next person cannot check the claim.
        process.env['GEA_PARAM_INDEX_OFF'] ? undefined : parameterIndex,
        valueFlow
      ),
      collectionsThisRound,
      valueFlow,
      bagsThisRound
    )
    const parameters = withJsDocTypeNames(
      compiled.checker,
      compiled.sourceFiles,
      reachable,
      withFieldBindings(
        compiled.checker,
        compiled.sourceFiles,
        reachable,
        withLocalBindings(
          compiled.checker,
          compiled.sourceFiles,
          reachable,
          returnStage.view,
          collectionsThisRound,
          valueFlow,
          bagsThisRound,
          upstream,
          commonJsModuleRecords
        ),
        collectionsThisRound,
        valueFlow
      )
    )
    return { parameters, facts: { returns: returnStage.returns, collections: collectionsThisRound, bags: bagsThisRound, valueFlow } }
  }
  /**
   * What the CHECKER answers, at one line of the TRANSFORMED source.
   *
   * `GEA_TYPE_AT=<file substring>#<line>` prints every identifier and member
   * access on that line with its type and the file:line of each declaration
   * its symbol resolves to; `GEA_SRC_SPAN=<from>-<to>` beside it prints the
   * transformed text itself.
   *
   * Both halves are load-bearing and neither is available anywhere else. The
   * source transforms (`declaration-overlay-transform.ts`,
   * `subclass-member-overlay-transform.ts`, `this-constructor-source-transform.ts`)
   * REWRITE the text every census then reads, so a line number from a compass
   * names a position in a file that exists only in memory, and the type at it
   * is not the type the same line has on disk. The DECLARATION list is what
   * turns a wrong type into a located defect: `Object3D.parent` reading back
   * `boolean | undefined` says nothing until the symbol is seen resolving to
   * `EventDispatcher.js`, at which point the whole class of defect
   * (a synthesized field on a base shadowing every declarer's own `@type`) is
   * visible at once. Two commits came out of exactly that.
   */
  if (process.env['GEA_TYPE_AT']) {
    const [want, lineText] = String(process.env['GEA_TYPE_AT']).split('#')
    const wantLine = Number(lineText)
    for (const file of compiled.sourceFiles) {
      if (!file.fileName.includes(String(want))) continue
      if (process.env['GEA_SRC_SPAN']) {
        const [a, b] = String(process.env['GEA_SRC_SPAN']).split('-').map(Number)
        const lines = file.getFullText().split('\n')
        for (let i = (a ?? 1) - 1; i < Math.min(b ?? 0, lines.length); i++) process.stderr.write(`[SRC] ${i + 1}| ${lines[i]}\n`)
      }
      const visit = (node: ts.Node): void => {
        const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1
        if (line === wantLine && (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node))) {
          const sym = compiled.checker.getSymbolAtLocation(node)
          const decls = (sym?.declarations ?? [])
            .map((d) => {
              const f = d.getSourceFile()
              return `${f.fileName.split('/').slice(-2).join('/')}:${f.getLineAndCharacterOfPosition(d.getStart()).line + 1}`
            })
            .join(',')
          process.stderr.write(
            `[TYPE] ${line} ${ts.SyntaxKind[node.kind]} ${node.getText().slice(0, 40)} :: ${compiled.checker.typeToString(compiled.checker.getTypeAtLocation(node))} @[${decls}]\n`
          )
        }
        ts.forEachChild(node, visit)
      }
      visit(file)
    }
  }
  // A round is settled only when its actual input queries retain their answers.
  // A stable count alone can hide changed carriers or a same-size swap of cells.
  const settled = settleBindingCensus(compose)
  timing.mark('binding-fixpoint')
  if (process.env['GEA_ROUNDS_DEBUG'])
    process.stderr.write(`[ROUNDS] ${settled.round} rounds, boundCount ${settled.parameters.boundCount}\n`)
  const parameters: ParameterBindingCensus = settled.parameters
  // Every one of these is the SETTLING round's own instance, which is what the
  // snapshot exists to guarantee: the structural mapper below and the censuses
  // that produced `parameters` are looking at the identical answers.
  const { collections, bags, valueFlow } = settled.facts
  // The census belonging to the round `parameters` is, which is the one
  // `types` (and therefore every `typeAt`) answers from.
  const returns: ReturnBindingCensus | null = settled.facts.returns
  const absent = censusAbsentGlobals(
    compiled.checker,
    compiled.sourceFiles,
    input.absentGlobals ?? new Set(),
    platformDeclarationTest(compiled.program),
    namespacePaths
  )
  // Beside `argumentsObjects`, and for the identical reason: the reference
  // producer publishes an unresolvable name's value and `citeExpressionResult`
  // predicts it, so both must read one census rather than ask the checker
  // twice. See `unresolvable-names.ts`.
  const unresolvableNames = censusUnresolvableNames(compiled.checker, compiled.sourceFiles)
  const identities = createIdentityTable(compiled.program, compiled.checker, specializations)
  const prototypeReparentings = prototypeReparentingsOf(compiled.checker, identities, compiled.sourceFiles)
  // Beside `absent` and `identities`, the two facts this rests on: which host
  // globals are declared absent, and how to name the AST positions the answer
  // covers. See `dead-typeof-guards.ts` for why this cannot be derived from
  // any type -- a structural `never` here would collapse to the same id as a
  // TypeScript inference's own `never`, so the proof has to come from the
  // guard's own shape and the host's own statement instead.
  const deadTypeofGuards = censusDeadTypeofGuards(compiled.sourceFiles, absent, identities)
  // The array/collection census now runs INSIDE the fixpoint above (see
  // `compose`'s own comment) rather than once more here over the settled
  // parameter census. `settled.facts.collections` already IS the instance computed
  // from round one's settled view and consulted by round two's own
  // parameter/return/local/field censuses while they produced `parameters`
  // -- reusing it rather than recomputing keeps the mapper and the fixpoint's
  // own censuses looking at the identical answer for the identical question.
  // On the three.js app it binds 10 collections and 40 empty array literals whose
  // element type TypeScript inferred as `never`, same totals as the
  // once-recomputed version -- the round-two view this reuses already had
  // round one's settled parameter census as its own upstream, which is the
  // same evidence a fresh recomputation over `parameters` would have added.
  // Beside `collections`, and now on the same terms: the instance the LAST
  // round of `compose` computed and handed to that round's own return and
  // local censuses. An open property bag (`{}` filled a property at a time) is
  // a storage position the checker types as the EMPTY object, so every write
  // to it is a write the type does not have and every touch boxes. See
  // `object-bag-bindings.ts`.
  //
  // Reusing rather than recomputing is the same two-authorities argument
  // `collections` above states: a fresh census over the fully settled
  // `parameters` would answer some nodes more precisely than the one those
  // censuses actually consulted, and the mapper would then disagree with the
  // view that produced the bindings it is mapping.
  if (process.env['GEA_BINDING_DEBUG']) {
    process.stderr.write(
      `[BINDINGS] bound=${parameters.boundCount} refusals=${JSON.stringify([...censusRefusalCounts(parameters.refusals)])}\n`
    )
    process.stderr.write(parameters.debugReport?.() ?? '')
  }
  if (process.env['GEA_BAG_DEBUG']) {
    process.stderr.write(`[BAG] bound=${bags.boundCount} refusals=${JSON.stringify([...censusRefusalCounts(bags.refusals)])}\n`)
    process.stderr.write(bags.debugReport())
  }
  // The CENSUS half of `GEA_TYPE_AT`: what the settled binding census answers
  // for the same nodes the checker half printed above. A store the emitter
  // refuses names a carrier the checker's `[TYPE]` line does not show -- a
  // `typeof`-narrowed `string` read that reaches the field as a number is a
  // disagreement between these two lines, and only seeing both locates it.
  if (process.env['GEA_TYPE_AT']) {
    const [want, lineText] = String(process.env['GEA_TYPE_AT']).split('#')
    const wantLine = Number(lineText)
    for (const file of compiled.sourceFiles) {
      if (!file.fileName.includes(String(want))) continue
      const visit = (node: ts.Node): void => {
        const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1
        if (line === wantLine && (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node) || ts.isVariableDeclaration(node))) {
          const answer = parameters.typeAt(node)
          const stated = parameters.statedTypeAt(node)
          const arms = parameters.unionArmsAt(node)
          process.stderr.write(
            `[CENSUS] ${line} ${ts.SyntaxKind[node.kind]} ${node.getText().slice(0, 40)} :: ` +
              `${answer ? compiled.checker.typeToString(answer) : '(null)'} stated=${stated ? compiled.checker.typeToString(stated) : '-'}` +
              `${arms ? ` arms=[${arms.map((arm) => compiled.checker.typeToString(arm)).join(' | ')}]` : ''}\n`
          )
        }
        ts.forEachChild(node, visit)
      }
      visit(file)
    }
  }
  // Before the mapper, which lays every family member out as the one layout
  // this census names -- see `interface-families.ts`.
  const interfaceFamilies = interfaceFamiliesOf(compiled.checker, identities, compiled.sourceFiles)
  if (process.env['GEA_FAMILY_DEBUG']) {
    for (const family of interfaceFamilies.families) {
      process.stderr.write(`[FAMILY] ${family.key}: ${family.members.map((member) => member.name.text).join(' ')}\n`)
    }
  }
  // Descriptor input facts become usable only after the existing mutation
  // census seals this shared set. Its rawTypeAt input bypasses structural
  // descriptor inference, so this introduces no inference cycle.
  const globalHostMutationTaint = new HostMutationTaint()
  let hostMutationFactsSealed = false
  const intrinsicPropertyContext = {
    checker: compiled.checker,
    identities,
    isStandardLibraryDeclaration: (declaration: ts.Declaration) => compiled.program.isSourceFileDefaultLibrary(declaration.getSourceFile()),
    globalHostMutationTaint
  }
  const types = createStructuralMapper(
    compiled.checker,
    identities,
    table,
    instantiations,
    specializations,
    parameters,
    absent,
    collections,
    bags,
    valueFlow,
    interfaceFamilies,
    commonJsModuleRecords,
    censusDeclaredMembers(compiled.checker, compiled.sourceFiles, identities, (body) => bodyReadsThis(body), reachable),
    (call) =>
      hostMutationFactsSealed && intrinsicPropertyCallOf(intrinsicPropertyContext, call, call.expression) === 'getOwnPropertyDescriptor'
  )
  // The frontend's evidence-policy tables: built from the same
  // `identities`/`valueFlow`/`reachable` the fixpoint above already settled,
  // right after `types` exists so the agreement instrument can ask the
  // mapper's own `typeAt`/`typeOf` for the SAME declarations while both are
  // still in scope -- nowhere else in this function has both at once without
  // recomputing one of them. Additive only: nothing here reads from or writes
  // into `parameters`/`returns`/`collections`/`bags`, and nothing downstream
  // reads `cellFacts` back, so this cannot change what any of those censuses,
  // or `types` itself, answer.
  const cellFacts = publishCellFacts(
    buildCellFactsTable(
      identities,
      valueFlow,
      compiled.sourceFiles,
      createCellPolicyRegistry(defaultCellEvidencePolicies(compiled.checker, reachable, bags.identity))
    ),
    types,
    // Only when asked -- see `cells/agreement.ts` for why an unasked `typeAt`
    // renumbers the emitted C++.
    Boolean(process.env['GEA_CELL_FACTS_AGREEMENT'])
  )
  if (process.env['GEA_CELL_FACTS_DEBUG']) {
    process.stderr.write(
      `[CELLS] declarations=${cellFacts.table.all.length} twoOwner=${cellFacts.table.twoOwnerClaims.length} ` +
        `refusals=${cellFacts.table.refusals.length} agreement=${JSON.stringify(cellFacts.agreement)}\n`
    )
  }
  // The STRUCTURAL half of `GEA_TYPE_AT`: the mapper's own answer, which is
  // what every producer publishes -- a `[CENSUS]` union-arms line and a
  // `[STRUCT]` line that disagree locate a reduction between the two.
  if (process.env['GEA_TYPE_AT']) {
    const [want, lineText] = String(process.env['GEA_TYPE_AT']).split('#')
    const wantLine = Number(lineText)
    for (const file of compiled.sourceFiles) {
      if (!file.fileName.includes(String(want))) continue
      const visit = (node: ts.Node): void => {
        const line = file.getLineAndCharacterOfPosition(node.getStart()).line + 1
        if (line === wantLine && (ts.isIdentifier(node) || ts.isPropertyAccessExpression(node))) {
          let shape = '(throws)'
          try {
            shape = structuralShapeKey(table.get(types.typeAt(node)).shape)
          } catch {}
          process.stderr.write(`[STRUCT] ${line} ${ts.SyntaxKind[node.kind]} ${node.getText().slice(0, 40)} :: ${shape.slice(0, 600)}\n`)
        }
        ts.forEachChild(node, visit)
      }
      visit(file)
    }
  }
  const prototypeFallback = input.dynamicFallback
    ? prototypeMutatedConstructorTypes(compiled.sourceFiles, compiled.checker, types, identities)
    : { types: new Set<StructuralTypeId>(), callables: new Set<FunctionId>() }
  const dynamicFallbackTypes = input.dynamicFallback
    ? new Set<StructuralTypeId>([...proxyFallbackTypes(compiled.sourceFiles, compiled.checker, types), ...prototypeFallback.types])
    : new Set<StructuralTypeId>()
  const dynamicWrittenTypes = anyKeyedWriteTypes(compiled.sourceFiles, compiled.checker, types)
  const census = censusProgram(compiled.sourceFiles, identities, reachable, specializations, namespacePaths)
  // Before normalization, not after: the table seals when the graph does, and a
  // census that interns a type it is the first to ask about would be asking a
  // sealed table to grow. The types are the same either way -- interning is
  // idempotent and the element producer asks for exactly these -- so the only
  // thing the order decides is whether this runs against a table that can still
  // answer.
  //
  // Also before `context` is built (not after, as this used to run): a
  // producer -- `calleeAwareTypeAt`, `producers/shared.ts` -- reads this same
  // census through `context.hostProtocols` to tell whether a call's callee is
  // a bound declaration before deciding whether to read back the checker's
  // resolved-signature type or the plain one, so the map has to already exist
  // (even if still empty) when the `context` object below captures a
  // reference to it. Population still happens right after, and because
  // `context.hostProtocols` holds the SAME map instance -- never a copy --
  // every producer sees it fully populated by the time `normalizeProgram`
  // actually calls any of them.
  const hosts: HostCensus = {
    protocols: new Map(),
    externals: new Map(),
    externalFiles: new Map(),
    namespaceRoots: new Map(),
    standardLibrary: new Set(),
    commonJsBindings: new Map(),
    commonJsProvenanceFailures: new Set(),
    hostSingletonBindings: new Set(),
    hostNamespaceBindings: new Set()
  }
  // Resolved before `context` is built, unlike the two host censuses above:
  // this one is a pure name lookup with no walk to populate it, so it can be
  // complete up front rather than shared-by-reference and filled in after.
  // One authority, two readers -- `derive.ts`'s carrier policy (through
  // `compiler.ts`) and the iteration producers below, which have to agree
  // about which sources take the native-cursor path.
  const keyedCollections = keyedCollectionDeclarationsOf(compiled.checker, identities, compiled.sourceFiles)
  // The same shape of fact as `keyedCollections`, with the same two readers
  // that must agree: `derive.ts`'s `GeneratorDeclarationPolicy` (through
  // `compiler.ts`) decides that a `Generator<T, ...>` IS the cursor carrier,
  // and `producers/shared.ts`'s `isNativeIterableGeneratorType` decides that a
  // `for`-`of` over one skips the `@@iterator` lookup. Resolving it twice would
  // let one side take the fast path for a declaration the other did not
  // recognise.
  const generatorDeclarationEarly = generatorDeclarationOf(compiled.checker, identities, compiled.sourceFiles)
  const asyncGeneratorDeclarationEarly = asyncGeneratorDeclarationOf(compiled.checker, identities, compiled.sourceFiles)
  const mapIteratorDeclarationEarly = mapIteratorDeclarationOf(compiled.checker, identities, compiled.sourceFiles)
  const standardBuffers = standardBufferDeclarationsOf(compiled.checker, identities, compiled.sourceFiles)
  const wellKnownSymbols = wellKnownSymbolDeclarationsOf(compiled.checker, identities, compiled.sourceFiles)
  // A computed write key narrowed to a proven finite set -- three's
  // `this[ key ] = newValue` in `Material.setValues`/`Texture.setValues`. Built
  // once and shared by BOTH readers that must agree it proves the same thing:
  // the global-host-mutation census below (which narrows a WRITE's taint) and
  // `computedKeyTextsOf` a few lines down (which narrows a `get`/`set`
  // operation's REFLECTION demand, `ir/reflection-demand.ts`).
  // `GEA_HOST_CENSUS_KEY_SETS_OFF` keeps every computed key unknown for both.
  const computedKeysOf = process.env['GEA_HOST_CENSUS_KEY_SETS_OFF']
    ? undefined
    : createCensusComputedKeysOf(
        compiled.checker,
        valueFlow,
        closedCallableAuthorityOf(
          compiled.checker,
          valueFlow,
          (expression) => types.rawTypeAt(expression),
          (declaration) => argumentsObjects.usesByOwner.get(declaration)
        )
      )
  // `Object.prototype`'s own declaration identity, resolved once: the anchor
  // `computedKeyTextsOf` below checks the for-in arm's "Object.prototype
  // carries no enumerable key" assumption against -- the same identity
  // `global-host-mutations.ts`'s own `objectPrototypeKeysOf` resolves.
  const objectPrototypeDeclaration: DeclarationId | null = (() => {
    const anchor = compiled.sourceFiles[0]
    const objectSymbol = anchor ? compiled.checker.resolveName('Object', anchor, ts.SymbolFlags.Value, false) : undefined
    const prototype =
      objectSymbol && anchor ? compiled.checker.getTypeOfSymbolAtLocation(objectSymbol, anchor).getProperty('prototype') : undefined
    return prototype ? identities.symbolDeclarationId(prototype) : null
  })()
  // Memoized by node identity: this is a whole-program proof
  // (`computed-key-set.ts`), and `keyOf` in `producers/properties.ts` asks
  // this hook once per element-access candidate across every specialization
  // copy that reaches it -- an unmemoized re-proof per copy is exactly the
  // mistake that once turned a 32s compile into 746s (see
  // `geatsc-escape-proof-needs-memoized-predicates` in project memory).
  const provenKeyTextsCache = new Map<ts.Expression, readonly string[] | null>()
  /**
   * `ProducerContext.computedKeyTextsOf` -- see that field's own comment for
   * the contract. `computedKeysOf` above proves a TENTATIVE key set under
   * intrinsic assumptions it cannot discharge by itself
   * (`createCensusComputedKeysOf`'s own header explains why); this is what
   * actually discharges them, against the FINAL sealed
   * `globalHostMutationTaint` -- never the mid-fixed-point state the mutation
   * census below iterates through on its way there. Guarded on
   * `hostMutationFactsSealed` (false until the call below completes) so a
   * caller that somehow reached this before sealing gets the same "not
   * proven" answer a refused proof gives, never a stale one built on an
   * incomplete census.
   */
  const computedKeyTextsOf = (key: ts.Expression): readonly string[] | null => {
    if (!hostMutationFactsSealed) return null
    const cached = provenKeyTextsCache.get(key)
    if (cached !== undefined) return cached
    const compute = (): readonly string[] | null => {
      if (!computedKeysOf) return null
      const answer = computedKeysOf(key)
      if (!answer) return null
      // Whatever the proof leaned on `Object.keys`/the Array iteration
      // protocol staying intact: checked against the sealed census exactly as
      // `censusGlobalHostMutations`'s own final check does (see that file's
      // `assumptionFailed`), never assumed because the proof assumed it.
      if (answer.requirements.length > 0 && failedIntrinsicProtocolRequirements(intrinsicPropertyContext, answer.requirements).length > 0) {
        return null
      }
      const keys = new Set(answer.keys)
      if (answer.inheritsObjectPrototypeKeys) {
        const surface = globalHostMutationTaint.surfaceKeys
        // `every`/`numeric` on the surface or on Object.prototype's own
        // record means the for-in arm's "Object.prototype carries no
        // enumerable key" assumption did NOT survive: some write this
        // program made could put any name (or an unbounded numeric one) on
        // Object.prototype -- exactly the "may have grown an arbitrary
        // property" case this whole mechanism exists to rule out. Refuse
        // rather than publish a set the language does not actually bound.
        if (globalHostMutationTaint.has('*') || surface.every || surface.numeric) return null
        const own = objectPrototypeDeclaration === null ? undefined : globalHostMutationTaint.keysOf(objectPrototypeDeclaration)
        if (own?.every || own?.numeric) return null
        for (const name of surface.names) keys.add(name)
        for (const name of own?.names ?? []) keys.add(name)
      }
      return [...keys]
    }
    const result = compute()
    provenKeyTextsCache.set(key, result)
    return result
  }
  const context: ProducerContext = {
    isStandardLibraryDeclaration: (declaration) => compiled.program.isSourceFileDefaultLibrary(declaration.getSourceFile()),
    hostMethodOf: (node) => resolveHostMethod(compiled.checker, hostMethodBindings, node),
    computedKeyTextsOf,
    numericIndexAbsenceProvenAt: (receiver, key) => {
      if (!hostMutationFactsSealed) return false
      const proof = intrinsicProtocols.capture(() =>
        numericIndexAbsenceProven(
          compiled.checker,
          valueFlow,
          compiled.checker.getNonNullableType(types.rawTypeAt(receiver)),
          types.rawTypeAt(key)
        )
      )
      // Inference records provisional obligations; operation production runs
      // after the shared mutation census has sealed and discharges them now.
      return proof.value && failedIntrinsicProtocolRequirements(intrinsicPropertyContext, proof.requirements).length === 0
    },
    closedLiteralMemberAbsenceProvenAt: (receiver, name) => {
      if (!hostMutationFactsSealed) return false
      const proof = intrinsicProtocols.capture(() =>
        closedLiteralMemberAbsenceProven(
          compiled.checker,
          valueFlow,
          compiled.checker.getNonNullableType(types.rawTypeAt(receiver)),
          name,
          receiver
        )
      )
      // Same rule as `numericIndexAbsenceProvenAt`: the proof is provisional
      // until the shared mutation census seals, and is discharged against it
      // here rather than assumed from its own inference-time capture.
      return proof.value && failedIntrinsicProtocolRequirements(intrinsicPropertyContext, proof.requirements).length === 0
    },
    checker: compiled.checker,
    identities,
    types,
    // Read from the build. Every module setting except `None`/`CommonJS`
    // compiles ES modules, and an ES module is strict whole -- so this is a
    // fact about the build, not about any one file's syntax.
    buildIsStrict,
    table,
    ordinals: createOrdinalCounter(),
    evaluationOrdinals: createEvaluationOrdinals(),
    // Overridden per candidate below (`path: candidate.specialization`) --
    // `rootSpecialization` here is only to satisfy the type on this shared
    // base object, which is never read from directly as a producer context.
    path: rootSpecialization,
    specializations,
    hostProtocols: hosts.protocols,
    hostSingletonBindings: hosts.hostSingletonBindings,
    hostNamespaceBindings: hosts.hostNamespaceBindings,
    globalHostMutationTaint,
    prototypeReparentings,
    dynamicFallbackTypes,
    commonJsBindings: hosts.commonJsBindings,
    commonJsProvenanceFailures: hosts.commonJsProvenanceFailures,
    commonJsRequire: createCommonJsRequireCensus(compiled.checker, compiled.program.getSourceFiles(), input.commonJsGlobals ?? new Map()),
    commonJsModuleRecords,
    builtinModuleNameOf: (specifier) => input.commonJsBuiltinModules?.get(specifier) ?? null,
    builtinModuleSourceOf: (name) => input.commonJsBuiltinModuleSources?.get(name) ?? null,
    runtimeModuleTargetOf: compiled.runtimeModuleTargetOf,
    sourceFileOf: compiled.sourceFileOf,
    absentGlobals: absent,
    argumentsObjects,
    unresolvableNames,
    reassignedBindings: createReassignedBindingCensus(compiled.checker, valueFlow),
    namespacePaths,
    keyedCollections,
    collections,
    bags,
    parameters,
    generatorDeclaration: generatorDeclarationEarly,
    asyncGeneratorDeclaration: asyncGeneratorDeclarationEarly,
    mapIteratorDeclaration: mapIteratorDeclarationEarly,
    ...(returns ? { returns } : {})
  }
  const hostInput: HostProtocolInput = {
    checker: compiled.checker,
    identities,
    files: compiled.sourceFiles,
    census: census.candidates,
    types,
    table,
    nativeTypes: input.nativeTypes ?? new Map(),
    nativeTypesByDeclaration: input.nativeTypesByDeclaration ?? new Map(),
    hostSingletonDeclarations: input.hostSingletonDeclarations ?? new Map(),
    hostNamespaceRoots: input.hostNamespaceRoots ?? new Set(),
    hostNamespaceRootDeclarations: input.hostNamespaceRootDeclarations ?? [],
    hostNamespacePaths: input.hostNamespacePaths ?? new Set(),
    hostNamespaceRootTypes: input.hostNamespaceRootTypes ?? new Map(),
    commonJsGlobals: input.commonJsGlobals ?? new Map(),
    commonJsDeclarationFiles: [
      ...new Set(
        [...(input.commonJsGlobals ?? new Map()).values()].flatMap((entry) => {
          const file = compiled.sourceFileOf(entry.declarationFileName)
          return file ? [file] : []
        })
      )
    ],
    namespacePaths,
    isIntrinsicGlobalThis: unresolvableNames.isIntrinsicGlobalThis
  }
  const typedArrayElements = new Map<DeclarationId, TypedArrayElementDomain>()
  hostProtocolBindings(hostInput, hosts)
  ambientHostBindings(hostInput, hosts, typedArrayElements)
  // The nine typed-array INSTANCE interfaces, resolved by name and unioned
  // over whatever the seed walk above already found. Unconditional, because a
  // program can hold a typed array without ever naming one -- see
  // `typedArrayDeclarationsOf`. The two agree wherever both answer; this one
  // also answers where the walk has no seed.
  for (const [declaration, domain] of typedArrayDeclarationsOf(
    compiled.checker,
    identities,
    compiled.sourceFiles,
    compiled.program,
    input.hostTypedArrayDeclarations ?? []
  )) {
    typedArrayElements.set(declaration, domain)
  }
  // After the ambient census, deliberately: a standard-library class the
  // census already bound weakly (as a structural body, or as a protocol with
  // no carrier) must end up on the backend's own carrier, not beside it. See
  // `bindStandardClasses`.
  bindStandardClasses(hostInput, hosts, input.standardClasses ?? new Set())
  const hostGlobalBindings = new Set<DeclarationId>([...hosts.hostSingletonBindings, ...hosts.hostNamespaceBindings])
  // The mutation census must see the exact identities whose representation
  // policy carries them outside `globalThis`: typed-array instances and native
  // host handles.  Passing identities, rather than spelling names in the
  // census, keeps a caller declaration or merged ambient symbol from acquiring
  // this proof.
  const nativeReceiverDeclarations = new Set<DeclarationId>(typedArrayElements.keys())
  for (const [declaration, binding] of hosts.protocols) if (binding.native !== null) nativeReceiverDeclarations.add(declaration)
  const nativeReceiverSymbols = new Set<ts.Symbol>()
  const nativeConstructorSymbols = new Set<ts.Symbol>()
  // `bindStandardClasses` publishes the carrier policy, while the mutation
  // census needs the checker's instance identity at each call result. Resolve
  // that identity again from the policy's own names so an unmentioned class is
  // still proven (and a caller declaration with the same spelling is not).
  const receiverAnchor = compiled.sourceFiles[0]
  if (receiverAnchor) {
    for (const name of [...typedArrayInstanceInterfaceNames, ...(input.standardClasses ?? [])]) {
      const symbol = compiled.checker.resolveName(name, receiverAnchor, ts.SymbolFlags.Interface, false)
      const typedArray = typedArrayInstanceInterfaceNames.includes(name)
      if (
        !symbol ||
        (!typedArray &&
          (!symbol.declarations?.length || !symbol.declarations.every((declaration) => declaration.getSourceFile().hasNoDefaultLib)))
      ) {
        continue
      }
      nativeReceiverSymbols.add(symbol)
      const declaration = identities.symbolDeclarationId(symbol, receiverAnchor)
      if (declaration) nativeReceiverDeclarations.add(declaration)
    }
  }
  const standardClassNames = input.standardClasses ?? new Set<string>()
  const admitNativeConstructor = (constructor: ts.Symbol | undefined, location: ts.Node): void => {
    const valueDeclaration = constructor?.valueDeclaration
    if (!constructor || !valueDeclaration || !isAmbientDeclaration(valueDeclaration)) return
    nativeConstructorSymbols.add(constructor)
    const constructorType = compiled.checker.getTypeOfSymbolAtLocation(constructor, location)
    for (const signature of compiled.checker.getSignaturesOfType(constructorType, ts.SignatureKind.Construct)) {
      const result = compiled.checker.getReturnTypeOfSignature(signature)
      const symbol = result.aliasSymbol ?? result.getSymbol()
      if (!symbol) continue
      nativeReceiverSymbols.add(symbol)
      const declaration = identities.symbolDeclarationId(symbol, location)
      if (declaration) nativeReceiverDeclarations.add(declaration)
    }
  }
  const executableSourceFiles = new Set(compiled.sourceFiles)
  for (const file of compiled.program.getSourceFiles()) {
    if (executableSourceFiles.has(file)) {
      for (const name of standardClassNames) {
        admitNativeConstructor(compiled.checker.resolveName(name, file, ts.SymbolFlags.Value, false), file)
      }
    }
    const visitNativeConstructorDeclaration = (node: ts.Node): void => {
      // A declaration-bound host class states its constructor identity as
      // well as its instance carrier. Reading only standardClasses here left
      // `new HostView()` opaque even though hosts.protocols had already sealed
      // that very class as native. Do not admit a structurally compatible
      // constructor signature: the ambient class declaration must be the one
      // the host bound.
      if (ts.isClassDeclaration(node) && node.name && isAmbientDeclaration(node)) {
        const symbol = compiled.checker.getSymbolAtLocation(node.name)
        const declaration = symbol ? identities.symbolDeclarationId(symbol, node.name) : null
        const binding = declaration === null ? undefined : hosts.protocols.get(declaration)
        if (binding && binding.native !== null) admitNativeConstructor(symbol, node.name)
      }
      if (
        executableSourceFiles.has(file) &&
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        standardClassNames.has(node.name.text) &&
        isAmbientDeclaration(node)
      ) {
        admitNativeConstructor(compiled.checker.getSymbolAtLocation(node.name), node.name)
      }
      ts.forEachChild(node, visitNativeConstructorDeclaration)
    }
    visitNativeConstructorDeclaration(file)
  }
  // `absorb`, not a copy of the set: the census's per-key facts are not in
  // its legacy set view, and dropping them would lose writes.
  globalHostMutationTaint.absorb(
    censusGlobalHostMutations(
      compiled.checker,
      identities,
      compiled.sourceFiles,
      unresolvableNames,
      hostGlobalBindings,
      valueFlow,
      reachable,
      nativeReceiverDeclarations,
      nativeReceiverSymbols,
      nativeConstructorSymbols,
      types.rawTypeAt,
      compiled.program.getSourceFiles().filter((file) => file.isDeclarationFile),
      // The one shared instance built above, alongside `computedKeyTextsOf` --
      // `GEA_HOST_CENSUS_KEY_SETS_OFF` keeps every computed key unknown for
      // both readers.
      computedKeysOf
    )
  )
  hostMutationFactsSealed = true
  const failedIntrinsicRequirements = failedIntrinsicProtocolRequirements(intrinsicPropertyContext, intrinsicProtocols.requirements())
  // `GEA_LEDGER_DEBUG=1` pairs with the publish-time `[LEDGER]` lines
  // `createDeferredIntrinsicProtocolLedger`'s `replace` prints for every scope:
  // those name WHERE an obligation was raised, and this names WHY the final
  // sealed census refused each one that is still standing at this, the only
  // point the compiler itself asks -- the same `failedIntrinsicProtocolRequirements`
  // call the certification gate uses, so nothing here can disagree with the
  // real answer; it only narrates it.
  if (process.env['GEA_LEDGER_DEBUG'] !== undefined) {
    const clauses = new Map<string, number>()
    for (const requirement of failedIntrinsicRequirements) {
      const query = requirement.member !== undefined ? 'all' : (requirement.prototypeKeys ?? 'all')
      const why =
        requirement.member !== undefined
          ? intrinsicPropertyContext.globalHostMutationTaint.has('*')
            ? '*'
            : 'member'
          : explainIntrinsicProtocolFailure(intrinsicPropertyContext, requirement.intrinsic, requirement.location, query)
      clauses.set(why, (clauses.get(why) ?? 0) + 1)
      const file = requirement.location.getSourceFile()
      const line = file.getLineAndCharacterOfPosition(requirement.location.getStart(file)).line + 1
      console.error(
        `[LEDGER-FAILED] ${requirement.intrinsic}${requirement.member !== undefined ? `.${requirement.member}` : ''} ${intrinsicProtocolRequirementKind(requirement) ?? 'whole'} why=${why} ${file.fileName.split('/').pop()}:${line}`
      )
    }
    console.error(
      `[LEDGER-SUMMARY] failed=${failedIntrinsicRequirements.length} clauses=${[...clauses].map(([clause, count]) => `${clause}:${count}`).join(',')}`
    )
  }
  const intrinsicProtocolDiagnostics: DiagnosticEvidence[] = failedIntrinsicRequirements.map((requirement, ordinal) => {
    const file = requirement.location.getSourceFile()
    const position = file.getLineAndCharacterOfPosition(requirement.location.getStart(file))
    return {
      id: `intrinsic-protocol/${requirement.intrinsic}/${ordinal}`,
      component: checkerComponent,
      operation: null,
      missingPrimitive: null,
      // Names the exact obligation: a per-key requirement fails only when the
      // census recorded one of those keys, a whole-prototype one under any
      // unattributed key write at all -- which of the two is what to fix.
      message: `Inferred callable closure requires the intrinsic ${requirement.intrinsic}${
        requirement.member === undefined
          ? requirement.prototypeKeys
            ? ` prototype keys [${prototypeKeyQuerySignature(requirement.prototypeKeys)}]`
            : ' prototype (whole)'
          : `.${requirement.member}`
      } to remain intact; the final host mutation census did not prove that requirement.`,
      location: { file: file.fileName, line: position.line + 1, column: position.character + 1 }
    }
  })
  const promiseDeclaration = promiseDeclarationOf(compiled.checker, identities, compiled.sourceFiles)
  const dateDeclaration = dateDeclarationOf(compiled.checker, identities, compiled.sourceFiles)
  const stringObjectDeclaration = stringObjectDeclarationOf(compiled.checker, identities, compiled.sourceFiles)
  const errorDeclarations = errorDeclarationsOf(compiled.checker, identities, compiled.sourceFiles)
  const functionDeclaration = functionDeclarationOf(compiled.checker, identities, compiled.sourceFiles)
  const classHeritage = classHeritageOf(compiled.checker, identities, compiled.sourceFiles, prototypeReparentings.baseOf)
  const constructorSlotSubclasses = constructorSlotSubclassesOf(compiled.checker, identities, compiled.sourceFiles, classHeritage)
  const uninstantiableClasses = uninstantiableClassesOf(compiled.checker, identities, compiled.sourceFiles)
  const interfaceImplementors = interfaceImplementorsOf(compiled.checker, identities, compiled.sourceFiles)
  const generatorDeclaration = generatorDeclarationEarly
  const asyncGeneratorDeclaration = asyncGeneratorDeclarationEarly
  const mapIteratorDeclaration = mapIteratorDeclarationEarly
  // Resolved the same way and for the same reason as `keyedCollections` above.
  const regexpDeclarations = regexpDeclarationsOf(compiled.checker, identities, compiled.sourceFiles)
  timing.mark('structural-and-host-censuses')
  const normalized = normalizeProgram({
    census,
    types: table,
    // One producer set per monomorphized copy, differing only in which mapper
    // view they ask. Everything else -- the checker, the identity table, both
    // ordinal counters -- is the one shared context, because those answer
    // whole-program questions that a copy must not fork.
    producers: (candidate) =>
      input.producers({
        ...context,
        identities: identities.forSpecialization(candidate.specialization),
        types: types.forSpecialization(candidate.specialization),
        path: candidate.specialization
      }),
    // Which copy a candidate belongs to, owner included -- the identity table's
    // own answer, so the producer cache, the identity views and the structural
    // mappers all agree on what "the same copy" means.
    copyKey: (candidate) => identities.copyKeyOf(candidate.specialization),
    gates: (operations) =>
      gatingEdges({
        files: compiled.sourceFiles,
        identities,
        operations,
        reachable,
        specializations,
        argumentsObjects,
        unresolvableNames,
        namespacePaths
      })
  })

  timing.mark('normalization')
  timing.report()
  // See `FrontendResult.locationOfNode`. Lazy, because a compilation that
  // reports nothing must not pay for a whole-program walk to name nodes
  // nobody asked about.
  //
  // Keyed by `positionKeyOfNode` -- file and ordinal, kind and monomorphization
  // suffix both dropped -- rather than by the raw NodeId text. A monomorphized
  // copy has no source text of its own (the position key already names the
  // root it was cut from, so no separate `withoutSpecialization` fallback
  // lookup is needed), and dropping kind is what lets `locationOfDeclaration`
  // resolve a DeclarationId -- which never carries one -- through this SAME
  // index instead of a second one built to answer the identical question in a
  // different identity currency.
  let nodesByPosition: Map<string, ts.Node> | null = null
  const positionIndex = (): Map<string, ts.Node> => {
    if (nodesByPosition === null) {
      const index = new Map<string, ts.Node>()
      for (const file of compiled.sourceFiles) {
        if (file.isDeclarationFile) continue
        const walk = (current: ts.Node): void => {
          let key: string | null = null
          try {
            key = positionKeyOfNode(identities.nodeIdOf(current))
          } catch {
            key = null
          }
          if (key !== null && !index.has(key)) index.set(key, current)
          ts.forEachChild(current, walk)
        }
        walk(file)
      }
      nodesByPosition = index
    }
    return nodesByPosition
  }
  const sourceNodeOf = (node: NodeId): ts.Node | null => positionIndex().get(positionKeyOfNode(node)) ?? null
  const sourceNodeOfDeclaration = (declaration: DeclarationId): ts.Node | null =>
    positionIndex().get(positionKeyOfDeclaration(declaration)) ?? null
  const locationOfFound = (found: ts.Node | null): DiagnosticLocation | null => {
    if (!found) return null
    const file = found.getSourceFile()
    const { line, character } = file.getLineAndCharacterOfPosition(found.getStart())
    return { file: file.fileName, line: line + 1, column: character + 1 }
  }
  const locationOfNode = (node: NodeId): DiagnosticLocation | null => locationOfFound(sourceNodeOf(node))
  const textOfNode = (node: NodeId): string | null => sourceNodeOf(node)?.getText() ?? null
  /** `locationOfNode`'s twin for a DeclarationId -- see `FrontendResult.locationOfDeclaration`. */
  const locationOfDeclaration = (declaration: DeclarationId): DiagnosticLocation | null =>
    locationOfFound(sourceNodeOfDeclaration(declaration))

  return {
    dynamicFallbackTypes,
    dynamicWrittenTypes,
    dynamicFallbackCallables: prototypeFallback.callables,
    graph: normalized.graph,
    sourcePreparations: compiled.sourcePreparations,
    hostProtocols: hosts.protocols,
    wellKnownSymbols,
    externalBindings: hosts.externals,
    commonJsBindings: hosts.commonJsBindings,
    hostSingletonBindings: hosts.hostSingletonBindings,
    hostNamespaceBindings: hosts.hostNamespaceBindings,
    absentBindings: absentBindingIds(absent, identities),
    deadTypeofGuards,
    locationOfNode,
    locationOfDeclaration,
    textOfNode,
    externalBindingFiles: hosts.externalFiles,
    standardLibraryBindings: hosts.standardLibrary,
    // The module bodies the graph actually has, in evaluation order. A file the
    // reachability walk pruned whole, or one whose top level censused nothing,
    // has no region -- and a name in this list that no region answers would be
    // a call to a function nothing defines.
    // `fileEvaluates` is the reached-statement half of that: a file kept only
    // for a layout-only class has a region and, by design, no body.
    moduleOrder: moduleEvaluationOrder({ checker: compiled.checker, files: compiled.sourceFiles, entries: compiled.entryFiles })
      .filter((file) => fileEvaluates(reachable, file))
      .map((file) => regionId(identities.nodeIdOf(file), 'module-body'))
      .filter((region) => normalized.graph.regions.has(region)),
    sourceFileNames: identities.sourceFileNames,
    typedArrayElements,
    promiseDeclaration,
    dateDeclaration,
    stringObjectDeclaration,
    errorDeclarations,
    functionDeclaration,
    classHeritage,
    constructorSlotSubclasses,
    uninstantiableClasses,
    interfaceImplementors,
    generatorDeclaration,
    asyncGeneratorDeclaration,
    mapIteratorDeclaration,
    keyedCollections,
    regexpDeclarations,
    standardBuffers,
    hostNamespaceRoots: hosts.namespaceRoots,
    checkerDiagnostics: ((): readonly DiagnosticEvidence[] => {
      const compiledFiles = new Set(compiled.sourceFiles)
      const syntactic = new Set(compiled.program.getSyntacticDiagnostics())
      return compiled.diagnostics
        .filter((diagnostic) => !diagnosticIsInPrunedCode(diagnostic, reachable, compiledFiles, syntactic))
        .map(translateDiagnostic)
    })(),
    intrinsicProtocolDiagnostics,
    uninstalledFamilies: normalized.uninstalledFamilies,
    // `parameters` is the COMPOSED census: `composeReturnBindings`,
    // `withLocalBindings`, `withFieldBindings` and `withJsDocTypeNames` each
    // concatenate their own refusals onto their upstream's, so this one list
    // already carries five censuses. The old string prefixes (`return:`,
    // `local:`, `field:`) are gone -- a `CensusRefusal`'s key is namespaced by
    // its domain already, and a prefix applied by the WRAPPER was the layer
    // above naming a refusal the layer below had raised.
    // `collections` and `bags` are not in that chain and keep their own.
    censusAccounting: new Map([
      ['bindings', { bound: parameters.boundCount, refusals: censusRefusalCounts(parameters.refusals) }],
      ['collections', { bound: collections.boundCount, refusals: censusRefusalCounts(collections.refusals) }],
      ['bags', { bound: bags.boundCount, refusals: censusRefusalCounts(bags.refusals) }]
    ]),
    censusRefusals: [...parameters.refusals, ...collections.refusals, ...bags.refusals],
    cellFacts,
    structuralDisagreements: types.structuralDisagreements,
    structuralFormViolations: types.structuralFormViolations,
    classCopies: types.classCopies()
  }
}
