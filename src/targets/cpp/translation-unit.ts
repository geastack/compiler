import { nativeSelectionHelpers } from './native-selection-helpers.js'
import { cppErrorNativeType } from './error-types.js'
import { isNativeErrorBaseRefusal, nativeErrorBaseInitializeStatements } from './native-error-base.js'
import { classFieldStorageOwnerOf, classMemberOf, classMethodOverrideOf } from '../../projection/fields.js'
import { balanceCppUnits } from './balanced-units.js'
import { stableBorrowEntryOf, type StableBorrowEntry } from './borrowed-call-entry.js'
import { programFactsOf } from '../../ir/program-facts.js'
import { nativeOrdinaryConstructInstanceMatches } from '../../ir/construct-entry.js'
import type { CapabilityCertificate } from '../../ir/certificate.js'
import type { CapabilityKey } from '../../ir/certify.js'
import type { SealedRepresentationPlan } from '../../representation/plan.js'
import {
  fileIdentityOf,
  isRegionId,
  type DeclarationId,
  type FunctionId,
  type RegionId,
  type StructuralTypeId
} from '../../identity/ids.js'
import type { BindingPlacement } from '../../projection/bindings.js'
import { constructedBaseOf, runtimeClassLayoutsOf, type ClassLayout, type PhysicalClassLayout } from '../../projection/classes.js'
import type { StructuralType } from '../../semantics/model/structural-types.js'
import type { CallableAbi, Representation } from '../../representation/model.js'
import { allOperationsOf, type IrBody } from '../../ir/model.js'
import type { IrValueId } from '../../identity/ids.js'
import { representationKey } from '../../representation/model.js'
import type { RuntimeDefinition } from '../../plugins/model.js'
import type { HostSpellings } from './host/host-members.js'
import { hostCallName } from './host/host-members.js'
import { reactiveBoundRecordFields, reactiveDependenciesOfBodies } from './reactive-dependencies.js'
import { buildDirectCallableIndex, buildCaptureIndex } from './captures.js'
import { createCppDocumentBuilder, emptyCppFacts, render, spliceRendered, type CppArtifact, type RenderedCppSource } from './document.js'
import { beginUnionAliasing, endUnionAliasing } from './types.js'
import {
  cppConstructedThunkName,
  cppConstructThunkName,
  cppFormalName,
  cppReceiverName,
  cppThunkName,
  emitBody,
  isCppEmitBlockedError
} from './emit.js'
import {
  cppCaptureFieldName,
  cppCaptureReceiverFieldName,
  cppEnvironmentLocalName,
  cppEnvironmentParamName,
  cppEnvironmentSlotName,
  cppEnvironmentStructName,
  effectiveAbiOf,
  symbolKeyDefinitions,
  templateObjectDefinitions,
  type CallableFactsSpelling,
  type TemplateObjectDefinition,
  type CaptureAdmission,
  type CaptureIndex
} from './emit-context.js'
import {
  censusClassStaticFieldStorage,
  censusConstantFieldInitializers,
  censusLazyArrowFields,
  classBoxable,
  cppFieldInitializerStatements,
  publishBoxableClasses,
  publishClassStaticFieldStorage,
  publishConstantFieldInitializers,
  publishLazyArrowFieldPlans
} from './class-layout.js'
import {
  classStaticFieldStorageRows,
  cppRecordDeclarations,
  cppStructNameOf,
  declaredFieldRepresentationOf,
  declaredRecordFieldOf,
  recordAccessorBodiesOf,
  representationNamesMintedStruct,
  withUnreadParametersUnnamed
} from './records.js'
import { prototypeReadHooks, virtualMethodEmission, virtualMethodFamiliesOf } from './virtual-methods.js'
import { virtualDispatchVerdictOf } from '../../projection/dispatch.js'
import { stringConstantsOf } from '../../ir/dead-values.js'
import { integerParameterSlot, integerResultSlot, integerStorageCensusOf, integerStorageSlot } from '../../ir/integer-storage.js'
import type { ReflectionDemand, ReflectionExposure } from '../../ir/reflection-demand.js'
import { classesConstructedUnobservably, functionsIgnoringTheirReceiver, type InstantiationFacts } from '../../ir/instantiation.js'
import { renderJsonStructDeclarations } from './emit-json.js'
import { alignedValueText, type ConversionSite, type PrinterDrift } from './emit-narrowing.js'
import { recordLayoutPolicyOf } from '../../projection/fields.js'
import type { ConversionCensus } from '../../conversion/nodes.js'
import type { RepresentationDeriver } from '../../representation/derive.js'
import {
  cppAbiParameterType,
  cppAbiType,
  cppStringLiteral,
  cppBodyName,
  cppCallableDeclarationTagName,
  cppCommonJsModuleName,
  cppCommonJsRecordName,
  cppNarrowedIntegerType,
  cppRefcountedReceiver,
  cppBoxedType,
  cppClassName,
  cppConstructName,
  cppGlobalName,
  cppInitializeName,
  cppRecordFieldName,
  cppRecordStructName,
  cppResultTypeOf,
  cppTypeOf,
  sanitizeForCppIdentifier
} from './types.js'
import { buildHostMethodAliasIndex } from './host/host-method-aliases.js'
import { cppRecursiveContainerDeclarations, cppRecursiveContainerTraceEdges } from './recursive-containers.js'

/**
 * One C++ translation unit, assembled from what earlier stages sealed.
 *
 * Assembly is the last place where order is a decision rather than a fact, and
 * there are exactly two ordering constraints: a struct must be declared before
 * a body mentions it, and a body must be declared before a thunk names it.
 * Everything else -- which body comes first, which struct -- is already fixed
 * deterministically upstream, and re-deciding it here would make two runs over
 * one program differ for no reason a reader could name.
 *
 * Every body is forward-declared before any body is defined, so a call to a
 * function defined later in the file, and mutual recursion between two of them,
 * both resolve. Emitting definitions in a dependency order instead would make
 * this file re-derive a call graph the semantic layer already published, and
 * would still have no answer for a cycle.
 *
 * The certificate is a parameter and not a courtesy. Emission is what turns a
 * missing capability into a crash halfway through a file, so the type requires
 * proof that preflight cleared before any text is produced.
 */

/**
 * The prelude every emitted unit needs.
 *
 * `gea_runtime.h` is the compiled-once runtime (`targets/cpp/runtime/`), and it
 * is included rather than inlined so that the carriers it defines have one
 * definition across every translation unit this compiler emits -- an inlined
 * copy per file is a second definition waiting to drift from the first.
 */
const standardIncludes = ['#include <cmath>', '#include <cstdint>', '#include <memory>', '#include <string>']

/**
 * The compiled-once runtime, LAST of the preludes.
 *
 * Last because a host's own header, when the unit needs one, has to be seen
 * first: `gea_runtime.h` carries stand-ins for the engine's types so that a
 * program using none of them still compiles standalone, and those stand-ins
 * step aside for the real definitions by asking whether the host declared
 * itself (`GEA_HOST_DECLARED`, the guard the plugin's own preamble defines).
 * A question asked before the answer exists is answered wrong -- 23 "definition
 * of type X conflicts with type alias of the same name", one per stand-in.
 */
const runtimeInclude = '#include "gea_runtime.h"'

/**
 * The host headers this particular unit needs, and no others.
 *
 * A host's templates name types this compiler never wrote -- `NSStackView` is
 * declared by the Apple bridge, not by `gea_runtime.h` -- so a unit that uses
 * one has to include the host's declarations. Decided from the carriers the
 * plan actually selected rather than from which plugins were installed: a
 * compilation with the Apple plugin installed and no Apple type in the program
 * must emit no Apple header, or every gea program starts carrying AppKit.
 */
const hostIncludesOf = (representations: readonly Representation[], hosts: HostSpellings): readonly string[] => {
  if (hosts.includes.size === 0) return []
  const headers = new Set<string>()
  for (const carrier of representations) {
    if (carrier.kind !== 'native-handle' || carrier.native === null) continue
    const header = hosts.includes.get(carrier.native)
    if (header !== undefined) headers.add(header)
  }
  return [...headers].sort().map((header) => `#include "${header}"`)
}

/**
 * The declarations this unit must carry before it may name a host's spellings.
 *
 * Decided from the PLACEMENTS, the way `hostIncludesOf` is decided from the
 * plan: a program that names no host global carries no host declaration, and a
 * compilation with a plugin installed but none of its globals used emits
 * nothing of the plugin's.
 *
 * A namespace contributes what its MEMBERS require rather than what its own
 * name does, because the members are what the tables state -- there is no row
 * for the bare path `deviceInfo`, only for `gea::host::device_info::deviceId`
 * and
 * its siblings. A unit that names the namespace at all can reach any of them,
 * so it takes the union: the declarations for a namespace it uses, not for a
 * member it happens to call.
 */
const hostPreamblesOf = (
  representations: readonly Representation[],
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  hosts: HostSpellings,
  bodies: readonly IrBody[]
): readonly string[] => {
  if (hosts.preambles.size === 0) return []
  const spellings = new Set<string>()
  for (const body of bodies) {
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) {
        if (operation.kind !== 'get' || !operation.hostMethod) continue
        const member = hosts.members.get(`${operation.hostMethod.protocol}.${operation.hostMethod.member}`)
        if (member?.kind === 'method') spellings.add(member.emit)
      }
    }
  }
  // A carrier contributes what its MEMBERS require, the same rule a namespace
  // gets below and for the same reason: the tables state rows for
  // `<carrier>.fillRect`, never for the carrier's bare name. A unit that holds
  // a value of that carrier at all can reach any of its members, so it takes
  // the union rather than guessing which ones a body calls -- and the plan is
  // where holding one is decided.
  for (const carrier of representations) {
    if (carrier.kind !== 'native-handle' || carrier.native === null) continue
    const prefix = `${carrier.native}.`
    for (const [key, member] of hosts.members) {
      if (!key.startsWith(prefix)) continue
      if (member.emit !== null) spellings.add(member.emit)
      if (member.kind === 'property' && member.store !== null) spellings.add(member.store)
    }
  }
  for (const placement of placements.values()) {
    const storage = placement.storage
    if (storage.kind === 'host-function' || storage.kind === 'host-constant') {
      spellings.add(storage.emit)
      continue
    }
    if (storage.kind !== 'host-namespace') continue
    const prefix = `${storage.linkageName}.`
    for (const [path, spelling] of hosts.namespaces.methods) if (path.startsWith(prefix)) spellings.add(hostCallName(spelling))
    for (const [path, emit] of hosts.namespaces.properties) if (path.startsWith(prefix)) spellings.add(emit)
  }
  const lines = new Set<string>()
  for (const spelling of [...spellings].sort()) {
    for (const line of hosts.preambles.get(spelling) ?? []) lines.add(line)
  }
  return [...lines]
}

/**
 * How badly this unit needs internal linkage.
 *
 * `'required'` is a resident build's answer: several geatsc units link into one
 * binary, their per-compilation identities collide, and a unit that cannot be
 * isolated must be refused rather than silently letting one definition win.
 *
 * `'preferred'` is every other program's. A unit that IS the whole program has
 * nothing to collide with, so isolation is not a correctness question there --
 * but it is still the right answer, because internal linkage is what lets the
 * C++ compiler see that a function is never called from anywhere else. Measured
 * on the comparison suite (2026-09-02, clang 18, 16 core fixtures): geomean vs
 * native 0.699 without it and 0.729 with, from `binary_trees` 0.207 -> 0.247,
 * `fibonacci` 0.660 -> 0.789 and `method_calls` 1.232 -> 1.579 -- the thunk and
 * the `CallableObject` global take a function's address, and an externally
 * visible address is what stops the inliner cloning it.
 *
 * A `'preferred'` unit that cannot be isolated simply is not, which is what
 * every unit did before this existed.
 */
export type CppSymbolIsolation = 'required' | 'preferred' | 'off'

export interface CppTranslationUnitInput {
  readonly plan: SealedRepresentationPlan
  /** Reachable carrier closure published before certification; absent facts retain the full plan. */
  readonly emissionRepresentations?: readonly Representation[]
  readonly reflection?: ReflectionExposure
  readonly structuralTypes: ReadonlyMap<StructuralTypeId, StructuralType>
  readonly bodies: readonly IrBody[]
  /** Where each binding cell lives, so a region-owned one becomes a file-scope variable. */
  readonly placements: ReadonlyMap<DeclarationId, BindingPlacement>
  /**
   * Region cells no surviving operation names, so no variable is defined for
   * them (`ir/shake.ts`).
   *
   * Passed alongside the placements rather than removed from them, because a
   * placement is where a cell LIVES and every consumer that resolves a
   * reference asks that map. Filtering it here would turn a cell this unit
   * simply has no use for into a cell whose reference refuses -- two different
   * facts, and only one of them is true.
   */
  readonly omitGlobals: ReadonlySet<DeclarationId>
  /** What each class is made of, so its construction can be rendered as one function. */
  readonly classes: ReadonlyMap<DeclarationId, ClassLayout>
  /** Physical inheritance also covers classes retained only through native field types. */
  readonly physicalClasses?: ReadonlyMap<DeclarationId, PhysicalClassLayout>
  /**
   * Every host member spelling installed for this compilation -- the backend's
   * own (`coreHostMembers`) unioned with every plugin's, by `compiler.ts`.
   *
   * The union happens once, next to the one that builds `nativeProtocols`, so a
   * protocol's claim and its spelling are admitted by the same step. Splitting
   * them would let a program certify against a claim whose template never
   * arrived, and that failure lands in clang rather than in a refusal.
   */
  readonly hosts: HostSpellings
  /**
   * The deriver that produced `plan`, so emission asks the same authority the
   * plan did rather than re-deriving under default policies.
   */
  readonly deriver: RepresentationDeriver
  /** The conversion census the lowering named its `convert` nodes from; see `EmitContext.conversions`. */
  readonly conversions: ConversionCensus
  /**
   * This program's module bodies, in the order ECMA-262 evaluates them
   * (`FrontendResult.moduleOrder`).
   *
   * A module body is called by nothing in the program -- it runs when the
   * module graph is evaluated -- so without this a rendered unit is a set of
   * functions no target can start. What it produces is one entry function that
   * calls them in order; see `entryDefinitionOf`.
   */
  /**
   * C++ the installed hosts require this unit to carry, verbatim
   * (`PluginCapabilities.runtimeDefinitions`, unioned by `compiler.ts`).
   *
   * Each carries its own condition rather than arriving as bare text, so a
   * definition that belongs only in some units says so itself -- see
   * `RuntimeDefinition.requires`.
   */
  readonly runtimeDefinitions: readonly RuntimeDefinition[]
  readonly moduleOrder: readonly RegionId[]
  /**
   * The C++ name the target starts this program at, or `null` to emit none.
   *
   * A name rather than a fixed symbol because it is the TARGET's convention,
   * not the language's: the gea runtimes call `__gea_top_level` (declared by
   * `core/gea_app_entry.cpp` and invoked from `Application::init`), and a
   * resident-app build gives each app its own prefixed entry so several can
   * link together. A caller that states no name gets no entry, which is right
   * for a unit that is being inspected rather than linked.
   */
  readonly entrySymbol: string | null
  /**
   * Whether this unit is one of several a single binary links, so everything
   * it defines except the names the caller states must be private to it.
   *
   * A resident build compiles one unit per app and links them together
   * (`simulator/targets/web/build-web.sh`). Every name this file mints is
   * derived from a declaration identity -- `gea_body_fn_decl_f67_3083`,
   * `gea_record_type_646`, `gea_global_decl_f65_17_0` -- and those identities
   * are per-COMPILATION, not per-program: two apps that both import the
   * framework number its files the same way, so four units collide on hundreds
   * of names, and the ones that happen to hold different code collide
   * SILENTLY (one definition wins, and the app that lost calls it).
   *
   * The fix is the language's own: an unnamed namespace gives every name in it
   * internal linkage, so nothing has to be renamed and nothing can be confused
   * across units. What stays outside is exactly what another unit declares --
   * the entry symbol, and the definitions the installed hosts require
   * (`runtimeDefinitions`: the per-resident `drainMicrotasks`, the weak
   * `gea_cpp_clear_microtasks`, and the prelude function the build named).
   * `core/packages/core/test/test_gea_resident_app_switch_main.cpp` states that
   * boundary from the other side, down to which symbol must NOT be anonymous.
   */
  readonly isolateSymbols: CppSymbolIsolation
  /**
   * How the program is laid out on disk -- see `CppTranslationUnitLayout`.
   *
   * `single` is what every unit was until this existed. `per-file` groups
   * bodies by the source file that declared them, one C++ unit each, with the
   * declarations they share in one header and the program's storage, dispatch
   * members, host-required definitions and entry in one program unit.
   */
  readonly layout: CppTranslationUnitLayout
  /**
   * The stem every file of a `per-file` layout is named from: `<stem>.hpp` is
   * the shared header each unit includes, `<stem>.cpp` the program unit, and
   * `<stem>.<module>.cpp` one module's bodies. Unused by `single`, whose one
   * unit the caller names itself.
   */
  readonly unitBaseName: string
  /** Which file each identity segment names (`FrontendResult.sourceFileNames`), so a module unit can be named after its file. */
  readonly sourceFileNames: ReadonlyMap<string, string>
  /** Declaration identities of the standard well-known symbols used by computed property keys. */
  readonly wellKnownSymbols: ReadonlyMap<DeclarationId, string>
  /** Proof that every obligation the program raised was satisfied. */
  readonly certificate: CapabilityCertificate
}

