import { readFileSync } from 'fs'
import type { PackageSource } from './semantics/package-sources.js'
import { projectAbis, type AbiProjectionBlocker } from './projection/abi.js'
import { projectBindingPlacements } from './projection/bindings.js'
import {
  physicalClassInstanceResolverOf,
  physicalClassLayoutsOf,
  projectClasses,
  type PhysicalClassLayoutPublication
} from './projection/classes.js'
import type { ConversionNode } from './conversion/algebra.js'
import { buildConversionGraph } from './conversion/build.js'
import { createConversionNodes, type ConversionCensus } from './conversion/nodes.js'
import type { ConversionRuntimeRegistry } from './conversion/registry.js'
import type { DiagnosticLocation, DiagnosticReport } from './diagnostics/model.js'
import { sweepDiagnostics } from './diagnostics/sweep.js'
import type { DeclarationId, FunctionId, NodeId, OperationFamily, SemanticResultId } from './identity/ids.js'
import type { CallableAbi } from './representation/model.js'
import type { ClassLayout } from './projection/classes.js'
import type { BindingPlacement } from './projection/bindings.js'
import type { SlotHook } from './projection/slots.js'
import type { CapabilityCertificate } from './ir/certificate.js'
import { refusalsOf, type Refusal } from './ir/refusal.js'
import { mintCapabilityCertificate } from './ir/certificate.js'
import type { TargetRuntimeManifest } from './preflight/obligations.js'
import type { PreflightReport } from './preflight/run.js'
import { runPreflight } from './preflight/run.js'
import { typeofOperandRepresentationOf } from './ir/certify/typeof-operand.js'
import type { RepresentationPublication } from './representation/publish.js'
import { defaultOwnershipPolicy } from './representation/derive.js'
import { publishRepresentations } from './representation/publish.js'
import { valueRecordTypesOf } from './representation/value-records.js'
import { createAmbientTypeRealizationTransform } from './semantics/ambient-type-realization-transform.js'
import { declarationOverlayTransform } from './semantics/declaration-overlay-transform.js'
import { createSubclassMemberOverlayTransform, type DeclarerReader } from './semantics/subclass-member-overlay-transform.js'
import { aliasThisFieldDeclarationTransform } from './semantics/alias-this-field-declaration-transform.js'
import { definePropertySourceTransform } from './semantics/define-property-source-transform.js'
import { prototypeInstallSourceTransform } from './semantics/prototype-install-source-transform.js'
import { prototypeObjectClassSourceTransform } from './semantics/prototype-object-class-source-transform.js'
import { jsdocNamepathTransform } from './semantics/jsdoc-namepath-transform.js'
import { thisConstructorSourceTransform } from './semantics/this-constructor-source-transform.js'
import { symbolKeyedExpandoSourceTransform } from './semantics/symbol-keyed-expando-source-transform.js'
import { newCalleeClassTagSourceTransform } from './semantics/new-callee-class-tag-source-transform.js'
import { borrowedBuiltinCallBindSourceTransform } from './semantics/borrowed-builtin-call-bind-source-transform.js'
import { runFrontend, type CensusAccounting } from './semantics/frontend.js'
import type { CellFactsPublication } from './semantics/normalize/cells/index.js'
import type { DiagnosticSourcePreparationAudit } from './semantics/diagnostic-source-preparation.js'
import type { SemanticGraph } from './semantics/model/graph.js'
import { installedProducers } from './semantics/normalize/producers/installed.js'
import type { CompilerPlugin, PluginInstance, PluginOptions } from './plugins/model.js'
import { installedPlugins } from './plugins/installed.js'
import type { IrLoweringBlocker } from './ir/lower.js'
import type { SlotDrift } from './ir/lower-operands.js'
import { createSlotCensus } from './projection/slots.js'
import { hostMethodAliasDeclarations } from './projection/callee.js'
import { lowerToIr } from './ir/lower.js'
import { certifyIr, type IrCertification } from './ir/certify.js'
import { publishCaptureFacts } from './ir/captures.js'
import { recordAccessorBodiesOf } from './projection/fields.js'
import { fillCallDispatchTargets } from './ir/call-dispatch.js'
import type { IrBody } from './ir/model.js'
import { virtualDispatchVerdictOf } from './projection/dispatch.js'
import { splitGeneratorBodies } from './ir/generator-split.js'
import { shakeProgram } from './ir/shake.js'
import { pruneProvenBranches } from './ir/proven-branches.js'
import { publishEmissionRepresentationsOf, type EmissionRepresentationPublication } from './ir/emission-representations.js'
import { finalizeTypedComputedReads, reflectionExposureOf, type ReflectionExposure } from './ir/reflection-demand.js'
import { finalizeAbsentClassArms } from './ir/absent-class-arm.js'
import { closePhysicalClassReflection } from './ir/physical-class-reflection.js'
import { createCppTargetManifest } from './targets/cpp/manifest.js'
import {
  coreHostConstants,
  coreHostFunctions,
  coreHostMembers,
  type HostMemberTable,
  type HostSpellings
} from './targets/cpp/host/host-members.js'
import { coreGlobalClasses, coreGlobalFunctions, coreNativeTypes } from './targets/cpp/host/core-globals.js'
import { createCppConversionRegistry } from './targets/cpp/conversions.js'
import type { PrinterDrift } from './targets/cpp/emit-narrowing.js'
import { recordLayoutPolicyOf } from './projection/fields.js'
import { nativeClassFieldUsesOf, projectNativeClassStorage } from './projection/class-storage.js'
import { finalizeNativeFieldOwnership } from './ir/native-field-owner.js'
import { withPresenceChecks } from './ir/presence-proof.js'
import type { ConvertOperation } from './ir/model.js'
import { cppDateType } from './targets/cpp/prototype/emit-prototype-date.js'
import { cppRegExpNativeTypes, cppStringObjectNativeType } from './targets/cpp/regexp-types.js'
import { cppErrorNativeType } from './targets/cpp/error-types.js'
import type { RenderedCppSource } from './targets/cpp/document.js'
import {
  renderTranslationUnit,
  type CppEmissionRefusal,
  type CppRenderedUnit,
  type CppTranslationUnitLayout
} from './targets/cpp/translation-unit.js'

/**
 * The compilation pipeline.
 *
 * The stage order here is the architecture's mandatory publication order, and
 * every stage consumes only what the previous one sealed:
 *
 *   normalize -> publish carriers -> derive conversions -> preflight -> certify
 *   -> project ABIs -> lower to IR -> render
 *
 * Lowering is gated on the plan, emission on the certificate. A program whose
 * frontend, census and plan raised nothing (`DiagnosticReport.planClean`)
 * lowers whether or not preflight certified it, and every body lowering
 * cannot build is a `Refusal` row beside preflight's own; this is what lets
 * certification move onto the IR --
 * a check over operations that exist rather than a model of operations that
 * would. Text is still produced only under a certificate with every body
 * lowered: a stage that renders before the certificate exists can discover,
 * halfway through emission, that a capability it needed was never installed,
 * which is the failure mode preflight exists to remove.
 */

export interface CompilationRequest {
  /** Package checkouts prepared by the project loader; the compiler discovers their implementation entries. */
  readonly packageSources?: readonly PackageSource[]
  /** Opt in to boxed C++ carriers where static specialization cannot select storage. */
  readonly dynamicFallback?: boolean
  readonly rootFileNames: readonly string[]
  /** The project file defining this program. `null` compiles the roots under this compiler's own defaults. */
  readonly projectFileName?: string | null
  /** The target's installed conversion primitives; empty means none are built yet. */
  readonly conversionRegistry?: ConversionRuntimeRegistry
  /** Libraries whose meaning this program depends on. Defaults to what this build installs. */
  readonly plugins?: readonly CompilerPlugin[]
  /** What the build told those libraries -- see `PluginOptions`. Empty when the caller passed none. */
  readonly pluginOptions?: PluginOptions
  /**
   * The C++ name the target starts this program at, or `null` to emit no entry.
   *
   * The gea runtimes call `__gea_top_level`, which is why that is the default:
   * `core/gea_app_entry.cpp` declares it and `Application::init` invokes it, so
   * an emitted unit links against the engine as it stands. A resident-app build
   * gives each app its own prefixed entry so several link together, and a
   * caller inspecting a unit rather than linking it can ask for none.
   */
  readonly entrySymbol?: string | null
  /**
   * Legacy explicit JavaScript admission. JavaScript dependencies are now admitted automatically.
   *
   * The gea build pipeline hands its compiler a vite bundle, not the app's
   * TypeScript: plain JS with JSDoc annotations and a generated `.d.ts`
   * reference. Saying so is a statement about the input; what the checker is
   * then configured with is `semantics/`'s to decide (`FrontendInput`).
   */
  readonly javaScriptSources?: boolean
  /** File text this compilation uses instead of what is on disk, by absolute path. */
  readonly sourceOverlay?: ReadonlyMap<string, string>
  /** How each file's own import specifiers resolve, when the build is the authority. */
  readonly moduleResolution?: ReadonlyMap<string, ReadonlyMap<string, string>>
  /** Whether this request states the module set -- see `ProgramInput.statedModuleSet`. */
  readonly statedModuleSet?: boolean
  /** Caller-stated classic-script lexical realm boundary; see `ProgramInput.closedScriptScope`. */
  readonly closedScriptScope?: boolean
  /** Whether the emitted unit is one of several a single binary links -- see `TranslationUnitInput.isolateSymbols`. */
  readonly isolateSymbols?: boolean
  /** Retain final IR in the result for diagnostics. Off by default so normal builds can release it. */
  readonly includeIr?: boolean
  /**
   * How many C++ files the program becomes -- see `CppTranslationUnitLayout`.
   * `single` (the default) is one unit; `per-file` is one unit per source file
   * plus a shared header and a program unit.
   */
  readonly translationUnits?: CppTranslationUnitLayout
  /**
   * The stem the emitted files are named from (`<stem>.cpp`, and under
   * `per-file` also `<stem>.hpp` and `<stem>.<module>.cpp`). The CLI passes the
   * input's own base name; the default is `unit`.
   */
  readonly unitBaseName?: string
}

