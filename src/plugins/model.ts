import type { SlotHook } from '../projection/slots.js'
import type { DeclarationId, SemanticResultId } from '../identity/ids.js'
import type { FamilyProducer } from '../semantics/normalize/contribution.js'
import type { ProducerContext } from '../semantics/normalize/producer-context.js'
import type { SemanticOperand } from '../semantics/model/operands.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import type { LoweringContext } from '../ir/lower-operands.js'
import type { IrBlockId, IrOperand } from '../ir/model.js'
import type {
  HostBaseTable,
  HostConstructorTable,
  HostFunctionFileTable,
  HostFunctionTable,
  HostInvocationTable,
  HostIncludeTable,
  HostMemberTable,
  HostNameFileTable,
  HostNamespaceTable
} from '../targets/cpp/host/host-members.js'
import { noHostNamespaces } from '../targets/cpp/host/host-members.js'
import type { AmbientTypeRealization } from '../semantics/ambient-type-realization-transform.js'
import type { HostMethodBindingTable } from '../semantics/host-methods.js'

/**
 * The extension seam.
 *
 * This compiler translates TypeScript, and TypeScript alone. That is not
 * modesty about scope, it is what keeps the thing correct: the moment a stage
 * knows what a component is, or what mounting means, or which member of a class
 * a runtime will call later, it has stopped compiling a language and started
 * compiling one library's idea of one -- and every other library then arrives
 * as a special case bolted next to the first.
 *
 * But a library really does add meaning that the language does not state.
 * `<Row/>` is, to TypeScript, a JSX element whose tag resolves a construct
 * signature; whether the result is called once, instantiated and re-entered
 * every frame, or compiled into a static structure with patched positions is
 * something only the library that defined `Row`'s base knows. A compiler with
 * no way to be told that either guesses (which is how a framework ends up
 * hard-coded into a language compiler) or refuses every program that uses one.
 *
 * So a plugin is not a table of data this compiler consults. It is code, and it
 * changes what the compiler does:
 *
 *   - `producers` runs during normalization, with the checker, and may replace
 *     the core producer for a family outright. A plugin that wants to see an
 *     element differently sees it differently -- there is no second, weaker
 *     hook that only gets to annotate what the core already decided.
 *   - `lower` runs before the core's own lowering for every operation, and a
 *     plugin that claims one owns it completely.
 *   - `capabilities` are merged into the target manifest, so preflight censuses
 *     against what the plugin's runtime actually installs. A plugin that claims
 *     a recipe it has not written fails the same way the backend would.
 *
 * The order those hooks run in is the compiler's own publication order, not a
 * negotiation: a plugin producer publishes into the same graph, under the same
 * transactional withholding, and a plugin lowering runs after the same
 * certificate every other body waits on.
 *
 * What a plugin may NOT do is smuggle source shape back in. It sees the checker
 * because normalization does; it does not see file names, offsets, or emitted
 * text, for the same reasons nothing else here does.
 */

/** One exact declaration a host supplies. */
export interface HostOwnedDeclaration {
  /** Absolute path of the host-owned declaration file. */
  readonly declarationFileName: string
  /** The value declaration's spelling in that file. */
  readonly declarationName: string
  /**
   * Other exact declarations that the host deliberately merges into this
   * checker Symbol.
   *
   * A host sometimes supplies a replacement type while TypeScript's platform
   * declarations still contribute the global cell that names it.  The merged
   * Symbol is authentic only when EVERY declaration is one of these explicit
   * rows; this is not a name fallback.  `process` is the motivating case:
   * node-compat owns `Process`, while `@types/node/globals.d.ts` contributes
   * the global `var process` declaration that points at that type.
   */
  readonly compatibleDeclarations?: readonly HostOwnedDeclaration[]
}

/** One exact declaration a host supplies for a CommonJS wrapper parameter. */
export interface CommonJsWrapperDeclaration extends HostOwnedDeclaration {
  /** The wrapper parameter this declaration represents. */
  readonly global: 'require' | 'exports' | 'module'
}

/** One exact declared type a host carries in its native runtime. */
export interface HostNativeTypeDeclaration extends HostOwnedDeclaration {
  /** The host runtime's C++ carrier for values of this declaration. */
  readonly native: string
}

/** Capability rows a plugin's own runtime installs, merged into the target manifest. */
/**
 * A definition a plugin needs in the emitted unit, with what the unit must be
 * for it to belong there.
 *
 * A bare string could not say the second thing, so every definition was emitted
 * into every program -- including the engine's cycle-collection deferral hooks,
 * whose `gea::collectCyclesIfNeeded()` landed in a program that allocates
 * nothing traceable at all and therefore has no cycle to collect. The
 * alternative was for the target to recognize the hooks by matching their C++
 * TEXT, which would make the emitter a second authority on what the plugin
 * wrote, keyed on a string either side could change alone.
 *
 * So the plugin states the condition with the definition. `null` means
 * unconditional, which is what almost every definition is.
 */
