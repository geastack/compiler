import type { DeclarationId, FunctionId, RegionId } from '../../../identity/ids.js'
import type { ReactiveDependency } from '../reactive-dependencies.js'
import type { HostIntrinsicMember } from '../../../semantics/host-protocols.js'
import type { Representation } from '../../../representation/model.js'
/**
 * What a host protocol's members lower to.
 *
 * A host object is not a struct this compiler lays out: its members are the
 * host's own implementation, reached by a spelling the host defines. So a
 * member is rendered from a template naming that spelling, exactly as the v1
 * plugin's host shims do (`geatsc-plugin-gea/src/host-shims.ts`), rather than
 * by inventing a field offset or a calling convention.
 *
 * Two kinds, because a host member is one of two things and the difference is
 * observable. A `property` is read at the access itself -- `el.scrollTop` is a
 * value. A `method` is NOT: `el.setAttribute` on its own is a function, and
 * what the program does is *call* it, so the template renders at the call and
 * the access alone renders nothing. Treating a method as a property would
 * materialise a callable no host symbol corresponds to.
 *
 * `{receiver}` is the object the member was reached through, `{arg0}`,
 * `{arg1}`, ... are the call's own arguments, and `{value}` -- in a `store`
 * template only -- is what is being written. A template naming a slot the site
 * does not supply is refused rather than rendered with a hole, so an arity the
 * host does not implement cannot reach C++.
 */
export type HostMember =
  /**
   * A data property, with one template per direction.
   *
   * Read and write are separate host spellings, not one spelling used twice:
   * `view.frame` reads as `(...).frame` and writes as `(...).frame = {value}`,
   * and a numeric setter may need a cast the getter does not. Either may be
   * `null` -- a read-only member states no `store`, and an access in the
   * direction a member does not state is refused by name at the site rather
   * than rendered from the other direction's text. A row states at least one;
   * a row stating neither would claim a member it cannot render at all.
   */
  | {
      readonly kind: 'property'
      readonly emit: string | null
      readonly store: string | null
      /** Fixed carrier returned by the host template, when it differs from a site's checker result. */
      readonly resultRepresentation?: Representation
      /** Direct numeric operands can use this borrowed sequence spelling; reads and spreads retain the callable ABI. */
      readonly numericRestCall?: string
    }
  | {
      readonly kind: 'method'
      readonly emit: string
      readonly arity: number
      readonly receiver?: 'host' | 'raw'
      /** The host returns a dynamic Value that must be checked at the result boundary. */
      readonly result?: 'dynamic'
    }
  // `console.log`/`console.error` take however many arguments a call site
  // happens to pass -- `lib.dom.d.ts` declares both `(...data: any[]): void`
  // -- which no fixed integer `arity` can describe. This arm names that
  // shape explicitly rather than smuggling it through a sentinel number
  // (`-1`, `Infinity`): a caller that switches on `arity` gets a type error
  // if it forgets this arm exists, where a sentinel would silently fall
  // through to the fixed-arity check instead.
  | {
      readonly kind: 'method'
      readonly emit: string
      readonly arity: 'variadic'
      readonly receiver?: 'host' | 'raw'
      readonly result?: 'dynamic'
    }
  // A member whose C++ spelling is not a template at all, because it depends
  // on the STATIC TYPES at each individual call site rather than on the
  // member alone -- `Promise.resolve(x)` mints a `gea::Promise<T>` whose `T`
  // is that call's own payload, and no fixed string can name it. A dedicated
  // renderer states the whole call (`promiseResolveText`,
  // emit-host-invoke.ts), so both `emit` and any fixed `arity` are unread
  // here, and this arm says so instead of parking a number the table would
  // then be lying about: `Promise.resolve` is legally called with one
  // argument or none, and either `0` or `1` would be false half the time.
  // `JSON.stringify`/`parse` are the same shape and predate this arm; their
  // rows still carry `arity: 1`, which `hostCallText`'s own JSON dispatch
  // reaches past before the arity check, so nothing reads it there either.
  | {
      readonly kind: 'method'
      readonly emit: string
      readonly arity: 'call-site'
      readonly receiver?: 'host' | 'raw'
      readonly result?: 'dynamic'
    }
  // A member whose host spelling takes the call's arguments through, in order
  // and each in its own carrier, however many there are. `{args}` is the slot,
  // as it is for `variadic` -- and the difference between the two is what fills
  // it: `console.log` joins its arguments' ToString TEXT into one string, and
  // this passes the values themselves.
  //
  // The engine's canvas is why this exists. `ctx.fillRect(x, y, w, h)` and
  // `ctx.drawImage(img, dx, dy)` and `ctx.drawImage(img, dx, dy, w, h)` are one
  // member each in the table and several C++ overloads on the class, so no
  // fixed integer describes them and no per-overload row could pick between
  // them -- C++'s own overload resolution does, at the call, from the argument
  // types the program already has.
  | {
      readonly kind: 'method'
      readonly emit: string
      readonly arity: 'pass-through'
      readonly receiver?: 'host' | 'raw'
      readonly result?: 'dynamic'
    }

/** Key: `<protocol>.<member>`, the same protocol string the checker bound. */
export type HostMemberTable = ReadonlyMap<string, HostMember>

/**
 * What constructing one of a host's own types costs, as the host spells it.
 *
 * A separate table from `HostMemberTable` for the same reason `hostInvocations`
 * and `hostMemberRenderers` are two maps in `emit-host-invoke.ts`: they answer
 * about two different things. A protocol may have constructible values, callable
 * members, or both, and one map keyed by protocol could not say which.
 *
 * The template carries `{argN}` slots and NO `{receiver}`: a construction has no
 * receiver, and `fillHostTemplate` refuses a template that names one -- which is
 * the fail-closed answer for a host row that was written for the wrong position.
 *
 * `arity` is a fixed count for a template naming `{argN}` slots, and the string
 * `'pass-through'` for one naming the single `{args}` slot instead -- the same
 * distinction `HostMember`'s own `'pass-through'` arm makes, for the same
 * reason: `new MediaStream({args})`, `new AudioContext({args})` and the like
 * take however many constructor arguments the program wrote, and which of the
 * host's overloads that means is for C++'s own overload resolution to decide
 * from the argument types, not something to count here. A fixed number would
 * refuse every call whose argument count did not match the one call site the
 * number happened to be read from.
 */
export interface HostConstructor {
  readonly emit: string
  readonly arity: number | 'pass-through'
}

/**
 * Key: the carrier the host stated for the protocol, falling back to the
 * declared protocol name for a host that stated none -- the same key
 * `HostMemberTable` uses, so one host's rows are all filed under one name.
 */
export type HostConstructorTable = ReadonlyMap<string, HostConstructor>

/**
 * One host handle's `[[Call]]` spelling, keyed `${carrier}.call`.
 *
 * Hosts can expose a callable value which itself has typed members. Keeping
 * that callable as a host handle lets both halves remain authenticated by the
 * checker instead of inventing a language-level function object.
 */
export type HostInvocationTable = ReadonlyMap<string, HostConstructor>

/**
 * Which host type each host type derives from: carrier to immediate base
 * carrier.
 *
 * A host's own inheritance, stated by the host. AppKit's `NSStackView` IS an
 * `NSView` -- passing one where the other is declared is not a conversion at
 * all, and the generated bridge makes it free in C++ by giving the wrapper
 * structs the same inheritance (`struct NSStackView : gea::apple::AppKit::NSView`).
 * But nothing in TypeScript's structural view says two opaque handles are
 * related, so without this the backend refuses an upcast the target performs
 * implicitly.
 *
 * The chain is walked exactly once, by `compiler.ts`, into the transitive
 * answer each `native-handle` carrier then STATES (`Representation`'s
 * `native-handle` arm). Nothing reads this table at emission: the two
 * questions that need the fact -- the conversion census admitting the pair and
 * the printer rendering it -- are both pure carrier-to-carrier, and a table
 * only one of them could reach is what let a certificate refuse an upcast the
 * printer knew how to write.
 *
 * A host that states no inheritance gets an empty table and every handle stays
 * unrelated to every other, which is the correct answer for a host whose types
 * really are unrelated.
 */
export type HostBaseTable = ReadonlyMap<string, string>

/**
 * Everything the hosts installed in one compilation say about their own types.
 *
 * Bundled rather than threaded one map per question: they are all the same
 * plugin's answer about the same protocols, they are all unioned once by
 * `compiler.ts`, and they all reach emission by the same route. A signature
 * that grew a parameter per table would say they were independent, and the
 * next host fact would be a fourth.
 */
/**
 * The header that declares each host carrier.
 *
 * Keyed by carrier rather than by plugin so a unit includes exactly the hosts
 * it used: a program that never touches AppKit must not carry an AppKit header,
 * and "which plugin was installed" is the wrong question -- installing a plugin
 * is what makes a host available, not what makes a program use it.
 */
export type HostIncludeTable = ReadonlyMap<string, string>

/**
 * The free functions a host defines, keyed by the name a program writes.
 *
 * A host function is not a member of anything and not a constructor of
 * anything: `installRootViewController(vc)` and `requestAnimationFrame(f)` are
 * ambient names that resolve to a C++ free function the host's own runtime
 * defines. Nothing declares a C++ *variable* of that name, so a compiler with
 * no table for it emits `extern gea::CallableObject<...> installRootViewController;`
 * and calls through it -- text that compiles and never links, because the
 * symbol the host exports is a function and this named a global.
 *
 * The host states the qualified spelling itself (`embeddedHostFunctions` in
 * v1's plugin packages, verbatim), so the call renders as the call it always
 * was.
 */