export interface CompilationResult {
  readonly dynamicFallback: { readonly enabled: boolean; readonly valueCount: number }
  /**
   * Where a node identity is, for display -- the frontend's own identity walk
   * (`FrontendResult.locationOfNode`). Exposed so a reader of the plan can put
   * a carrier at a place in the program: the diagnostic sweep already does this
   * for every failing row, and `cli-coverage.ts` asks the same question of the
   * rows that did NOT fail -- which carriers boxed, and where.
   */
  readonly locationOfNode: (node: NodeId) => DiagnosticLocation | null
  /** `locationOfNode`'s twin for a DeclarationId (`FrontendResult.locationOfDeclaration`) -- see `AbiProjectionBlocker.location`. */
  readonly locationOfDeclaration: (declaration: DeclarationId) => DiagnosticLocation | null
  /** The node's source text, for display (`FrontendResult.textOfNode`). */
  readonly textOfNode: (node: NodeId) => string | null
  readonly graph: SemanticGraph
  /** Stable file identities used in declaration and function ids, mapped to display paths. */
  readonly sourceFileNames: ReadonlyMap<string, string>
  /** Diagnostic-proven stale package-source directives removed before the final checker pass. */
  readonly sourcePreparations: readonly DiagnosticSourcePreparationAudit[]
  readonly representations: RepresentationPublication
  readonly manifest: TargetRuntimeManifest
  readonly preflight: PreflightReport
  /** Non-null only when every mandatory obligation was satisfied. */
  readonly certificate: CapabilityCertificate | null
  readonly diagnostics: DiagnosticReport
  readonly uninstalledFamilies: readonly OperationFamily[]
  /** What each write-discovery census bound and why it refused the rest -- see `FrontendOutput.censusAccounting`. */
  readonly censusAccounting: ReadonlyMap<string, CensusAccounting>
  /**
   * The frontend's per-cell fact table, forwarded verbatim (`FrontendResult.cellFacts`).
   * Exposed so a caller can ask `cellFacts.table.twoOwnerClaims` -- the cells two
   * independent write-discovery censuses both claimed -- without threading a new
   * field through every stage that already forwards `frontend.graph` the same way.
   */
  readonly cellFacts: CellFactsPublication
  /**
   * The derived conversion graph, keyed by carrier.
   *
   * Exposed because a `conversion-capability` obligation carries only its
   * predicate STRING -- `return-conversion:<source key>-><target key>` -- and
   * a bare "absent" says nothing about why. The node's own `capability` holds
   * the `never` REASON the derivation stated, which is the actual root: 35
   * distinct carrier pairs on the three.js app collapsed to a handful of reasons the
   * first time this was asked, and the pair keys had been ranked as 35
   * separate problems until then.
   */
  readonly conversionNodes: ReadonlyMap<string, ConversionNode>
  /**
   * The conversion census over the same registry: one node per carrier
   * pair, the eager graph's where it minted one and otherwise minted on
   * demand from the registry's tables (`conversion/nodes.ts`). This is the
   * authority the lowering's `convert` instructions name.
   */
  readonly conversionCensus: ConversionCensus
  /** Physical carrier dependencies and reflection demands of the final emitted program. */
  readonly emissionRepresentations: EmissionRepresentationPublication | null
  readonly reflection: ReflectionExposure | null
  /** Final IR supplied to certification, including published callable identities. Null unless requested by includeIr. */
  readonly irBodies: readonly IrBody[] | null
  readonly physicalClasses: PhysicalClassLayoutPublication | null
  /**
   * The program as one unit. Non-null only when a certificate was minted,
   * every body lowered, and the layout is `single`; under `per-file` the
   * program is `units`, and there is no one text that is all of it.
   */
  readonly source: RenderedCppSource | null
  /** Every C++ file the layout produced, named and in write order; empty whenever `source` would be null for a `single` layout. */
  readonly units: readonly CppRenderedUnit[]
  /** Bodies the IR refused, each naming what has no primitive yet. */
  readonly loweringBlockers: readonly IrLoweringBlocker[]
  /** Every refusal past the plan -- ABI, lowering and printer -- as one list (`ir/refusal.ts`). */
  /** The IR certification's verdict, or `null` for a program that did not lower; `certificate` is minted from it. */
  readonly certification: IrCertification | null
  readonly refusals: readonly Refusal[]
  /** Slots lowering left unconverted because the conversion census has no node for the pair (`ir/lower-operands.ts`'s `SlotDrift`). */
  readonly slotDrift: readonly SlotDrift[]
  /** Every chain call the printer still made on a pair lowering had not aligned; `emit-narrowing.ts`'s `PrinterDrift`. */
  readonly printerDrift: readonly PrinterDrift[]
  /** Functions whose calling convention could not be projected, each naming why. */
  readonly abiBlockers: readonly AbiProjectionBlocker[]
  /** Bodies the C++ emitter refused, each naming the capability it lacked. */
  readonly emissionRefusals: readonly CppEmissionRefusal[]
  /** The whole-program projections lowering consumes, published so the slot census can be asked outside the pipeline. */
  readonly projection: {
    readonly abis: ReadonlyMap<FunctionId, CallableAbi>
    readonly constructs: ReadonlyMap<FunctionId, CallableAbi>
    readonly callableOrigins: ReadonlyMap<SemanticResultId, FunctionId>
    readonly classes: ReadonlyMap<DeclarationId, ClassLayout>
    readonly placements: ReadonlyMap<DeclarationId, BindingPlacement>
    readonly slotHooks: readonly SlotHook[]
  }
  /**
   * The installed plugins' own `writeArtifacts`, for the caller to run against
   * its output directory once it has written a unit.
   *
   * Returned rather than called here because this function does not know where
   * -- or whether -- anything is written. `compile` produces a result; the CLI
   * decides that the result is worth putting on disk and where it goes, and an
   * artifact a plugin's host requires beside the unit is part of that same
   * decision. Empty for every compilation whose plugins state one.
   */
  readonly artifacts: readonly ((outDir: string) => void)[]
  /**
   * Header paths the caller's `generated_support.hpp` must state, unioned from
   * the installed plugins -- see `PluginCapabilities.generatedSupportIncludes`.
   * Returned for the same reason `artifacts` is: this function does not write
   * files, and what a unit is compiled against is a fact of the compilation
   * rather than of the directory it lands in.
   */
  readonly generatedSupportIncludes: readonly string[]
}

/**
 * The entry symbol the gea runtimes call, and so this compiler's default.
 *
 * `core/gea_app_entry.cpp` declares `extern void __gea_top_level();` and
 * `Application::init` calls it; v1's compiler emits that name for the same
 * reason. Defaulting to it is what makes an emitted unit start when the engine
 * starts, rather than being a set of functions with a working program inside
 * that nothing reaches.
 */
const defaultEntrySymbol = '__gea_top_level'

const union = (base: ReadonlySet<string>, added: readonly string[]): ReadonlySet<string> => new Set([...base, ...added])

/**
 * Every source transform a compilation applies, in order, for a given set of
 * instantiated plugins.
 *
 * Exported because a PROBE that builds its own `ts.Program` to map results
 * back to source must parse the files exactly the way the compilation did.
 * Node identity is positional: the first transform that splices text into a
 * file shifts every node after it, so a probe running a SHORTER list silently
 * attributes a result to the wrong syntax and reads as a confident, wrong
 * answer rather than as an error. That has already cost a full investigation
 * here. One list, one home, cited by both.
 */
/**
 * How the subclass overlay reads a declarer: disk text, through this
 * compilation's plugin transforms -- the same statements the checker will see
 * for that file. See `DeclarerReader` for why the index cannot read raw disk
 * text, and why only the plugin transforms apply. A plugin that throws on a
 * file (an anchor it never compiled against) states nothing about it, so that
 * file reads as it sits on disk.
 */
const declarerReaderFor = (plugins: readonly PluginInstance[]): DeclarerReader => {
  const transforms = plugins.flatMap((plugin) => (plugin.transformSource ? [plugin.transformSource] : []))
  return (filePath) => {
    const disk = readFileSync(filePath, 'utf8')
    let text = disk
    try {
      for (const transform of transforms) text = transform({ fileName: filePath, text }) ?? text
    } catch {
      return disk
    }
    return text
  }
}