/**
 * One namespace-scope object spelled both ways a layout can need it: the
 * `extern` declaration a shared header carries, and the one definition.
 *
 * A single-unit layout emits only `definition`; the per-file layout puts
 * `declaration` in the header every unit includes and `definition` in the one
 * program unit, so the object exists exactly once however many units name it.
 */
interface StorageSpelling {
  readonly declaration: string
  readonly definition: string
}

const storageSpelling = (type: string, name: string): StorageSpelling => ({
  declaration: `extern ${type} ${name};`,
  definition: `${type} ${name};`
})

/**
 * File-scope variables for the cells a run-once region owns.
 *
 * A cell whose carrier the plan never selected is skipped rather than given a
 * guessed type -- the body that reads it then refuses by name, which is the
 * answer, instead of this file inventing a layout to make the file compile.
 */
const globalStorage = (
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  omit: ReadonlySet<DeclarationId>
): readonly StorageSpelling[] =>
  [...placements.entries()]
    .filter(
      ([declaration, placement]) => placement.storage.kind === 'region' && placement.representation !== null && !omit.has(declaration)
    )
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([declaration, placement]) => {
      const representation = placement.representation
      if (!representation || representation.kind === 'unresolved' || representation.kind === 'void') return []
      return [storageSpelling(cppTypeOf(representation), cppGlobalName(declaration))]
    })

/**
 * `extern` declarations for cells a host defines.
 *
 * These are declarations, never definitions: the whole reason a cell reaches
 * `BindingStorage.kind === 'external'` is that this program never initializes
 * it, so emitting a defining statement here would either zero-initialize a
 * value the host owns or, for a carrier with no default constructor, refuse to
 * compile at all. `linkageName` is not `cppGlobalName(declaration)` on
 * purpose: it is the ABI contract preflight's `native-boundary` obligation
 * already proved is installed (`buildExternalBindingObligation`,
 * preflight/run.ts), carried verbatim from the declaration's own spelling
 * (`BindingOperation.external`, semantics/model/operations.ts) rather than
 * re-derived here.
 */
/**
 * Definitions for cells an installed host said it does NOT provide.
 *
 * The mirror image of `externDeclarations` below, and deliberately in this file
 * next to it: both answer "what does the unit say about a cell this program
 * names but never initializes", and the answer turns entirely on whether
 * anything out there defines it. A host that denied the name is saying nothing
 * does, so the unit defines it -- one object holding `undefined`, which is the
 * carrier the type census already gave it.
 *
 * A definition rather than an `extern` is the whole fix: `extern gea::Undefined
 * VideoFrame;` compiles and never links, and before this existed that is
 * exactly what a program guarding `typeof VideoFrame !== 'undefined'` emitted --
 * alongside a guard folded to `true`. See `semantics/normalize/absent-globals.ts`.
 */
/**
 * One declaration's rendered C++ text alongside the representation it was
 * rendered from -- kept paired so a later question about the declaration
 * ("does it name a struct this compilation mints") can be answered by asking
 * the representation directly, rather than by re-deriving the answer from the
 * text this same representation already produced.
 */
interface RenderedDeclaration {
  readonly text: string
  readonly representation: Representation
}

/**
 * An absent global, spelled both ways: `text` is the definition a single unit
 * emits at global scope, `declaration` the `extern` a shared header carries so
 * the per-file layout can define it in one unit and name it from every other.
 */
interface RenderedAbsentDefinition extends RenderedDeclaration {
  readonly declaration: string
}

const absentDefinitions = (placements: ReadonlyMap<DeclarationId, BindingPlacement>): readonly RenderedAbsentDefinition[] =>
  [...placements.entries()]
    .filter(([, placement]) => placement.storage.kind === 'absent' && placement.representation !== null)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([declaration, placement]) => {
      const representation = placement.representation
      if (!representation || representation.kind === 'unresolved' || representation.kind === 'void') return []
      const spelling = storageSpelling(cppTypeOf(representation), cppGlobalName(declaration))
      return [{ text: spelling.definition, declaration: spelling.declaration, representation }]
    })

const externDeclarations = (placements: ReadonlyMap<DeclarationId, BindingPlacement>): readonly RenderedDeclaration[] =>
  [...placements.entries()]
    .filter(([, placement]) => placement.storage.kind === 'external' && placement.representation !== null)
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([, placement]) => {
      const { storage, representation } = placement
      if (storage.kind !== 'external' || !representation || representation.kind === 'unresolved' || representation.kind === 'void') {
        return []
      }
      return [{ text: `extern ${cppTypeOf(representation)} ${storage.linkageName};`, representation }]
    })

/** The formals one calling convention declares, receiver first, in the order `cppAbiType` keys them. */
/**
 * A body's formals.
 *
 * `narrowed` is the whole-program integer census's answer for this body's own
 * positions (`ir/integer-storage.ts`): a `number` formal every call site writes
 * an integer into is declared `long long`, so the body works in one rather than
 * converting at entry and back at every recursive call. It is the BODY's
 * spelling only -- the ABI, the `CallableObject` carrier and the thunk's own
 * external signature all keep the convention every caller agrees on, and the
 * thunk casts across (`thunkOf`). Passing an empty set gives the ABI spelling,
 * which is what the thunk and the constructor definitions want.
 */
const formalsOf = (
  abi: CallableAbi,
  narrowed: ReadonlySet<number> = new Set(),
  borrowReceiver = false,
  borrowed: ReadonlySet<number> = new Set()
): readonly string[] => [
  ...(abi.receiver === null
    ? []
    : [`${borrowReceiver ? `const ${cppTypeOf(abi.receiver)}&` : cppTypeOf(abi.receiver)} ${cppReceiverName}`]),
  ...abi.parameters.map((parameter, ordinal) => {
    const type = narrowed.has(ordinal)
      ? cppNarrowedIntegerType
      : borrowed.has(ordinal)
        ? `const ${cppAbiParameterType(parameter)}&`
        : cppAbiParameterType(parameter)
    return `${type} ${cppFormalName(ordinal)}`
  })
]

/**
 * The formals a *body itself* declares, as opposed to the ones its thunk
 * exposes externally.
 *
 * A capturing body gets one extra leading formal -- a pointer to its own
 * environment struct -- that no caller ever supplies directly and no ABI
 * states: it is populated by the thunk's own unpacking, from the pointer
 * `CallableObject.environment` carries. `effectiveAbi` already carries the
 * *captured* receiver's type in `.receiver` when one applies (see
 * `effectiveAbiOf`), so `formalsOf(effectiveAbi)` alone renders the receiver
 * formal correctly either way; only the environment pointer itself is this
 * function's own addition.
 */
const bodyFormalsOf = (
  owner: FunctionId | RegionId,
  effectiveAbi: CallableAbi,
  admission: CaptureAdmission,
  narrowed: ReadonlySet<number>,
  borrowReceiver: boolean,
  borrowed: ReadonlySet<number> = new Set()
): readonly string[] => [
  ...(admission.kind === 'ok' ? [`${cppEnvironmentStructName(owner)}* ${cppEnvironmentLocalName}`] : []),
  ...formalsOf(effectiveAbi, narrowed, borrowReceiver, borrowed)
]

/**
 * Whether this body is emitted as a C++20 coroutine -- `emit.ts`'s `emitYield`
 * renders `co_yield`, which makes the whole function one.
 *
 * Asked of the body's own DECLARATION rather than of its result carrier: a
 * function that merely RETURNS a `gea::Iterator<T>` (the `get-iterator` step
 * over an array builds and returns one, and `function makeGen() { return g() }`
 * hands back a generator's cursor unchanged) is an ordinary function, and its
 * result carrier is the very same `iterator(source: generator)` a real
 * `function*` publishes -- the carrier cannot tell them apart, only the
 * `function*` itself can.
 */
const isCoroutineBody = (body: IrBody): boolean =>
  body.generator === true || [...body.blocks.values()].some((block) => block.operations.some((operation) => operation.kind === 'yield'))

/**
 * Whether this body may take its receiver by reference.
 *
 * Only a receiver the ABI itself states, never a CAPTURED one: a captured
 * receiver is a field of an environment the callable owns, and binding a
 * reference to it would outlive nothing this frame can see. A stated receiver
 * is an argument the caller evaluates -- a local it owns for the whole call, or
 * a temporary whose lifetime a `const&` parameter already extends past it.
 *
 * NEVER for a coroutine, and that is a correctness rule rather than a
 * preference. C++20 copies a coroutine's parameters into the frame, but a
 * REFERENCE parameter is copied as a reference: the frame holds a reference to
 * whatever the caller passed. A coroutine suspends at `initial_suspend`
 * (`gea::Iterator<E>::promise_type`, runtime/gea_runtime.h) and returns to its
 * caller immediately, so by the time the first `next()` resumes the body, the
 * caller's own argument -- the thunk's by-value `gea_this`, which is what every
 * generator method is reached through -- is long destroyed and the reference
 * dangles.
 *
 * That produced a program that certified, cleared clang with no warning, and
 * read freed memory: `class Counter { *[Symbol.iterator]() { for (let i = 0; i
 * < this.limit; ...) yield i } }` walked zero elements, because `this->limit`
 * read a destroyed refcount handle. Whether the loop runs at all is undefined
 * behaviour, which is exactly why no gate above this one could have caught it.
 */
const borrowsReceiver = (body: IrBody): boolean =>
  body.abi?.receiver != null && cppRefcountedReceiver(body.abi.receiver) && !isCoroutineBody(body)

/**
 * The environment struct one capturing function's allocation populates and
 * its thunk unpacks, or `null` for a function that captures nothing.
 *
 * One struct per capturing function, not a shared layout, because two
 * closures capture different cells in general and a shared struct would need
 * a field for everything any closure anywhere ever captures. Declared ahead
 * of every body signature (`renderTranslationUnit`), because a body's own
 * formal names this struct as a pointer type before any body is defined.
 */
const environmentDeclarationOf = (owner: FunctionId | RegionId, admission: CaptureAdmission): string | null => {
  if (admission.kind !== 'ok') return null
  const fields = [
    ...admission.layout.slots.map(
      (slot, index) => `  ${slot.boxed ? cppBoxedType(slot.representation) : cppTypeOf(slot.representation)} ${cppCaptureFieldName(index)};`
    ),
    ...(admission.layout.receiver !== null ? [`  ${cppTypeOf(admission.layout.receiver)} ${cppCaptureReceiverFieldName};`] : [])
  ]
  const traceFields = [
    ...admission.layout.slots.map((_, index) => cppCaptureFieldName(index)),
    ...(admission.layout.receiver !== null ? [cppCaptureReceiverFieldName] : [])
  ]
  const traceableFields = traceFields.map((field) => `gea::detail::TraceEdges<decltype(${field})>::supported`)
  return [
    `struct ${cppEnvironmentStructName(owner)} {`,
    ...fields,
    // Same reasoning as `records.ts`'s own `geaTraceRefs`: whether any capture
    // in this environment reaches a ref is a program-wide fact (which types
    // this closure happened to capture), not something this struct's own
    // renderer predicts, so it is marked unconditionally rather than only
    // when `traceableFields` looks empty from here.
    `  [[maybe_unused]] friend auto geaTraceRefs(const ${cppEnvironmentStructName(owner)}& value, gea::detail::RefVisitor& visitor)`,
    `    -> std::bool_constant<${traceableFields.length ? traceableFields.join(' || ') : 'false'}> {`,
    ...traceFields.map((field) => `    gea::detail::traceRefs(value.${field}, visitor);`),
    '    return {};',
    '  }',
    '};'
  ].join('\n')
}

/**
 * What one class's initialization runs against an object that already exists --
 * everything `[[Construct]]` does after `OrdinaryCreateFromConstructor`.
 *
 * The three shapes are the language's three, not a convenience split:
 *
 * - A **base** class runs its own field initializers in declaration order, then
 *   its constructor body. The order matters: a constructor that reads a field
 *   before its initializer ran must read the initialized value, not a zeroed
 *   struct member.
 * - A **derived class with a written constructor** runs *only* that body. Its
 *   own field initializers do not belong here at all: the language runs them at
 *   the `super(...)` call, after the base chain returns and before the next
 *   statement of the constructor, and `emit.ts`'s super-initialization is where
 *   that happens. Running them here as well would initialize each field twice
 *   and, worse, would run them before a base constructor that the derived
 *   constructor may deliberately let observe them absent.
 * - A **derived class with no written constructor** has the implicit
 *   `constructor(...args) { super(...args) }`: the base's initialization takes
 *   this construction's own arguments unchanged, and the field initializers run
 *   after it returns.
 */