export type HostFunctionTable = ReadonlyMap<string, string>

/**
 * The same, for the names one host declares more than once.
 *
 * Keyed by the *declaration file* the program's binding resolved to, because
 * that is what tells two same-named functions apart: Apple's UIKit and AppKit
 * each declare an `installRootView`, taking different views and calling
 * different thunks, and a table keyed by name can only hold one of them. This
 * one is consulted first and the flat table answers everything it does not
 * cover, so a host with no such collisions states nothing and nothing changes.
 */
export type HostFunctionFileTable = ReadonlyMap<string, ReadonlyMap<string, string>>

/**
 * The declaration-file-keyed sibling of `HostFunctionFileTable` for a table
 * whose flat form is a set of claimed names rather than a name-to-spelling
 * map -- `PluginCapabilities.nativeConstants`'s keys, `hostNamespaces.roots`,
 * `hostSingletons`. A name claimed twice by one host, under two of its own
 * files, means two different things by it exactly as a doubly-declared
 * function does; this states which declaration this program actually
 * resolved to answers, the same way the file-keyed function table does,
 * consulted first and answered by the flat set for every host with no such
 * collision.
 */
export type HostNameFileTable = ReadonlyMap<string, ReadonlySet<string>>

/**
 * How a host names something the program CALLS.
 *
 * Two forms, because hosts state two genuinely different things and the
 * difference is not recoverable from the text:
 *
 * - a PATH is the function's own name, and the call is that name with the
 *   arguments appended -- `gea::host::device_info::deviceId(a, b)`;
 * - a TEMPLATE places the arguments itself, and can therefore do something to
 *   the call that the name alone cannot -- wrap the result
 *   (`gea::host::MediaStream(gea::host::media::get_user_media_audio({args}))`,
 *   which turns a raw handle into the typed value the program's carrier
 *   actually holds), reorder, or take the receiver first.
 *
 * This used to be one `string`, always a path, and a package row that stated a
 * template was reduced to the bare symbol inside it or dropped -- so a member a
 * host described twice, once bare and once typed, silently rendered as the bare
 * one and the wrapper went missing. That is a *carrier* difference, not a
 * cosmetic one: `get_user_media_audio` returns a `NativeMediaStreamHandle`
 * (`unsigned int`) where the program holds `gea::Promise<gea::host::MediaStream>`.
 * Naming the two forms apart is what lets the typed row win without the
 * renderer having to guess which kind of string it was handed.
 */
export type HostCallSpelling = ({ readonly kind: 'path'; readonly text: string } | { readonly kind: 'template'; readonly emit: string }) & {
  readonly arrayArguments?: 'snapshot' | 'native'
  readonly arguments?: 'dynamic'
  /**
   * The host hands back a `gea::Value`, whatever carrier the PROGRAM holds the
   * result in. `Reflect.get` is the case: its target is boxed, so the runtime
   * can only answer with a boxed value -- while the compiler may well know the
   * result is a `number`, because the target it reflects over is a
   * `Record<string, number>` whose values are numbers no matter how the key is
   * spelled. Without this the call assigned a `Value` straight into a `double`
   * and clang refused the unit; the crossing back is an unbox, and it is stated
   * by the host rather than guessed from the spelling's name.
   */
  readonly result?: 'dynamic'
}

/** The one string that identifies a call spelling -- for a diagnostic, and as the key its preamble is stated under. */
export const hostCallName = (spelling: HostCallSpelling): string => (spelling.kind === 'path' ? spelling.text : spelling.emit)

/**
 * A host's NAMESPACE surface: global names that are paths, not values.
 *
 * `deviceInfo`, `Display`, `navigator` are not objects a program can hold.
 * Every use is a path to a C++ spelling -- `deviceInfo.deviceId(...)` is
 * `gea::host::device_info::deviceId(...)`, `Display.width` is `gea::host::Display.width`
 * -- and the object itself never exists at run time. Given no table for them
 * the backend has one shape left for "a global you read members off": a
 * structural record, so it emits `extern std::shared_ptr<gea_record_type_801>
 * deviceInfo;` and member reads through it. That compiles and never links,
 * the same way a host free function declared as a callable global does.
 *
 * Keyed by the PROGRAM's path rather than the host's prefix. The package states
 * a nested namespace by spelling its whole program-facing path
 * (`navigator.bluetooth.keyboard`), so following that spelling makes "what does
 * this member render to" and "is this path itself a namespace" one lookup and
 * one prefix test over one key space -- where translating to the host's prefix
 * first would be a second naming rule, free to disagree with the tables.
 */
export interface HostNamespaceTable {
  /** The global names that begin a namespace path. */
  readonly roots: ReadonlySet<string>
  /**
   * Namespace paths whose JavaScript `typeof` differs from the carrier used
   * only to resolve their members. `Buffer` is both a callable constructor
   * object and a namespace of statics, while `performance` is an object; the
   * host owns that distinction because neither path is materialized as a C++
   * value the generic carrier table can inspect.
   */
  readonly typeofs: ReadonlyMap<string, 'function' | 'object'>
  /** `path.member` to the C++ spelling a CALL through it renders. */
  readonly methods: ReadonlyMap<string, HostCallSpelling>
  /** `path.member` to the C++ spelling a READ of it renders. */
  readonly properties: ReadonlyMap<string, string>
  /**
   * `path.member` to the C++ spelling a WRITE of it renders.
   *
   * A separate map from `properties`, never merged in: the host states a
   * different spelling for each direction -- `Display.autoRotate` READS
   * `gea::host::Display.autoRotate()` and WRITES
   * `gea::host::Display.setAutoRotate(...)` -- so one map keyed by `path.member`
   * could hold only one of the two, exactly the reason `HostMemberTable`'s own
   * `property` arm carries an `emit` and a `store` rather than one `emit` field.
   */
  readonly propertySetters: ReadonlyMap<string, string>
}

export const noHostNamespaces: HostNamespaceTable = Object.freeze({
  roots: new Set<string>(),
  typeofs: new Map<string, 'function' | 'object'>(),
  methods: new Map<string, HostCallSpelling>(),
  properties: new Map<string, string>(),
  propertySetters: new Map<string, string>()
})

/**
 * Whether a path names a namespace rather than a member of one.
 *
 * Asked of the member tables' own keys: `navigator.bluetooth` is a namespace
 * exactly because members are stated under it. A prefix test rather than a
 * separate list, so a path cannot be a namespace here and have no members
 * there.
 */
export const isHostNamespacePath = (namespaces: HostNamespaceTable, path: string): boolean => {
  if (namespaces.roots.has(path)) return true
  const prefix = `${path}.`
  for (const key of namespaces.methods.keys()) if (key.startsWith(prefix)) return true
  for (const key of namespaces.properties.keys()) if (key.startsWith(prefix)) return true
  return false
}

/**
 * Which class fields are held in a reactive cell, and what that cell is spelled.
 *
 * The two halves travel together because neither is usable alone: a set of
 * fields with no cell spelling names storage nothing can render, and a spelling
 * with no fields is a type nothing uses. Both come from the same plugin
 * statement (`PluginCapabilities.reactiveClassFields` / `nativeReactiveCell`),
 * so keeping them in one object is what stops a compilation from marking fields
 * reactive under one plugin and spelling the cell from another.
 */