export interface RuntimeDefinition {
  readonly text: string
  /**
   * `cycle-collectable-program`: emit only where this unit renders something a
   * cycle could run through -- a struct, a recursive container, or a captured
   * environment. `gea::bufferCycleCandidate` no-ops for a `Ref` whose
   * operations carry no `trace`, so for a program with none of those the hook
   * is provably dead, and the engine already treats the pair as optional
   * (`gea_app_entry.cpp`'s `active_ = (defer_begin && defer_end)`).
   */
  readonly requires: 'cycle-collectable-program' | null
}

export interface PluginCapabilities {
  readonly runtimeHelpers: ReadonlySet<string>
  readonly propertyRecipes: ReadonlySet<string>
  readonly nativeProtocols: ReadonlySet<string>
  /**
   * Host-owned interfaces whose checker-declared heritage is allowed to reuse
   * a standard TypedArray carrier.
   *
   * The declaration identity is the capability. The compiler still derives
   * the element domain from the interface's actual `extends` chain; a host
   * cannot state a byte width that the checker did not.
   */
  readonly typedArrayDeclarations?: readonly HostOwnedDeclaration[]
  /**
   * Host-authenticated CommonJS wrapper declarations. The key is only a
   * lookup spelling: admission verifies the resolved Symbol's complete value
   * declaration set against this host-owned declaration identity.
   */
  readonly commonJsGlobals?: ReadonlyMap<string, CommonJsWrapperDeclaration>
  /**
   * Canonical names for runtime builtins that this host's build resolves to
   * compiled source. Keys are accepted loader spellings (for example both
   * `diagnostics_channel` and `node:diagnostics_channel`); values are the
   * canonical registry names the native runtime uses. This is host build data,
   * not a compiler spelling heuristic.
   */
  readonly commonJsBuiltinModules?: ReadonlyMap<string, string>
  /**
   * Runtime source files for canonical CommonJS builtin names.  Only modules
   * with a real implementation belong here: a declaration-only or throwing
   * facade is deliberately unavailable to the native builtin lookup.
   */
  readonly commonJsBuiltinModuleSources?: ReadonlyMap<string, string>
  /**
   * Native type rows whose meaning belongs to one exact host declaration.
   *
   * Like `commonJsGlobals`, the key is a lookup spelling only. The frontend
   * admits a row only when every declaration on the resolved Symbol is one
   * of the stated exact host rows. This prevents an application-owned
   * `Process` (or an unapproved merged declaration) from inheriting Node's
   * C++ ABI by name.
   */
  readonly nativeTypesByDeclaration?: ReadonlyMap<string, HostNativeTypeDeclaration>
  /**
   * The declared type names this plugin's host owns, to the type its own
   * runtime carries their values in.
   *
   * This is the half `nativeProtocols` cannot state. A protocol name says a
   * value of that type may be read at all; this says what it physically *is* --
   * and the two are not one-to-one, because a host routinely carries many
   * declared types in one runtime type. Thirteen of gea's DOM interface names
   * all carry `gea::embedded::ui::NodeHandle`, which is why the claim set is
   * derived from the *values* here rather than the keys, and why a member table
   * keyed by the carrier has one entry where a name-keyed one has thirteen
   * chances to drift.
   *
   * The compiler never reads this file's contents from anywhere but a plugin:
   * a name absent here is not host-owned, and nothing downstream may invent a
   * carrier for it. That is what keeps `frontend.ts`'s binding pass from
   * matching a name by guesswork.
   */
  readonly nativeTypes: ReadonlyMap<string, string>
  /**
   * Host singleton values authenticated by exact declaration identity.
   *
   * The older file-keyed table remains for existing hosts. New host surfaces
   * with a collision-prone global should use this table so a complete merged
   * Symbol is checked before placement can turn it into a singleton.
   */
  readonly hostSingletonDeclarations?: ReadonlyMap<string, HostOwnedDeclaration>
  /** Packages/modules this host implements instead of compiling their JavaScript; package/* includes subpaths. */
  readonly declarationModules?: ReadonlySet<string>
  /**
   * An ambient declared type this plugin's own package REPLACES with a
   * concrete type it ships as ordinary source, keyed by the ambient name.
   *
   * The other half of what `nativeTypes` cannot state. `nativeTypes` says "a
   * value of this declared type is physically a C++ type the host runtime
   * carries" -- a spelling, for a boundary this compiler never compiles a
   * definition for. This says something narrower and different: "the language
   * surface documents this parameter as one ambient type, but every value
   * this program actually supplies is an INSTANCE OF A CLASS THE PACKAGE
   * SHIPS AS TYPESCRIPT" -- three's `WebGLRenderer` states its `_gl` as the
   * browser's `WebGLRenderingContext`, and `@geastack/native-webgl-angle`
   * supplies `NativeWebGL2RenderingContext`, a real class this compiler reads
   * and compiles like any other. No carrier needs inventing for it, no host
   * protocol needs installing -- the ambient name only needs to stop meaning
   * the wrong, structurally unrelated interface and start meaning the class
   * the value already is.
   *
   * A compiler-owned, generic source transform
   * (`semantics/ambient-type-realization-transform.ts`) is what acts on this:
   * it respells a stated ambient name to the realization's own name, in every
   * JSDoc type this program's files (and any declaration overlay already
   * applied) carry, and imports the realization from `importedFrom`. Nothing
   * about the transform names a library; the map is the whole of what a
   * plugin states.
   */
  readonly ambientTypeRealizations: ReadonlyMap<string, AmbientTypeRealization>
  /**
   * What each of this plugin's host members renders to.
   *
   * A protocol name on its own is only half an answer: `nativeProtocols` says a
   * read of it is allowed, and this says what a call on it becomes. Carrying
   * both here is what stops them drifting -- a plugin that claimed a protocol
   * the backend then had no template for would certify at preflight and refuse
   * at emission, which is the one ordering the manifest exists to prevent.
   */
  readonly hostMembers: HostMemberTable
  /** Ambient instance methods implemented by this host, resolved by declaration rather than storage carrier. */
  readonly hostMethodBindings?: HostMethodBindingTable
  /**
   * `<carrier>.<member>` keys, from `hostMembers`' own key space, whose real
   * C++ return is `void` when the checker's declared return for that member is
   * not -- see `HostSpellings.voidResults` for the defect this states the cure
   * for. A plugin with no such divergence between its own declarations and its
   * own runtime states an empty set, and nothing changes for it.
   */
  readonly hostMemberVoidResults: ReadonlySet<string>
  /**
   * How this plugin's host constructs values of its own types.
   *
   * The half `hostMembers` cannot state. `NSStackView.spacing` is a member of a
   * view and `new NSStackView()` is not a member of anything -- it is the one
   * expression that brings the view into existence -- so a plugin that stated
   * only members would leave every program that builds a host object refused at
   * emission with nothing to render, while preflight certified it.
   */
  readonly hostConstructors: HostConstructorTable
  /** Checker-authenticated host-handle `[[Call]]` implementations, keyed `${carrier}.call`. */
  readonly hostInvocations?: HostInvocationTable
  /**
   * The ambient free functions this plugin's host defines, to the C++ each is.
   *
   * The third thing a host owns that is neither a member nor a constructor.
   * `installRootViewController(vc)` is a bare name in the program and a
   * qualified free function in the host's runtime; with no table for it the
   * backend has only one shape left for "a value you call" -- a callable
   * carrier -- so it declares `extern gea::CallableObject<...>` of that name
   * and calls through it. That compiles and never links: the host exports a
   * function, and this declared a global variable.
   *
   * Keyed by the name the program writes, like `nativeConstants` and for the
   * same reason: a function reached as a bare name has no receiver type to be
   * filed under.
   */
  /** C++ free functions that synchronously consume an owned array snapshot as a span. */
  readonly hostArraySnapshotFunctions?: ReadonlySet<string>
  /** Functions whose host adapter consumes native array carriers without the vector ABI. */
  readonly hostNativeArrayFunctions?: ReadonlySet<string>
  readonly hostFunctions: HostFunctionTable
  /**
   * The same functions, for a host that declares one name more than once.
   *
   * Keyed by the declaration file a program's binding resolves to, and consulted
   * before `hostFunctions`. Apple's `installRootView` is declared by UIKit and by
   * AppKit both -- two functions, two thunks, one bare name -- and the flat table
   * above can hold only one of them. A host with no such collision states an
   * empty table and every name is answered exactly as before.
   */
  readonly hostFunctionsByDeclaration: HostFunctionFileTable
  /**
   * The global names this host owns as NAMESPACES rather than as values.
   *
   * See `HostNamespaceTable`. Stated separately from `hostFunctions` because a
   * namespace is not callable and a function is not traversable: conflating
   * them would let `deviceInfo` be called and `requestAnimationFrame.foo` be
   * read, and both are refusals this compiler should make by construction.
   */
  readonly hostNamespaces: HostNamespaceTable
  /**
   * The same, for a host that claims one namespace root name under more than
   * one of its own declaration files.
   *
   * Keyed by the declaration file, exactly as `hostFunctionsByDeclaration` is
   * and consulted the same way, before `hostNamespaces.roots`: two of a host's
   * own files declaring one name as a namespace root is the same collision a
   * doubly-declared function is, and only the file the program's binding
   * actually resolved to says which root was meant. A host with no such
   * collision states an empty table and every root is answered exactly as
   * before.
   */
  readonly hostNamespaceRootsByDeclaration: HostNameFileTable
  /**
   * Namespace roots authenticated by their complete checker declaration set.
   * A configured name masks the legacy name-only root when the resolved symbol
   * is merged with a caller declaration.
   */
  readonly hostNamespaceRootDeclarations?: readonly HostOwnedDeclaration[]
  /**
   * The type this host carries the one object behind each of those namespace
   * roots in, keyed by the root's own name -- `window` ->
   * `gea::host::WindowFacade`.
   *
   * A root is a path and not a cell, which is what `hostNamespaces` says and
   * what the emitter acts on: nothing named `window` is ever materialized,
   * every use of it resolves to a spelling. This states the other half of that
   * fact -- the path is not nothing, it is one object the host holds, and this
   * is its type. The representation layer needs it because a carrier is asked
   * of the ROOT itself (`window`, as a reference and as a binding read), and
   * the only other answer available is the ambient DOM declaration the root's
   * name happens to have, which is a 26-field flattening of `Window & typeof
   * globalThis` that no host implements. See
   * `representation/policies.ts`'s `HostNamespaceRootPolicy`.
   *
   * Separate from `nativeTypes` because it is keyed differently and cannot be
   * folded into it: `nativeTypes` is keyed by a declared TYPE name, and a
   * namespace root's type is routinely anonymous or an intersection with no
   * name to key by. A root the plugin states no type for is simply not
   * answered, and derives exactly as it did before -- nothing here invents a
   * spelling.
   */
  readonly hostNamespaceRootTypes: ReadonlyMap<string, string>
  /**
   * A host's own `[[HasInstance]]`: the C++ predicate that answers `v
   * instanceof <root>` for the object a namespace root names, keyed by the
   * SAME native type `hostNamespaceRootTypes` maps that root to.
   *
   * `Buffer` is the case. Node's `Buffer` is one object that is both a
   * constructor and a namespace of statics; this compiler answers the namespace
   * half and carries the VALUE as an empty facade struct
   * (`namespaceRootTypes`), which has no prototype chain for 13.10.2 to walk.
   * But `x instanceof Buffer` is live code in `@hono/node-server`, the question
   * is not unanswerable at all, and the host already knows the exact answer:
   * `Buffer.isBuffer` IS `instanceof Buffer` (Node's own docs say so), and it is
   * a host brand read, not a structural guess -- a `Uint8Array` that no Buffer
   * factory produced answers `false`.
   *
   * Stated rather than inferred from the member table for the same reason every
   * other row here is stated: "the member called `isBuffer` must be the instance
   * test" is a naming convention, and a compiler that acts on one is guessing.
   * The spelling is a function of one argument, applied to the left operand.
   */
  readonly hostInstanceTests?: ReadonlyMap<string, string>
  /**
   * The global names this host owns as SINGLETON OBJECTS: one instance the host
   * itself holds, reached by name and never loaded from a cell.
   *
   * `document` is the case, and it is neither of the two above. It is not a
   * namespace -- its members are members of a host TYPE, resolved through
   * `hostMembers` on that type's carrier like any other host object's. It is
   * not an ordinary value either: the engine's `Document` has a private
   * constructor and one instance, so `extern ... document;` names a cell that
   * does not exist and a local holding a copy does not compile.
   *
   * A plugin states this from what its own package says: a host that ships a
   * receiverless member table for an object is telling you exactly that the
   * object is reached by name.
   */
  readonly hostSingletons: ReadonlySet<string>
  /**
   * The same, for a host that claims one singleton name under more than one of
   * its own declaration files.
   *
   * Keyed by the declaration file and consulted before `hostSingletons`, on
   * the same precedent as `hostFunctionsByDeclaration`. A host with no such
   * collision states an empty table and every name is answered exactly as
   * before.
   */
  readonly hostSingletonsByDeclaration: HostNameFileTable
  /**
   * Ambient global names this host declares it does NOT provide.
   *
   * The other half of a host describing its platform, and the half nothing
   * could state before. An ambient declaration is a contract with a host --
   * `declare var VideoFrame: {...}` says "something out there defines this" --
   * and a compiler with no way to be told otherwise believes every one of them.
   * Measured, that belief is a silent miscompile: `typeof VideoFrame !==
   * 'undefined'` folds to `true` while the unit emits an `extern` no object
   * file defines, so a library's own absence guard takes the branch that cannot
   * work and the failure lands in the linker, or at runtime, rather than here.
   *
   * three.js is written to run where these may not exist and says so in its own
   * source -- `typeof VideoFrame !== 'undefined' && image instanceof VideoFrame`.
   * A native ANGLE context is exactly such a place. Stating the absence is what
   * lets that guard mean what it says.
   *
   * A name here is `undefined` at every reference, which is the language's own
   * answer for a global that is not there, so `typeof` yields `'undefined'` and
   * the guarded branch is dead. It is NOT a refusal: refusing would reject a
   * program that is correct precisely because it checked.
   *
   * A host that states nothing changes nothing -- every ambient name keeps the
   * treatment it has today.
   */
  readonly absentGlobals: ReadonlySet<string>
  /**
   * What a unit must declare before it may name one of this host's spellings,
   * keyed by the spelling.
   *
   * Keyed rather than stated once per plugin, for the reason `nativeIncludes`
   * is: a program that uses no host spelling must carry no host declaration.
   */
  readonly hostPreambles: ReadonlyMap<string, readonly string[]>
  /**
   * Which of this host's types derive from which, as the host states it.
   *
   * A third fact about the same protocols, and the one TypeScript's structural
   * view cannot supply: two opaque handles are unrelated to the checker no
   * matter what the host's own class hierarchy says, so a program that passes
   * an `NSStackView` where an `NSView` is declared is refused for a conversion
   * that the target performs implicitly and for free.
   */
  readonly nativeBases: HostBaseTable
  /**
   * The header each of this host's carriers is declared by.
   *
   * A host's spellings name types this compiler never wrote, so a unit that
   * uses them has to include the host's own declarations -- and only when it
   * uses them, which is why this is keyed by carrier rather than stated once
   * per plugin. Without it a program emits perfectly correct text naming types
   * nothing declared, and the failure lands in clang rather than here.
   */
  readonly nativeIncludes: HostIncludeTable
  /**
   * Ambient names this host defines as constants, to the C++ text each is.
   *
   * Keyed by the name the program writes, because a constant is a VALUE and a
   * value has no type table to be filed under. `NSBoxCustom` is an Objective-C
   * enumerator: there is no C++ global of that name to link against, and
   * declaring one is not merely unlinkable but ill-formed in Objective-C++,
   * where the enumerator is already in scope. What the host states instead is
   * the text -- `4` -- and the read renders it.
   */
  readonly nativeConstants: ReadonlyMap<string, string>
  /**
   * The same, for a host that declares one constant name under more than one
   * of its own declaration files.
   *
   * Keyed by the declaration file, on the same precedent as
   * `hostFunctionsByDeclaration`: two of a host's own files can declare one
   * name as a different ambient constant, and only the declaration this
   * program actually resolved to says which value was meant. Consulted before
   * `nativeConstants`; a host with no such collision states an empty table and
   * every name is answered exactly as before.
   */
  readonly hostConstantsByDeclaration: HostFunctionFileTable
  /**
   * C++ definitions this plugin's host requires every generated unit to carry.
   *
   * A host runtime can depend on the compiled program, not only the other way
   * round: the gea engine's frame loop calls `generated::drainMicrotasks()` on
   * every frame and `gea_cpp_clear_microtasks()` when an app starts, because
   * the microtask queue belongs to the compiled program and only the program
   * can drain it. Those are declarations in the engine and definitions
   * nowhere, so a unit that omits them compiles and does not link.
   *
   * Text rather than structure because there is nothing here for this compiler
   * to reason about -- it is the host's own C++, appended verbatim, exactly as
   * a member template is. A plugin whose host asks nothing of a unit states
   * nothing.
   */
  /**
   * Header paths this build's `generated_support.hpp` must state, as bare
   * paths -- the `#include` line is the CLI's spelling, not a plugin's.
   *
   * The support header is a declaration of what a generated unit is compiled
   * against, and a host whose bridge the unit is compiled against is the only
   * authority on whether it is. `cli-emit.ts` used to answer that question by
   * substring-searching the already-rendered C++ for one host's include text,
   * which is a source-shaped authority over generated text -- two invariants at
   * once -- and it held that host's header spelling in a core code path
   * besides. Stated by the plugin, rendered by the CLI, so neither knows the
   * other's half.
   *
   * Gated by the plugin on its OWN activation condition, not on installation:
   * a plugin whose tables are data is installed for builds that never touch it
   * (see `applePlugin`'s `appleBridgeArtifacts` for the same reasoning about
   * the same option), and stating a header for one of those would put a host's
   * declarations into every unrelated program's output.
   */
  readonly generatedSupportIncludes: readonly string[]
  readonly runtimeDefinitions: readonly RuntimeDefinition[]
  /**
   * What a JSX FRAGMENT is, in this host's own C++, or `null` if it has none.
   *
   * `<>...</>` names no tag, so the intrinsic recipe -- which is entirely "call
   * the host's create with this tag string" -- has nothing to pass. What a
   * fragment builds is the host's answer and no one else's: a host with a node
   * tree may have a real fragment node that appends its children into whatever
   * it is appended to, and a host without one has no meaning for the syntax at
   * all. So it is stated here, as one expression, and a plugin that leaves it
   * `null` leaves every fragment refused by name at emission -- the same
   * refusal an unclaimed member gets, rather than an invented node.
   *
   * The plugin reads it from what its own package already ships. gea's is
   * `Document.createDocumentFragment`, which its host-shim table states as a
   * receiverless document method with `NodeHandle` as its return type -- the
   * engine's `Document::createDocumentFragment` (`engine/ui/document.h`),
   * whose `appendChild` moves a fragment's children into the parent rather
   * than nesting the fragment itself.
   */
  readonly elementFragment: string | null
  /**
   * Intrinsic tags whose SINGLE-TEXT-RUN form this host builds as a text node
   * rather than as a container with a text child.
   *
   * Two authorities, deliberately split. Whether an element's contents ARE one
   * text run -- no element children, exactly one run -- is a fact about the
   * element, and the compiler answers it from the children's own carriers
   * (`ir/lower-element.ts`). WHICH tags then collapse is a fact about the host's
   * node model, and only the host knows it: gea's engine has a real text node
   * whose class and style work exactly as an element's do, so a `<span>` that
   * holds only characters IS that node, while a `<div>` never is. A host that
   * leaves this empty builds every element as a container, which is what every
   * host did before this existed.
   *
   * The rule and the list are both v1's -- `canUseTextNodeForElement` and
   * `isTextNodeTag` in the gea plugin package's `cpp-template-renderer.ts` --
   * and the plugin reads the list from that package rather than restating it.
   */
  readonly elementTextTags: readonly string[]
  /**
   * Class member names this host reaches without the program spelling them.
   *
   * `semantics/normalize/reachability.ts` keeps an instance method only when
   * live code names it, and a name only a lowering synthesizes is one no walk
   * over the source can see: the gea plugin turns `instance.render(root,
   * depth)` into a call to the class's own `template` member
   * (`plugins/gea/render-bridge.ts`), so `template` is reached by this host and
   * spelled by nobody. Stating it here rather than in the reachability walk is
   * what keeps that walk generic -- a member name hard-coded there would be one
   * host's contract living in the compiler.
   */
  readonly reachedMemberKeys: ReadonlySet<string>
  /**
   * Whether programs holding this host cannot discharge an obligation on
   * `Object.prototype`'s keys, so the proofs that would raise one must refuse
   * up front and leave the read boxed.
   *
   * Two proofs replace a boxed read with a proven `undefined` by resting on
   * "Object.prototype lacks this key": the class-family absence proof
   * (`flow/class-family-member-read.ts`) and the numeric-absence proof
   * (`derived-expression-type.ts`). Each records a DEFERRED obligation the
   * final host mutation census judges long after the read is typed. Under the
   * census's `*` wildcard no such obligation can be judged true, and the
   * program loses its certificate to a diagnostic -- a sound outcome, but a
   * worse one than the boxed read the proof replaced. three.js programs take
   * that wildcard through the ANGLE host (troika's writes through receivers
   * the census cannot prove non-global, `threeWebGLBufferData( ... )`'s
   * arguments), so that host states the fact here instead of every build
   * remembering `GEA_FAMILY_MEMBER_ABSENT_KEYS=0 GEA_NUMERIC_ABSENCE=0`.
   *
   * The statement is about programs that HOLD this host, not every compile:
   * the built-in plugins are installed for every compilation, so a host's word
   * alone would refuse the proofs for programs that never touch it. A program
   * is this host's when reachable code names one of its `hostFunctions` --
   * `nativeWebGL.ts` calls `threeWebGLBufferData` and its kin on every path,
   * and nothing else spells those names.
   *
   * A stopgap by construction: it mirrors those two kill switches and goes
   * away with them when the census stops taking the wildcard. Optional;
   * absent means the proofs run.
   */
  readonly refusesObjectPrototypeAbsenceProofs?: boolean
  /**
   * Which class fields this library holds in a REACTIVE CELL, keyed by the
   * class that declares them.
   *
   * A cell is storage, not a box: it holds exactly the `T` the field's carrier
   * already says, and adds only the subscriber list a write notifies. So this
   * changes what a struct member's C++ TYPE is and nothing else -- reads and
   * writes keep the spellings they had, and no value anywhere becomes dynamic.
   * The cell's own spelling is `nativeReactiveCell` below.
   *
   * Stated by the plugin because "which classes have reactive state" is a
   * library's question and not TypeScript's: a field of a class is a field of a
   * class, and nothing in the language says that assigning one should re-render
   * anything. gea answers it from its own two bases (`contract.ts`'s
   * `geaReactiveBaseNames`) -- and answers it NARROWLY, because its own
   * documentation promises that a plain `Component` pays nothing for
   * reactivity.
   *
   * Unlike every other table here, this one is filled DURING the compilation
   * rather than stated up front: a class declaration is not known until the
   * program has been read. It is shared by reference with the producer that
   * fills it (`component-classes.ts`), exactly as that plugin's `facts` and
   * `componentClasses` already are, and it is read only after normalization has
   * finished -- so a reader always sees the whole answer for the one program
   * this plugin instance was created for.
   */
  readonly reactiveClassFields: ReadonlyMap<DeclarationId, ReadonlySet<string>>
  /**
   * The C++ cell a reactive field's storage is wrapped in, as a template whose
   * one argument is the carrier the field would otherwise have had.
   *
   * A spelling rather than a structure, for the same reason `nativeTypes` is
   * one: the type belongs to the library's runtime, and a name minted here
   * would be a second identity for it. gea's is the engine's own
   * `gea::embedded::ui::Signal<T>` (`core/packages/core/include/ui/signal.h`),
   * which was written to be exactly this -- "a drop-in for a `T` everywhere the
   * generated code reads the field", with an `operator=` that assigns and
   * notifies. `null` for a plugin that marks no fields reactive.
   */
  readonly nativeReactiveCell: string | null