const initializationStatements = (
  site: ConversionSite,
  deriver: RepresentationDeriver,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  layout: ClassLayout,
  abi: CallableAbi,
  actuals: readonly string[],
  bodyAbis: ReadonlyMap<string, CallableAbi | null>
): readonly string[] | string => {
  const fieldInitializers = cppFieldInitializerStatements(site, layout.declaration, layout.fields, cppReceiverName, (field) =>
    layout.instance === null ? null : declaredRecordFieldOf(deriver, layout.instance, field.key, classes)
  )
  if (typeof fieldInitializers === 'string') return fieldInitializers
  let constructorCall: readonly string[] = []
  if (layout.constructor) {
    const bodyAbi = bodyAbis.get(String(layout.constructor))
    if (!bodyAbi) return `its constructor body ${layout.constructor} published no callable ABI`
    if (bodyAbi.parameters.length !== abi.parameters.length) {
      return `its construct convention declares ${abi.parameters.length} parameter(s), but constructor body ${layout.constructor} declares ${bodyAbi.parameters.length}`
    }
    const converted: string[] = []
    for (let index = 0; index < actuals.length; index += 1) {
      const source = abi.parameters[index]?.value
      const target = bodyAbi.parameters[index]?.value
      const actual = actuals[index]
      if (!source || !target || actual === undefined) return `its constructor parameter ${index} has no complete ABI mapping`
      const text = alignedValueText(site, 'translation-unit.ts:722', source, target, actual)
      if (text === null) {
        return (
          `its construct parameter ${index} carries ${representationKey(source)}, while constructor body ${layout.constructor} carries ` +
          `${representationKey(target)}, and no conversion is installed between them`
        )
      }
      converted.push(text)
    }
    constructorCall = [`${cppBodyName(layout.constructor)}(${[cppReceiverName, ...converted].join(', ')});`]
  }
  if (constructedBaseOf(layout) === null && layout.nativeBase === null) return [...fieldInitializers, ...constructorCall]
  if (layout.constructor) return constructorCall
  if (layout.nativeBase !== null) {
    // The implicit `constructor(...args) { super(...args) }` forwards this
    // construction's own arguments to the native base unchanged, which is
    // exactly what `emitSuperInitialize` renders for a class that writes the
    // constructor out -- so it is the same shared renderer, not a second
    // reading of 20.5.1.1. The field initializers follow it for the same
    // reason they follow a written `super()`: the language runs them once the
    // base chain has returned.
    if (layout.nativeBase.instance.native !== cppErrorNativeType) {
      return (
        `it extends native base ${layout.nativeBase.protocol}, which uses "${layout.nativeBase.instance.native ?? 'no native layout'}"; ` +
        'only the intrinsic Error layout has an existing-receiver initializer'
      )
    }
    const baseStatements = nativeErrorBaseInitializeStatements(
      deriver,
      cppReceiverName,
      abi.parameters.slice(0, 2).map((parameter, index) => {
        const actual = actuals[index]
        return actual === undefined ? undefined : { representation: parameter.value, text: actual }
      })
    )
    if (isNativeErrorBaseRefusal(baseStatements)) return baseStatements.reason
    return [...baseStatements, ...fieldInitializers]
  }
  const baseDeclaration = layout.base
  if (baseDeclaration === null) return 'it has no base class after native-base handling'
  const base = classes.get(baseDeclaration)
  if (!base || !base.construct) {
    return `its base ${layout.base} published no construct convention, so the implicit \`super(...)\` has no frame to fill`
  }
  // The implicit constructor forwards every argument positionally, so the two
  // conventions have to agree on how many there are. They do whenever the
  // checker gave the derived class its base's construct signature, which is
  // what it does for a class that declares no constructor -- a disagreement
  // here is a fact about the program this file cannot repair by dropping or
  // inventing an argument.
  if (base.construct.parameters.length !== abi.parameters.length) {
    return (
      `it declares no constructor, so its implicit one forwards all ${abi.parameters.length} argument(s) to ` +
      `base ${baseDeclaration}, whose construct convention declares ${base.construct.parameters.length}`
    )
  }
  return [`${cppInitializeName(baseDeclaration)}(${[cppReceiverName, ...actuals].join(', ')});`, ...fieldInitializers]
}

/**
 * Every class's `[[Construct]]`, rendered as functions.
 *
 * A class some other class extends additionally gets its initialization half
 * emitted on its own, as `gea_initialize_<class>`: a `super(...)` has to run the
 * base's initialization against the object the *derived* construction already
 * allocated, never allocate a second one of the base's own type. Every
 * initializer is declared ahead of every definition, so a base's initializer
 * being defined after the derived one that calls it -- or a chain of any depth
 * -- resolves without this file computing an order.
 *
 * A class whose construction cannot be rendered is refused by name rather than
 * half-emitted, because a construction that silently skips an initializer is a
 * program whose fields are wrong everywhere and whose C++ still compiles.
 */
/**
 * Which linkage the functions this file mints get.
 *
 * `'internal'` is the single-unit layout's: a thunk or a construct wrapper is
 * `static`, because nothing outside the one unit can name it and internal
 * linkage is what lets the inliner see that. `'external'` is the per-file
 * layout's: the same functions are declared in a header every unit includes
 * and defined in the one unit that owns them, so a body in another unit can
 * take a function's address or construct its class.
 */
type CppLinkage = 'internal' | 'external'

// `[[maybe_unused]]` because whether a minted function has a user in this unit
// is a property of the PROGRAM, not of the generator: a thunk exists so a body
// CAN be taken as a value, and a program that never does so leaves a correct,
// unreferenced definition behind. Only internal linkage needs it -- an external
// one is nameable from another unit, so no compiler can call it unused. Without
// it the shipping ESP-IDF component, which compiles with `-Wall -Wextra
// -Werror`, refuses the emitted unit outright: 114 of one app's 289
// warnings were this one diagnostic.
const linkagePrefix = (linkage: CppLinkage): string => (linkage === 'internal' ? '[[maybe_unused]] static ' : '')

/**
 * One class's `[[Construct]]`: the prototypes a header states, and the
 * definitions the owning unit holds.
 *
 * The initializer's prototype is kept apart from the construct wrapper's two
 * because the single-unit layout forward-declares only the former (a base's
 * initializer may be defined after the derived construction that calls it),
 * while the per-file layout's header needs all three.
 */
interface ClassConstruction {
  readonly declaration: DeclarationId
  readonly initializerPrototype: string | null
  readonly constructPrototypes: readonly string[]
  readonly definitions: readonly string[]
}

const constructionsOf = (
  site: ConversionSite,
  deriver: RepresentationDeriver,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  refused: CppEmissionRefusal[],
  linkage: CppLinkage,
  bodyAbis: ReadonlyMap<string, CallableAbi | null>,
  /** The classes whose struct holds `gea_method_state` statically -- `cppRecordDeclarations`' own report, never re-derived here. */
  staticMethodStateClasses: ReadonlySet<DeclarationId> = new Set()
): readonly ClassConstruction[] => {
  // Layout-only classes publish no requested construction. Every runtime
  // construction still passes the complete ABI/initialization checks below.
  const ordered = [...runtimeClassLayoutsOf(classes)].sort((left, right) => left.declaration.localeCompare(right.declaration))
  const extended = new Set(ordered.flatMap((layout) => (layout.base === null ? [] : [layout.base])))
  const constructions: ClassConstruction[] = []

  for (const layout of ordered) {
    const abi = layout.construct
    const instance = layout.instance
    if (!abi || !instance || instance.kind !== 'class-ref') {
      refused.push({
        owner: layout.declaration,
        reason: `class ${layout.declaration} published no construct convention, so no construction can be rendered for it`,
        key: 'print:refused'
      })
      continue
    }
    const formals = abi.parameters.map((parameter, ordinal) => `${cppAbiParameterType(parameter)} ${cppFormalName(ordinal)}`)
    // Each parameter is forwarded exactly once. Preserve borrowed ABI slots,
    // and transfer owned strings, optionals and handles instead of undoing
    // the moves performed by the caller and the constructor body.
    const actuals = abi.parameters.map((parameter, ordinal) => `std::forward<${cppAbiParameterType(parameter)}>(${cppFormalName(ordinal)})`)
    const statements = initializationStatements(site, deriver, classes, layout, abi, actuals, bodyAbis)
    if (typeof statements === 'string') {
      refused.push({
        owner: layout.declaration,
        reason: `class ${layout.declaration} cannot be constructed: ${statements}`,
        key: 'print:refused'
      })
      continue
    }
    const result = cppTypeOf(instance)
    const prefix = linkagePrefix(linkage)
    const initializerName = cppInitializeName(layout.declaration)
    // A base class with no field initializers and no written constructor body
    // (`statements` empty) never reads its own receiver -- same "deliberately
    // unused formal" shape `records.ts`'s reflection hooks already spell by
    // omitting the name, applied here via the same helper rather than a
    // second `[[maybe_unused]]`-on-parameters idiom this file would have to
    // invent and keep in sync.
    const initializerSignature = withUnreadParametersUnnamed(
      `${prefix}void ${initializerName}(${[`${result} ${cppReceiverName}`, ...formals].join(', ')})`,
      statements
    )
    let initializerPrototype: string | null = null
    const definitions: string[] = []
    // Only a class something extends is ever initialized through a receiver it
    // did not allocate, so only such a class needs the half emitted separately;
    // every other construction inlines the same statements.
    if (extended.has(layout.declaration)) {
      initializerPrototype = `${initializerSignature};`
      definitions.push([`${initializerSignature} {`, ...statements, '}'].join('\n'))
    }
    const name = cppConstructName(layout.declaration)
    // A raw pointer, not a `Ref`: the caller reads it off a class cell it
    // holds for the whole call (the cell's `environmentOwner` owns the
    // state), and a `Ref` argument was a retain and a release of the SAME
    // shared count around every construction -- in `binary_trees`' `build`
    // the two read-modify-writes and the release's branches were the hottest
    // lines after the construct itself.
    const stateFormal = 'gea::NativeClassMethodState* gea_method_state'
    const constructSignature = `${prefix}${result} ${name}(${[stateFormal, ...formals].join(', ')})`
    const thunkSignature = `${prefix}${result} ${cppConstructThunkName(layout.declaration)}(${['void* gea_environment', ...formals].join(', ')})`
    const allocation = `${result} ${cppReceiverName} = gea::makeRef<${cppClassName(layout.declaration)}>();`
    const initialization = extended.has(layout.declaration)
      ? [`${initializerName}(${[cppReceiverName, ...actuals].join(', ')});`]
      : statements
    // A static state (`records.ts`'s `staticMethodState`) is the one the
    // program's single evaluation minted: fill it in on first construction
    // and thereafter only confirm it, cheaper than a handle copy per instance
    // and unable to disagree with the per-instance store it replaces. It goes
    // BEFORE the allocation so that nothing with a call in it (the first
    // fill's release of the old handle) sits between `makeRef`'s
    // zero-initialization of the fields and the constructor body's stores:
    // with a call in between, clang cannot see that a field it is about to
    // move-assign still holds the null it was just given, and re-tests the
    // old value of every handle field for something to release.
    const className = cppClassName(layout.declaration)
    const staticState = staticMethodStateClasses.has(layout.declaration)
    const adoptedState = 'gea::Ref<gea::NativeClassMethodState>::adopt(gea_method_state, true)'
    definitions.push(
      [
        `${constructSignature} {`,
        ...(staticState
          ? [`if (${className}::gea_method_state.get() != gea_method_state) ${className}::gea_method_state = ${adoptedState};`]
          : []),
        allocation,
        ...(staticState ? [] : [`${cppReceiverName}->gea_method_state = ${adoptedState};`]),
        ...initialization,
        `return ${cppReceiverName};`,
        '}'
      ].join('\n'),
      `${thunkSignature} { return ${name}(${['static_cast<gea::NativeClassMethodState*>(gea_environment)', ...actuals].join(', ')}); }`
    )
    constructions.push({
      declaration: layout.declaration,
      initializerPrototype,
      constructPrototypes: [`${constructSignature};`, `${thunkSignature};`],
      definitions
    })
  }

  return constructions
}

/**
 * Every class's construction as one flat section, in the order the single-unit
 * layout has always used: every initializer declared ahead of every definition,
 * so a base defined after the derived class that calls it -- or a chain of any
 * depth -- resolves without this file computing an order. Construct wrappers
 * need no prototype there: each is defined before any body, and its thunk
 * follows it directly.
 */
const constructDefinitionsOf = (constructions: readonly ClassConstruction[]): readonly string[] => [
  ...constructions.flatMap((construction) => (construction.initializerPrototype === null ? [] : [construction.initializerPrototype])),
  ...constructions.flatMap((construction) => construction.definitions)
]

/**
 * One body's C++ signature.
 *
 * `void ...()` for a body with no convention is not a fallback: a module body,
 * a field initializer, and a static block are evaluated, never called, so they
 * genuinely take nothing and return nothing. A callable body spells the ABI the
 * projection published, so the frame it reads and the frame it declares are the
 * same object rather than two agreeing guesses.
 */
const signatureOf = (
  body: IrBody,
  captures: CaptureIndex,
  narrowed: ReadonlySet<number> = new Set(),
  narrowedResult = false,
  borrowed: ReadonlySet<number> = new Set(),
  name = cppBodyName(body.sourceOwner)
): string => {
  // A body with no convention is entered by the region walker, or by nothing at
  // all when its region is never reached -- so an unreferenced definition here
  // is a fact about the program, not a defect in the emission. A callable body
  // is not marked: something demanded its ABI, so an unused one is worth seeing.
  if (!body.abi) return `[[maybe_unused]] void ${name}()`
  const admission = captures.of(body.sourceOwner)
  const effectiveAbi = effectiveAbiOf(body.abi, admission) ?? body.abi
  const result = narrowedResult ? cppNarrowedIntegerType : cppResultTypeOf(effectiveAbi.result)
  const formals = bodyFormalsOf(body.sourceOwner, effectiveAbi, admission, narrowed, borrowsReceiver(body), borrowed)
  return `${result} ${name}(${formals.join(', ')})`
}

/**
 * The adapter between a body's own signature and the environment-passing
 * pointer a callable carrier holds.
 *
 * The carrier stores `R (*)(void*, A...)` for every callable of one ABI, so
 * two functions with the same convention are interchangeable at a call site.
 * A body compiled with its own name as the symbol cannot fill that slot
 * directly -- it has no environment parameter -- and giving every function an
 * unused leading `void*` instead would put a capture-free function's ABI at
 * odds with the convention the plan actually published.
 *
 * The thunk's own external signature always spells the *real*, unmodified
 * ABI: a caller never pushes a captured receiver or a captured cell, so
 * neither belongs in the formals a call site sees. What differs for a
 * capturing function is only the *call this thunk makes* -- it casts its
 * `void*` to the environment struct the allocation populated, and forwards
 * that pointer (and, for a captured receiver, the field the receiver was
 * stored in) as the body's own leading argument(s), exactly the positions
 * `bodyFormalsOf` declared them in.
 */
/** One thunk, spelled as the prototype a header states and the definition its owning unit holds. */
interface RenderedThunk {
  readonly prototype: string
  readonly definition: string
}

const thunkOf = (
  body: IrBody,
  captures: CaptureIndex,
  narrowed: ReadonlySet<number>,
  narrowedResult: boolean,
  linkage: CppLinkage
): RenderedThunk | null => {
  if (!body.abi) return null
  const abi = body.abi
  const admission = captures.of(body.sourceOwner)
  const hasEnvironment = admission.kind === 'ok'
  const formals = [hasEnvironment ? `void* ${cppEnvironmentParamName}` : 'void*', ...formalsOf(abi)]
  // One pointer of stack, which `gea::unpackEnvironment` copies the captured
  // state into where the state fits in the pointer the carrier holds and
  // ignores where the state is on the heap. Declared here rather than inside
  // the helper because a heap environment's members must not be constructed
  // once per call just to be overwritten by a pointer cast.
  const unpack = hasEnvironment
    ? `alignas(void*) unsigned char ${cppEnvironmentSlotName}[sizeof(void*)]; ` +
      `auto* ${cppEnvironmentLocalName} = gea::unpackEnvironment<${cppEnvironmentStructName(body.sourceOwner)}>(${cppEnvironmentParamName}, ${cppEnvironmentSlotName}); `
    : ''
  const receiverActual =
    abi.receiver !== null
      ? [cppReceiverName]
      : admission.kind === 'ok' && admission.layout.receiver !== null
        ? [`${cppEnvironmentLocalName}->${cppCaptureReceiverFieldName}`]
        : []
  const call = `${cppBodyName(body.sourceOwner)}(${[
    ...(hasEnvironment ? [cppEnvironmentLocalName] : []),
    ...receiverActual,
    // The thunk's own formals stay the ABI's, so the carrier's function-pointer
    // type is unchanged; a narrowed body formal is converted here, at the one
    // boundary where the two spellings meet.
    ...abi.parameters.map((parameter, ordinal) =>
      narrowed.has(ordinal)
        ? `static_cast<${cppNarrowedIntegerType}>(${cppFormalName(ordinal)})`
        : `std::forward<${cppAbiParameterType(parameter)}>(${cppFormalName(ordinal)})`
    )
  ].join(', ')})`
  // The thunk's own result stays the ABI's, so the carrier's function-pointer
  // type is unchanged; a narrowed body result converts back here.
  const returned = narrowedResult ? `static_cast<${cppResultTypeOf(abi.result)}>(${call})` : call
  const statement = `${unpack}${abi.result.kind === 'void' ? `${call};` : `return ${returned};`}`
  const signature = `${linkagePrefix(linkage)}${cppResultTypeOf(abi.result)} ${cppThunkName(body.sourceOwner)}(${formals.join(', ')})`
  const construct = constructThunkOf(body, abi, hasEnvironment, linkage)
  return {
    prototype: [`${signature};`, ...(construct === null ? [] : [construct.prototype])].join('\n'),
    // No `registerSource` beside the thunk any more: the function's
    // `name`/`length`/source text register at the sites that mint a function
    // object from it (`emit-context.ts`'s `cppThunkEntryText`), so a function
    // nothing reaches is not pinned into the binary by its own registration.
    definition: [`${signature} { ${statement} }`, ...(construct === null ? [] : [construct.definition])].join('\n')
  }
}