export interface ReactiveCellPlan {
  readonly fields: ReadonlyMap<DeclarationId, ReadonlySet<string>>
  readonly cell: string | null
  /**
   * What a unit must carry before it may name `cell`, from the plugin that
   * stated the spelling (`PluginCapabilities.nativeReactiveCellPreamble`).
   *
   * `cell` says what the cell is spelled and this says what that spelling
   * needs -- the same fact, one step on, which is why it travels beside it
   * rather than as its own emitter channel. `translation-unit.ts` emits it only
   * where a field is actually celled: gea's cell lives in the engine's own
   * `ui/signal.h`, which is on the include path for an engine build only.
   */
  readonly cellPreamble: readonly string[]
  /**
   * Which reactive fields each BODY reads, so a caller can subscribe a thunk
   * it cannot see inside of -- see `targets/cpp/reactive-dependencies.ts`.
   *
   * It lives on the reactive plan rather than travelling as its own emitter
   * parameter because it answers the same question the two fields above do,
   * one step further along: `fields` says which storage is a cell, `cell` says
   * what the cell is spelled, and this says which cells a given body depends
   * on. A consumer that has one always wants the others. `compiler.ts` states
   * it empty -- the plugins that decide `fields` have no IR -- and
   * `translation-unit.ts`, which does, fills it in for the emission it runs.
   */
  readonly dependencies: ReadonlyMap<FunctionId | RegionId, readonly ReactiveDependency[]>
  /**
   * The same census narrowed for a NODE slot, where re-running a binding means
   * rebuilding a subtree rather than rewriting a value -- so a dependency
   * carried in from a callee is kept only when the callee BRANCHES on it. See
   * `ReactiveDependencyCensus` in `targets/cpp/reactive-dependencies.ts` for
   * why the two censuses cannot be one.
   */
  readonly nodeDependencies: ReadonlyMap<FunctionId | RegionId, readonly ReactiveDependency[]>
  /**
   * Which reactive fields hold a COMPANION revision cell rather than a cell of
   * their own -- `records.ts`'s own decision, reported by it and read back
   * here. See `cppReactiveRevisionFieldName`.
   *
   * Like `dependencies`, `compiler.ts` states it empty (the plugins that decide
   * `fields` have no carriers) and `translation-unit.ts` fills it in from the
   * struct rendering that just made the call.
   */
  readonly revisions: ReadonlyMap<string, ReadonlySet<string>>
  /**
   * Which struct members are held in a cell, by struct name -- `records.ts`'s
   * own decision, read back.
   *
   * Keyed by struct rather than by class declaration because a reactive struct
   * is not only a class: the ELEMENT record of a reactive array is reactive
   * too, so `cell.filled = 1` notifies exactly the row props that read it, and
   * an element record has no declaration to key by.
   */
  readonly celled: ReadonlyMap<string, ReadonlySet<string>>
  /**
   * Which struct members a JSX slot actually BINDS, by struct name --
   * `reactive-dependencies.ts`'s `reactiveBoundRecordFields`.
   *
   * Two consumers, one question. `records.ts` cells an element record's member
   * only when a row renders it, and the emitter skips the companion revision
   * notify for a member no row renders: writing `cell.piece = -1` when nothing
   * displays `piece` would otherwise tick the array's revision and rebuild
   * every row, which is both wasted work and the trigger for a real defect
   * (the rebuild re-subscribes the surviving element records, so effects
   * accumulate).
   */
  readonly boundRecordFields: ReadonlyMap<string, ReadonlySet<string>>
}

export interface HostSpellings {
  readonly members: HostMemberTable
  readonly constructors: HostConstructorTable
  readonly invocations: HostInvocationTable
  readonly arraySnapshotFunctions?: ReadonlySet<string>
  readonly nativeArrayFunctions?: ReadonlySet<string>
  readonly functions: HostFunctionTable
  /** The global names the hosts own as PATHS rather than as values. */
  readonly namespaces: HostNamespaceTable
  /** A host's own `[[HasInstance]]` per namespace-root carrier -- see `PluginCapabilities.hostInstanceTests`. */
  readonly instanceTests: ReadonlyMap<string, string>
  /** The global names a host holds one instance of and reaches by name -- see `PluginCapabilities.hostSingletons`. */
  readonly singletons: ReadonlySet<string>
  /** What a unit must declare before it may name a spelling, keyed by the spelling. */
  readonly preambles: ReadonlyMap<string, readonly string[]>
  readonly includes: HostIncludeTable
  /** What a JSX fragment builds, in the host's own C++; `null` when no installed host has one -- see `PluginCapabilities.elementFragment`. */
  readonly fragment: string | null
  /** Which class fields this compilation holds in a reactive cell, and the cell's own spelling. */
  readonly reactive: ReactiveCellPlan
  /**
   * `<carrier>.<member>` keys (the same key space `HostMemberTable` uses) whose
   * REAL C++ return is `void`, when the checker's declared return is not.
   *
   * `OscillatorNode.connect` is the case this exists for: `lib`'s ambient
   * `connect(destination): AudioDestinationNode` states the Web Audio
   * chaining convention, but `gea::host::OscillatorNode::connect` (the actual
   * function this compiler calls) returns `void` -- the package's own
   * `nativeMemberMethods` states as much per row (`returnType: "void"`), and
   * that is the truth an emitted call has to render against, not the checker's
   * declared shape. Without this, `emitCall` mints a variable of the CHECKER's
   * non-void carrier and assigns a void expression to it, which certifies and
   * emits (the call itself has a real host spelling) and fails only in clang:
   * "no viable overloaded '='". A member listed here is always emitted as a
   * bare statement, discarding whatever `operation.result` the checker's ABI
   * would otherwise have this backend capture.
   */
  readonly voidResults: ReadonlySet<string>
  /**
   * A reflectable host intrinsic's own member list, keyed by protocol name --
   * the SAME data `semantics/host-protocols.ts`'s `HostProtocolBinding.members`
   * carries per declaration, collected here into one flat table because a
   * reflection call (`Object.getOwnPropertyDescriptor(Math, k)`) has only the
   * receiver's `native-handle` REPRESENTATION in hand at emission, which
   * carries a protocol NAME and no declaration id to look a binding up by.
   *
   * Absent (no entry) for a protocol `bindAmbientValue` never classified --
   * every host-carried protocol (`native !== null`), and every protocol
   * reached through a route other than an ambient global read. A reflection
   * renderer must tell that apart from a classified-but-EMPTY list: absence
   * means "no static answer exists" and refuses by name, where an empty list
   * is itself the true, checked answer "this intrinsic has no own members".
   */
  readonly intrinsicMembers: ReadonlyMap<string, readonly HostIntrinsicMember[]>
}

/**
 * The members this backend states a spelling for on its own.
 *
 * Only the surface a *language* runtime owns. `console` is not ECMA-262 --
 * `lib.dom.d.ts` is where TypeScript declares it -- but it is present in every
 * JavaScript host there is, and a compiler that cannot render `console.log`
 * cannot compile ordinary TypeScript. `localStorage` is claimed on the same
 * ground: a key-value store over strings, with no document and no node tree
 * behind it.
 *
 * What is NOT here is the document, the element tree, and JSX. Those are a
 * host's object model rather than the language's, so the plugin that installs
 * that host states them (`plugins/gea/host.ts`) and this backend never learns
 * their spellings. The split is not cosmetic: it is what keeps a claim and the
 * text that renders it in one place. A protocol claimed here whose template
 * lived elsewhere would be two authorities over one question, and the drift
 * between them is silent -- preflight certifies, emission refuses by name.
 */
const nativeHandleProperty = (protocol: string, emit: string): HostMember => ({
  kind: 'property',
  store: null,
  emit,
  resultRepresentation: { kind: 'native-handle', protocol, version: 1, native: null, bases: [], call: null, construct: null }
})