export const sourceTransformsFor = (
  plugins: readonly PluginInstance[]
): readonly ((input: { readonly fileName: string; readonly text: string }) => string | null)[] => [
  // A prototype object instantiated with `Object.create` becomes its class
  // first, so the installs and re-parenting below see a class prototype.
  prototypeObjectClassSourceTransform,
  definePropertySourceTransform,
  // After it, so a descriptor it already turned into an assignment is not
  // read again: methods and getters a script installs onto its own class
  // become the class members they install (see the transform's comment).
  prototypeInstallSourceTransform,
  // `thisConstructorSourceTransform` runs right after: it is also a
  // language-level rewrite of a call the checker has no special knowledge of
  // (`new this.constructor(...)`, see the transform's own module comment),
  // not a host's or plugin's data, so it applies to every compilation
  // unconditionally, in the same tier as `definePropertySourceTransform`.
  thisConstructorSourceTransform,
  // `symbolKeyedExpandoSourceTransform` is the third language-level rewrite in
  // this tier: it keeps the checker from crashing on a JS expando the binder
  // cannot late-bind (see the transform's module comment). It only ever adds
  // two parentheses, so it changes no other node's text and states no type.
  symbolKeyedExpandoSourceTransform,
  // `newCalleeClassTagSourceTransform` is the fourth: a plain JS function the
  // program constructs with `new` is tagged `@class` so the checker's own
  // constructor inference runs on it (see the transform's module comment).
  newCalleeClassTagSourceTransform,
  // `borrowedBuiltinCallBindSourceTransform` is the fifth: a borrowed built-in
  // method (`Function.prototype.call.bind(Array.prototype.push)`, or the
  // bare `Array.prototype.push.call(xs, v)` it also covers) is rewritten to
  // the ordinary member call it always meant (`xs.push(v)`), so every layer
  // after this one sees an expression it already knows how to compile
  // natively -- see the transform's own module comment.
  borrowedBuiltinCallBindSourceTransform,
  // `jsdocNamepathTransform` runs before the overlay: it respells a name the
  // source already stated into one the checker can bind, so the overlay --
  // which reads the source's own tags to decide what it must bring into
  // scope -- sees the name the program meant rather than a fragment
  // TypeScript stopped reading halfway.
  jsdocNamepathTransform,
  // `declarationOverlayTransform` runs next, and for the same reason: a
  // package's own `.d.ts` stating its JS module's parameter types is shipped
  // DATA, not a host's vocabulary. It never overrides what the source itself
  // says -- a parameter already annotated, or already carrying a `@param`, is
  // left exactly as written -- so it speaks only where the program was silent.
  declarationOverlayTransform,
  // The subclass overlay runs on the overlay's output and before the ambient
  // realization, so a member it declares is respelled too.
  createSubclassMemberOverlayTransform(declarerReaderFor(plugins)),
  // The alias-this field declaration runs after the subclass overlay so its
  // "already declared" check sees any member the overlay just added, and
  // never fights it over the same name. It states no type -- only that a
  // field exists -- so ordering relative to the ambient realization below
  // does not matter for it either way.
  aliasThisFieldDeclarationTransform,
  // `ambientTypeRealizationTransform` runs after the overlay so it sees the
  // types that transform just injected, not only the program's own source. A
  // package states, as data, that an ambient name a library documents is
  // realised by a concrete class the package ships; nothing here names one.
  createAmbientTypeRealizationTransform(new Map(plugins.flatMap((plugin) => [...plugin.capabilities.ambientTypeRealizations]))),
  ...plugins.flatMap((plugin) => (plugin.transformSource ? [plugin.transformSource] : []))
]