/**
 * The `[[Construct]]` half of a pre-`class` JavaScript constructor function:
 * allocate the instance, enter the body with it, evaluate to it.
 *
 * ECMA-262 10.2.2 in three steps, and the reason a construction cannot reuse
 * the invoke pointer: `[[Call]]` is HANDED a receiver and returns whatever the
 * body returns (`void`, for nine of the ten in three.js's renderer), while
 * `[[Construct]]` manufactures the receiver and evaluates to it. The two
 * conventions differ in both ends, which is why `gea::CallableConstructorObject`
 * holds two pointers rather than one.
 *
 * The instance's own allocation is `emit-allocation.ts`'s `emitAllocateRecord`
 * ownership switch, and deliberately the same two spellings: `owned` is a value
 * (`T{}`) and `shared-refcount` is a counted reference (`gea::makeRef<T>()`).
 * `borrowed` is refused there for the reason it is refused here -- an
 * allocation has no object to point at.
 *
 * The receiver the body declares and the object this returns must be the SAME
 * carrier, and where they are not, what is rendered is a fault rather than a
 * construction. That is not a hedge: it is the `this.setState = function (
 * material ) { this.numPlanes += n; }` case, whose receiver is the instance it
 * was INSTALLED on (`structural-receiver.ts`'s `jsConstructorReceiverOf`) while
 * TypeScript's constructor-function inference still gives it a construct
 * signature returning the subset of fields it happens to assign. Nothing can
 * `new` such a value through the field it lives in without saying so, and if
 * something does, a named abort is the honest answer -- a silent one would
 * allocate a two-field record and run a body that expects the whole instance.
 */
const constructThunkOf = (
  body: IrBody,
  abi: CallableAbi,
  hasEnvironment: boolean,
  linkage: CppLinkage
): { readonly prototype: string; readonly definition: string } | null => {
  const construct = body.construct
  if (!construct) return null
  const instance = construct.result
  const formals = [hasEnvironment ? `void* ${cppEnvironmentParamName}` : 'void*', ...formalsOf(construct)]
  const signature = `${linkagePrefix(linkage)}${cppResultTypeOf(instance)} ${cppConstructedThunkName(body.sourceOwner)}(${formals.join(', ')})`
  // A body that never reads `this` declares no receiver (`structural-
  // receiver.ts` gates the JS-constructor receiver on `bodyReadsThis`), and
  // `[[Construct]]` of it is still a construction: allocate the instance, run
  // the body with the convention it has, return the instance. `function F()
  // {}` constructed with `new F()` is exactly that -- test262 builds most of
  // its throwaway constructors this way -- and rendering it as a fault made
  // a certified program abort at runtime.
  const actuals = [
    ...(hasEnvironment ? [cppEnvironmentParamName] : ['nullptr']),
    ...(abi.receiver !== null ? [cppReceiverName] : []),
    ...construct.parameters.map((_, ordinal) => cppFormalName(ordinal))
  ]
  const buildable = nativeOrdinaryConstructInstanceMatches(abi, instance)
  if (!buildable) {
    const why =
      abi.receiver === null
        ? `its construction evaluates to ${representationKey(instance)}, which is not an allocatable record`
        : `its body is entered with ${representationKey(abi.receiver)} while its construction evaluates to ${representationKey(instance)}`
    return {
      prototype: `${signature};`,
      definition: `${signature} { gea::detail::failUnconstructableFunction("${cppBodyName(body.sourceOwner)}", "${why}"); }`
    }
  }
  const allocation =
    instance.ownership === 'owned'
      ? `${cppTypeOf(instance)} ${cppReceiverName}{};`
      : `${cppTypeOf(instance)} ${cppReceiverName} = gea::makeRef<${cppRecordStructName(instance.shapeId)}>();`
  // Through the INVOKE thunk, not the body: the thunk is the one place that
  // knows how this body's captured state is packed, and rebuilding that
  // unpacking here would be a second answer to `gea::packEnvironment`'s own
  // question. A body with no environment is called through it just the same,
  // with the `void*` the signature carries either way.
  const entry = `${cppThunkName(body.sourceOwner)}(${actuals.join(', ')});`
  // Published against the INVOKE pointer, beside the `name`/`length`/source
  // text `registerSource` publishes against the same key. A value that is
  // later viewed under a type naming its `[[Construct]]` -- `Factory as typeof
  // Factory & (new (v: number) => T)` -- carries that pointer and nothing
  // else about its declaration, so this is what lets the conversion stay a
  // property of the VALUE rather than a guess about which declaration a cell
  // holds (`gea::withConstructEntry`, gea_runtime.h).
  const registration =
    `[[maybe_unused]] static const bool ${cppConstructedThunkName(body.sourceOwner)}_entry = ` +
    `gea::registerConstructEntry(&${cppThunkName(body.sourceOwner)}, &${cppConstructedThunkName(body.sourceOwner)});`
  return {
    prototype: `${signature};`,
    definition: `${signature} { ${allocation} ${entry} return ${cppReceiverName}; }\n${registration}`
  }
}

/** One thing the emitter refused, naming what it was rendering and the capability it lacked. */
export interface CppEmissionRefusal {
  /**
   * The body, the class whose construction, or the struct whose layout could
   * not be rendered.
   *
   * A struct name is not an identity the rest of the compiler mints, and it is
   * admitted here anyway because the alternative is worse: a struct is required
   * by every carrier that names it and authored by none of them, so there is no
   * single semantic owner to attribute its gap to, and refusing to name one
   * would leave the only report as an exception escaping the whole compilation.
   */
  readonly owner: FunctionId | RegionId | DeclarationId | string
  readonly reason: string
  /**
   * The capability the printer lacked, as `createCppEmitBlockedError` named
   * it -- one of `ir/certify.ts`'s keys since Phase 2.3, so a print-stage
   * refusal of a certified program is attributable to the demand the
   * certifier failed to raise. `print:refused` is the residue: a refusal this
   * module states itself (an unconstructible class, a module body with no
   * lowering) rather than one a renderer threw.
   */
  readonly key: CapabilityKey | 'print:refused'
}

/**
 * How many C++ files one program becomes.
 *
 * `single` renders the whole program as one translation unit, which is what
 * every build consumed until the other layout existed, and stays the default.
 *
 * `per-file` renders one unit per SOURCE FILE -- the file that declared a
 * body, read back off its identity (`fileIdentityOf`, identity/ids.ts) rather
 * than off any path -- plus a header holding everything those units share and
 * a program unit holding everything that must exist exactly once. The point
 * is the build, not the program: a C++ compiler works on one unit at a time,
 * so a program in one unit compiles on one core and recompiles whole after any
 * edit, while a program in many compiles in parallel and recompiles the units
 * that changed. What it costs is linkage: a function another unit may call or
 * take the address of cannot be `static`, so the inliner no longer sees that
 * nothing else reaches it. `docs/TRANSLATION-UNITS.md` records both measured.
 */
export type CppTranslationUnitLayout = 'single' | 'per-file' | 'balanced'

/** One file of a rendered program, named and ready to write. */
export interface CppRenderedUnit {
  /** `unit` is the `single` layout's one file; the other three are the `per-file` layout's. */
  readonly role: 'unit' | 'runtime-header' | 'header' | 'program' | 'module'
  readonly fileName: string
  /** For a `module` unit, the source file whose bodies it holds -- display evidence for a reader, decided by nothing. */
  readonly sourceFile: string | null
  readonly sourceFiles?: readonly string[]
  readonly source: RenderedCppSource
}

export interface CppTranslationUnitResult {
  /**
   * The program as one unit -- `single` only. `null` under `per-file`, where
   * there is no one text that is the program, and whenever any body was
   * refused: a file missing one body is silently wrong, not partially right.
   */
  readonly source: RenderedCppSource | null
  /** Every file the layout produced, in the order to write them; empty whenever any body was refused. */
  readonly units: readonly CppRenderedUnit[]
  readonly refused: readonly CppEmissionRefusal[]
  readonly printerDrift: readonly PrinterDrift[]
}

/**
 * The program's entry: the module bodies, called in evaluation order.
 *
 * This is the one function in an emitted unit that no operation in the graph
 * asked for, and it exists because module evaluation is not an operation --
 * it is what a *program* is. Every other body here is reached from a call the
 * program makes; a module body is reached because the host started the program.
 *
 * The order is the frontend's (`FrontendResult.moduleOrder`), never this
 * file's: which module runs first is decided by the import graph, which is a
 * question only the checker can answer, and re-deriving it from the bodies --
 * which carry no import edges at all -- would be inventing an answer.
 *
 * A named region with no lowered body is refused rather than skipped. Skipping
 * would emit an entry that silently runs fewer modules than the program has,
 * which is a program whose module state is half-built and whose failure lands
 * at runtime with nothing pointing back here.
 */
const entryDefinitionOf = (
  entrySymbol: string,
  moduleOrder: readonly RegionId[],
  bodies: readonly IrBody[],
  commonJsModules: ReadonlySet<RegionId>,
  hasBuiltinModuleRegistry: boolean
): { readonly text: string } | { readonly refusal: CppEmissionRefusal } => {
  const byOwner = new Map(bodies.map((body) => [body.sourceOwner, body]))
  const calls: string[] = hasBuiltinModuleRegistry ? ['gea_register_commonjs_builtin_modules();'] : []
  for (const region of moduleOrder) {
    const body = byOwner.get(region)
    if (!body) {
      return {
        refusal: {
          owner: region,
          reason: `module body ${region} is in this program's evaluation order but lowered no body to call`,
          key: 'print:refused'
        }
      }
    }
    // `signatureOf` renders a body with no ABI as `void name()`, which is
    // exactly what a run-once region is and exactly what this can call. An ABI
    // would mean parameters, and parameters mean this entry would have to
    // invent arguments for a module body -- so it refuses instead.
    if (body.abi) {
      return {
        refusal: {
          owner: region,
          reason: `module body ${region} lowered with a calling convention; a module body takes no arguments and this entry has none to pass`,
          key: 'print:refused'
        }
      }
    }
    calls.push(commonJsModules.has(region) ? `${cppCommonJsModuleName(region)}();` : `${cppBodyName(region)}();`)
  }
  // Script evaluation ends with a microtask checkpoint. Synchronously settled
  // Promise reactions queued by a module body must run before a standalone
  // entry returns; otherwise a plain compiled program drops `Promise.resolve()
  // .then(...)` work at process exit. Long-lived hosts keep using their own
  // frame checkpoint for jobs that settle later through I/O.
  calls.push('gea::detail::drainPromiseJobs();')
  return { text: [`void ${entrySymbol}() {`, ...calls, '}'].join('\n') }
}

/**
 * One record accessor per checker-resolved CommonJS target.  The record is
 * created before its initializer runs, so a recursive require observes the
 * same live exports cell. Dynamic records use the runtime evaluator; proven
 * exact records use a generated state whose field has the published carrier.
 */
interface CommonJsDefinitions {
  readonly definitions: readonly string[]
  readonly modules: ReadonlySet<RegionId>
  readonly hasBuiltinModuleRegistry: boolean
  readonly refused: readonly CppEmissionRefusal[]
}

interface NativeCommonJsRecord {
  readonly record: Extract<Representation, { readonly kind: 'record' }>
  readonly exports: Representation
}

const commonJsDefinitionsOf = (bodies: readonly IrBody[]): CommonJsDefinitions => {
  const targets = new Set<RegionId>()
  const builtinTargets = new Map<string, RegionId>()
  const nativeRecords = new Map<RegionId, NativeCommonJsRecord>()
  const refused: CppEmissionRefusal[] = []
  const addBuiltinTarget = (owner: RegionId, name: string, target: RegionId): void => {
    const prior = builtinTargets.get(name)
    if (prior !== undefined && prior !== target) {
      refused.push({
        owner,
        reason: `builtin module "${name}" resolved to two CommonJS module records (${prior} and ${target})`,
        key: 'print:refused'
      })
    } else {
      builtinTargets.set(name, target)
    }
  }
  for (const body of bodies)
    for (const block of body.blocks.values())
      for (const operation of allOperationsOf(block)) {
        if (operation.kind === 'commonjs-require') {
          targets.add(operation.owner)
          targets.add(operation.target)
          if (operation.builtinModule !== null) {
            addBuiltinTarget(operation.owner, operation.builtinModule, operation.target)
          }
        }
        if (operation.kind === 'call' && operation.builtinModuleLookup) {
          targets.add(operation.builtinModuleLookup.target)
          addBuiltinTarget(
            operation.builtinModuleLookup.target,
            operation.builtinModuleLookup.builtinModule,
            operation.builtinModuleLookup.target
          )
        }
        if (operation.kind === 'commonjs-binding' || operation.kind === 'commonjs-binding-set') targets.add(operation.owner)
        // The semantic proof is consumed by publication: unproved CommonJS
        // bindings are forced to `dynamic`, so this carrier distinction is
        // exact evidence at IR rather than ambient-shape inference.
        if (operation.kind === 'commonjs-binding' && operation.result.representation.kind !== 'dynamic') {
          if (operation.global !== 'module' || operation.result.representation.kind !== 'record') {
            refused.push({
              owner: operation.owner,
              reason: `native CommonJS module proof lowered through ${operation.global}:${operation.result.representation.kind}, not one native record`,
              key: 'print:refused'
            })
            continue
          }
          const fields = operation.result.representation.fields.filter((field) => field.key === 'exports')
          if (
            fields.length !== 1 ||
            operation.result.representation.fields.length !== 1 ||
            operation.result.representation.accessors.length !== 0 ||
            fields[0]?.required !== true
          ) {
            refused.push({
              owner: operation.owner,
              reason: 'native CommonJS module proof did not lower to exactly one stored exports field',
              key: 'print:refused'
            })
            continue
          }
          const field = fields[0]
          if (!field) continue
          if (field.value.kind === 'dynamic' || field.value.kind === 'unresolved') {
            refused.push({
              owner: operation.owner,
              reason: `native CommonJS exports field selected ${field.value.kind}; an exact module record cannot contain a boxed or unresolved export`,
              key: 'print:refused'
            })
            continue
          }
          const prior = nativeRecords.get(operation.owner)
          if (prior && representationKey(prior.record) !== representationKey(operation.result.representation)) {
            refused.push({
              owner: operation.owner,
              reason: 'one CommonJS module lowered to multiple native record carriers',
              key: 'print:refused'
            })
            continue
          }
          nativeRecords.set(operation.owner, { record: operation.result.representation, exports: field.value })
        }
      }
  for (const body of bodies)
    for (const block of body.blocks.values())
      for (const operation of allOperationsOf(block)) {
        if (operation.kind !== 'commonjs-require' || operation.result.representation.kind === 'dynamic') continue
        const native = nativeRecords.get(operation.target)
        if (!native) {
          refused.push({
            owner: operation.owner,
            reason: `native CommonJS require target ${operation.target} has no matching native module record`,
            key: 'print:refused'
          })
          continue
        }
        if (representationKey(native.exports) !== representationKey(operation.result.representation)) {
          refused.push({
            owner: operation.owner,
            reason: `native CommonJS require carrier ${representationKey(operation.result.representation)} does not match target exports carrier ${representationKey(native.exports)}`,
            key: 'print:refused'
          })
        }
      }
  for (const [name, target] of builtinTargets) {
    if (nativeRecords.has(target)) {
      refused.push({
        owner: target,
        reason: `builtin module "${name}" has a native CommonJS exports carrier, but the dynamic builtin registry cannot own it without boxing`,
        key: 'print:refused'
      })
    }
  }
  const byOwner = new Map(bodies.map((body) => [body.sourceOwner, body]))
  const definitions: string[] = []
  for (const target of targets) {
    const body = byOwner.get(target)
    if (!body) {
      refused.push({
        owner: target,
        reason: `CommonJS module record ${target} has no lowered module body to initialize`,
        key: 'print:refused'
      })
      continue
    }
    if (body.abi) {
      refused.push({
        owner: target,
        reason: `CommonJS module record ${target} resolved to a body with a calling convention; module initializers take no arguments`,
        key: 'print:refused'
      })
      continue
    }
    const native = nativeRecords.get(target)
    if (!native) {
      definitions.push(
        `inline gea::commonjs::ModuleRecord& ${cppCommonJsRecordName(target)}() { static gea::commonjs::ModuleRecord record; return record; }\n` +
          `inline gea::Value ${cppCommonJsModuleName(target)}() { return gea::commonjs::evaluate(${cppCommonJsRecordName(target)}(), [] { ${cppBodyName(target)}(); }); }`
      )
      continue
    }
    if (native.record.ownership !== 'shared-refcount') {
      refused.push({
        owner: target,
        reason: `native CommonJS module record requires shared ownership, but publication selected ${native.record.ownership}`,
        key: 'print:refused'
      })
      continue
    }
    const stateName = `${cppCommonJsRecordName(target)}_state`
    const stateAccessor = `${stateName}_of`
    const recordType = cppTypeOf(native.record)
    const exportType = cppTypeOf(native.exports)
    const exportField = cppRecordFieldName('exports')
    const recordInit = `gea::makeRef<${cppRecordStructName(native.record.shapeId)}>()`
    definitions.push(
      [
        `struct ${stateName} {`,
        '  enum class Phase { fresh, loading, loaded };',
        '  Phase phase = Phase::fresh;',
        `  ${recordType} module = ${recordInit};`,
        '};',
        `inline ${stateName}& ${stateAccessor}() { static ${stateName} state; return state; }`,
        `inline ${recordType} ${cppCommonJsRecordName(target)}() { return ${stateAccessor}().module; }`,
        `inline ${exportType} ${cppCommonJsModuleName(target)}() {`,
        `  auto& state = ${stateAccessor}();`,
        `  if (state.phase != ${stateName}::Phase::fresh) return state.module->${exportField};`,
        `  state.phase = ${stateName}::Phase::loading;`,
        `  try { ${cppBodyName(target)}(); state.phase = ${stateName}::Phase::loaded; return state.module->${exportField}; }`,
        `  catch (...) { state.phase = ${stateName}::Phase::fresh; state.module = ${recordInit}; throw; }`,
        '}'
      ].join('\n')
    )
  }
  if (builtinTargets.size > 0) {
    const registrations = [...builtinTargets.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, target]) => `gea::commonjs::registerBuiltinModule(${cppStringLiteral(name)}, &${cppCommonJsModuleName(target)});`)
    definitions.push(
      `inline void gea_register_commonjs_builtin_modules() {\n` +
        `  static const bool registered = [] { ${registrations.join(' ')} return true; }();\n` +
        `  (void)registered;\n` +
        `}`
    )
  }
  return { definitions, modules: targets, hasBuiltinModuleRegistry: builtinTargets.size > 0, refused }
}