export const coreHostMembers: HostMemberTable = new Map<string, HostMember>([
  // Atomics is a finite language primitive, not an any-shaped Node shim. The
  // call-site renderer verifies the concrete typed-array element carrier and
  // names the one native operation; methods omitted here fail at the property.
  ...['load', 'store', 'add', 'sub', 'and', 'or', 'xor', 'exchange', 'compareExchange', 'isLockFree', 'wait', 'notify'].map(
    (member) => [`Atomics.${member}`, { kind: 'method', emit: '/* atomics call-site renderer */', arity: 'call-site' }] as const
  ),
  // `console`. Only `log`/`error` are claimed -- the two members any real
  // corpus program actually calls (`citations.md` section 2a) -- not
  // `lib.dom.d.ts`'s full ~18-member interface. `{args}` is the one join of
  // every call argument's ToString text, computed by
  // `emit-tostring.ts`'s `consoleArgumentsText` before this template is
  // filled (`emit-host-invoke.ts`'s `hostCallText`); there is no `{receiver}`
  // because `console`, like `document`, is a singleton whose identity a
  // call never needs to name.
  // `TextEncoder`/`TextDecoder` (Encoding Standard), keyed by the CARRIER the
  // backend states for each in `core-globals.ts`'s `coreNativeTypes` -- the
  // same key `nativeHandleMemberText` builds (`native ?? protocol`) and the
  // same one an installed host's rows are filed under. Each `emit` names a
  // real member of the class `runtime/gea_runtime.h` defines, so clang checks
  // every one of them.
  //
  // What is NOT here is `TextEncoder.encodeInto`: it writes into a caller's
  // view and answers a `{ read, written }` record, and neither half has an
  // implementation behind it. With no row it refuses BY NAME at its own
  // access, which is the whole point of the table being the single authority.
  ['gea::runtime::textcodec::TextEncoder.encoding', { kind: 'property', emit: '{receiver}.encoding', store: null }],
  ['gea::runtime::textcodec::TextEncoder.encode', { kind: 'method', emit: '{receiver}.encode({args})', arity: 'pass-through' }],
  ['gea::runtime::textcodec::TextDecoder.encoding', { kind: 'property', emit: '{receiver}.encoding', store: null }],
  ['gea::runtime::textcodec::TextDecoder.fatal', { kind: 'property', emit: '{receiver}.fatal', store: null }],
  ['gea::runtime::textcodec::TextDecoder.ignoreBOM', { kind: 'property', emit: '{receiver}.ignoreBOM', store: null }],
  // `pass-through`, not a fixed arity, and for the reason that arm exists:
  // both members declare a single OPTIONAL parameter, so a call site legally
  // passes one argument or none, and either fixed number would refuse half of
  // them. The runtime states one overload per real shape (`encode()` /
  // `encode(string)`, `decode()` / `decode(view)`), so which one a call means
  // is C++'s own overload resolution over the argument the program actually
  // wrote -- and a shape no overload covers is a clang error naming the
  // member, never a silently different answer.
  ['gea::runtime::textcodec::TextDecoder.decode', { kind: 'method', emit: '{receiver}.decode({args})', arity: 'pass-through' }],
  ['Console.log', { kind: 'method', emit: 'gea::host::console::log({args})', arity: 'variadic' }],
  ['Console.error', { kind: 'method', emit: 'gea::host::console::error({args})', arity: 'variadic' }],
  // `console.info` is Node's own alias of `console.log` (see the runtime's own
  // `info` overloads for the citation), so this row buys a real member rather
  // than a second severity: `@hono/node-server` writes one on the recoverable
  // client-abort path and refused by name until it existed.
  ['Console.info', { kind: 'method', emit: 'gea::host::console::info({args})', arity: 'variadic' }],
  // `localStorage`. `gea::host::storage` is a singleton table rather than a
  // per-handle one, so no template here names a `{receiver}`.
  ['Storage.getItem', { kind: 'method', emit: 'gea::host::storage::getItem({arg0})', arity: 1 }],
  ['Storage.setItem', { kind: 'method', emit: 'gea::host::storage::setItem({arg0}, {arg1})', arity: 2 }],
  ['Storage.removeItem', { kind: 'method', emit: 'gea::host::storage::removeItem({arg0})', arity: 1 }],
  // `JSON`. Neither member has a single fixed-arity C++ spelling the way
  // every other entry here does -- `stringify`/`parse`'s real signature
  // depends on the STATIC type of the value/assertion at each individual
  // call site, which is exactly what a boxed `gea::Value`-shaped template
  // slot cannot express without reintroducing the boxing this compiler
  // forbids. `emit` is never read: `hostCallText` (emit-host-invoke.ts)
  // recognizes `protocol === 'JSON'` and dispatches to `emit-json.ts`'s
  // `jsonCallText` before it ever reaches this template's fill step.
  ['JSON.stringify', { kind: 'method', emit: '/* unused: see emit-json.ts */', arity: 1 }],
  ['JSON.parse', { kind: 'method', emit: '/* unused: see emit-json.ts */', arity: 1 }],
  // `Math`, `Date` and `String`'s own singleton members -- three of the
  // protocols `manifest.ts` claims in `nativeProtocols`, and the three whose
  // members `gea_runtime.h` actually implements one by one, inside `namespace
  // gea::host::Math` / `::DateConstructor` / `::StringConstructor`. Every
  // `emit` below names a symbol that header really declares; none is derived
  // from the protocol string, so a member the header does not declare cannot
  // be spelled by accident.
  //
  // `property`, not `method`, and the distinction is exactly the one this
  // file's own header draws. `storage.getItem` is a `method` because it names
  // no C++ symbol on its own -- only the call has a spelling. `Math.floor` is
  // the opposite: `gea::host::Math::floor` is a real `const
  // gea::CallableObject<double(double)>` object, so the access loads a value
  // and the *call* goes through that callable carrier rather than through any
  // template here. Rendering it as a `method` would defer the call to a free
  // function the runtime does not have.
  //
  // Listing them is what makes this table the single authority for "what does
  // this member render to". Until they were listed, `nativeHandleMemberText`
  // (emit-properties.ts) interpolated `gea::host::<protocol>::<key>` for them
  // -- and, having no way to tell a member with a real symbol from one with
  // none, for every unclaimed member of every other native-handle protocol
  // too. `Promise.resolve` and `Math.acos` are the two the corpus actually
  // reached that way: both sit on protocols `manifest.ts` claims, neither has
  // any symbol behind it, and both emitted C++ that clang rejected with "no
  // member named ... in namespace 'gea::host'" -- naming neither the access
  // nor this table.
  // `Math.toString()` -- ECMA-262 defines no own `toString` for `Math`
  // (21.3), so it inherits `Object.prototype.toString` (20.1.3.6), whose
  // builtin-tag walk reads `Math[Symbol.toStringTag]` (21.3.1.28.1's own
  // "Math" literal) with no [[Call]] of anything else. The result is
  // therefore a compile-time constant with no receiver read at all -- the
  // same shape `promiseToStringText` (emit-prototype-invoke.ts) answers for
  // `Promise.prototype.toString`, for the identical reason (neither
  // `[Symbol.toStringTag]` nor an own `toString` is ever overridden for
  // these). Borrowed Object.prototype.toString calls use ObjectTag and its
  // native @@toStringTag lookup instead of this direct member path.
  ['Math.toString', { kind: 'method', emit: 'std::string("[object Math]")', arity: 0 }],
  ['Math.floor', { kind: 'property', store: null, emit: 'gea::host::Math::floor' }],
  ['Math.round', { kind: 'property', store: null, emit: 'gea::host::Math::round' }],
  ['Math.sin', { kind: 'property', store: null, emit: 'gea::host::Math::sin' }],
  ['Math.cos', { kind: 'property', store: null, emit: 'gea::host::Math::cos' }],
  ['Math.sqrt', { kind: 'property', store: null, emit: 'gea::host::Math::sqrt' }],
  ['Math.abs', { kind: 'property', store: null, emit: 'gea::host::Math::abs' }],
  ['Math.ceil', { kind: 'property', store: null, emit: 'gea::host::Math::ceil' }],
  ['Math.pow', { kind: 'property', store: null, emit: 'gea::host::Math::pow' }],
  ['Math.atan2', { kind: 'property', store: null, emit: 'gea::host::Math::atan2' }],
  ['Math.random', { kind: 'property', store: null, emit: 'gea::host::Math::random' }],
  ['Math.tan', { kind: 'property', store: null, emit: 'gea::host::Math::tan' }],
  ['Math.asin', { kind: 'property', store: null, emit: 'gea::host::Math::asin' }],
  ['Math.acos', { kind: 'property', store: null, emit: 'gea::host::Math::acos' }],
  ['Math.atan', { kind: 'property', store: null, emit: 'gea::host::Math::atan' }],
  ['Math.sinh', { kind: 'property', store: null, emit: 'gea::host::Math::sinh' }],
  ['Math.log', { kind: 'property', store: null, emit: 'gea::host::Math::log' }],
  // All three retain their array-parameter callable values. Direct numeric
  // max/min calls can additionally borrow a stack sequence without allocating
  // the rest array; aliases and spreads keep the ordinary value spelling.
  ['Math.max', { kind: 'property', store: null, emit: 'gea::host::Math::max', numericRestCall: 'gea::host::Math::maxDirect({args})' }],
  ['Math.min', { kind: 'property', store: null, emit: 'gea::host::Math::min', numericRestCall: 'gea::host::Math::minDirect({args})' }],
  ['Math.hypot', { kind: 'property', store: null, emit: 'gea::host::Math::hypot' }],
  // The sixteen `Math` members `gea_runtime.h` did not have. `cbrt` is v1's
  // (`gea::runtime::math::cbrt`, stdlib.cpp); the other fifteen are written
  // against ECMA-262 §21.3.2 there, because v1's own `gea::runtime::math`
  // namespace has none of them and its boxed `Math` object is an empty record.
  // Each row names a symbol that header really declares, in the same
  // `CallableObject<double(double)>` shape as the rows above -- `imul` is the
  // one binary member.
  ['Math.cbrt', { kind: 'property', store: null, emit: 'gea::host::Math::cbrt' }],
  ['Math.sign', { kind: 'property', store: null, emit: 'gea::host::Math::sign' }],
  ['Math.trunc', { kind: 'property', store: null, emit: 'gea::host::Math::trunc' }],
  ['Math.exp', { kind: 'property', store: null, emit: 'gea::host::Math::exp' }],
  ['Math.expm1', { kind: 'property', store: null, emit: 'gea::host::Math::expm1' }],
  ['Math.log10', { kind: 'property', store: null, emit: 'gea::host::Math::log10' }],
  ['Math.log1p', { kind: 'property', store: null, emit: 'gea::host::Math::log1p' }],
  ['Math.log2', { kind: 'property', store: null, emit: 'gea::host::Math::log2' }],
  ['Math.cosh', { kind: 'property', store: null, emit: 'gea::host::Math::cosh' }],
  ['Math.tanh', { kind: 'property', store: null, emit: 'gea::host::Math::tanh' }],
  ['Math.acosh', { kind: 'property', store: null, emit: 'gea::host::Math::acosh' }],
  ['Math.asinh', { kind: 'property', store: null, emit: 'gea::host::Math::asinh' }],
  ['Math.atanh', { kind: 'property', store: null, emit: 'gea::host::Math::atanh' }],
  ['Math.fround', { kind: 'property', store: null, emit: 'gea::host::Math::fround' }],
  ['Math.clz32', { kind: 'property', store: null, emit: 'gea::host::Math::clz32' }],
  ['Math.imul', { kind: 'property', store: null, emit: 'gea::host::Math::imul' }],
  // `readonly PI: number` -- a data property, and the one member here that is
  // not a callable at all.
  ['Math.PI', { kind: 'property', store: null, emit: 'gea::host::Math::PI' }],
  ['Math.LN2', { kind: 'property', store: null, emit: 'gea::host::Math::LN2' }],
  // The six siblings PI/LN2 never had rows for -- see `gea_runtime.h`'s own
  // comment on the identical gap in its `Math` namespace.
  ['Math.E', { kind: 'property', store: null, emit: 'gea::host::Math::E' }],
  ['Math.LN10', { kind: 'property', store: null, emit: 'gea::host::Math::LN10' }],
  ['Math.LOG2E', { kind: 'property', store: null, emit: 'gea::host::Math::LOG2E' }],
  ['Math.LOG10E', { kind: 'property', store: null, emit: 'gea::host::Math::LOG10E' }],
  ['Math.SQRT1_2', { kind: 'property', store: null, emit: 'gea::host::Math::SQRT1_2' }],
  ['Math.SQRT2', { kind: 'property', store: null, emit: 'gea::host::Math::SQRT2' }],
  ['DateConstructor.now', { kind: 'property', store: null, emit: 'gea::host::DateConstructor::now' }],
  // The prototype slot is a handle of its own protocol (`Date.prototype@1`,
  // registered by `bindHostObjectClosure` beside the constructor): reading it
  // hands the program a namespace-shaped intrinsic, not a Date instance.
  ['DateConstructor.prototype', nativeHandleProperty('Date.prototype', 'gea::NativeHandle<gea_native_protocol_Date_prototype_v1>{}')],
  ['StringConstructor.prototype', nativeHandleProperty('String.prototype', 'gea::NativeHandle<gea_native_protocol_String_prototype_v1>{}')],
  ['NumberConstructor.prototype', nativeHandleProperty('Number.prototype', 'gea::NativeHandle<gea_native_protocol_Number_prototype_v1>{}')],
  // The same slot, widened from Date/String/Number to RegExp, Boolean and
  // Object -- `RegExp.prototype@1`/`Boolean.prototype@1`/`Object.prototype@1`
  // (native-protocols.ts) are claimed rows, so each has a tag struct in
  // `gea_runtime.h` for this handle to name.
  ['RegExpConstructor.prototype', nativeHandleProperty('RegExp.prototype', 'gea::NativeHandle<gea_native_protocol_RegExp_prototype_v1>{}')],
  [
    'BooleanConstructor.prototype',
    nativeHandleProperty('Boolean.prototype', 'gea::NativeHandle<gea_native_protocol_Boolean_prototype_v1>{}')
  ],
  ['ObjectConstructor.prototype', nativeHandleProperty('Object.prototype', 'gea::NativeHandle<gea_native_protocol_Object_prototype_v1>{}')],
  // `Date.parse` / `Date.UTC` -- ECMA-262 21.4.3.2 / 21.4.3.4.
  //
  // `call-site`, not a fixed-arity template, because `Date.UTC` takes one to
  // seven arguments and an `arity: number` row can state only one of those.
  // `dateConstructorCallText` (emit-prototype-date.ts) is the renderer, keyed
  // off this protocol in `emit-host-invoke.ts`'s `hostMemberRenderers` -- the
  // same mechanism `Promise.resolve` and `Symbol.for` already use.
  //
  // `now` above stays a `property`: it is a real readable
  // `gea::CallableObject<double()>`, so the access loads it and the call goes
  // through that carrier, exactly as `Math.floor` does.
  [
    'DateConstructor.parse',
    { kind: 'method', emit: '/* unused: see dateConstructorCallText, emit-prototype-date.ts */', arity: 'call-site' }
  ],
  [
    'DateConstructor.UTC',
    { kind: 'method', emit: '/* unused: see dateConstructorCallText, emit-prototype-date.ts */', arity: 'call-site' }
  ],
  // `Number.isInteger`/`Number.isFinite` -- ECMA-262 21.1.2.3 / 21.1.2.2.
  //
  // `method`, not `property`, and for the reason `Promise.resolve` is: there
  // is no readable `CallableObject` behind them and there could not be one.
  // `lib.es2015.core.d.ts` declares both `(number: unknown) => boolean`, so a
  // callable carrier would have to name a parameter the declaration says is
  // `unknown` -- which is to say it would have to box a number to ask whether
  // it is an integer. The call has a spelling, the member on its own does not,
  // and `gea::host::NumberConstructor`'s overload set refuses in clang for any
  // carrier it cannot answer for rather than answering `false` for a value
  // that is in fact an integer.
  ['NumberConstructor.isInteger', { kind: 'method', emit: 'gea::host::NumberConstructor::isInteger({arg0})', arity: 1 }],
  ['BigIntConstructor.asIntN', { kind: 'method', emit: 'gea::host::BigIntConstructor::asIntN({arg0}, {arg1})', arity: 2 }],
  ['BigIntConstructor.asUintN', { kind: 'method', emit: 'gea::host::BigIntConstructor::asUintN({arg0}, {arg1})', arity: 2 }],
  ['NumberConstructor.isFinite', { kind: 'method', emit: 'gea::host::NumberConstructor::isFinite({arg0})', arity: 1 }],
  // `isNaN`/`isSafeInteger` -- ECMA-262 21.1.2.4 / 21.1.2.5, `method` for the
  // identical reason: both are declared `(number: unknown) => boolean`, so
  // there is no callable carrier to read, and the overload set in
  // `gea_runtime.h` refuses in clang for any carrier it cannot answer for.
  ['NumberConstructor.isNaN', { kind: 'method', emit: 'gea::host::NumberConstructor::isNaN({arg0})', arity: 1 }],
  ['NumberConstructor.isSafeInteger', { kind: 'method', emit: 'gea::host::NumberConstructor::isSafeInteger({arg0})', arity: 1 }],
  // `Number.parseInt` / `Number.parseFloat` -- 21.1.2.13 / 21.1.2.12, which the
  // specification defines as *the same function objects* the globals name.
  // `method`, not `property`: the runtime spells them as free functions, since
  // `parseInt`'s second parameter is optional and a `CallableObject`'s C++
  // signature is one fixed arity. `arity: 2` is the declaration's own frame --
  // `parseInt(string, radix?)` -- and the absent radix arrives as the `0` the
  // clause's step 7 means by "absent", not as a guess.
  ['NumberConstructor.parseInt', { kind: 'method', emit: 'gea::host::NumberConstructor::parseInt({arg0}, {arg1})', arity: 2 }],
  ['NumberConstructor.parseFloat', { kind: 'method', emit: 'gea::host::NumberConstructor::parseFloat({arg0})', arity: 1 }],
  // The five `NumberConstructor` data properties -- 21.1.2.1 `EPSILON`, .6
  // `MAX_SAFE_INTEGER`, .7 `MAX_VALUE`, .8 `MIN_SAFE_INTEGER`, .9 `MIN_VALUE`.
  // `property` like `Math.PI`, and for the same reason: each is a value the
  // access loads, not a call.
  ['NumberConstructor.EPSILON', { kind: 'property', store: null, emit: 'gea::host::NumberConstructor::EPSILON' }],
  ['NumberConstructor.MAX_SAFE_INTEGER', { kind: 'property', store: null, emit: 'gea::host::NumberConstructor::MAX_SAFE_INTEGER' }],
  ['NumberConstructor.MIN_SAFE_INTEGER', { kind: 'property', store: null, emit: 'gea::host::NumberConstructor::MIN_SAFE_INTEGER' }],
  ['NumberConstructor.MAX_VALUE', { kind: 'property', store: null, emit: 'gea::host::NumberConstructor::MAX_VALUE' }],
  ['NumberConstructor.MIN_VALUE', { kind: 'property', store: null, emit: 'gea::host::NumberConstructor::MIN_VALUE' }],
  ['NumberConstructor.POSITIVE_INFINITY', { kind: 'property', store: null, emit: 'gea::host::NumberConstructor::POSITIVE_INFINITY' }],
  ['NumberConstructor.NEGATIVE_INFINITY', { kind: 'property', store: null, emit: 'gea::host::NumberConstructor::NEGATIVE_INFINITY' }],
  ['NumberConstructor.NaN', { kind: 'property', store: null, emit: 'std::numeric_limits<double>::quiet_NaN()' }],
  // `Array.isArray` -- 23.1.2.2. The one `ArrayConstructor` member wired here:
  // it asks what a value IS rather than building or reading one, so it needs
  // no array runtime beyond the tag `gea::Value` already carries.
  // ...and `call-site`, because the answer IS the argument's carrier: an
  // `array-object` is `true` with nothing read, a record/dictionary/string is
  // `false`, a TAGGED UNION is its own discriminant, and only the dynamic box
  // needs the runtime's tag. A fixed `{arg0}` template handed the union
  // straight to C++, which has no overload for one. See `isArrayText`
  // (emit-host-invoke.ts).
  ['ArrayConstructor.isArray', { kind: 'method', emit: '/* unused: see isArrayText, emit-host-invoke.ts */', arity: 'call-site' }],
  ['ArrayConstructor.from', { kind: 'method', emit: '/* unused: see arrayFromText, emit-host-invoke.ts */', arity: 'call-site' }],
  // `Array.prototype` READ AS A VALUE -- `describe(Array.prototype, 'join')`
  // (test/runtime/static-intrinsic-reflection.runtime.js) passes it as an
  // ordinary argument. Its stable native identity owns the intrinsic method
  // descriptors in the same sidecar used for other array properties.
  [
    'ArrayConstructor.prototype',
    {
      kind: 'property',
      store: null,
      emit: 'gea::arrayPrototypeObject()',
      resultRepresentation: {
        kind: 'array-object',
        element: { kind: 'dynamic', reason: 'declared-any-never-narrowed' },
        ownership: 'shared-refcount',
        extension: null
      }
    }
  ],
  ['Int8ArrayConstructor.from', { kind: 'method', emit: '/* unused: see typedArrayFromText, emit-host-invoke.ts */', arity: 'call-site' }],
  ['Uint8ArrayConstructor.from', { kind: 'method', emit: '/* unused: see typedArrayFromText, emit-host-invoke.ts */', arity: 'call-site' }],
  [
    'Uint8ClampedArrayConstructor.from',
    { kind: 'method', emit: '/* unused: see typedArrayFromText, emit-host-invoke.ts */', arity: 'call-site' }
  ],
  ['Int16ArrayConstructor.from', { kind: 'method', emit: '/* unused: see typedArrayFromText, emit-host-invoke.ts */', arity: 'call-site' }],
  [
    'Uint16ArrayConstructor.from',
    { kind: 'method', emit: '/* unused: see typedArrayFromText, emit-host-invoke.ts */', arity: 'call-site' }
  ],
  ['Int32ArrayConstructor.from', { kind: 'method', emit: '/* unused: see typedArrayFromText, emit-host-invoke.ts */', arity: 'call-site' }],
  [
    'Uint32ArrayConstructor.from',
    { kind: 'method', emit: '/* unused: see typedArrayFromText, emit-host-invoke.ts */', arity: 'call-site' }
  ],
  [
    'Float32ArrayConstructor.from',
    { kind: 'method', emit: '/* unused: see typedArrayFromText, emit-host-invoke.ts */', arity: 'call-site' }
  ],
  [
    'Float64ArrayConstructor.from',
    { kind: 'method', emit: '/* unused: see typedArrayFromText, emit-host-invoke.ts */', arity: 'call-site' }
  ],
  ['StringConstructor.fromCharCode', { kind: 'property', store: null, emit: 'gea::host::StringConstructor::fromCharCode' }],
  // `Promise.resolve` -- ECMA-262 27.2.4.7. `PromiseConstructor@1` is claimed
  // in `manifest.ts`'s own `nativeProtocols` beside `Math`/`Date`/`String`
  // because `Promise` is the language's, not a host's; until this row it was
  // the one such claim with nothing at all behind it, which is exactly the
  // drift this file's header warns about -- a protocol claimed in one place
  // whose spelling lives in another, or in this case nowhere.
  //
  // `method`, not `property`: `Math.floor` loads one `CallableObject` that
  // already exists, and `Promise.resolve` cannot, because the promise it
  // mints is typed by the call's own payload. `gea::host::PromiseConstructor::
  // resolve` is a free function TEMPLATE in `gea_runtime.h` (beside
  // `ErrorConstructor::create`, for the identical reason: a payload is
  // routinely a `gea_record_type_N` this header cannot name), so only the
  // call has a spelling and `promiseResolveText` states it.
  //
  // `allSettled`, `any` and the remaining combinators still have no
  // implementation and no row, so they refuse by name at the access -- the
  // corpus census behind that choice, and the one `Promise.all` site it found,
  // are in citations.md. `reject`, `all` and `race` have since each been given
  // a real renderer, listed below.
  ['PromiseConstructor.resolve', { kind: 'method', emit: '/* unused: see promiseResolveText, emit-host-invoke.ts */', arity: 'call-site' }],
  [
    'PromiseConstructor.reject',
    { kind: 'method', emit: '/* unused: see promiseConstructorText, emit-host-invoke.ts */', arity: 'call-site' }
  ],
  // `Promise.all` -- 27.2.4.1. Same `call-site` reason as `resolve`: the array
  // it fulfils with is typed by the call's own elements, and the per-element
  // `PromiseResolve` is a carrier question only the emitter can answer, so the
  // renderer hands the runtime a lambda rather than a fixed spelling.
  ['PromiseConstructor.all', { kind: 'method', emit: '/* unused: see promiseAllText, emit-host-invoke.ts */', arity: 'call-site' }],
  // `Promise.race` -- 27.2.4.5, `call-site` for the same reason `all` is: the
  // promise it mints is typed by the call's own `Awaited<T>` and the per-element
  // registration is a carrier question only the emitter can answer, so the
  // renderer hands the runtime an adopter lambda rather than a fixed spelling.
  ['PromiseConstructor.race', { kind: 'method', emit: '/* unused: see promiseRaceText, emit-host-invoke.ts */', arity: 'call-site' }],
  // `Symbol.for` -- ECMA-262 20.4.2.2. `call-site` because a LITERAL key does
  // not render as a call at all: `symbolMemberText` (emit-host-invoke.ts)
  // interns it into the unit's own table and the access becomes a reference to
  // one namespace-scope `inline const gea::Symbol`, evaluated once. A computed
  // key has no literal to intern and renders as the `gea::symbolFor(k)` call
  // this row would otherwise template -- one member, two spellings, which is
  // precisely what a fixed `emit` string cannot say.
  ['SymbolConstructor.for', { kind: 'method', emit: '/* unused: see symbolMemberText, emit-host-invoke.ts */', arity: 'call-site' }],
  // `Symbol.keyFor` -- 20.4.2.6. One fixed spelling, so an ordinary row: the
  // registry lookup is a runtime question about a symbol whose value is not
  // known here, and it answers `Optional<std::string>` because an unregistered
  // symbol's key is `undefined`, not `""`.
  ['SymbolConstructor.keyFor', { kind: 'method', emit: 'gea::symbolKeyFor({arg0})', arity: 1 }],
  // The well-known symbols this backend has an id for -- ECMA-262 6.1.5.1.
  // Data properties, so `kind: 'property'` with no store: `Symbol.dispose` IS
  // a value, and reading it neither calls anything nor can be assigned to.
  //
  // Reading one is all a row here claims. `Symbol.iterator` being readable
  // does not make a `for...of` over an arbitrary object work, and the
  // operations that consume these symbols refuse at their own sites exactly as
  // they did before -- which is why the rows are per member rather than a
  // blanket claim over `SymbolConstructor`.
  [
    'SymbolConstructor.asyncIterator',
    { kind: 'property', store: null, emit: 'gea::wellKnownSymbol(gea::detail::WellKnownSymbol::AsyncIterator)' }
  ],
  ['SymbolConstructor.iterator', { kind: 'property', store: null, emit: 'gea::wellKnownSymbol(gea::detail::WellKnownSymbol::Iterator)' }],
  // `Symbol.match` and `Symbol.toPrimitive` are readable for the same reason
  // `Symbol.iterator` above is, and the RUNTIME already implements both
  // behaviours in full: `isRegExp` (gea_runtime.h) does the 22.2.7.4 `@@match`
  // read through `wellKnownSymbol(WellKnownSymbol::Match)`, and
  // `dynamicToPrimitive`/`dynamicToNumber` (gea_dynamic_proxy.h) run 7.1.1's
  // `@@toPrimitive` dispatch. Only this table was missing the rows, so
  // `exotic[Symbol.toPrimitive] = ...` and `regexLike[Symbol.match]` were
  // refused at the property read while the machinery behind them was sitting
  // there complete.
  //
  // This table is still an arbitrary SUBSET of the runtime's own
  // `WellKnownSymbol` enum -- `hasInstance`, `isConcatSpreadable`, `matchAll`,
  // `replace`, `search`, `species`, `split` and `unscopables` remain absent
  // with no stated reason. Each needs the same one-line row plus evidence that
  // whatever consumes it exists; they are left out here rather than added
  // blind, because a readable property whose behaviour is not implemented
  // turns a clean refusal into a wrong answer.
  ['SymbolConstructor.match', { kind: 'property', store: null, emit: 'gea::wellKnownSymbol(gea::detail::WellKnownSymbol::Match)' }],
  [
    'SymbolConstructor.toPrimitive',
    { kind: 'property', store: null, emit: 'gea::wellKnownSymbol(gea::detail::WellKnownSymbol::ToPrimitive)' }
  ],
  [
    'SymbolConstructor.toStringTag',
    { kind: 'property', store: null, emit: 'gea::wellKnownSymbol(gea::detail::WellKnownSymbol::ToStringTag)' }
  ],
  ['SymbolConstructor.dispose', { kind: 'property', store: null, emit: 'gea::wellKnownSymbol(gea::detail::WellKnownSymbol::Dispose)' }],
  [
    'SymbolConstructor.asyncDispose',
    { kind: 'property', store: null, emit: 'gea::wellKnownSymbol(gea::detail::WellKnownSymbol::AsyncDispose)' }
  ],
  // `Object`'s statics. Every row is `call-site` and every one of them has to
  // be, for one reason each spelling shares: what these render depends on the
  // RECEIVER'S CARRIER at the individual site, which no fixed template can
  // name.
  //
  // `Object.keys(shape)` where `shape`'s fields the checker already knows is a
  // constant -- the field list, written out, with no runtime walk at all --
  // and `Object.keys(anything)` where the program declared `anything` to be
  // `any` is a real enumeration of a real ordered own-property table
  // (`gea::host::ObjectConstructor::keys`, gea_runtime.h). One member, two
  // spellings, decided by the argument: exactly what `SymbolConstructor.for`'s
  // own row above describes for a literal vs. a computed key, and exactly what
  // a fixed `emit` string cannot say. `objectMemberText` (emit-host-invoke.ts)
  // states all of them and refuses by name for a carrier neither arm covers.
  //
  // The claim is per MEMBER, never per protocol: `Object.create`,
  // `Object.setPrototypeOf`, `Object.defineProperties`
  // and the rest have no row here, so each refuses
  // at its own access with its own name. See `manifest.ts`'s
  // `ObjectConstructor@1` entry for why each is absent. `Object.getPrototypeOf`
  // is claimed below despite that entry's own comment predating it: the
  // `[[Prototype]]` slot this backend's `DynamicObject` already carries and
  // honours (`instanceof`/`in` already walk it) is a real answer, not the
  // unmodeled `Object.prototype` INTRINSIC that comment is about -- see
  // `getPrototypeOfText`, `emit-host-object.ts`. `Object.prototype` ITSELF is a
  // separate row above this block, under the `.prototype` widening
  // (`ObjectConstructor.prototype`) -- a reflection-only handle, not the
  // intrinsic object `getPrototypeOfText` still refuses to fabricate.
  ['ObjectConstructor.keys', { kind: 'method', emit: '/* unused: see objectMemberText, emit-host-invoke.ts */', arity: 'call-site' }],
  ['ObjectConstructor.values', { kind: 'method', emit: '/* unused: see objectMemberText, emit-host-invoke.ts */', arity: 'call-site' }],
  ['ObjectConstructor.entries', { kind: 'method', emit: '/* unused: see objectMemberText, emit-host-invoke.ts */', arity: 'call-site' }],
  [
    'ObjectConstructor.getOwnPropertyNames',
    { kind: 'method', emit: '/* unused: see objectMemberText, emit-host-invoke.ts */', arity: 'call-site' }
  ],
  ['ObjectConstructor.assign', { kind: 'method', emit: '/* unused: see objectMemberText, emit-host-invoke.ts */', arity: 'call-site' }],
  // `Object.create(null)` -- the one-argument, null-prototype form; see `createText` (emit-host-object.ts) for what renders and what still refuses.
  [
    'ObjectConstructor.fromEntries',
    { kind: 'method', emit: '/* unused: see objectMemberText, emit-host-invoke.ts */', arity: 'call-site' }
  ],
  ['ObjectConstructor.create', { kind: 'method', emit: '/* unused: see objectMemberText, emit-host-invoke.ts */', arity: 'call-site' }],
  [
    'ObjectConstructor.defineProperty',
    { kind: 'method', emit: '/* unused: see objectMemberText, emit-host-invoke.ts */', arity: 'call-site' }
  ],
  [
    'ObjectConstructor.getOwnPropertyDescriptor',
    { kind: 'method', emit: '/* unused: see objectMemberText, emit-host-invoke.ts */', arity: 'call-site' }
  ],
  ['ObjectConstructor.freeze', { kind: 'method', emit: '/* unused: see objectMemberText, emit-host-invoke.ts */', arity: 'call-site' }],
  ['ObjectConstructor.isFrozen', { kind: 'method', emit: '/* unused: see objectMemberText, emit-host-invoke.ts */', arity: 'call-site' }],
  ['ObjectConstructor.seal', { kind: 'method', emit: '/* unused: see objectMemberText, emit-host-invoke.ts */', arity: 'call-site' }],
  ['ObjectConstructor.isSealed', { kind: 'method', emit: '/* unused: see objectMemberText, emit-host-invoke.ts */', arity: 'call-site' }],
  [
    'ObjectConstructor.preventExtensions',
    { kind: 'method', emit: '/* unused: see objectMemberText, emit-host-invoke.ts */', arity: 'call-site' }
  ],
  [
    'ObjectConstructor.isExtensible',
    { kind: 'method', emit: '/* unused: see objectMemberText, emit-host-invoke.ts */', arity: 'call-site' }
  ],
  ['ObjectConstructor.hasOwn', { kind: 'method', emit: '/* unused: see objectMemberText, emit-host-invoke.ts */', arity: 'call-site' }],
  ['ObjectConstructor.is', { kind: 'method', emit: '/* unused: see objectMemberText, emit-host-invoke.ts */', arity: 'call-site' }],
  [
    'ObjectConstructor.getPrototypeOf',
    { kind: 'method', emit: '/* unused: see objectMemberText, emit-host-invoke.ts */', arity: 'call-site' }
  ],
  // `ArrayBuffer.isView` is a carrier test: typed arrays and DataViews are
  // views, while the backing ArrayBuffer and every other stated carrier are
  // not. The call-site renderer owns that distinction.
  [
    'ArrayBufferConstructor.isView',
    { kind: 'method', emit: '/* unused: see isArrayBufferViewText, emit-host-invoke.ts */', arity: 'call-site' }
  ],
  // `PropertyDescriptor`'s own six fields -- ECMA-262 6.1.7.1, and the whole
  // of the interface `lib.es5.d.ts` declares. `property`, not `method`: a
  // descriptor field IS a value, unlike `Object.keys`, which names a symbol
  // only at its call.
  //
  // Every row names a member of `gea::PropertyDescriptor` itself, because that
  // is what the carrier is: `gea::NativeHandle` is specialized for this
  // protocol's tag onto the real descriptor (see that specialization in
  // `gea_runtime.h`), so `{receiver}.value` is a struct member load and not an
  // id lookup into a store.
  //
  // `value` is declared `any`, which derives `dynamic` and carries
  // `gea::Value` -- the same type the descriptor field already is, so the read
  // is a plain member load. A descriptor that states no value holds a
  // default-constructed `gea::Value`, which IS `undefined`: the right answer
  // rather than a coincidence.
  //
  // `writable`/`enumerable`/`configurable` are declared `boolean | undefined`,
  // so the plan selects `gea::Optional<bool>` and the read has to PRODUCE one.
  // The descriptor's own `has*` flag is exactly that presence bit (6.2.6
  // distinguishes "states false" from "states nothing"), so the ternary below
  // is not a widening bolted on -- it is the same fact spelled in the carrier
  // the checker asked for. Emitting the bare `bool` instead type-checked in
  // this table and disagreed with the plan at the use site, which is the
  // checker-vs-physical-carrier defect this compiler exists to not have.
  // `{receiver}` repeats, which is safe: an operand's text is a value name or
  // a literal, never an expression with an effect to run twice.
  //
  // Every row is READ-ONLY. A write would have to reconcile an
  // `Optional<bool>` back onto a `bool` plus its flag, and nothing in the
  // corpus mutates a descriptor in place -- a program builds a literal and
  // passes it to `defineProperty`. So a write refuses by name rather than
  // carrying a reconciliation with no call site to check it.
  //
  // `get`/`set` have NO ROW AT ALL, so a read of either refuses by name.
  // `gea::PropertyDescriptor` stores an accessor as a native `std::function`
  // -- which is what lets `gea::runtime::object::get` actually invoke one --
  // and the program's own carrier for `(() => any) | undefined` is a
  // `gea::CallableObject`. Those are different physical types, and a row
  // spelling the member anyway would emit the descriptor's field where the
  // plan wants the callable. Converting between them is real work with a real
  // question in it (how the receiver reaches the getter), and it is not done
  // here -- see `objectMemberText`'s matching refusal for an accessor
  // descriptor passed to `defineProperty`.
  ['PropertyDescriptor.value', { kind: 'property', emit: '{receiver}.value', store: null }],
  [
    'PropertyDescriptor.writable',
    {
      kind: 'property',
      emit: '({receiver}.hasWritable ? gea::Optional<bool>({receiver}.writable) : gea::Optional<bool>())',
      store: null
    }
  ],
  [
    'PropertyDescriptor.enumerable',
    {
      kind: 'property',
      emit: '({receiver}.hasEnumerable ? gea::Optional<bool>({receiver}.enumerable) : gea::Optional<bool>())',
      store: null
    }
  ],
  [
    'PropertyDescriptor.configurable',
    {
      kind: 'property',
      emit: '({receiver}.hasConfigurable ? gea::Optional<bool>({receiver}.configurable) : gea::Optional<bool>())',
      store: null
    }
  ]
])