  /**
   * What a unit must carry before it may name `nativeReactiveCell`.
   *
   * Stated beside the spelling because it is the same fact one step on: a
   * plugin that names a type from its library's runtime is the only thing that
   * knows where that type is declared. It was left empty on the claim that
   * `gea_runtime.h` already carries the engine's cell, and that claim was
   * wrong -- the header only FORWARD-declares `gea::embedded::ui::Signal<T>`
   * (deliberately: `ui/signal.h` is on the include path for an engine build
   * only, so naming it unconditionally would break every program that does not
   * link the engine). A reference to an incomplete class template is
   * well-formed, so a JSX program got away with it by including the engine for
   * its own reasons -- and an ordinary program with a reactive field did not,
   * failing at the field DECLARATION with "implicit instantiation of undefined
   * template" and then cascading into every conversion that touches the class.
   *
   * Emitted only where a field is actually celled, which is what keeps the
   * forward declaration's whole purpose intact.
   */
  readonly nativeReactiveCellPreamble: readonly string[]
}

export const noPluginCapabilities: PluginCapabilities = Object.freeze({
  runtimeHelpers: new Set<string>(),
  propertyRecipes: new Set<string>(),
  nativeProtocols: new Set<string>(),
  typedArrayDeclarations: [],
  commonJsGlobals: new Map(),
  commonJsBuiltinModules: new Map(),
  commonJsBuiltinModuleSources: new Map(),
  nativeTypes: new Map(),
  nativeTypesByDeclaration: new Map(),
  ambientTypeRealizations: new Map(),
  hostMembers: new Map(),
  hostMemberVoidResults: new Set<string>(),
  hostConstructors: new Map(),
  hostInvocations: new Map(),
  hostFunctions: new Map(),
  hostFunctionsByDeclaration: new Map(),
  hostNamespaces: noHostNamespaces,
  hostNamespaceRootsByDeclaration: new Map(),
  hostNamespaceRootDeclarations: [],
  hostNamespaceRootTypes: new Map(),
  hostInstanceTests: new Map(),
  hostSingletons: new Set<string>(),
  hostSingletonsByDeclaration: new Map(),
  hostSingletonDeclarations: new Map(),
  absentGlobals: new Set<string>(),
  hostPreambles: new Map(),
  nativeBases: new Map(),
  nativeIncludes: new Map(),
  nativeConstants: new Map(),
  hostConstantsByDeclaration: new Map(),
  generatedSupportIncludes: [],
  runtimeDefinitions: [],
  elementFragment: null,
  elementTextTags: [],
  reachedMemberKeys: new Set<string>(),
  reactiveClassFields: new Map(),
  nativeReactiveCell: null,
  nativeReactiveCellPreamble: []
})