/** The lexical module record a body uses, if it reaches any CommonJS wrapper binding. */
interface CommonJsOwner {
  readonly owner: RegionId
  readonly nativeRecord: boolean
}

const commonJsOwnerOf = (body: IrBody): CommonJsOwner | CppEmissionRefusal | null => {
  const owners = new Set<RegionId>()
  let nativeRecord = false
  let needsDynamicScope = false
  for (const block of body.blocks.values()) {
    for (const operation of allOperationsOf(block)) {
      if (operation.kind === 'commonjs-require' || operation.kind === 'commonjs-binding' || operation.kind === 'commonjs-binding-set')
        owners.add(operation.owner)
      if (operation.kind === 'commonjs-binding' && operation.result.representation.kind !== 'dynamic') nativeRecord = true
      if (operation.kind === 'commonjs-binding' && operation.result.representation.kind === 'dynamic') needsDynamicScope = true
      if (operation.kind === 'commonjs-binding-set') needsDynamicScope = true
    }
  }
  if (owners.size === 0) return null
  if (owners.size === 1) {
    const owner = [...owners][0] as RegionId
    if (nativeRecord && needsDynamicScope) {
      return {
        owner,
        reason: 'one CommonJS body selected a native module record while still requiring a dynamic wrapper scope',
        key: 'print:refused'
      }
    }
    return { owner, nativeRecord }
  }
  return {
    owner: body.sourceOwner,
    reason: `one lexical body reached CommonJS operations for multiple module records (${[...owners].join(', ')}); normalization must carry one source-module owner`,
    key: 'print:refused'
  }
}

/** The text-only sections a layout places; `empty` facts because none of them is authored by one semantic result. */
const plain = (text: string): CppArtifact => ({ text, facts: emptyCppFacts })

/**
 * One rendered body: its artifacts with their own facts, and the template
 * objects its statements were the first to reach.
 *
 * The template objects are recorded per body because the per-file layout
 * defines each one in the unit whose body reaches it. A site is one node in
 * one file, so "the first body to reach it" and "the only file whose bodies
 * reach it" are the same file -- which is what makes the snapshot sufficient.
 * Symbol keys need no such record: `Symbol.for('k')` can be named from any
 * file, and its definition is an interned constant every unit may hold.
 */
interface RenderedBody {
  readonly body: IrBody
  readonly artifacts: readonly CppArtifact[]
  readonly templateObjects: readonly TemplateObjectDefinition[]
}

/**
 * The name of one module unit: the base name, the source file relative to the
 * directory every module file shares, and `.cpp`.
 *
 * Spelled with a character walk rather than a RegExp because the architecture
 * gate forbids RegExp literals under `targets/cpp/` -- the same reason
 * `sanitizeForCppIdentifier` walks. The extension is dropped so `a.ts` and
 * `a.tsx` read the same way in a directory listing, and every path separator
 * becomes `_` so the name is one file-system entry. Two files that sanitize to
 * one spelling keep their file identity as a suffix rather than colliding.
 */
const moduleUnitNames = (
  base: string,
  files: readonly { readonly identity: string; readonly displayName: string }[]
): ReadonlyMap<string, string> => {
  const segmentsOf = (name: string): readonly string[] => name.split('/').filter((segment) => segment.length > 0)
  // A file no name was published for is spelled by its identity and takes no
  // part in the prefix: one `f57` in the set would otherwise leave every other
  // unit carrying its file's whole absolute path.
  const named = files.filter((file) => file.displayName !== file.identity)
  const split = named.map((file) => segmentsOf(file.displayName))
  // The directory every module shares is dropped, and a lone module keeps only
  // its own name: a one-file program's unit is `<stem>.index.cpp`, not the
  // file's whole absolute path spelled with underscores.
  const first = split[0] ?? []
  let shared = split.length === 1 ? Math.max(0, first.length - 1) : 0
  if (split.length > 1) {
    while (shared < first.length - 1 && split.every((segments) => segments[shared] === first[shared])) shared += 1
  }
  const sanitize = (raw: string): string => {
    let out = ''
    for (const character of raw) out += cppIdentifierCharacters.includes(character) || character === '-' ? character : '_'
    return out
  }
  const stem = (segments: readonly string[]): string => {
    const relative = segments.slice(shared)
    const last = relative[relative.length - 1] ?? ''
    const dot = last.lastIndexOf('.')
    const trimmed = dot > 0 ? last.slice(0, dot) : last
    return sanitize([...relative.slice(0, -1), trimmed].join('/'))
  }
  const counts = new Map<string, number>()
  const stems = new Map(named.map((file, index) => [file.identity, stem(split[index] ?? [])]))
  for (const value of stems.values()) counts.set(value, (counts.get(value) ?? 0) + 1)
  const names = new Map<string, string>()
  for (const file of files) {
    const value = stems.get(file.identity) ?? file.identity
    const unique = (counts.get(value) ?? 0) > 1 ? `${value}_${file.identity}` : value
    names.set(file.identity, `${base}.${unique}.cpp`)
  }
  return names
}

const cppIdentifierCharacters = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'