/**
 * The ambient FREE FUNCTIONS the language itself defines on the global object,
 * to the C++ each is -- the `hostFunctions` half of what `coreHostMembers` is
 * to `hostMembers`.
 *
 * These are ECMAScript's, not any host's, so they belong here and not in a
 * plugin package: `parseInt` is defined by ECMA-262 §19.2.5 and is present in
 * every conforming environment, gea or otherwise. Before this table they had
 * no claim anywhere, so `projection/bindings.ts` fell through to the ordinary
 * external-cell case and `translation-unit.ts` declared `extern
 * gea::CallableObject<double(std::string, gea::Optional<double>)> parseInt;`
 * -- a global VARIABLE no object file defines. That passes a `-fsyntax-only`
 * check, never links, and (if something does define the symbol) calls through
 * a null invoke pointer. `plugins/model.ts`'s own `hostFunctions` comment
 * describes exactly that failure for the host case.
 *
 * `parseInt` and `parseFloat` name `NumberConstructor`'s functions rather than
 * twins of their own, because ECMA-262 21.1.2.13 and 21.1.2.12 define
 * `Number.parseInt`/`Number.parseFloat` as *the same function objects* as the
 * globals. `isNaN`/`isFinite` do get their own spellings, because the global
 * pair and the `Number` pair are genuinely different functions -- see
 * `gea::host::globalIsNaN` in `gea_runtime.h`.
 */