/**
 * One plugin, bound to one compilation.
 *
 * A plugin that learns something during normalization and acts on it during
 * lowering has to remember it in between, and that memory belongs to the
 * program it was learned from. So the registry holds factories, and every
 * compilation instantiates fresh: a fact derived from one program can never be
 * read back while compiling another.
 */
export interface PluginInstance {
  /**
   * Producers this plugin installs, built from the same context the core's are
   * so every family shares one ordinal authority.
   *
   * A producer whose family the core also installs replaces it. Two producers
   * for one family would publish the same operation twice under the same
   * identity, so precedence is stated rather than merged.
   */
  readonly producers: (context: ProducerContext) => readonly FamilyProducer[]
  /** Lowers `operation` and returns true, or returns false to leave it to the core. */
  readonly lower: (ctx: LoweringContext, block: IrBlockId, operation: SemanticOperation) => boolean
  /**
   * The slot census's answer for operands of operations this plugin lowers
   * its own way (`projection/slots.ts`); `null` defers to the core census.
   * The same seam as `lower`, asked one stage earlier, so a plugin that
   * builds a frame of its own also states which carriers fill it.
   */
  readonly slotOf?: SlotHook
  /**
   * Lowers one PROP of an intrinsic element, or returns false to leave it to
   * the core's own `elementProp`.
   *
   * The narrower sibling of `lower`, and it exists because an intrinsic element
   * is the core's to lower while a handful of the names written on one are not.
   * `ref={this.imgEl}` is the case that forced it: JSX's `ref` is not an
   * attribute of the node at all -- it names a place to PUT the node, so its
   * meaning is a store into the referenced slot, not a property write. Nothing
   * about that is TypeScript's, and a library that spells it differently (or
   * not at all) must not have this compiler's answer imposed on it.
   *
   * Offered per prop rather than per element so the plugin claims exactly the
   * names it knows and every other prop keeps the core's own path, unchanged.
   */
  readonly lowerElementProp?: (
    ctx: LoweringContext,
    block: IrBlockId,
    lineage: SemanticResultId,
    node: IrOperand,
    key: SemanticOperand,
    value: SemanticOperand
  ) => boolean
  readonly capabilities: PluginCapabilities
  /**
   * Rewrites one file's source before the checker parses it, or `null` to leave
   * it exactly as written.
   *
   * The one hook that runs before everything else, because some libraries state
   * meaning in a form the CHECKER cannot type. `<NSStackView spacing={8}/>` is
   * the case that forced it: TypeScript types every JSX element as
   * `JSX.Element`, never as the tag's own class -- measured, and true even with
   * `jsx: "react-jsx"` and a factory declared to return `InstanceType<T>` --
   * and JSX attribute checking requires a props PARAMETER, which an AppKit
   * class does not have, so `spacing="not-a-number"` raises no diagnostic at
   * all. A producer reading the checker's answer after the fact therefore has
   * nothing better to read; the element has to become construction and property
   * assignment BEFORE the checker sees it, which is exactly what v1 does with a
   * Babel transform in `vite-plugin-apple-native`.
   *
   * Text in, text out, so what the checker types is a real program a person
   * could have written -- not a private AST this compiler alone understands.
   * A plugin that returns `null` costs one substring test.
   */
  readonly transformSource?: (input: PluginSourceFile) => string | null
  /**
   * Writes the files this plugin's host requires *beside* the emitted unit,
   * into the caller's `--out-dir`.
   *
   * The one hook that runs after everything else, and the only one that touches
   * a filesystem. It exists because a host's contribution to a build is not
   * always text inside the translation unit: Apple's bridge is a header the
   * unit `#include`s and an Objective-C++ source the target links, neither of
   * which can be a C++ string spliced into a generated function. The core
   * already states the same kind of fact for itself -- `cli-emit.ts` copies
   * `gea_runtime.h` into the output directory because which runtime a unit
   * needs is the compiler's own fact -- and this is that sentence with "the
   * compiler's" replaced by "the plugin's".
   *
   * Called only once a unit was actually emitted: an artifact next to a build
   * that produced nothing is a stale file the next build would read as fresh.
   * A plugin that omits it writes nothing, which is every plugin whose host is
   * fully described by `capabilities`.
   */
  readonly writeArtifacts?: (outDir: string) => void
}

/** One file offered to a plugin's source transform. */
export interface PluginSourceFile {
  readonly fileName: string
  readonly text: string
}

/**
 * What the build told a plugin, verbatim, keyed by the option name the caller
 * wrote (`gea.cpp-prelude`).
 *
 * The compiler never reads a key of this map. It carries a library's own
 * settings from the command line to the one library they belong to, which is
 * what keeps an option like `gea.cpp-prelude` -- a path to C++ the gea build
 * generated and the unit must carry -- out of the compiler's own vocabulary.
 * Dropping such an option silently is the failure this exists to prevent: the
 * program compiles, links, runs, and renders unstyled.
 */
export type PluginOptions = ReadonlyMap<string, string>

export interface CompilerPlugin {
  readonly name: string
  readonly instantiate: (options: PluginOptions) => PluginInstance
}

/** A plugin instance that changes nothing, for a compilation with none installed. */
export const inertPluginInstance: PluginInstance = Object.freeze({
  producers: () => [],
  lower: () => false,
  capabilities: noPluginCapabilities
})