export const renderTranslationUnit = (input: CppTranslationUnitInput): CppTranslationUnitResult => {
  const emissionRepresentations = input.emissionRepresentations ?? [...input.plan.selected.values()]
  const printerDrift: PrinterDrift[] = []
  const refuse = (refused: readonly CppEmissionRefusal[]): CppTranslationUnitResult => ({
    source: null,
    units: [],
    refused: Object.freeze([...refused]),
    printerDrift
  })

  // An isolated unit puts everything it defines in a namespace whose names no
  // other unit can reach by accident, and a name declared there has internal
  // linkage when the namespace is unnamed -- including an `extern` one. So the
  // externs are emitted AHEAD of the namespace, where they keep the external
  // linkage that is their whole point.
  //
  // That works while their types are declared ahead of it too, which is the
  // ordinary case: a host global is a `gea::NativeHandle<gea_native_protocol_
  // Math_v1>` and both spellings come from `gea_runtime.h` and
  // `generated_support.hpp`, which the includes above already brought in. What
  // does NOT work is an extern whose type names a struct this compilation
  // minted -- `extern gea::CallableObject<NodeHandle(gea::Ref<gea_record_type_
  // 253>)> Image;` -- because that struct is defined inside the namespace and
  // cannot be named before it. Such a unit is refused rather than reordered:
  // the struct's own name is per-compilation, so hoisting the definition out
  // would put the very thing isolation exists to hide back in the global
  // namespace.
  const externs = externDeclarations(input.placements)
  const absent = absentDefinitions(input.placements)
  // Spelled in full, above: an extern or an absent global is declared at
  // global scope, before the program's namespace and before the alias block
  // inside it, so neither may name an alias. Everything rendered from here on
  // may, and the block is spliced in at `unionAliasMarker` once every
  // spelling is known.
  beginUnionAliasing()
  const selectionHelpers = input.layout === 'balanced' ? nativeSelectionHelpers(input.bodies, input.conversions) : undefined
  // Whether a declaration's OWN representation names a struct this
  // compilation mints -- asked of the representation `cppTypeOf` rendered
  // `text` from, not re-derived by searching that rendered text for the
  // struct-name prefixes. See `representationNamesMintedStruct` (records.ts):
  // it walks the same representation tree `cppRecordDeclarations` orders
  // structs from, so this and that ordering can never disagree about what a
  // carrier names.
  const programMinted = [...externs, ...absent].filter((declaration) => representationNamesMintedStruct(declaration.representation))
  // A unit that only PREFERS isolation and cannot have it is emitted the way
  // every unit was before isolation existed. Refusing is right only where
  // isolation is what keeps two units apart.
  const isolate = input.isolateSymbols !== 'off' && programMinted.length === 0
  if (input.isolateSymbols === 'required' && programMinted.length > 0) {
    return refuse([
      {
        owner: 'translation-unit',
        reason: `symbol isolation was requested for a unit whose external global names a struct this compilation minted, which cannot be declared ahead of the unnamed namespace that defines it: ${programMinted.map((declaration) => declaration.text).join(' ')}`,
        key: 'print:refused'
      }
    ])
  }
  const perFile = input.layout !== 'single'
  // The per-file layout's namespace is NAMED, because its units have to reach
  // each other's definitions and an unnamed namespace is a different one in
  // every unit. The name is the program's -- its entry symbol -- so two
  // programs a resident build links keep their namespaces apart exactly as the
  // unnamed one kept them, and `using namespace` after the close restores the
  // unqualified lookup the host-required definitions and the entry relied on
  // when the unnamed namespace's implicit using-directive supplied it.
  const namespaceName = perFile ? `gea_program_${sanitizeForCppIdentifier(input.entrySymbol ?? 'unit')}` : null
  const namespaceOpen = namespaceName === null ? 'namespace {' : `namespace ${namespaceName} {`
  const namespaceClose = namespaceName === null ? '}  // namespace' : `}  // namespace ${namespaceName}\nusing namespace ${namespaceName};`
  // Internal linkage stays the single layout's answer for the functions this
  // file mints (see `CppLinkage`); the per-file layout has to let every unit
  // name them.
  const linkage: CppLinkage = perFile ? 'external' : 'internal'

  // Computed once from the lowered bodies the caller already has: which
  // functions capture, and whether each one's environment is safe to build.
  // Every later section -- the struct declarations, the forward signatures,
  // the thunks, and each body's own statements -- reads the same index, so a
  // function's admission cannot come apart between where it is declared and
  // where it is used.
  //
  // `captures`/`directCallables` stay here rather than in `programFactsOf`,
  // and for two different reasons. `buildCaptureIndex` decides nothing: every
  // input it reads is already sealed on `IrBody.facts` by `ir/captures.ts`,
  // so it is an INDEX -- a lookup shape over one authority's answers -- and
  // moving it would relocate a projection, not a decision. `directCallables`
  // is the one whose admission compares two carriers' C++ SPELLING
  // (`cppTypeOf`), a target decision `ir/program-facts.ts` must not re-derive. Everything downstream of them -- which cells route their
  // call by name, which constructors run repeatedly, which arguments die,
  // and the borrow fixed point -- is a question about the lowered IR alone,
  // so it is asked once, in `programFactsOf`'s own dependency order, with
  // this target's remaining decisions (capture admission, coroutine-ness,
  // which writes are private to their owning body) arriving as hooks.
  // An accessor body is named by the shape, never allocated as a value, so the
  // set has to come from the carriers rather than from the operations -- see
  // `recordAccessorBodiesOf`.
  const captures = buildCaptureIndex(input.bodies, input.placements, recordAccessorBodiesOf(emissionRepresentations, input.deriver))
  const directCallables = buildDirectCallableIndex(input.bodies, captures, input.placements)
  const {
    callableMemberCandidates,
    repeatedConstructors,
    dyingArguments,
    formalsBorrowedIn,
    bodyCallsUnsafeKnownCallee,
    callableIdentityDemand,
    nativeIntegrityRestricted,
    fixedFieldStateConstant,
    singleEvaluationClasses
  } = programFactsOf(input.bodies, directCallables, input.placements, {
    captureFree: (functionId) => captures.of(functionId).kind === 'none',
    isBoxed: (declaration) => captures.isBoxed(declaration),
    isCoroutineBody,
    classInstanceOf: (declaration) => input.classes.get(declaration)?.instance ?? null,
    plainFieldRead: (receiver, key) => {
      if (receiver.kind === 'class-ref') {
        // A class over a host base reads its members through the host's
        // protocol; only a wholly projected class has plain member loads.
        if (input.classes.get(receiver.declaration)?.nativeBase !== null) return false
        return classMemberOf(input.classes, receiver.declaration, key)?.kind === 'field'
      }
      if (receiver.kind === 'record')
        return receiver.fields.some((field) => field.key === key) && !receiver.accessors.some((accessor) => accessor.key === key)
      return false
    },
    isPrivateLocal: (body, declaration) => {
      const placement = input.placements.get(declaration)
      return (
        placement?.storage.kind === 'local' &&
        String(placement.storage.owner) === String(body.sourceOwner) &&
        !captures.isBoxed(declaration)
      )
    }
  })
  // The one authority on what a structural type physically is, for
  // `emit-properties.ts` to ask a receiver's own declared field
  // representation when widening a concrete value into a `dynamic` field.
  // The deriver that built the plan, not a fresh one. A carrier depends on the
  // policies this compilation supplied -- the frontend's host-protocol and
  // typed-array censuses -- so an instance constructed here would default them
  // to `() => null` and answer a different question than the plan did. That is
  // not hypothetical: measured on one 14-line fixture, the two disagreed about
  // 10 of 32 structural types, a default-policy deriver reading
  // `typed-array(float32)` as `native-record-ref` and `native-handle(
  // ArrayBuffer@1)` as `native-record-ref`. One plan, one deriver.
  const deriver = input.deriver

  // The prelude and the struct declarations carry no single semantic result:
  // a struct is required by every carrier that names it, not authored by one
  // of them. `empty` facts are exactly right here and nowhere else in this
  // file -- a body section that reached for them would be hiding the authority
  // it does have.
  // Which record members a JSX slot binds, decided before the structs are
  // rendered because it is what narrows their reactive storage. It reads the
  // bodies only -- never the cell plan it feeds -- so the two stay acyclic.
  const boundRecordFields = reactiveBoundRecordFields(input.bodies)
  // Dispatch for the methods this program overrides, decided before the structs
  // render because it puts a member INSIDE them. The conventions come from the
  // bodies themselves -- one authority, the same one `signatureOf` spells --
  // rather than from a second derivation that could disagree with the
  // definition it has to match.
  const abiByBody = new Map(input.bodies.map((body) => [String(body.sourceOwner), body.abi]))
  // Capture-freedom for the dispatchability verdict below, read directly off
  // the published `IrBody.facts` (`ir/captures.ts`'s `publishCaptureFacts`,
  // sealed onto every body before `compiler.ts` calls `renderTranslationUnit`)
  // rather than the render-time `CaptureIndex`: a plain instance method is
  // almost never named by an `allocate-callable` operation, so the `CaptureIndex`
  // -- keyed on exactly that -- answered `{ kind: 'none' }` for one whether or
  // not its body actually captured anything. The raw fact is the one
  // the move of facts out of the target names as the unblocking
  // answer.
  const bodyFactsBySourceOwner = new Map(input.bodies.map((body) => [String(body.sourceOwner), body.facts]))
  const capturesNothingOf = (callable: FunctionId): boolean => {
    const facts = bodyFactsBySourceOwner.get(String(callable))
    return facts === undefined || (facts.capturedDeclarations.length === 0 && facts.capturedReceiver === null)
  }
  // The conversion site of everything rendered outside a body: construct
  // thunks, field initializers, virtual dispatch adapters. Same census, same
  // drift list, one owner name.
  const programSite: ConversionSite = {
    conversions: input.conversions,
    ...(selectionHelpers === undefined ? {} : { nativeSelectionHelpers: selectionHelpers }),
    printerDrift,
    owner: 'program',
    layouts: recordLayoutPolicyOf(deriver, input.classes),
    classes: input.classes,
    captures
  }
  // The dispatchability VERDICT itself -- `projection/dispatch.ts`'s
  // `virtualDispatchVerdictOf` -- moved out of this file's `virtual-methods.ts`
  // (a fact moved out of the target); `virtualMethodEmission` below
  // now only renders the C++ struct members and adapter bodies for whatever
  // it says is dispatchable.
  const virtualVerdict = virtualDispatchVerdictOf(
    input.classes,
    (callable) => abiByBody.get(String(callable)) ?? null,
    capturesNothingOf,
    input.conversions
  )
  const virtuals = virtualMethodEmission(programSite, input.classes, (callable) => abiByBody.get(String(callable)) ?? null, virtualVerdict)
  // Which classes a box can hold, by the reflection census's own verdict. A
  // prototype property is read through a `gea::Value` only where an instance
  // reached a dynamic carrier the census could not see through -- the
  // `promoteFull` boundaries of `ir/reflection-demand.ts`, which leave the
  // demand UNRESTRICTED (no `fieldOperations` map). A `full` demand whose
  // field operations are sealed came from named operations on a typed
  // instance (`a.hook = f`, `Reflect.deleteProperty(a, 'hook')`): every key
  // is spelled, no box ever holds the instance, and the hook -- whose method
  // arm boxes each method into a function object -- must not be emitted for
  // it. An incomplete census or an uncensused class keeps the hook, as
  // `records.ts` keeps the struct's protocol; a base keeps it whenever any
  // descendant needs it, because the descendant reaches its hooks through
  // the base's `virtual` members.
  const dynamicallyReadClasses = ((): ReadonlySet<DeclarationId> | null => {
    const reflection = input.reflection
    if (reflection === undefined || !reflection.complete) return null
    const held = new Set<DeclarationId>()
    for (const declaration of input.classes.keys()) {
      const demand = reflection.classes.get(declaration)
      if (demand !== undefined && (demand.level !== 'full' || demand.fieldOperations !== undefined)) continue
      for (let base: DeclarationId | null = declaration; base !== null && !held.has(base); base = input.classes.get(base)?.base ?? null)
        held.add(base)
    }
    return held
  })()
  publishBoxableClasses(input.classes, dynamicallyReadClasses)
  const prototypeHooks = prototypeReadHooks(
    input.classes,
    (callable) => abiByBody.get(String(callable)) ?? null,
    capturesNothingOf,
    (declaration) => classBoxable(input.classes, declaration)
  )
  const structMembers = new Map<string, readonly string[]>(virtuals.membersByStruct)
  for (const [struct, members] of prototypeHooks.membersByStruct)
    structMembers.set(struct, [...(structMembers.get(struct) ?? []), ...members])
  // Which record and class members may be held in a `long long`, decided before
  // the structs are rendered because it is what their storage is spelled from.
  //
  // The exclusions are the other authorities over the same member's C++ type: a
  // JSON overload binds a reference to it, and a JSX slot binds one to a prop
  // of the type the element declares. Each of those decides the member's type
  // for itself, and a census that narrowed one anyway would produce two
  // spellings of one storage.
  const jsonStructs = renderJsonStructDeclarations(input.bodies, deriver)
  // A reactive class is NOT among them. `records.ts`'s `fieldStorageType`
  // spells a celled member from this same answer -- `Signal<long long>` where
  // the slot narrowed, `Signal<double>` where it did not -- so the cell and the
  // census are one authority by construction rather than two that agree. Every
  // integer flag of `examples/apps/weather`'s store (`active`, `managing`,
  // `synced`, `fetchInFlight`, `refreshPending`, `wifiRequested`,
  // `wifiRetryTicks`, `searchResultVisible`, `searchRequestId`,
  // `searchTimerId`, `toastTimerId`) was a `Signal<double>` compared and
  // stepped in software floating point on a core with no double FPU.
  const excludedStructs = new Set<string>([...jsonStructs.structNames, ...boundRecordFields.keys()])
  // Reflected field protocols exchange the published carrier, even when an
  // ordinary direct read could tolerate an implicit integer conversion. A
  // NativeFieldRead<double> cannot read a long long slot, and native writes
  // must likewise retain their declared carrier. The reflection census has
  // already closed inherited physical protocols, so this includes a base's
  // storage reached through a derived-class Reflect call.
  const hasPayloadProtocol = (demand: ReflectionDemand): boolean =>
    demand.level === 'full' &&
    (demand.fieldOperations === undefined ||
      [...demand.fieldOperations.values()].some((operations) =>
        [...operations].some(
          (operation) =>
            operation === 'read' ||
            operation === 'write' ||
            operation === 'native-read' ||
            operation === 'native-write' ||
            operation === 'descriptor' ||
            operation === 'define'
        )
      ))
  for (const [declaration, demand] of input.reflection?.classes ?? [])
    if (hasPayloadProtocol(demand)) excludedStructs.add(cppClassName(declaration))
  for (const [shape, demand] of input.reflection?.records ?? [])
    if (hasPayloadProtocol(demand)) excludedStructs.add(cppRecordStructName(shape))
  const fieldStructNameOf = (representation: Representation, key: string): string | null => {
    if (representation.kind !== 'class-ref') return cppStructNameOf(representation)
    const owner = classFieldStorageOwnerOf(deriver, representation, key, input.classes)
    return owner === null ? null : cppClassName(owner)
  }
  const structFamilyOf = (representation: Representation): readonly string[] => {
    const name = cppStructNameOf(representation)
    if (name === null) return []
    const names = [name]
    if (representation.kind !== 'class-ref') return names
    const seen = new Set<DeclarationId>([representation.declaration])
    const classes = input.physicalClasses ?? input.classes
    for (let base = classes.get(representation.declaration)?.base; base != null && !seen.has(base); base = classes.get(base)?.base) {
      seen.add(base)
      names.push(cppClassName(base))
    }
    return names
  }
  const fieldSeeds = new Map<string, { initializer: FunctionId; representation: Representation | null }[]>()
  for (const layout of input.classes.values()) {
    for (const field of layout.fields) {
      const owner = layout.instance === null ? null : fieldStructNameOf(layout.instance, field.key)
      if (field.initializer !== null && owner !== null) {
        const slot = integerStorageSlot(owner, field.key)
        const seeds = fieldSeeds.get(slot) ?? []
        seeds.push({
          initializer: field.initializer,
          representation:
            layout.instance === null ? null : declaredFieldRepresentationOf(deriver, layout.instance, field.key, input.classes)
        })
        fieldSeeds.set(slot, seeds)
      }
    }
  }
  // Which body a `receiver.key(...)` reaches, for the census's own attribution
  // of an argument to a formal. Built off the class layouts the emitter binds
  // from, and deliberately empty for any key a virtual family overrides -- there
  // the receiver's static class does not decide which body runs.
  const families = virtualMethodFamiliesOf(input.classes)
  const overriddenKeys = new Set(families.map((family) => family.key))
  const excludedFormalOwners = new Set<string>(
    families.flatMap((family) => family.implementors.map((implementor) => String(implementor.callable)))
  )
  for (const layout of input.classes.values()) if (layout.constructor !== null) excludedFormalOwners.add(String(layout.constructor))
  const methodBodies = new Map<string, FunctionId>()
  for (const [declaration, layout] of input.classes) {
    const bound = new Set<string>()
    let current: ClassLayout | undefined = layout
    while (current !== undefined) {
      for (const method of current.methods) {
        if (
          method.callable === null ||
          bound.has(method.key) ||
          overriddenKeys.has(method.key) ||
          classMethodOverrideOf(input.classes, declaration, method.key) !== null
        )
          continue
        bound.add(method.key)
        methodBodies.set(`${declaration} ${method.key}`, method.callable)
      }
      current = current.base === null ? undefined : input.classes.get(current.base)
    }
  }
  // A signature slot may only be narrowed where the ABI says the slot holds a
  // number. Every other slot is excluded by name: the census reads call-site
  // arguments to decide a formal is integral, and an argument widened into a
  // union arm on the way in still arrives as the `double` it was.
  //
  // The RESULT is the same rule at the other end of the frame, and `async` is
  // why it has to be stated: the census reads the terminator, which carries the
  // returned `number`, while the convention returns `gea::Promise<double>`
  // because the emitter wraps that value on the way out. Narrowing from the
  // terminator alone spelled `long long gea_body_fn_decl_f168_30(...)` around
  // `return gea::Promise<double>(v0);` -- certified, and refused by clang.
  // What a construction is worth keeping -- see `ir/instantiation.ts`. A
  // stateless component's render ignores `this`, so the `construct` that exists
  // only to give it one has no reader and no consequence, and goes whole. Both
  // halves are whole-program questions, so they are answered once here rather
  // than per body.
  const instantiation: InstantiationFacts = {
    receiverIgnoringFunctions: functionsIgnoringTheirReceiver(input.bodies),
    unobservableConstructions: classesConstructedUnobservably(
      new Map(
        [...input.classes].map(([declaration, layout]) => [
          declaration,
          {
            base: constructedBaseOf(layout),
            constructor: layout.constructor,
            initializers: layout.fields.flatMap((field) => (field.initializer === null ? [] : [field.initializer]))
          }
        ])
      ),
      input.bodies
    )
  }
  const excludedSignatureSlots = new Set<string>()
  for (const body of input.bodies) {
    const abi = body.abi
    if (abi === null) continue
    abi.parameters.forEach((parameter, ordinal) => {
      if (parameter.value.kind === 'scalar' && parameter.value.domain === 'number') return
      excludedSignatureSlots.add(integerParameterSlot(body.sourceOwner, ordinal))
    })
    if (abi.result.kind !== 'scalar' || abi.result.domain !== 'number') excludedSignatureSlots.add(integerResultSlot(body.sourceOwner))
  }
  const narrowedStorage = integerStorageCensusOf({
    bodies: input.bodies,
    structNameOf: cppStructNameOf,
    structFamilyOf,
    fieldStructNameOf,
    fieldRepresentationOf: (representation, key) => declaredFieldRepresentationOf(deriver, representation, key, input.classes),
    excludedStructs,
    fieldSeeds,
    directCallees: directCallables,
    methodBodies,
    excludedFormalOwners,
    excludedSignatureSlots
  })
  // Published before `cppRecordDeclarations` runs, and for the same reason as
  // `classStaticFields` below: a class field's lazy-materialization plan is a
  // whole-compile fact (`class-layout.ts`'s `censusLazyArrowFields`), and
  // `cppFieldInitializerStatements` (constructor emission), `records.ts`'s
  // dynamic-read dispatcher (built by the very next call), and
  // `emit-properties.ts` (every static read) must all agree on it without any
  // of the three re-deriving it. Unlike `classStaticFields`, this one has an
  // actual reader in this same function -- `cppRecordDeclarations` itself --
  // so it cannot be published after, the way that one is.
  publishLazyArrowFieldPlans(input.classes, censusLazyArrowFields(input.bodies, input.classes, captures))
  // Published alongside it, and read by the same constructor emission: which
  // field initializers are a single constant, so a store that writes what
  // value-initialization already wrote can be dropped. Passed the plugin's own
  // `reactive.fields` rather than the settled `celledFields`, which
  // `cppRecordDeclarations` has not produced yet -- see the census's own
  // comment for why that is the right superset to refuse.
  publishConstantFieldInitializers(input.classes, censusConstantFieldInitializers(input.bodies, input.classes, input.hosts.reactive.fields))
  const structs = cppRecordDeclarations(
    input.plan,
    deriver,
    input.classes,
    input.hosts.reactive,
    boundRecordFields,
    structMembers,
    narrowedStorage.slots,
    input.wellKnownSymbols,
    perFile,
    input.reflection,
    emissionRepresentations,
    input.physicalClasses ?? input.classes,
    (body) => captures.of(body).kind === 'ok',
    fixedFieldStateConstant,
    singleEvaluationClasses
  )
  const recursiveContainers = cppRecursiveContainerDeclarations(input.plan, emissionRepresentations)

  // Real storage for every `ClassName.KEY = value` site the whole program
  // contains -- three.js's own idiom for a class static, spelled as a bare
  // assignment rather than a `static` member (`class-layout.ts`'s own doc
  // comment on `ClassStaticFieldStorage`). Published as a whole-compile
  // sidecar (keyed off `input.classes`'s own identity) BEFORE any body
  // renders, so a `constructor-family` `[[Get]]`/`[[Set]]` site anywhere in
  // the program can resolve it the same way `classStaticMemberOf` resolves a
  // REAL static -- by (declaration, key), never by re-deriving anything.
  // After the struct declarations and before every body, mirroring
  // `globalStorage`'s own ordering below: a static whose carrier is
  // itself a struct needs that struct to already be a complete type, and
  // every body that reads or writes one has to find its extern-free
  // definition already in scope.
  const classStaticFields = censusClassStaticFieldStorage(input.bodies, input.classes)
  publishClassStaticFieldStorage(input.classes, classStaticFields.storage)
  const classStatics = classStaticFieldStorageRows(classStaticFields.storage).map((row) => storageSpelling(row.type, row.name))

  // The reactive plan, completed with the two answers only this stage has.
  //
  // `revisions` is the struct renderer's own decision about which reactive
  // fields could not hold a cell and got a companion revision one instead, and
  // it is read back rather than recomputed so an emitted member pointer names
  // a member the struct actually declares.
  //
  // `dependencies` is decided once over every lowered body, because a JSX slot
  // subscribes a THUNK it did not itself render (`emit-jsx.ts`) -- the caller
  // and the callee are separate bodies, emitted independently and in no
  // guaranteed order. It is computed after `revisions` because which member a
  // dependency names depends on it.
  const reactive = { ...input.hosts.reactive, revisions: structs.revisionFields, celled: structs.celledFields, boundRecordFields }
  // Built here rather than beside the other includes above because one of its
  // lines is decided by the struct rendering that just ran: the cell's own
  // header is carried only where a field is ACTUALLY celled. `input.hosts
  // .reactive.fields` is the plugin's statement that a class has reactive
  // fields; `structs.celledFields`/`revisionFields` is whether this unit
  // rendered storage for one. Only the second may pull in the engine, because
  // the engine's headers are on the include path for an engine build alone --
  // which is exactly why `gea_runtime.h` forward-declares the cell instead of
  // including it.
  const cellPreamble =
    reactive.cell !== null && (structs.celledFields.size > 0 || structs.revisionFields.size > 0) ? input.hosts.reactive.cellPreamble : []
  const prelude = [
    ...standardIncludes,
    ...hostPreamblesOf(emissionRepresentations, input.placements, input.hosts, input.bodies),
    ...cellPreamble,
    runtimeInclude,
    ...hostIncludesOf(emissionRepresentations, input.hosts)
  ].join('\n')
  const reactiveCensus = reactiveDependenciesOfBodies(input.bodies, input.classes, reactive)
  const hosts: HostSpellings = {
    ...input.hosts,
    reactive: { ...reactive, dependencies: reactiveCensus.all, nodeDependencies: reactiveCensus.node }
  }
  const hostMethodAliases = buildHostMethodAliasIndex(input.bodies, input.placements, hosts)

  // The JSON overload set the runtime header declares, re-introduced HERE when
  // this unit is isolated.
  //
  // `gea_json_write`/`gea_json_read` are deliberately un-namespaced so that a
  // generated overload can call a sibling, or one of the header's primitives,
  // by a plain unqualified name (`gea_runtime.h`'s own note says so). A
  // namespace breaks exactly that: an overload declared inside one HIDES every
  // global-scope declaration of the same name for unqualified lookup, and
  // argument-dependent lookup cannot make up the difference for a
  // `std::string` or a `double` field, whose associated namespace is `std` or
  // nothing. A record with one string member then failed to compile -- "no
  // matching function for call to `gea_json_write`", with only this unit's own
  // record overloads offered as candidates.
  //
  // Two using-declarations put both sets in one scope, which is what overload
  // resolution needs. Only when isolated: at global scope a `using ::name;`
  // would name a member of the namespace it appears in, which is ill-formed.
  const jsonUsing = isolate && jsonStructs.declarations.length > 0 ? ['using ::gea_json_write;\nusing ::gea_json_read;'] : []

  // A host-method alias cell is never written or read as storage -- both ends
  // name the host member instead (`buildHostMethodAliasIndex`) -- so declaring
  // it would leave a `CallableObject` of the method's own convention in the
  // unit, boxing an `any` formal that no code ever passes.
  const globals = globalStorage(input.placements, new Set([...input.omitGlobals, ...hostMethodAliases.keys()]))

  // Environment structs ahead of every forward signature: a capturing body's
  // own formal names its struct as a pointer type, so the struct must already
  // be a complete type by the time that formal is spelled.
  const environments = input.bodies.flatMap((body) => {
    const declaration = environmentDeclarationOf(body.sourceOwner, captures.of(body.sourceOwner))
    return declaration === null ? [] : [declaration]
  })

  // The census answers per SLOT; a signature is spelled per body, so its
  // formal slots are read back here into the positions each body declares.
  // A cycle can only run through something this unit renders that carries a
  // `trace`: a struct, a recursive container, or a captured environment.
  // `gea::bufferCycleCandidate` no-ops for every other `Ref`, so for a program
  // with none of the three the engine's deferral hooks are provably dead code
  // -- and `borrow-helper-chain.ts` pins their absence, because emitting them
  // put `gea::collectCyclesIfNeeded()` into a program that allocates nothing
  // collectable at all.
  const cycleCollectableProgram = structs.declarations.length > 0 || recursiveContainers.length > 0 || environments.length > 0
  const runtimeDefinitions = input.runtimeDefinitions
    .filter((definition) => definition.requires === null || cycleCollectableProgram)
    .map((definition) => definition.text)
  const narrowedFormals = new Map<string, Set<number>>()
  for (const slot of narrowedStorage.slots) {
    const boundary = slot.lastIndexOf('#')
    if (boundary <= 0) continue
    const ordinal = Number(slot.slice(boundary + 1))
    if (!Number.isInteger(ordinal)) continue
    const owner = slot.slice(0, boundary)
    const positions = narrowedFormals.get(owner) ?? new Set<number>()
    positions.add(ordinal)
    narrowedFormals.set(owner, positions)
  }
  const formalsNarrowedIn = (owner: FunctionId | RegionId): ReadonlySet<number> => narrowedFormals.get(String(owner)) ?? new Set<number>()
  const narrowedResults = new Set<string>()
  for (const slot of narrowedStorage.slots) {
    const boundary = slot.lastIndexOf('#')
    if (boundary > 0 && slot.slice(boundary + 1) === 'result') narrowedResults.add(slot.slice(0, boundary))
  }
  const resultNarrowedIn = (owner: FunctionId | RegionId): boolean => narrowedResults.has(String(owner))
  // A field initializer is only a candidate. The runtime guard authenticates
  // it before a borrowed body is entered; all other targets keep owning ABI
  // parameters. Reuse the same borrowing and capture proofs as direct calls.
  // Integer-adapted signatures and receivers still need their normal thunk.
  const borrowableMemberBodies = new Set<FunctionId>()
  for (const candidate of callableMemberCandidates.values()) {
    const body = input.bodies.find((body) => body.sourceOwner === candidate)
    if (body?.abi?.receiver !== null || captures.of(candidate).kind !== 'none') continue
    if (formalsBorrowedIn(candidate).size === 0 || formalsNarrowedIn(candidate).size > 0 || resultNarrowedIn(candidate)) continue
    borrowableMemberBodies.add(candidate)
  }

  // Keep the old entry convention for every unproved caller. A second entry
  // may borrow stable caller slots even when the implementation re-enters JS.
  const stableBorrowEntries = new Map<string, StableBorrowEntry>()
  const physicalCounts = new Map<string, number>()
  for (const body of input.bodies) physicalCounts.set(String(body.sourceOwner), (physicalCounts.get(String(body.sourceOwner)) ?? 0) + 1)
  for (const body of input.bodies) {
    if (isRegionId(body.sourceOwner)) continue
    const entry = stableBorrowEntryOf(
      body,
      body.sourceOwner,
      (declaration) => {
        const placement = input.placements.get(declaration)
        return placement?.storage.kind === 'local' && placement.storage.owner === body.sourceOwner && !captures.isBoxed(declaration)
          ? placement.representation
          : null
      },
      formalsBorrowedIn(body.sourceOwner),
      dyingArguments,
      bodyCallsUnsafeKnownCallee(body.sourceOwner),
      {
        captureFree: captures.of(body.sourceOwner).kind === 'none',
        synchronous: !isCoroutineBody(body),
        singleBody: physicalCounts.get(String(body.sourceOwner)) === 1,
        unchangedNumericAbi: formalsNarrowedIn(body.sourceOwner).size === 0 && !resultNarrowedIn(body.sourceOwner)
      }
    )
    if (entry) stableBorrowEntries.set(cppBodyName(body.sourceOwner), entry)
  }
  const signatures = input.bodies.flatMap((body) => {
    const original = `${signatureOf(body, captures, formalsNarrowedIn(body.sourceOwner), resultNarrowedIn(body.sourceOwner), formalsBorrowedIn(body.sourceOwner))};`
    const entry = stableBorrowEntries.get(cppBodyName(body.sourceOwner))
    return entry === undefined ? [original] : [original, `${signatureOf(body, captures, new Set(), false, entry.formals, entry.name)};`]
  })
  // Source/name/length reflection keeps its facts program-wide, including
  // functions arriving through fields and ABI adapters -- one registration
  // table backs all three (`gea::CallableObject::facts()`), so a program that
  // reads any of `.toString()`, `.name` or `.length` off a callable needs
  // every body's registration, not just the one the read happens to reach.
  // Programs with none of these three reads need neither the strings nor the
  // static registrations at all.
  //
  // `Object.getOwnPropertyDescriptor(fn, "name")` and its reflective siblings
  // read the same facts a direct `fn.name` does, one call later: the `get`
  // fetching the `Object.*` member is noted, and a call through that value
  // handing over a callable is the read. A callable read through a RUNTIME
  // key (`fn[k]`) may name any of the three, so it counts as well.
  const reflectiveObjectMembers = new Set([
    'getOwnPropertyDescriptor',
    'getOwnPropertyNames',
    'hasOwn',
    'defineProperty',
    'keys',
    'entries',
    'values'
  ])
  // One read anywhere turns the source text on for EVERY function in the
  // program, so when it is on the only question worth asking is which body
  // turned it on. Env-gated because the answer is a single line and the
  // question is only asked while sizing a binary.
  const traceFunctionFacts = (body: IrBody, why: string): void => {
    if (process.env['GEA_FUNCTION_FACTS_DEBUG']) console.log(`[FACTS] ${String(body.sourceOwner)}: ${why}`)
  }
  const preserveFunctionFacts = input.bodies.some((body) => {
    const keys = stringConstantsOf(body)
    const callable = (representation: Representation): boolean =>
      representation.kind === 'function-value-dispatch' || representation.kind === 'function-and-constructor'
    const reflectors = new Set<IrValueId>()
    for (const block of body.blocks.values())
      for (const operation of block.operations) {
        // A callable BOXED into a dynamic carrier (`const named: any =
        // function named() {...}`) can reach `Function.prototype.toString`
        // through any later `String(x)`/template-literal/`+` coercion of that
        // dynamic value -- `gea::host::detail::toString` dispatches on the
        // boxed VALUE's own runtime tag, not on which read site the census
        // happened to see, so the box itself is the read that matters, not a
        // later member access this census could name. Missing this left
        // every boxed callable answering `Function.prototype.toString` with
        // the registry's generic "function () { [native code] }" fallback,
        // silently dropping the function's own name and source text.
        if (
          operation.kind === 'convert' &&
          callable(operation.source.representation) &&
          operation.result.representation.kind === 'dynamic'
        ) {
          traceFunctionFacts(body, 'a callable boxed into a dynamic carrier')
          return true
        }
        if (operation.kind === 'get') {
          if (callable(operation.receiver.representation)) {
            const key = keys.get(operation.key.value)
            if (key === undefined || key === 'toString' || key === 'name' || key === 'length') {
              traceFunctionFacts(body, `a read of "${key ?? '<runtime key>'}" off a callable`)
              return true
            }
          }
          const receiver = operation.receiver.representation
          const member =
            operation.hostMethod?.protocol === 'ObjectConstructor'
              ? operation.hostMethod.member
              : receiver.kind === 'native-handle' && (receiver.native ?? receiver.protocol) === 'ObjectConstructor'
                ? keys.get(operation.key.value)
                : undefined
          if (member !== undefined && reflectiveObjectMembers.has(member)) reflectors.add(operation.result.id)
        }
        if (
          operation.kind === 'call' &&
          reflectors.has(operation.callee.value) &&
          operation.arguments.some((argument) => callable(argument.representation))
        ) {
          traceFunctionFacts(body, 'a reflective Object.* call handed a callable')
          return true
        }
      }
    return false
  })
  // The facts every mint site of a function registers (`cppThunkEntryText`),
  // spelled once per body here rather than looked up through the thunk. Empty
  // when the census above found no reader, so `&thunk` alone is stored.
  const functionFacts = new Map<FunctionId, CallableFactsSpelling>()
  if (preserveFunctionFacts)
    for (const body of input.bodies) {
      if (isRegionId(body.sourceOwner) || body.abi === null || body.functionSource === undefined) continue
      functionFacts.set(body.sourceOwner, {
        abiType: cppAbiType(body.abi),
        name: body.functionName ?? '',
        length: body.functionLength ?? 0,
        source: body.functionSource
      })
    }
  const thunks = new Map<IrBody, RenderedThunk>()
  for (const body of input.bodies) {
    const thunk = thunkOf(body, captures, formalsNarrowedIn(body.sourceOwner), resultNarrowedIn(body.sourceOwner), linkage)
    if (thunk) thunks.set(body, thunk)
  }

  // ONE tag object per source declaration, shared by every monomorphic copy of
  // it. `gea::identifyCallable<&tag>` instantiates
  // `detail::CallableDeclarationTag` on this address, and the runtime documents
  // that address as "one program-wide address per emitted source declaration" --
  // which it was not while the emitter passed the per-COPY thunk pointer. Two
  // instantiations of one generic function are two thunks and still ONE
  // JavaScript function object, so `stateStack[i] !== State.done` compared two
  // identities of one `State.done` and answered true forever.
  //
  // Deduplicated by NAME rather than by body, since that is exactly the
  // equivalence being expressed: two bodies whose owners differ only in their
  // `@N` copy ordinal share this object.
  //
  // Taken from every body, not only the ones a thunk was rendered for: the tag
  // is named at the ALLOCATION site, and a body can reach one without
  // `thunkOf` producing a thunk of its own.
  const declarationTags = [...new Set(input.bodies.map((body) => cppCallableDeclarationTagName(body.sourceOwner)))].map(
    (name) => `inline constexpr char ${name} = 0;`
  )

  // A refused body is an answer, not a crash. Emission is the last stage that
  // can discover a missing capability, and the discovery has to travel back as
  // a named gap the same way a lowering blocker does -- an exception escaping
  // here would take down a compilation that has a perfectly good report to give.
  const refused: CppEmissionRefusal[] = structs.refused.map((refusal) => ({
    owner: refusal.structName,
    reason: refusal.reason,
    key: 'print:refused'
  }))
  for (const conflict of classStaticFields.conflicts) {
    refused.push({
      owner: conflict,
      reason: `cpp emission refuses to declare static field storage for ${conflict}: its writes carry incompatible representations`,
      key: 'print:refused'
    })
  }
  // `virtuals.refused` is deliberately NOT among them. A family with no dispatch
  // member is only a defect where something actually CALLS it through a base --
  // and `emit-properties.ts` refuses exactly there, naming the call. Reporting
  // the family itself withholds the certificate for a program that may never
  // dispatch on it: the gea framework's own `Component.template` is overridden
  // by every app component under a different convention, and every JSX app
  // resolves it concretely through the plugin's render bridge, so raising it
  // here failed 40-odd programs that had nothing wrong with them.

  const constructions = constructionsOf(programSite, deriver, input.classes, refused, linkage, abiByBody, structs.staticMethodStateClasses)

  // One intern table for the whole program, shared by every body: two bodies
  // that name the same `Symbol.for` key must reach the same static, and a
  // per-body table would give them one each.
  const symbolKeys = new Map<string, string>()

  // One table for the whole program for the same reason, and with a stricter
  // requirement: a tagged-template site's object must be ONE object, so the
  // definition every body that reaches that site calls has to be the same one.
  const templateObjects = new Map<string, TemplateObjectDefinition>()

  // The bodies are rendered before any section is placed, because the symbol
  // statics they reference are only known once every body has been rendered,
  // and C++ requires a namespace-scope name to be declared before it is used.
  // Rendering first is the whole of the reordering: each body's artifacts keep
  // their own facts and their own order.
  const renderedBodies: RenderedBody[] = []
  for (const body of input.bodies) {
    // A body's statements are not a translation unit on their own: they need a
    // signature to live in, and the owner is what names it. The open and close
    // are structure with no semantic operation behind them, which is exactly
    // what `empty` facts are for -- the statements inside keep their own.
    const templateObjectsBefore = templateObjects.size
    const commonJsOwner = commonJsOwnerOf(body)
    if (commonJsOwner !== null && 'reason' in commonJsOwner) {
      refused.push(commonJsOwner)
      continue
    }
    try {
      const sections = emitBody(
        body,
        input.placements,
        input.classes,
        hosts,
        deriver,
        input.wellKnownSymbols,
        captures,
        symbolKeys,
        templateObjects,
        directCallables,
        virtuals.dispatched,
        narrowedStorage.factsOf(body.sourceOwner),
        formalsNarrowedIn(body.sourceOwner),
        repeatedConstructors,
        dyingArguments,
        instantiation,
        (callable) => abiByBody.get(String(callable)) ?? null,
        functionFacts,
        hostMethodAliases,
        callableMemberCandidates,
        borrowableMemberBodies,
        stableBorrowEntries,
        printerDrift,
        input.conversions,
        selectionHelpers,
        callableIdentityDemand,
        nativeIntegrityRestricted,
        fixedFieldStateConstant
      )
      const stableEntry = stableBorrowEntries.get(cppBodyName(body.sourceOwner))
      const commonJsScope =
        commonJsOwner === null || commonJsOwner.nativeRecord
          ? []
          : [`gea::commonjs::Scope commonjs_scope(${cppCommonJsRecordName(commonJsOwner.owner)}());`]
      // A body's formals are named `gea_this`/`gea_arg_N`/`gea_e` by this
      // emitter, never by the user's own source -- so whether the source
      // *read* a given position is a fact only the rendered body text can
      // answer, exactly as `records.ts`'s reflection hooks already spell
      // "unread" by omitting the name rather than by (void)-casting it.
      const opening = withUnreadParametersUnnamed(
        signatureOf(
          body,
          captures,
          formalsNarrowedIn(body.sourceOwner),
          resultNarrowedIn(body.sourceOwner),
          stableEntry?.formals ?? formalsBorrowedIn(body.sourceOwner),
          stableEntry?.name ?? cppBodyName(body.sourceOwner)
        ),
        [...commonJsScope, ...sections.map((section) => section.text)]
      )
      renderedBodies.push({
        body,
        artifacts: [
          plain(`${opening} {`),
          ...commonJsScope.map(plain),
          ...sections,
          plain('}'),
          ...(stableEntry === undefined
            ? []
            : [
                plain(`${signatureOf(body, captures, new Set(), false, formalsBorrowedIn(body.sourceOwner))} {`),
                plain(
                  // The stable entry's own signature always states `gea_this`
                  // first when the body has a receiver (`formalsOf` spells it
                  // unconditionally), a fact `stableEntry.abi.parameters` --
                  // receiver-less by construction -- never carries. This
                  // owning wrapper's own formal is exactly that receiver, so
                  // it forwards unchanged: never moved (the receiver formal
                  // above is never in `narrowed`/moved sets) and never boxed.
                  `return ${stableEntry.name}(${[
                    ...(stableEntry.abi.receiver !== null ? [cppReceiverName] : []),
                    ...stableEntry.abi.parameters.map((_, ordinal) =>
                      stableEntry.formals.has(ordinal) ? cppFormalName(ordinal) : `std::move(${cppFormalName(ordinal)})`
                    )
                  ].join(', ')});`
                ),
                plain('}')
              ])
        ],
        templateObjects: [...templateObjects.values()].slice(templateObjectsBefore)
      })
    } catch (error) {
      if (!isCppEmitBlockedError(error)) throw error
      refused.push({ owner: body.sourceOwner, reason: error.message, key: error.kind })
    }
  }

  let entry: string | null = null
  const commonJs = commonJsDefinitionsOf(input.bodies)
  refused.push(...commonJs.refused)
  if (input.entrySymbol !== null) {
    const rendered = entryDefinitionOf(
      input.entrySymbol,
      input.moduleOrder,
      input.bodies,
      commonJs.modules,
      commonJs.hasBuiltinModuleRegistry
    )
    if ('refusal' in rendered) refused.push(rendered.refusal)
    else entry = rendered.text
  }

  if (refused.length > 0) return refuse(refused)

  // The union alias block goes where `unionAliasMarker` was appended: inside
  // the program's namespace, ahead of every struct body (a struct's fields
  // spell unions) and every signature. A union's arms name program structs
  // through `gea::Ref<T>`, which needs only a forward declaration, so the
  // block opens by forward-declaring every struct the unit declares anyway --
  // the same lines `appendStructDeclarations` emits, repeated, which C++
  // permits -- and then declares each alias in first-spelling order. Spliced
  // into the rendered text rather than appended, because the aliases are
  // known only once the LAST body has been rendered, and the block has to
  // come first.
  const unionAliasMarker = '// gea-union-aliases'
  const spliceUnionAliases = (source: RenderedCppSource): RenderedCppSource => {
    const aliases = endUnionAliasing()
    const forwards = [...recursiveContainers, ...structs.declarations, ...jsonStructs.declarations].filter(
      (declaration) => declaration.startsWith('struct ') && declaration.endsWith(';') && !declaration.includes('{')
    )
    const block = [...forwards, ...aliases.map(({ name, spelling }) => `using ${name} = ${spelling};`)].join('\n')
    return spliceRendered(source, unionAliasMarker, block)
  }

  const appendStructDeclarations = (builder: ReturnType<typeof createCppDocumentBuilder>): void => {
    for (const declaration of recursiveContainers) builder.append(plain(declaration))
    for (const declaration of structs.declarations) builder.append(plain(declaration))
    const qualifier = isolate && namespaceName !== null ? `${namespaceName}::` : ''
    // A recursive callable/container wrapper's `gea::detail::TraceEdges`
    // specialisation has the exact same problem `structs.runtimeClassBases`
    // solves below: re-opening `namespace gea::detail` from INSIDE the
    // isolating namespace declares a shadow `gea`, not the real one. So it is
    // closed out to global scope here too, sharing the one close/reopen
    // rather than doing it twice.
    const recursiveContainerTraceEdges = cppRecursiveContainerTraceEdges(input.plan, qualifier, emissionRepresentations)
    if (recursiveContainerTraceEdges.length === 0 && structs.runtimeClassBases.length === 0) return
    // Explicit specializations belong to the runtime template's namespace,
    // never a nested gea namespace inside the isolated program. Named program
    // types stay qualified so separately linked programs cannot collide.
    if (isolate) builder.append(plain(namespaceClose))
    for (const declaration of recursiveContainerTraceEdges) builder.append(plain(declaration))
    if (structs.runtimeClassBases.length > 0) {
      builder.append(plain('namespace gea::detail {'))
      for (const { derived, base } of structs.runtimeClassBases) {
        builder.append(plain(`template <> struct ClassRefBase<${qualifier}${derived}> { using type = ${qualifier}${base}; };`))
      }
      builder.append(plain('}  // namespace gea::detail'))
    }
    if (isolate) builder.append(plain(namespaceOpen))
  }

  if (!perFile) {
    const builder = createCppDocumentBuilder()
    builder.append(plain(prelude))
    // Everything from here to `runtimeDefinitions` is this program's own, and in
    // a resident build no other unit may see any of it. See `isolateSymbols`.
    //
    // Nothing with EXTERNAL linkage may be declared inside, which is why an
    // isolated unit with an `extern` global is refused above rather than wrapped:
    // an unnamed namespace would turn that declaration into a second, internal
    // entity and the real symbol would go unreferenced.
    if (isolate) {
      for (const declaration of [...externs, ...absent]) builder.append(plain(declaration.text))
      builder.append(plain(namespaceOpen))
    }
    builder.append(plain(unionAliasMarker))
    appendStructDeclarations(builder)
    for (const spelling of classStatics) builder.append(plain(spelling.definition))
    for (const text of jsonUsing) builder.append(plain(text))
    for (const declaration of jsonStructs.declarations) builder.append(plain(declaration))
    if (!isolate) for (const declaration of [...externs, ...absent]) builder.append(plain(declaration.text))
    for (const spelling of globals) builder.append(plain(spelling.definition))
    for (const declaration of environments) builder.append(plain(declaration))
    for (const signature of signatures) builder.append(plain(signature))
    // A field dispatcher the struct could not define inline. An accessor arm
    // CALLS a body, and every struct is declared long before any body has a
    // name, so `records.ts` puts that struct's whole dispatcher out of line and
    // this is the first point at which the names it calls exist. The map holds
    // only those structs in this layout (`needsOutOfLineFields`), so nothing
    // else moves out of the class body.
    for (const definitions of structs.fieldDefinitionsByStruct.values())
      for (const definition of definitions) builder.append(plain(definition))
    for (const definition of commonJs.definitions) builder.append(plain(definition))
    // After every body has a name, because each dispatch member forwards to one.
    for (const definition of virtuals.definitions) builder.append(plain(definition))
    for (const definition of prototypeHooks.definitions) builder.append(plain(definition))
    for (const tag of declarationTags) builder.append(plain(tag))
    for (const thunk of thunks.values()) builder.append(plain(thunk.definition))
    // After the body declarations: a construct function calls the field
    // initializers and the constructor body by name.
    for (const definition of constructDefinitionsOf(constructions)) builder.append(plain(definition))
    for (const definition of symbolKeyDefinitions(symbolKeys)) builder.append(plain(definition))
    for (const definition of templateObjectDefinitions(templateObjects)) builder.append(plain(definition))
    for (const rendered of renderedBodies) for (const artifact of rendered.artifacts) builder.append(artifact)
    // After every body, and before the entry: a host's required definition can
    // name anything this unit declared, and nothing this unit emits depends on
    // one, so the last position with no ordering constraint is the honest one.
    if (isolate) builder.append(plain(namespaceClose))
    for (const definition of runtimeDefinitions) builder.append(plain(definition))
    if (entry !== null) builder.append(plain(entry))
    const source = spliceUnionAliases(render(builder.seal()))
    return {
      source,
      units: [{ role: 'unit', fileName: `${input.unitBaseName}.cpp`, sourceFile: null, source }],
      refused: Object.freeze([]),
      printerDrift
    }
  }

  // The per-file layout. Three kinds of file, and the rule for what goes where
  // is C++'s own: a DECLARATION may appear in every unit, so it goes in the
  // header; a DEFINITION with external linkage may appear in exactly one, so it
  // goes in the unit that owns it -- a body's or a class's own file, or the
  // program unit for what belongs to no file (storage, dispatch members, the
  // host-required definitions, the entry). Record field tables belong to no
  // source declaration and live in the program unit. Class field tables live
  // with their class. JSON overloads and symbol keys remain inline.
  const headerName = `${input.unitBaseName}.hpp`
  const include = `#include "${headerName}"`

  // The prelude is a header of its own so a build can precompile it as the
  // RUNTIME layer and chain the program's header on top. It has to be this
  // text and not `generated_support.hpp`: the hosts' preambles come before
  // `gea_runtime.h` and decide what it declares (`GEA_HOST_DECLARED` turns its
  // engine stand-ins off), so a PCH built from a header without them declares
  // stand-ins that then collide with the engine's own types in every unit.
  const runtimeHeaderName = `${input.unitBaseName}.runtime.hpp`
  const runtimeHeader = createCppDocumentBuilder()
  runtimeHeader.append(plain('#pragma once'))
  runtimeHeader.append(plain(prelude))

  const header = createCppDocumentBuilder()
  header.append(plain('#pragma once'))
  header.append(plain(`#include "${runtimeHeaderName}"`))
  if (isolate) {
    for (const declaration of externs) header.append(plain(declaration.text))
    for (const definition of absent) header.append(plain(definition.declaration))
    header.append(plain(namespaceOpen))
  }
  header.append(plain(unionAliasMarker))
  appendStructDeclarations(header)
  for (const spelling of classStatics) header.append(plain(spelling.declaration))
  for (const text of jsonUsing) header.append(plain(text))
  for (const declaration of jsonStructs.declarations) header.append(plain(declaration))
  if (!isolate) {
    for (const declaration of externs) header.append(plain(declaration.text))
    for (const definition of absent) header.append(plain(definition.declaration))
  }
  for (const spelling of globals) header.append(plain(spelling.declaration))
  for (const declaration of environments) header.append(plain(declaration))
  for (const signature of signatures) header.append(plain(signature))
  for (const helper of selectionHelpers?.values() ?? []) header.append(plain(helper.declaration))
  for (const definition of commonJs.definitions) header.append(plain(definition))
  for (const tag of declarationTags) header.append(plain(tag))
  for (const thunk of thunks.values()) header.append(plain(thunk.prototype))
  for (const construction of constructions) {
    if (construction.initializerPrototype !== null) header.append(plain(construction.initializerPrototype))
    for (const prototype of construction.constructPrototypes) header.append(plain(prototype))
  }
  for (const definition of symbolKeyDefinitions(symbolKeys)) header.append(plain(definition))
  if (isolate) header.append(plain(namespaceClose))

  const program = createCppDocumentBuilder()
  program.append(plain(include))
  // At global scope whether or not the program is isolated, because that is
  // where the header declared them: an absent global is a host's name, and a
  // host's name is never inside the program's namespace.
  for (const definition of absent) program.append(plain(definition.text))
  if (isolate) program.append(plain(namespaceOpen))
  for (const spelling of classStatics) program.append(plain(spelling.definition))
  for (const spelling of globals) program.append(plain(spelling.definition))
  for (const helper of selectionHelpers?.values() ?? []) program.append(plain(helper.definition))
  for (const definition of virtuals.definitions) program.append(plain(definition))
  for (const definition of prototypeHooks.definitions) program.append(plain(definition))
  const classStructNames = new Set([...input.classes.values()].map((layout) => cppClassName(layout.declaration)))
  for (const [structName, definitions] of structs.fieldDefinitionsByStruct) {
    if (!classStructNames.has(structName)) for (const definition of definitions) program.append(plain(definition))
  }
  if (isolate) program.append(plain(namespaceClose))
  for (const definition of runtimeDefinitions) program.append(plain(definition))
  if (entry !== null) program.append(plain(entry))

  // Bodies and classes grouped by the file that declared them. The identity is
  // the grouping key; the file name is only what the unit is called.
  const groups = new Map<string, { bodies: RenderedBody[]; constructions: ClassConstruction[]; fieldDefinitions: string[] }>()
  const groupOf = (identity: string): { bodies: RenderedBody[]; constructions: ClassConstruction[]; fieldDefinitions: string[] } => {
    const existing = groups.get(identity)
    if (existing) return existing
    const created = { bodies: [], constructions: [], fieldDefinitions: [] }
    groups.set(identity, created)
    return created
  }
  for (const rendered of renderedBodies) groupOf(fileIdentityOf(rendered.body.sourceOwner)).bodies.push(rendered)
  for (const construction of constructions) groupOf(fileIdentityOf(construction.declaration)).constructions.push(construction)
  for (const layout of input.classes.values()) {
    const definitions = structs.fieldDefinitionsByStruct.get(cppClassName(layout.declaration))
    if (definitions) groupOf(fileIdentityOf(layout.declaration)).fieldDefinitions.push(...definitions)
  }
  const files = [...groups.keys()]
    .map((identity) => ({ identity, displayName: input.sourceFileNames.get(identity) ?? identity }))
    .sort((left, right) =>
      left.displayName < right.displayName ? -1 : left.displayName > right.displayName ? 1 : left.identity.localeCompare(right.identity)
    )
  const names = moduleUnitNames(input.unitBaseName, files)

  const units: CppRenderedUnit[] = [
    { role: 'runtime-header', fileName: runtimeHeaderName, sourceFile: null, source: render(runtimeHeader.seal()) },
    { role: 'header', fileName: headerName, sourceFile: null, source: spliceUnionAliases(render(header.seal())) },
    { role: 'program', fileName: `${input.unitBaseName}.cpp`, sourceFile: null, source: render(program.seal()) }
  ]
  for (const file of files) {
    const group = groups.get(file.identity)
    if (!group) continue
    const unit = createCppDocumentBuilder()
    unit.append(plain(include))
    if (isolate) unit.append(plain(namespaceOpen))
    for (const definition of group.fieldDefinitions) unit.append(plain(definition))
    for (const rendered of group.bodies) for (const definition of rendered.templateObjects) unit.append(plain(definition.text))
    for (const rendered of group.bodies) {
      const thunk = thunks.get(rendered.body)
      if (thunk) unit.append(plain(thunk.definition))
    }
    for (const construction of group.constructions) for (const definition of construction.definitions) unit.append(plain(definition))
    for (const rendered of group.bodies) for (const artifact of rendered.artifacts) unit.append(artifact)
    if (isolate) unit.append(plain(namespaceClose))
    units.push({
      role: 'module',
      fileName: names.get(file.identity) ?? `${input.unitBaseName}.${file.identity}.cpp`,
      sourceFile: input.sourceFileNames.get(file.identity) ?? null,
      source: render(unit.seal())
    })
  }
  return {
    source: null,
    units: input.layout === 'balanced' ? balanceCppUnits(units, input.unitBaseName) : units,
    refused: Object.freeze([]),
    printerDrift
  }
}