export const coreHostFunctions: HostFunctionTable = new Map<string, string>([
  ['parseInt', 'gea::host::NumberConstructor::parseInt'],
  ['parseFloat', 'gea::host::NumberConstructor::parseFloat'],
  ['isNaN', 'gea::host::globalIsNaN'],
  ['isFinite', 'gea::host::globalIsFinite']
])

/**
 * The ambient CONSTANTS the language defines on the global object, to the text
 * each read renders.
 *
 * `NaN` (ECMA-262 §19.1.1) and `Infinity` (§19.1.2) are `declare var`s in
 * `lib.es5.d.ts`, so without a claim here they were placed as ordinary
 * external cells and the unit emitted `extern double NaN;` -- again a symbol
 * nothing defines. A constant is the right storage rather than a function or a
 * cell: neither name is readable-and-writable in any meaningful sense (both
 * are non-writable, non-configurable properties of the global object), so
 * every read is the value, spelled inline, exactly as
 * `BindingStorage`'s `host-constant` describes for an Objective-C enumerator.
 *
 * `undefined` (§19.1.3) is not here: TypeScript treats it as a keyword with
 * its own type rather than a binding this projection ever asks about, so it
 * needs no cell and has none.
 */
export const coreHostConstants: ReadonlyMap<string, string> = new Map<string, string>([
  ['NaN', 'std::numeric_limits<double>::quiet_NaN()'],
  ['Infinity', 'std::numeric_limits<double>::infinity()']
])