export const compile = (request: CompilationRequest): CompilationResult => {
  // One instance per compilation. A plugin that learns something from a program
  // and acts on it later has to remember it in between, and a registry of
  // long-lived instances would let a fact derived from one program be read back
  // while compiling another -- a defect that reproduces only in the order the
  // programs happened to be compiled in.
  // `GEA_STAGE_TIMING=1` prints what each stage of the pipeline below costs.
  //
  // There was no way to ask this. The stages are named in the header comment
  // and nothing measured them, so "where does a compile spend its time" could
  // only be answered by a CPU profile -- which attributes to FUNCTIONS, and
  // therefore cannot say what share belongs to the frontend as against
  // emission. A program that certifies (`voice-notes`) and one that does not
  // (the three.js app, which stops before lowering) spend their time in completely
  // different places, and that difference was invisible.
  const stageStartedAt = process.env['GEA_STAGE_TIMING'] ? { at: performance.now() } : null
  const stage = (name: string): void => {
    if (!stageStartedAt) return
    const now = performance.now()
    process.stderr.write(`[STAGE] ${name.padEnd(16)} ${(now - stageStartedAt.at).toFixed(0)}ms\n`)
    stageStartedAt.at = now
  }
  const plugins = (request.plugins ?? installedPlugins).map((plugin) => plugin.instantiate(request.pluginOptions ?? new Map()))
  // Which declared type names the installed hosts own, unioned once. It reaches
  // the frontend because only the frontend can turn a name into a declaration
  // identity, and it reaches the manifest below because only the manifest can
  // say whether the target implements one.
  // The backend's own carriers for the standard library's native classes,
  // unioned into the same map an installed host's stated carriers arrive in --
  // the identical union `coreHostMembers` and `coreGlobalFunctions` get, and
  // for the identical reason: one map means one claim set and one member key
  // space. A plugin row wins a collision, because a target that implements
  // `TextDecoder` itself is describing its own platform.
  const nativeTypes = new Map([...coreNativeTypes, ...plugins.flatMap((plugin) => [...plugin.capabilities.nativeTypes])])
  const nativeTypesByDeclaration = new Map(plugins.flatMap((plugin) => [...(plugin.capabilities.nativeTypesByDeclaration ?? new Map())]))
  const hostNamespaceRootDeclarations = plugins.flatMap((plugin) => plugin.capabilities.hostNamespaceRootDeclarations ?? [])
  const frontend = runFrontend({
    ...(request.packageSources ? { packageSources: request.packageSources } : {}),
    declarationModules: new Set(plugins.flatMap((plugin) => [...(plugin.capabilities.declarationModules ?? [])])),
    rootFileNames: request.rootFileNames,
    projectFileName: request.projectFileName ?? null,
    javaScriptSources: request.javaScriptSources ?? false,
    dynamicFallback: request.dynamicFallback ?? false,
    ...(request.sourceOverlay ? { sourceOverlay: request.sourceOverlay } : {}),
    ...(request.moduleResolution ? { moduleResolution: request.moduleResolution } : {}),
    ...(request.statedModuleSet ? { statedModuleSet: true } : {}),
    ...(request.closedScriptScope ? { closedScriptScope: true } : {}),
    producers: installedProducers((context) => plugins.flatMap((plugin) => plugin.producers(context))),
    hostTypedArrayDeclarations: plugins.flatMap((plugin) => plugin.capabilities.typedArrayDeclarations ?? []),
    nativeTypes,
    nativeTypesByDeclaration,
    hostSingletonDeclarations: new Map(plugins.flatMap((plugin) => [...(plugin.capabilities.hostSingletonDeclarations ?? new Map())])),
    standardClasses: new Set(coreNativeTypes.keys()),
    // What the installed hosts state they do NOT provide, unioned the same way
    // their positive claims are. A name is absent only because a host said so:
    // with no plugin stating one this set is empty and every ambient
    // declaration is believed exactly as before.
    absentGlobals: new Set(plugins.flatMap((plugin) => [...plugin.capabilities.absentGlobals])),
    // The members the installed hosts reach on their own, unioned the same way
    // every other plugin table here is. `reachability.ts` keeps an instance
    // method only when live code names it, and a name only a lowering
    // synthesizes is one no walk over the source can see.
    hostReachedMemberKeys: new Set(plugins.flatMap((plugin) => [...plugin.capabilities.reachedMemberKeys])),
    // The host functions of every host stating that its programs take the
    // census wildcard; the frontend refuses the proofs when reachable code
    // names one. One such host is enough: the wildcard taints the whole
    // program's census, not only that host's reads.
    hostFunctionsRefusingObjectPrototypeAbsenceProofs: new Set(
      plugins
        .filter((plugin) => plugin.capabilities.refusesObjectPrototypeAbsenceProofs === true)
        .flatMap((plugin) => [...plugin.capabilities.hostFunctions.keys()])
    ),
    hostNamespaceRoots: new Set(['Reflect', ...plugins.flatMap((plugin) => [...plugin.capabilities.hostNamespaces.roots])]),
    hostNamespaceRootDeclarations,
    // Every leaf path a plugin's own namespace tables publish -- see
    // `FrontendInput.hostNamespacePaths` for what the frontend does with it.
    // Threaded from the identical `hostNamespaces.methods`/`.properties` maps
    // `hosts.namespaces` below is built from, so the frontend and the emitter
    // agree on what counts as a namespace path without a second table stating
    // it twice.
    hostNamespacePaths: new Set([
      'Reflect.get',
      'Reflect.set',
      'Reflect.has',
      'Reflect.deleteProperty',
      'Reflect.getOwnPropertyDescriptor',
      'Reflect.ownKeys',
      ...plugins.flatMap((plugin) => [
        ...plugin.capabilities.hostNamespaces.methods.keys(),
        ...plugin.capabilities.hostNamespaces.properties.keys()
      ])
    ]),
    // The type each host carries the one object behind its own roots in. The
    // frontend is where it has to land, for the same reason `nativeTypes` does:
    // only the frontend can turn a name a plugin states into the structural
    // type the checker resolved that name's value to, which is the key
    // `representation/derive.ts` can actually read.
    hostNamespaceRootTypes: new Map([
      ['Reflect', 'gea::ReflectNamespace'],
      ...plugins.flatMap((plugin) => [...plugin.capabilities.hostNamespaceRootTypes])
    ]),
    commonJsGlobals: new Map(plugins.flatMap((plugin) => [...(plugin.capabilities.commonJsGlobals ?? new Map())])),
    commonJsBuiltinModules: new Map(plugins.flatMap((plugin) => [...(plugin.capabilities.commonJsBuiltinModules ?? new Map())])),
    commonJsBuiltinModuleSources: new Map(
      plugins.flatMap((plugin) => [...(plugin.capabilities.commonJsBuiltinModuleSources ?? new Map())])
    ),
    hostMethodBindings: new Map(plugins.flatMap((plugin) => [...(plugin.capabilities.hostMethodBindings ?? [])])),
    // `definePropertySourceTransform` runs first and unconditionally: it is a
    // language-level rewrite (`Object.defineProperty`/`defineProperties` into
    // the assignment they define), not a host's data, so it applies to every
    // compilation the same way `fixedOptions` does in `program.ts`, ahead of
    // whatever a plugin adds. In installation order after that, so a file
    // offered to two plugins is offered to the second the way the first left
    // it. Only a plugin that installs one appears here, so a compilation whose
    // plugins state only data parses each file once past this first pass.
    sourceTransforms: sourceTransformsFor(plugins)
  })
  // The frontend's host-protocol census reaches the deriver as a policy rather
  // than as a table the deriver reads: `derive.ts` may not know what a JSX
  // element is, and the frontend may not know what a carrier is. The policy is
  // the whole of what crosses between them.
  // Which record types this program never mutates, never identity-tests and
  // never hands across a boundary -- the proof that carrying one BY VALUE is
  // unobservable. Computed here, over the sealed graph, because it is a
  // whole-program fact and `derive.ts` sees one type at a time.
  const valueRecords = valueRecordTypesOf(frontend.graph)
  // What each host says its own types derive from, unioned across the installed
  // plugins by the same rule every other host table here is (`hosts` below).
  // The rows are immediate base to immediate base; the walk to a full chain is
  // done once, here, so the carrier states the transitive answer and nobody
  // downstream has to walk anything (see `Representation`'s `native-handle`).
  const hostBases = new Map(plugins.flatMap((plugin) => [...plugin.capabilities.nativeBases]))
  const hostBaseChain = (native: string | null): readonly string[] => {
    const chain: string[] = []
    const seen = new Set<string>()
    let current = native === null ? null : (hostBases.get(native) ?? null)
    // A cycle is a host that stated one, and it is not this compiler's to
    // resolve: the walk stops at the first carrier it has already seen, so a
    // malformed table costs a shorter chain rather than a hang.
    while (current !== null && !seen.has(current)) {
      chain.push(current)
      seen.add(current)
      current = hostBases.get(current) ?? null
    }
    return chain
  }
  stage('frontend')
  const representations = publishRepresentations(
    frontend.graph,
    {
      // Only the OBJECT shape itself: a declared name for one reaches the same
      // carrier by delegation inside the deriver, and answering `owned` for the
      // NAME would make a `native-record-ref` -- a deliberately unexpanded
      // layout -- a by-value incomplete type.
      forShape: (shape, id) => (shape.kind === 'object' && valueRecords.has(id) ? 'owned' : defaultOwnershipPolicy.forShape(shape, id)),
      forParameter: defaultOwnershipPolicy.forParameter
    },
    {
      forDeclaration: (declaration) => frontend.hostProtocols.get(declaration) ?? null,
      basesOf: (native) => hostBaseChain(native)
    },
    {
      forDeclaration: (declaration) => frontend.typedArrayElements.get(declaration) ?? null
    },
    // `Promise<T>`'s own declaration identity, resolved once by the frontend
    // independent of whether the program's own text ever names `Promise`
    // (`frontend.ts`'s `promiseDeclarationOf`) -- an `async` function's
    // return type mentions it with no textual reference the ambient-value
    // seed walk that finds `hostProtocols`/`typedArrayElements` could ever
    // pick up.
    {
      forDeclaration: (declaration) => declaration === frontend.promiseDeclaration
    },
    // `Map`/`Set`/`WeakMap`/`WeakSet`, resolved by the frontend the same way
    // and for the same reason `promiseDeclaration` is -- see
    // `keyedCollectionDeclarationsOf` (semantics/host-protocols.ts). It is a
    // policy rather than a table for the reason stated above this call: the
    // deriver may not know what the standard library is, and the frontend may
    // not know what a carrier is.
    {
      forDeclaration: (declaration) => frontend.keyedCollections.get(declaration) ?? null
    },
    // `ArrayBuffer`/`DataView`, resolved by the frontend the same way and for
    // the same reason -- see `standardBufferDeclarationsOf`
    // (semantics/host-protocols.ts).
    {
      forDeclaration: (declaration) => frontend.standardBuffers.get(declaration) ?? null
    },
    // What carries a host namespace ROOT. Keyed by structural type, not by
    // declaration, and that is not a stylistic difference from its four
    // siblings above: a root is a VALUE, and `window`'s value type is the
    // intersection `Window & typeof globalThis`, which names no declaration at
    // all. See `HostNamespaceRootPolicy` (representation/policies.ts).
    {
      forType: (type) => frontend.hostNamespaceRoots.get(type) ?? null
    },
    // `Date`'s own declaration identity, resolved by the frontend the same way
    // and for the same reason `promiseDeclaration` is (`dateDeclarationOf`,
    // semantics/host-protocols.ts) -- a program can receive a Date through an
    // imported signature and never name the type itself.
    //
    // This is the one policy that carries a C++ SPELLING, and the join is
    // here on purpose: the declaration is the frontend's answer, the spelling
    // is the backend's (`targets/cpp/prototype/emit-prototype-date.ts` owns every Date
    // spelling this compiler has), and `derive.ts` may know neither. Date is
    // an ECMAScript builtin from `lib.es5`, not a gea host protocol, so its
    // spelling belongs to the compiler's own tables and never to a plugin
    // package's `nativeTypes`.
    {
      forDeclaration: (declaration) => (declaration === frontend.dateDeclaration ? cppDateType : null)
    },
    // `Generator<T, TReturn, TNext>`'s own declaration identity, resolved once
    // by the frontend for the identical reason `promiseDeclaration` is: a
    // `function*`'s return type mentions it with no textual reference the
    // ambient-value seed walk could pick up.
    {
      forDeclaration: (declaration: DeclarationId) =>
        declaration === frontend.generatorDeclaration ||
        declaration === frontend.asyncGeneratorDeclaration ||
        declaration === frontend.mapIteratorDeclaration
    },
    // `RegExp`/`RegExpExecArray`/`RegExpMatchArray`, resolved by the frontend
    // the same way `promiseDeclaration` and `keyedCollections` are, and
    // installed here for the same reason: the deriver may not know what the
    // standard library is, and the frontend may not know what a carrier is.
    //
    // This is the one policy that is COMPOSED here rather than forwarded. The
    // frontend answers which declaration it is; `cppRegExpNativeTypes`
    // (targets/cpp/regexp-types.ts) answers what this target spells it, and
    // `src/representation/` may not name a C++ type at all. This function is
    // already the composition root that defaults the conversion registry to
    // the C++ one, so it is the place the two authorities meet.
    {
      forDeclaration: (declaration) => {
        const kind = frontend.regexpDeclarations.get(declaration)
        return kind ? { kind, native: cppRegExpNativeTypes[kind] } : null
      }
    },
    // `String`, the wrapper OBJECT interface, resolved by the frontend the
    // same way `Date` is and composed here for the identical reason `RegExp`
    // immediately above is: the frontend answers WHICH declaration it is
    // (`frontend.stringObjectDeclaration`, `stringObjectDeclarationOf`),
    // `cppStringObjectNativeType` (targets/cpp/regexp-types.ts) answers
    // what this target spells it, and `src/representation/` may not name a
    // C++ type at all.
    {
      forDeclaration: (declaration) => (declaration === frontend.stringObjectDeclaration ? cppStringObjectNativeType : null)
    },
    // The bare `Function` interface's own declaration identity, resolved once
    // by the frontend for the identical reason `generatorDeclaration` is: a
    // program reaches the type constantly (`typeof x === 'function'`,
    // `x.constructor`) with no textual reference the ambient-value seed walk
    // could pick up. Forwarded rather than composed -- unlike `Date`/`String`,
    // the carrier names no C++ type for this target to spell.
    {
      forDeclaration: (declaration: DeclarationId) => declaration === frontend.functionDeclaration
    },
    // Class heritage, forwarded from the frontend's own checker-answered walk
    // (`classHeritageOf`, semantics/class-heritage.ts). Forwarded rather than
    // composed for the same reason the generator declaration is: the answer
    // names declarations, not C++ types, so this target has nothing to add.
    {
      forDeclaration: (declaration: DeclarationId) => frontend.classHeritage.get(declaration) ?? [],
      constructorSlotSubclassesOf: (declaration: DeclarationId) => frontend.constructorSlotSubclasses.get(declaration) ?? []
    },
    { forType: (id) => valueRecords.has(id) },
    // The classes this program declares as each interface's implementations,
    // forwarded from the frontend for the same reason class heritage is: the
    // answer names declarations, and it is read off `implements` clauses,
    // which only the semantic layer may look at.
    {
      forDeclaration: (declaration: DeclarationId) => frontend.interfaceImplementors.get(declaration) ?? []
    },
    {
      forDeclaration: (declaration: DeclarationId) => (frontend.errorDeclarations.has(declaration) ? cppErrorNativeType : null)
    },
    request.dynamicFallback ?? false,
    frontend.dynamicFallbackTypes,
    frontend.dynamicFallbackCallables,
    frontend.dynamicWrittenTypes,
    // The copies of every generic class whose copies can differ in layout,
    // forwarded from the frontend's typing for the deriver to group into
    // physical classes (`physicalClassDeclarationOf`).
    { copiesOf: (declaration: DeclarationId) => frontend.classCopies.get(declaration) ?? [] }
  )
  // The backend's own registry is the default, not `empty`: a compilation that
  // asked for no registry is asking this compiler to use the target it has, and
  // handing it an empty one made every conversion an uninstalled capability
  // regardless of what the target could really do. A caller may still pass its
  // own -- that is what measuring a target with a capability removed looks like.
  // This projection depends only on the sealed graph and representation plan.
  // Build it before conversions so the C++ registry can certify structural
  // class-to-interface views from the same member table emission later uses.
  const declaredClasses = projectClasses({
    graph: frontend.graph,
    plan: representations.plan,
    deriver: representations.deriver,
    uninstantiable: frontend.uninstantiableClasses
  })
  // `createCppTargetManifest` (targets/cpp/manifest.ts) is the permanent home
  // for every backend capability row, this one included, and it should move
  // there outright the next time that file is free to edit. The claim is not
  // provisional in the meantime: `bindingReference` (targets/cpp/emit-context.ts)
  // and the extern declarations `translation-unit.ts` renders both go through
  // one carrier-derived, uniform recipe for every ambient value binding, never
  // a per-declaration one, so this backend genuinely has the capability for
  // any ambient global a program names, not only the one that motivated it.
  // The spellings that render the host protocols, unioned here rather than in
  // the emitter, so a protocol's claim and its template are admitted by one
  // step over one set of plugins. A backend entry wins a collision: a plugin
  // may add a host the backend does not have, and may not redefine one it
  // does, for the same reason it cannot remove a capability row. Built before
  // the manifest because the manifest publishes this table's keys
  // (`hostMembers`) for certification to check host member reads against.
  const hostMembers: HostMemberTable = new Map([...plugins.flatMap((plugin) => [...plugin.capabilities.hostMembers]), ...coreHostMembers])
  const backend = createCppTargetManifest(
    representations.plan,
    undefined,
    (function* () {
      for (const operation of frontend.graph.operations.values()) {
        if (operation.family !== 'computation' || operation.form !== 'typeof') continue
        const representation = typeofOperandRepresentationOf(operation, representations.plan, representations.deriver)
        if (representation !== undefined) yield representation
      }
    })(),
    coreHostMembers,
    (function* () {
      for (const operation of frontend.graph.operations.values()) {
        if (operation.family !== 'computation' || operation.operator !== 'ObjectTag') continue
        const representation = typeofOperandRepresentationOf(operation, representations.plan, representations.deriver)
        if (representation !== undefined) yield representation
      }
    })(),
    new Map(plugins.flatMap((plugin) => [...(plugin.capabilities.hostInstanceTests ?? new Map<string, string>())]))
  )
  // A plugin's capabilities are unioned in, never allowed to remove a row. A
  // plugin installs a runtime of its own -- helpers the backend alone does not
  // carry -- but it cannot make the backend able to do less than it can, and a
  // merge that let it would turn preflight's answer into a negotiation.
  const manifest: TargetRuntimeManifest = {
    ...backend,
    supportsExternalBindings: true,
    runtimeHelpers: union(
      backend.runtimeHelpers,
      plugins.flatMap((plugin) => [...plugin.capabilities.runtimeHelpers])
    ),
    propertyRecipes: union(
      backend.propertyRecipes,
      plugins.flatMap((plugin) => [...plugin.capabilities.propertyRecipes])
    ),
    // Claimed by CARRIER, not by declared name: the runtime type is the thing a
    // target either has or does not, and thirty-nine names resolving to
    // twenty-six carriers means twenty-six claims. A per-name claim set would
    // let two names for one runtime type be admitted separately and then
    // disagree, which is the whole failure the join key exists to prevent.
    nativeProtocols: union(backend.nativeProtocols, [
      ...plugins.flatMap((plugin) => [...plugin.capabilities.nativeProtocols]),
      ...(request.dynamicFallback ? ['ProxyConstructor@1', 'FunctionConstructor@1'] : []),
      ...[...new Set([...nativeTypes.values(), ...[...nativeTypesByDeclaration.values()].map((row) => row.native)])].map(
        (carrier) => `${carrier}@1`
      )
    ]),
    hostInvocations: new Set(plugins.flatMap((plugin) => [...(plugin.capabilities.hostInvocations ?? new Map()).keys()])),
    hostConstructors: new Set(plugins.flatMap((plugin) => [...plugin.capabilities.hostConstructors.keys()])),
    hostMembers: new Set(hostMembers.keys())
  }
  // The reflectable member list per protocol NAME, collected out of this
  // program's own host-protocol census (`frontend.hostProtocols`, keyed by
  // DECLARATION) rather than a table this file states -- see
  // `HostProtocolBinding.members`'s own comment for why the list has to come
  // from there. Two declarations could in principle bind the same protocol
  // name; the later one wins, which is the identical last-write precedence
  // every other table on `hosts` already takes for a collision.
  const intrinsicMembers = new Map(
    [...frontend.hostProtocols.values()].flatMap((binding) => (binding.members ? [[binding.protocol, binding.members] as const] : []))
  )
  // The construct half of the same union. There is no core table to merge on
  // top: the protocols this backend constructs itself (`Error`, `String`,
  // `Number`) are rendered by `hostInvocations` in `emit-host-invoke.ts`, whose
  // spellings depend on the call's own static types and so are code rather than
  // a template. A plugin row and a backend renderer for one protocol would be
  // two authorities, which is why the renderer is consulted only when no row
  // claims the protocol.
  const hosts: HostSpellings = {
    members: hostMembers,
    intrinsicMembers,
    voidResults: new Set(plugins.flatMap((plugin) => [...plugin.capabilities.hostMemberVoidResults])),
    constructors: new Map(plugins.flatMap((plugin) => [...plugin.capabilities.hostConstructors])),
    invocations: new Map(plugins.flatMap((plugin) => [...(plugin.capabilities.hostInvocations ?? new Map())])),
    instanceTests: new Map(plugins.flatMap((plugin) => [...(plugin.capabilities.hostInstanceTests ?? new Map())])),
    // The language's own global functions (`parseInt`, `isNaN`, ...) unioned on
    // top of the plugins' the same way `hostMembers` is above, and with the same
    // precedence rule: a plugin may add a global the backend does not have, and
    // may not redefine one it does. They are ECMAScript's, present in every
    // conforming environment, so the backend is where they belong.
    arraySnapshotFunctions: new Set(plugins.flatMap((plugin) => [...(plugin.capabilities.hostArraySnapshotFunctions ?? [])])),
    nativeArrayFunctions: new Set(plugins.flatMap((plugin) => [...(plugin.capabilities.hostNativeArrayFunctions ?? [])])),
    functions: new Map([...plugins.flatMap((plugin) => [...plugin.capabilities.hostFunctions]), ...coreHostFunctions]),
    // Unioned the same way, one table per question. Two plugins claiming the
    // same global would be two hosts claiming one name, which is a
    // configuration this compiler cannot resolve and does not pretend to: the
    // later row wins, exactly as it does for every other table here.
    namespaces: {
      roots: new Set(['Reflect', ...plugins.flatMap((plugin) => [...plugin.capabilities.hostNamespaces.roots])]),
      typeofs: new Map(plugins.flatMap((plugin) => [...plugin.capabilities.hostNamespaces.typeofs])),
      methods: new Map([
        ['Reflect.get', { kind: 'path', text: 'gea::reflectGet', arguments: 'dynamic', result: 'dynamic' }],
        ['Reflect.set', { kind: 'path', text: 'gea::reflectSet', arguments: 'dynamic' }],
        ['Reflect.has', { kind: 'path', text: 'gea::reflectHas', arguments: 'dynamic' }],
        ['Reflect.deleteProperty', { kind: 'path', text: 'gea::reflectDelete', arguments: 'dynamic' }],
        ['Reflect.getOwnPropertyDescriptor', { kind: 'path', text: 'gea::reflectOwnDescriptor', arguments: 'dynamic', result: 'dynamic' }],
        // The key-array carrier belongs to this call's native recipe; there
        // is no single runtime function ABI to materialize for this template.
        ['Reflect.ownKeys', { kind: 'template', emit: 'gea::reflectOwnKeys({arg0})' }],
        ...plugins.flatMap((plugin) => [...plugin.capabilities.hostNamespaces.methods])
      ]),
      properties: new Map(plugins.flatMap((plugin) => [...plugin.capabilities.hostNamespaces.properties])),
      propertySetters: new Map(plugins.flatMap((plugin) => [...plugin.capabilities.hostNamespaces.propertySetters]))
    },
    singletons: new Set(plugins.flatMap((plugin) => [...plugin.capabilities.hostSingletons])),
    preambles: new Map(plugins.flatMap((plugin) => [...plugin.capabilities.hostPreambles])),
    includes: new Map(plugins.flatMap((plugin) => [...plugin.capabilities.nativeIncludes])),
    // One answer, not a union: a fragment is one node, so two hosts that both
    // had one would be two hosts claiming one syntax. The last plugin to state
    // one wins, exactly as the later row wins in every table above, and a
    // configuration with none leaves fragments refused by name.
    fragment: plugins.reduce<string | null>((claimed, plugin) => plugin.capabilities.elementFragment ?? claimed, null),
    // Unioned like every other table here, and read AFTER `runFrontend` above
    // has finished: a plugin fills this one while normalizing (a class
    // declaration is not known before the program is read), and shares the
    // live map rather than a copy, so flattening it here sees the whole
    // answer. See `PluginCapabilities.reactiveClassFields`.
    reactive: {
      fields: new Map(plugins.flatMap((plugin) => [...plugin.capabilities.reactiveClassFields])),
      // One answer, not a union, for the same reason `fragment` is one: a field
      // is held in one cell type. The last plugin to state one wins, and a
      // configuration with none leaves every field a plain member.
      cell: plugins.reduce<string | null>((claimed, plugin) => plugin.capabilities.nativeReactiveCell ?? claimed, null),
      // Unioned rather than last-wins, unlike `cell`: two plugins each naming a
      // header is two headers a unit needs, not a disagreement about one.
      cellPreamble: [...new Set(plugins.flatMap((plugin) => [...plugin.capabilities.nativeReactiveCellPreamble]))],
      // Empty here, filled by `translation-unit.ts`: the answer is read off the
      // lowered IR, which does not exist yet at this point in the pipeline.
      dependencies: new Map(),
      nodeDependencies: new Map(),
      revisions: new Map(),
      celled: new Map(),
      boundRecordFields: new Map()
    }
  }
  stage('representations')
  const preflight = runPreflight({ semanticGraph: frontend.graph, representationPlan: representations.plan, manifest })
  stage('preflight')
  const diagnostics = sweepDiagnostics({
    graph: frontend.graph,
    representations,
    preflight,
    frontend: [...frontend.checkerDiagnostics, ...frontend.intrinsicProtocolDiagnostics],
    locationOfNode: frontend.locationOfNode
  })

  // The ABI projection runs after preflight and before any body lowers:
  // a body reads its own frame, and a frame that is decided per body is a frame
  // two bodies can disagree about.
  const abis = projectAbis({
    graph: frontend.graph,
    plan: representations.plan,
    deriver: representations.deriver,
    locationOfDeclaration: frontend.locationOfDeclaration
  })
  const placements = projectBindingPlacements({
    graph: frontend.graph,
    plan: representations.plan,
    externals: frontend.externalBindings,
    absentBindings: frontend.absentBindings,
    externalFiles: frontend.externalBindingFiles,
    // `NaN`/`Infinity` and `parseInt`/`parseFloat`/`isNaN`/`isFinite`, unioned
    // on top of the plugins' tables by the same rule as `hosts` above. Without
    // them these names fall through to the ordinary external-cell case, and the
    // unit declares an `extern` for a symbol no object file defines.
    hostConstants: new Map([...plugins.flatMap((plugin) => [...plugin.capabilities.nativeConstants]), ...coreHostConstants]),
    // Per-declaration-file, unioned the same way `hostFunctionsByDeclaration`
    // is: each plugin's own table is keyed by ITS declaration files, so a
    // union of the per-plugin maps cannot let one plugin's file collide with
    // another's.
    hostConstantsByDeclaration: new Map(plugins.flatMap((plugin) => [...plugin.capabilities.hostConstantsByDeclaration])),
    hostFunctions: new Map([...plugins.flatMap((plugin) => [...plugin.capabilities.hostFunctions]), ...coreHostFunctions]),
    hostFunctionsByDeclaration: new Map(plugins.flatMap((plugin) => [...plugin.capabilities.hostFunctionsByDeclaration])),
    // The backend's own table, unioned in the same way `coreHostMembers` is
    // above and for the same reason: `btoa`/`encodeURIComponent` are language
    // builtins, so a plugin row for one would make an ECMAScript global
    // conditional on which host is installed. Passed separately rather than
    // merged into `hostFunctions`, because the two are admitted differently --
    // see `BindingPlacementInput.coreGlobalFunctions`.
    coreGlobalFunctions,
    coreGlobalClasses,
    standardLibraryExternals: frontend.standardLibraryBindings,
    hostNamespaces: hosts.namespaces,
    hostNamespaceRootsByDeclaration: new Map(plugins.flatMap((plugin) => [...plugin.capabilities.hostNamespaceRootsByDeclaration])),
    hostNamespaceBindings: frontend.hostNamespaceBindings,
    exactHostNamespaceNames: new Set(hostNamespaceRootDeclarations.map((row) => row.declarationName)),
    hostSingletons: hosts.singletons,
    hostSingletonsByDeclaration: new Map(plugins.flatMap((plugin) => [...plugin.capabilities.hostSingletonsByDeclaration])),
    hostSingletonBindings: frontend.hostSingletonBindings
  })
  stage('diagnostics+abi')
  const slotsForClasses = (classes: ReadonlyMap<DeclarationId, ClassLayout>) =>
    createSlotCensus({
      graph: frontend.graph,
      plan: representations.plan,
      deriver: representations.deriver,
      abis: abis.abis,
      constructs: abis.constructs,
      callableOrigins: abis.callableOrigins,
      classes,
      placements,
      hostMembers,
      hostMethodAliasDeclarations: hostMethodAliasDeclarations(frontend.graph, representations.plan, representations.deriver, hostMembers),
      slotHooks: plugins.flatMap((plugin) => (plugin.slotOf ? [plugin.slotOf] : []))
    })
  const nativeClassStorage = projectNativeClassStorage(
    declaredClasses,
    representations.deriver,
    nativeClassFieldUsesOf(frontend.graph, representations.plan, representations.deriver, declaredClasses, slotsForClasses(declaredClasses))
  )
  const classes = new Map(
    [...declaredClasses].map(([declaration, layout]) => {
      const nativeStorage = nativeClassStorage.get(declaration)
      return [declaration, nativeStorage === undefined ? layout : { ...layout, nativeStorage }]
    })
  )
  const conversionRegistry =
    request.conversionRegistry ??
    // No heritage policy: a `class-ref` carrier now STATES its own ancestors
    // (`representation/model.ts`), so the upcast/downcast admissions read the
    // fact off the carrier instead of asking a second authority for it.
    createCppConversionRegistry(recordLayoutPolicyOf(representations.deriver, classes))
  const conversions = buildConversionGraph(
    representations.plan,
    conversionRegistry,
    // Inline constants have no published result in the plan, but lowering
    // still converts them when they enter a merge or another typed slot.
    (function* () {
      for (const operation of frontend.graph.operations.values()) {
        for (const operand of operation.operands) {
          if (operand.source.kind === 'constant') yield representations.deriver.derive(operand.type)
        }
      }
    })()
  )
  const conversionCensus = createConversionNodes({ registry: conversionRegistry, nodes: conversions.nodes })
  // Lowering runs on the plan's verdict alone. An uncertified program lowers
  // too, so its refusals are rows beside preflight's rather than a stage that
  // never ran; only emission waits for the certificate (see the header).
  const lowered = diagnostics.planClean
    ? lowerToIr({
        graph: frontend.graph,
        plan: representations.plan,
        deriver: representations.deriver,
        abis: abis.abis,
        constructs: abis.constructs,
        callableOrigins: abis.callableOrigins,
        callableOwnPropertyWrites: abis.callableOwnPropertyWrites,
        functionPrototypePropertyWrites: abis.functionPrototypePropertyWrites,
        abiBlockers: new Map(abis.blocked.map((blocker) => [blocker.functionId, blocker.reason])),
        classes,
        slots: slotsForClasses(classes),
        conversions: conversionCensus,
        plugins
      })
    : null

  stage('lowering')
  // A partially lowered program renders a partially correct file, which is
  // worse than rendering none: the missing half is invisible in the output.
  // So text is produced only when every body lowered, and the blockers travel
  // back either way so the caller can say which ones did not.
  const complete = lowered !== null && lowered.blocked.length === 0
  // A generator whose formals need real work (a default, or a destructured
  // pattern) was lowered as one body with a marker `ir/lower.ts` left on it
  // (`IrBody.generatorPrologueBoundary`); this carves that one body into the
  // ordinary/coroutine pair ECMA-262's own timing needs -- see
  // `ir/generator-split.ts`. Run once here, after lowering and before both
  // consumers of the body list, so the shaker and the emitter agree on which
  // bodies -- and which placements, since a bridged cell mints its own -- the
  // program actually has.
  const split = complete && lowered ? splitGeneratorBodies(lowered.bodies, placements) : null
  const splitBodies = split?.bodies ?? lowered?.bodies ?? new Map()
  const splitPlacements = split?.placements ?? placements
  const pruned = complete
    ? pruneProvenBranches(splitBodies, frontend.graph, lowered?.slotDrift ?? [])
    : { bodies: splitBodies, slotDrift: lowered?.slotDrift ?? [] }
  // What the entry can reach, computed once over the whole lowered program.
  //
  // Placed here rather than inside emission because emission is a renderer:
  // which bodies a program HAS is a question about the program, and the answer
  // has to be the same one every artifact of the unit is built from -- the
  // capture index, the reactive dependencies, the forward signatures and the
  // thunks all read the body list, and two of them disagreeing about it is a
  // symbol declared and never defined. See `ir/shake.ts` for the rules and for
  // why the cut is after lowering rather than before it.
  const shaken =
    complete && lowered
      ? shakeProgram({
          bodies: pruned.bodies,
          placements: splitPlacements,
          classes,
          deriver: representations.deriver,
          // A computed class read keeps only methods the C++ callable
          // conversion authority can actually publish at that read's ABI.
          // Passing the question in keeps the generic IR shaker free of C++
          // spellings while making pruning and emission share one answer.
          computedMethodCanFill: (callable, target) => {
            const abi = abis.abis.get(callable)
            // A read the checker typed `any` boxes whatever method the key
            // selects; the boxing conversion is the same authority, asked
            // against the `dynamic` carrier.
            if (abi === undefined || (target.kind !== 'function-value-dispatch' && target.kind !== 'dynamic')) return false
            return conversionCensus.nodeFor({ kind: 'function-value-dispatch', abi }, target).capability.kind !== 'never'
          }
        })
      : null
  // Which cells a closure captures, and whether a captured cell is boxed
  // (a program fact, so it belongs to the IR), computed once here from the
  // FINAL, shaken body set -- not the pre-shake one `split` produced -- so a
  // relay edge through a callable `shakeProgram` removed as dead cannot
  // widen a surviving owner's environment past what
  // `targets/cpp/captures.ts` used to compute from this same, already-shaken
  // list at render time. `renderTranslationUnit` reads the published fact
  // off each body instead of re-deriving it from a fresh walk.
  const captureFacts = shaken
    ? publishCaptureFacts(
        shaken.bodies,
        splitPlacements,
        recordAccessorBodiesOf([...representations.plan.selected.values()], representations.deriver)
      )
    : null
  // `CallOperation.target` (a fact moved out of the target): which
  // FunctionId a call's callee resolves to statically, so the target reads a
  // fact instead of re-deriving it from a whole-unit capture index at render
  // time. This is the SAME rewrite-after-the-shake step captures itself
  // needed, applied to operations rather than bodies
  // (`ir/generator-split.ts`'s pattern, `ir/call-dispatch.ts`) -- it has to
  // run here because the capture-freedom test every branch of the target
  // bottoms out in (`IrBody.facts`) does not exist until `captureFacts`
  // above has published it, and every `call` operation was already built by
  // `lowerToIr`, long before that.
  //
  // The dispatchability verdict this needs for its `virtual` branch
  // (`projection/dispatch.ts`'s `virtualDispatchVerdictOf`) is computed here
  // from `shaken.classes` -- the SAME, already-pruned layout map
  // `renderTranslationUnit` is handed below -- so this pass and
  // `translation-unit.ts`'s own (separate, render-time) call to the same
  // pure function can never disagree: both read the identical classes,
  // ABIs, capture facts and conversion census.
  const bodyFactsBySourceOwner = new Map(
    captureFacts ? [...captureFacts.values()].map((body) => [String(body.sourceOwner), body.facts] as const) : []
  )
  const capturesNothingOf = (callable: FunctionId): boolean => {
    const facts = bodyFactsBySourceOwner.get(String(callable))
    return facts === undefined || (facts.capturedDeclarations.length === 0 && facts.capturedReceiver === null)
  }
  const dispatchVerdict = shaken
    ? virtualDispatchVerdictOf(shaken.classes, (callable) => abis.abis.get(callable) ?? null, capturesNothingOf, conversionCensus)
    : null
  let dispatchedBodies =
    captureFacts && shaken && dispatchVerdict
      ? fillCallDispatchTargets(
          captureFacts,
          splitPlacements,
          shaken.classes,
          (callable) => abis.abis.get(callable) ?? null,
          capturesNothingOf,
          dispatchVerdict,
          representations.deriver,
          conversionCensus
        )
      : captureFacts
  // Physical emission dependencies come from the final program. The sealed
  // plan stays intact as carrier authority and as the incomplete-shake fallback.
  const resolveClassRef = physicalClassInstanceResolverOf(
    shaken?.classes ?? classes,
    frontend.graph.structuralTypes,
    representations.deriver
  )
  let emissionRepresentations = shaken
    ? publishEmissionRepresentationsOf({
        bodies: dispatchedBodies ?? shaken.bodies,
        placements: splitPlacements,
        classes: shaken.classes,
        resolveClassRef,
        deriver: representations.deriver,
        conversions: conversionCensus,
        omitGlobals: shaken.unreferencedCells,
        complete: shaken.refused === null,
        fallbackRoots: [...representations.plan.selected.values()]
      })
    : undefined
  stage('emission-carriers')
  // Candidate native reads become executable only after the one reflection
  // census proves their layouts stay closed across the reachable program.
  let reflection = shaken
    ? reflectionExposureOf([...(dispatchedBodies ?? shaken.bodies).values()], shaken.classes, representations.deriver, {
        representations: emissionRepresentations?.representations ?? [...representations.plan.selected.values()],
        wellKnownSymbols: frontend.wellKnownSymbols,
        physicalClasses: physicalClassLayoutsOf(
          shaken.classes,
          emissionRepresentations?.representations ?? [...representations.plan.selected.values()]
        ).layouts,
        placements: splitPlacements,
        conversions: conversionCensus,
        trace: request.includeIr === true,
        shakeComplete: shaken.refused === null && emissionRepresentations?.complete === true
      })
    : undefined
  // Closed containers can transport callable records through their native
  // fields. Newly authenticated calls can close further containers. Grow the
  // same call/reflection censuses to a fixed point before ownership or emission
  // consumes either publication; no printer derives this provenance.
  if (shaken && dispatchedBodies && reflection && dispatchVerdict) {
    const closedFactsOf = (bodies: Iterable<IrBody>): number => {
      let count = 0
      for (const body of bodies)
        for (const block of body.blocks.values())
          for (const operation of block.operations)
            if (
              operation.kind === 'get' || operation.kind === 'binding-read'
                ? operation.closedCallable !== undefined
                : operation.kind === 'call' && operation.closedCallee !== undefined
            )
              count++
      return count
    }
    let count = closedFactsOf(dispatchedBodies.values())
    for (;;) {
      const next = fillCallDispatchTargets(
        dispatchedBodies,
        splitPlacements,
        shaken.classes,
        (callable) => abis.abis.get(callable) ?? null,
        capturesNothingOf,
        dispatchVerdict,
        representations.deriver,
        conversionCensus,
        reflection
      )
      const nextCount = closedFactsOf(next.values())
      if (nextCount <= count) break
      count = nextCount
      dispatchedBodies = next
      emissionRepresentations = publishEmissionRepresentationsOf({
        bodies: dispatchedBodies,
        placements: splitPlacements,
        classes: shaken.classes,
        resolveClassRef,
        deriver: representations.deriver,
        conversions: conversionCensus,
        omitGlobals: shaken.unreferencedCells,
        complete: shaken.refused === null,
        fallbackRoots: [...representations.plan.selected.values()]
      })
      reflection = reflectionExposureOf([...dispatchedBodies.values()], shaken.classes, representations.deriver, {
        representations: emissionRepresentations.representations,
        wellKnownSymbols: frontend.wellKnownSymbols,
        physicalClasses: physicalClassLayoutsOf(shaken.classes, emissionRepresentations.representations).layouts,
        placements: splitPlacements,
        conversions: conversionCensus,
        trace: request.includeIr === true,
        shakeComplete: shaken.refused === null && emissionRepresentations.complete
      })
    }
  }
  const finalizedReads = shaken && reflection ? finalizeTypedComputedReads(dispatchedBodies ?? shaken.bodies, reflection) : null
  const fieldOwnership =
    shaken && reflection && finalizedReads
      ? finalizeNativeFieldOwnership(finalizedReads, shaken.classes, representations.deriver, conversionCensus, reflection, (reads) =>
          nativeClassFieldUsesOf(frontend.graph, representations.plan, representations.deriver, classes, slotsForClasses(classes), reads)
        )
      : null
  // Presence is the census's to prove, not the checker's to assert: a load out
  // of an `optional` that no program fact proves present tests before it reads
  // (`ir/presence-proof.ts`). Which loads read unchecked is the conversion
  // census's fact -- `targets/cpp/conversions.ts` installs `operator*` as the
  // `present-optional` materializer.
  const readsUnchecked = (operation: ConvertOperation): boolean => {
    const node = conversionCensus.nodeById(operation.conversionUse)
    return (
      (node?.capability.kind === 'atom' || node?.capability.kind === 'static') && node.capability.materializer.domain === 'present-optional'
    )
  }
  const finalizedBodies = (() => {
    const bodies = fieldOwnership?.bodies ?? finalizedReads
    return bodies ? withPresenceChecks(bodies, readsUnchecked) : null
  })()
  const executableClasses = fieldOwnership?.classes ?? shaken?.classes ?? classes
  if (shaken && fieldOwnership && fieldOwnership.classes !== shaken.classes) {
    // Relocation preserves every lowered field carrier, but changes which
    // native layouts and dispatch identities the emitted program requires.
    emissionRepresentations = publishEmissionRepresentationsOf({
      bodies: fieldOwnership.bodies,
      placements: splitPlacements,
      classes: executableClasses,
      resolveClassRef: physicalClassInstanceResolverOf(executableClasses, frontend.graph.structuralTypes, representations.deriver),
      deriver: representations.deriver,
      conversions: conversionCensus,
      omitGlobals: shaken.unreferencedCells,
      complete: shaken.refused === null,
      fallbackRoots: [...representations.plan.selected.values()]
    })
  }
  const physicalClasses =
    shaken && emissionRepresentations ? physicalClassLayoutsOf(executableClasses, emissionRepresentations.representations) : undefined
  if (reflection && physicalClasses) reflection = closePhysicalClassReflection(reflection, physicalClasses.layouts)
  // A union read's class arm that provably lacks the key reads `undefined`;
  // only the CLOSED exposure can say its class never gained a dynamic protocol.
  const emittedBodies =
    finalizedBodies && reflection ? finalizeAbsentClassArms(finalizedBodies, reflection, executableClasses) : finalizedBodies
  stage('reflection')
  // Certification is a walk of the IR lowering actually built
  // (one question, one census): every capability the printer
  // will need is read off the operation that needs it and looked up in the
  // manifest's own sets, so nothing the printer asks for was left unasked.
  //
  // It runs on the SHAKEN bodies, after the generator split and after
  // `publishCaptureFacts`, because the certificate has to describe the
  // program that is printed. Certifying the pre-shake list demanded
  // capabilities for bodies the shaker then deleted -- a refusal in code the
  // unit never emits -- and it ran before `IrBody.facts` existed, which is
  // why captures went uncertified and were refused at print instead. An
  // incomplete program has no shaken list at all, so it certifies the bodies
  // lowering did build: its refusals are the point of running at all, and
  // dropping them would hide why it did not lower.
  const certifiedBodies = emittedBodies ?? lowered?.bodies ?? null
  const certification: IrCertification | null =
    lowered && certifiedBodies
      ? certifyIr({
          bodies: certifiedBodies,
          placements: splitPlacements,
          slotDrift: pruned.slotDrift,
          blocked: lowered.blocked,
          manifest,
          conversions: conversionCensus,
          deriver: representations.deriver,
          classes: executableClasses,
          ...(reflection ? { reflection } : {}),
          externalBindings: new Set(frontend.externalBindings.keys()),
          deadTypeofGuards: frontend.deadTypeofGuards,
          graph: frontend.graph
        })
      : null
  stage('certify')
  // Certification requires a clean sweep as well as a clean IR walk, and the
  // difference is not academic. The walk reads the bodies lowering built, so a
  // family whose producer never ran lowers nothing, demands nothing, and leaves
  // the walk vacuously clean -- a green answer for a program that was never
  // normalized at all. The sweep is what sees the census blockers, the plan's
  // guard violations and the checker's own errors, so it is the honest gate.
  //
  // The certificate itself is minted from the actual plan, graph, manifest and
  // demanded-key census rather than from a caller-supplied identity, so a
  // caller cannot hand in a name and acquire authority it did not earn.
  const certificate =
    diagnostics.clean && certification
      ? mintCapabilityCertificate(certification, { plan: representations.plan, semanticSnapshot: frontend.graph, manifest })
      : null
  const rendered =
    complete && certificate && shaken
      ? renderTranslationUnit({
          plan: representations.plan,
          structuralTypes: frontend.graph.structuralTypes,
          bodies: [...(emittedBodies ?? withPresenceChecks(shaken.bodies, readsUnchecked)).values()],
          omitGlobals: shaken.unreferencedCells,
          placements: splitPlacements,
          // The SHAKEN layouts. Emission renders a class's methods and
          // accessors from its layout, so a member whose body the shake
          // dropped has to be gone from here too -- see `ir/shake.ts`'s
          // `prunedClass`. Identical to `classes` whenever the pass declines.
          classes: executableClasses,
          ...(physicalClasses ? { physicalClasses: physicalClasses.layouts } : {}),
          hosts,
          runtimeDefinitions: plugins.flatMap((plugin) => [...plugin.capabilities.runtimeDefinitions]),
          moduleOrder: frontend.moduleOrder,
          entrySymbol: request.entrySymbol === undefined ? defaultEntrySymbol : request.entrySymbol,
          // `'preferred'` rather than `false`: a unit that is the whole program
          // has nothing to collide with, but internal linkage is still what
          // lets the C++ compiler see a function is never called from
          // elsewhere. See `CppSymbolIsolation`.
          isolateSymbols: request.isolateSymbols === true ? 'required' : 'preferred',
          layout: request.translationUnits ?? 'single',
          unitBaseName: request.unitBaseName ?? 'unit',
          sourceFileNames: frontend.sourceFileNames,
          wellKnownSymbols: frontend.wellKnownSymbols,
          // The one deriver this compilation built, so emission asks the same
          // authority the plan did. See `RepresentationPublication.deriver`.
          deriver: representations.deriver,
          conversions: conversionCensus,
          ...(emissionRepresentations ? { emissionRepresentations: emissionRepresentations.representations } : {}),
          ...(reflection ? { reflection } : {}),
          certificate
        })
      : null

  stage('emit')
  return {
    dynamicFallback: {
      enabled: request.dynamicFallback ?? false,
      valueCount: [...representations.plan.selected.values()].filter(
        (value) => value.kind === 'dynamic' && value.reason === 'opt-in-fallback'
      ).length
    },
    locationOfNode: frontend.locationOfNode,
    locationOfDeclaration: frontend.locationOfDeclaration,
    textOfNode: frontend.textOfNode,
    graph: frontend.graph,
    sourceFileNames: frontend.sourceFileNames,
    sourcePreparations: frontend.sourcePreparations,
    representations,
    manifest,
    preflight,
    certificate,
    diagnostics,
    uninstalledFamilies: frontend.uninstalledFamilies,
    censusAccounting: frontend.censusAccounting,
    cellFacts: frontend.cellFacts,
    conversionNodes: conversions.nodes,
    conversionCensus,
    source: rendered?.source ?? null,
    units: rendered?.units ?? [],
    loweringBlockers: lowered?.blocked ?? [],
    certification,
    refusals: refusalsOf(
      frontend.censusRefusals,
      abis.blocked,
      lowered?.blocked ?? [],
      certification?.refusals ?? [],
      rendered?.refused ?? []
    ),
    slotDrift: pruned.slotDrift,
    printerDrift: rendered?.printerDrift ?? [],
    abiBlockers: abis.blocked,
    emissionRefusals: rendered?.refused ?? [],
    artifacts: plugins.flatMap((plugin) => (plugin.writeArtifacts ? [plugin.writeArtifacts] : [])),
    generatedSupportIncludes: [...new Set(plugins.flatMap((plugin) => plugin.capabilities.generatedSupportIncludes))].sort(),
    projection: {
      abis: abis.abis,
      constructs: abis.constructs,
      callableOrigins: abis.callableOrigins,
      classes: new Map(
        [...classes].map(([id, layout]) => {
          const storage = executableClasses.get(id)?.nativeStorage
          return [id, storage === undefined ? layout : { ...layout, nativeStorage: storage }]
        })
      ),
      placements: splitPlacements,
      slotHooks: plugins.flatMap((plugin) => (plugin.slotOf ? [plugin.slotOf] : []))
    },
    emissionRepresentations: emissionRepresentations ?? null,
    reflection: reflection ?? null,
    irBodies: request.includeIr && certifiedBodies ? [...certifiedBodies.values()] : null,
    physicalClasses: physicalClasses ?? null
  }
}