/**
 * The member a protocol states, looked up in the table this compilation built.
 *
 * The table is passed rather than imported: a plugin installs host protocols of
 * its own, and a lookup that read a module-level map could only ever see this
 * file's half of the answer.
 */
export const hostMemberOf = (table: HostMemberTable, protocol: string, member: string): HostMember | undefined =>
  table.get(`${protocol}.${member}`)

/**
 * A builtin method's own `length` where ECMA-262 states one that the
 * declaration's required-parameter count does not reproduce. `lib.d.ts`
 * marks `setFullYear(year, month?, date?)` with two optionals, so the census
 * reads a required arity of 1; 21.4.4.22 gives the function `length` 3. The
 * spec's number is a host fact, stated here beside the other host facts, and
 * consulted before the census's arity by every reflection reader.
 */
const hostIntrinsicLengths: ReadonlyMap<string, number> = new Map<string, number>([
  ['Date.prototype.setFullYear', 3],
  ['Date.prototype.setHours', 4],
  ['Date.prototype.setMinutes', 3],
  ['Date.prototype.setMonth', 2],
  ['Date.prototype.setSeconds', 2],
  ['Date.prototype.setUTCFullYear', 3],
  ['Date.prototype.setUTCHours', 4],
  ['Date.prototype.setUTCMinutes', 3],
  ['Date.prototype.setUTCMonth', 2],
  ['Date.prototype.setUTCSeconds', 2],
  ['Date.prototype.toJSON', 1],
  ['Number.prototype.toExponential', 1],
  ['Number.prototype.toFixed', 1],
  ['Number.prototype.toPrecision', 1],
  ['Number.prototype.toString', 1],
  // `X.prototype.constructor.length` is the constructor's own `length`.
  ['Date.prototype.constructor', 7],
  ['String.prototype.constructor', 1],
  ['Number.prototype.constructor', 1],
  // 23.1.2.1: `Array.from` is one function of length 1 whatever the four
  // `lib.d.ts` overloads say. It is read as a VALUE rather than called, so
  // there is no census arity behind it to fall back to -- see
  // `statedHostIntrinsicLength` below.
  ['ArrayConstructor.from', 1]
])

/**
 * The spec's own `length` for a builtin, or `null` where none is stated here.
 *
 * Separated from `hostIntrinsicLengthOf` because a builtin read as a VALUE has
 * no census arity to fall back to: `0` would be a fabricated answer, and the
 * reader refuses by name instead. Same map, so the two readers cannot drift.
 */
export const statedHostIntrinsicLength = (protocol: string, member: string): number | null =>
  hostIntrinsicLengths.get(`${protocol}.${member}`) ?? null

export const hostIntrinsicLengthOf = (protocol: string, member: string, censusArity: number | null): number =>
  statedHostIntrinsicLength(protocol, member) ?? censusArity ?? 0

/**
 * Fills a template's `{receiver}`, `{argN}`, and `{args}` slots.
 *
 * Scanned rather than pattern-matched: a RegExp is forbidden under this
 * directory, and rightly so -- the emitted spelling of a program is not a place
 * for a pattern language whose failure mode is a silently different match.
 *
 * `{args}` is separate from `{argN}` rather than a positional index into the
 * same `args` array: a variadic call has no fixed positions to index, only
 * one already-joined value the caller (`hostCallText`) computed ahead of time
 * (see `consoleArgumentsText`, emit-tostring.ts). It is checked before the
 * `{arg` prefix test below on purpose -- the literal slot name `args` itself
 * starts with the three characters `arg`, so an unordered check would read it
 * as an argument index, fail `Number.isInteger` on the leftover `"s"`, and
 * refuse a template that is actually well-formed.
 *
 * Returns `null` when the template names a slot the call site did not supply,
 * so the caller refuses by name instead of emitting a hole.
 */
/**
 * Whether `{...}` here is meant as a slot at all.
 *
 * A slot is spelled in bare alphanumerics -- `receiver`, `args`, `value`,
 * `arg0` -- and a brace-delimited run of C++ never is: a lambda body, a
 * compound statement and an aggregate initializer all contain whitespace or
 * punctuation. So this is what separates "the table misspelled a slot", which
 * must be refused by name, from "the template contains C++", which must be
 * copied through. Measured against every installed row before being relied on:
 * 12 of 1044 templates carry a non-slot brace and none of them is ambiguous.
 *
 * Hand-rolled rather than a character class because no RegExp literal may
 * appear under `targets/cpp` -- see `scripts/architecture.mjs`.
 */
const isSlotSpelling = (slot: string): boolean => {
  if (slot.length === 0) return false
  for (const character of slot) {
    const isDigit = character >= '0' && character <= '9'
    const isLower = character >= 'a' && character <= 'z'
    const isUpper = character >= 'A' && character <= 'Z'
    if (!isDigit && !isLower && !isUpper) return false
  }
  return true
}

export const fillHostTemplate = (
  emit: string,
  receiver: string | null,
  args: readonly string[],
  variadicArgs: string | null = null,
  value: string | null = null
): string | null => {
  const out: string[] = []
  let index = 0
  while (index < emit.length) {
    const open = emit.indexOf('{', index)
    if (open < 0) {
      out.push(emit.slice(index))
      break
    }
    const close = emit.indexOf('}', open)
    if (close < 0) {
      out.push(emit.slice(index))
      break
    }
    out.push(emit.slice(index, open))
    const slot = emit.slice(open + 1, close)
    if (slot === 'receiver') {
      if (receiver === null) return null
      out.push(receiver)
    } else if (slot === 'args') {
      if (variadicArgs === null) return null
      out.push(variadicArgs)
    } else if (slot === 'value') {
      if (value === null) return null
      out.push(value)
    } else if (slot.startsWith('arg')) {
      const ordinal = Number(slot.slice(3))
      const argument = Number.isInteger(ordinal) ? args[ordinal] : undefined
      if (argument === undefined) return null
      out.push(argument)
    } else if (isSlotSpelling(slot)) {
      // A slot spelling this filler does not know is a defect in this table,
      // not in the program being compiled, and rendering the braces through
      // into C++ would turn it into a confusing clang error instead of a named
      // one.
      return null
    } else {
      // Not a slot at all: a host template is C++ text, and C++ text
      // legitimately contains braces. Twelve of the Apple rows spell a whole
      // lambda -- `([&]() { id __gea_view = ...; })()` -- and treating that
      // opening brace as a slot made the row unfillable, which surfaced as
      // "names a slot this call cannot fill" for a template that named no slot
      // there at all.
      //
      // Only the brace itself is consumed, never the span it appeared to open.
      // A C++ block CONTAINS slots -- `...initWithCallback:std::function<void()>({arg0})...`
      // sits inside a lambda body -- and skipping to the matching-looking `}`
      // swallowed them: `{arg0}` was copied through verbatim and reached clang
      // as an undeclared identifier. Advancing one character keeps the scan
      // inside the block, where the real slots are.
      out.push('{')
      index = open + 1
      continue
    }
    index = close + 1
  }
  return out.join('')
}

/**
 * How many arguments a host template consumes, read from the template itself.
 *
 * The template is the authority on this and nothing else is: it names
 * `{arg0}`, `{arg1}`, ... exactly as many times as the host spelling needs, and
 * `fillHostTemplate` refuses a slot the call cannot fill. Taking the count from
 * the declared parameter list instead would be a second answer to the same
 * question, free to drift from the text that actually gets rendered -- and a
 * declared optional parameter the spelling does not mention would make the two
 * disagree immediately.
 */
export const templateArity = (emit: string): number => {
  let highest = -1
  let index = 0
  while (index < emit.length) {
    const open = emit.indexOf('{arg', index)
    if (open < 0) break
    const close = emit.indexOf('}', open)
    if (close < 0) break
    const ordinal = Number(emit.slice(open + 4, close))
    if (Number.isInteger(ordinal) && ordinal > highest) highest = ordinal
    index = close + 1
  }
  return highest + 1
}
