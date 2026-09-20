import { createRequire } from 'node:module'
import type {
  HostCallSpelling,
  HostConstructor,
  HostConstructorTable,
  HostMember,
  HostMemberTable
} from '../../targets/cpp/host/host-members.js'
import { templateArity } from '../../targets/cpp/host/host-members.js'

/**
 * The one field of `HostShimDefinitions` this compiler reads, as this compiler
 * needs it.
 *
 * Deliberately NOT `import type { HostShimDefinitions } from
 * '@geastack/geatsc-plugin-gea'`: a static type import makes the framework
 * package a hard build dependency of the compiler, and this load is a `require`
 * in a `try` precisely so it is not one. Restating the *shape of the one field
 * read* is not restating the data -- the 39 entries stay in the package, which
 * is the whole point -- and the narrowing below is what makes the boundary
 * honest rather than asserted.
 */
/** One member binding, as the package states it: the spelling, and every receiver type it accepts. */
export interface GeaMemberBinding {
  readonly emit?: string
  readonly receiverTypes?: readonly string[]
  /**
   * The C++ this binding's `emit` actually evaluates to, stated by the package
   * because the DECLARED type (`index.d.ts`'s ambient interfaces) is
   * sometimes not it -- `OscillatorNode.connect` is declared to return
   * `AudioDestinationNode` (the Web Audio spec's chaining convention) and the
   * real `gea::host::OscillatorNode::connect` is `void`. Read only for the
   * literal string `"void"`: see `geaHostMemberVoidResults`, members.ts.
   */
  readonly returnType?: string
}

interface GeaHostShimSlice {
  readonly nativeTypes: Readonly<Record<string, string>>
  /**
   * `new <AmbientConstructor>(...)` spellings, keyed by the ambient
   * CONSTRUCTOR interface's own declared name (`AudioConstructor`, one level
   * up from the instance name `nativeTypes` carries). See `geaHostConstructors`
   * (below) for how this becomes a `HostConstructorTable`, and the package's
   * own `types.ts` doc comment on this field for why it is keyed this way.
   */
  readonly nativeConstructors?: Readonly<Record<string, string>>
  readonly nativeMemberMethods?: Readonly<Record<string, readonly GeaMemberBinding[]>>
  readonly nativeMemberPropertyGetters?: Readonly<Record<string, readonly GeaMemberBinding[]>>
  readonly nativeMemberPropertySetters?: Readonly<Record<string, readonly GeaMemberBinding[]>>
  readonly nativeDocumentMethods?: Readonly<Record<string, { readonly emit?: string }>>
  /** Intrinsic tags whose single-text-run form is a text node -- see `geaElementTextLeafTags`. */
  readonly elementTextLeafTags?: readonly string[]
  /**
   * Methods the host adds to a DOM ELEMENT -- one row, `getContext`.
   *
   * Read for the member name only. The spelling calls into `gea_ir::`, which
   * this compiler does not generate; what the wrapper does is stated by the
   * engine instead. See `geaCanvasAcquisition`.
   */
  readonly domElementMethods?: Readonly<Record<string, string>>
  /**
   * Global VALUES a host holds one instance of and reaches by a fixed C++
   * spelling -- `navigator`, `window`, `localStorage` -- stated separately from
   * `hostNamespaces` because a name here is not necessarily also a PATH: a
   * program may hold `navigator` itself (`navigator`/`window` state both,
   * deliberately), while `localStorage` states only this one, its every member
   * still reached through `hostNamespaceMethods`' identical path-call
   * mechanism. See `geaHostNamespaceRoots`.
   */
  readonly hostGlobalObjects?: Readonly<Record<string, string>>
  /**
   * The C++ TYPE of each `hostGlobalObjects` value, keyed by the same global
   * name -- `window` -> `gea::host::WindowFacade` for the `inline constexpr
   * WindowFacade window{}` that `hostGlobalObjects.window` spells.
   *
   * The two tables answer different questions and neither derives the other:
   * `localStorage`'s object is `gea::host::Storage` and its type is
   * `gea::host::StorageFacade`. See `geaHostNamespaceRootTypes`.
   */
  readonly hostGlobalObjectTypes?: Readonly<Record<string, string>>
  readonly hostNamespaces?: Readonly<Record<string, string>>
  readonly hostNamespaceMethods?: Readonly<Record<string, Readonly<Record<string, string>>>>
  /**
   * The same members, stated NATIVELY: a call template plus the C++ type the
   * call yields. The package writes these where the boxed spelling would lose
   * the result's type -- `image.make(id)` yields a `GeaEmbeddedImage` handle,
   * `image.readFile` a `std::vector<std::uint8_t>` rather than a per-byte boxed
   * record.
   *
   * Read as the table that WINS where both state a member: this one can place
   * the call inside something else, and `hostNamespaceMethods` -- a bare C++
   * path with the arguments appended -- structurally cannot. See
   * `geaHostNamespaceMethods` for the precedence and its measured blast
   * radius; the short version is that 21 of the 25 rows here agree with their
   * bare twin exactly (`gea::host::Battery.level` versus
   * `gea::host::Battery.level({args})`) and render identically either way, so
   * the precedence is only observable on `navigator.mediaDevices.getUserMedia`
   * and on the three rows -- `image.make`, `http.createServer`, `http.close` --
   * that no other table states at all.
   */
  readonly nativeNamespaceMethods?: Readonly<
    Record<string, Readonly<Record<string, { readonly emit?: string; readonly returnType?: string }>>>
  >
  readonly hostNamespaceProperties?: Readonly<Record<string, Readonly<Record<string, string>>>>
  /**
   * Which namespace properties are backed by an ACCESSOR, as a name set per
   * namespace -- `{ Display: ['ctx', 'width', ...] }`, not a spelling table.
   * The spelling is already in `hostNamespaceProperties`; this states that
   * reading it means CALLING it.
   */
  readonly hostNamespacePropertyAccessors?: Readonly<Record<string, readonly string[]>>
  readonly hostNamespacePropertySetters?: Readonly<Record<string, Readonly<Record<string, string>>>>
  readonly embeddedHostFunctions?: Readonly<Record<string, string>>
  readonly embeddedHostConstants?: Readonly<Record<string, { readonly emit?: string }>>
  readonly hostExternDeclarations?: Readonly<Record<string, readonly string[]>>
  /**
   * The 2D canvas context's members, keyed by name, each stating the package's
   * own `gea_ir::canvas<Member>` wrapper.
   *
   * Read for the member NAMES and for the engine method each wrapper is named
   * after -- see `geaCanvasMembers`. The templates themselves are not usable
   * here: they call into a namespace the package generates from a v1 IR bundle
   * this compiler does not produce.
   */
  readonly canvasContextMethods?: Readonly<Record<string, string>>
  /** The same, for the context's settable properties (`fillStyle` -> `gea_ir::canvasSetFillStyle`). */
  readonly canvasContextPropertySetters?: Readonly<Record<string, string>>
  /**
   * How the host constructs its own classes -- `new WebSocket(url)`,
   * `new MediaStream()` -- read by `geaHostConstructors` (constructors.ts).
   * See `GeaHostClass` for what one row states.
   */
  readonly embeddedHostClasses?: Readonly<Record<string, GeaHostClass>>
}

/**
 * One host class's construction convention, exactly as the package states it.
 *
 * Two conventions, because the host builds its classes two different ways.
 * `construct` is the whole `new C(...)` expression already assembled --
 * `gea::host::MediaStream({args})` -- for a class whose C++ constructor takes
 * the arguments directly. `factory` is a thunk that returns a handle as a
 * `double`, for a class built from a free function instead of a constructor
 * call (`gea::host::websocket::create_handle`); `wrapper` names the C++ type
 * that handle is wrapped in to become the value. A row with neither states no
 * construction at all, deliberately -- `hostConstructors` cannot invent one.
 */
export interface GeaHostClass {
  readonly wrapper?: string
  readonly construct?: string
  readonly factory?: string
}

const require_ = createRequire(import.meta.url)

/**
 * `nativeTypes`, narrowed at the boundary.
 *
 * Anything that is not a string-to-string record is refused whole rather than
 * partially admitted: a table half of which is a carrier and half of which is
 * something else would put this compiler back in the business of guessing.
 */
const nativeTypesOf = (value: unknown): ReadonlyMap<string, string> | null => {
  if (typeof value !== 'object' || value === null) return null
  const table = new Map<string, string>()
  for (const [name, carrier] of Object.entries(value)) {
    if (typeof carrier !== 'string' || carrier.length === 0) return null
    table.set(name, carrier)
  }
  return table
}

let loaded: ReadonlyMap<string, string> | null | undefined
let loadedSlice: GeaHostShimSlice | null = null
let loadedInterop: readonly string[] | null = null

/**
 * The host type table, from the package that owns it.
 *
 * gea ships its declarations, its native implementation and this table
 * together; the table is that package's statement about its own runtime, and a
 * copy of it here would be a second authority that drifts the first time the
 * runtime changes. So it is loaded, not restated.
 *
 * `require` rather than `import()`: this package is ESM, and Node's
 * `require(esm)` (>= 22.12; this repo runs 24) resolves it synchronously, so
 * `compile()` stays synchronous end to end and no caller has to await a plugin
 * before compiling. A module graph with a top-level `await` would not load this
 * way, and the `catch` below is what that fails into.
 *
 * `GEATSC2_GEA_PLUGIN` overrides the specifier with an explicit path -- how a
 * different build of the plugin is measured against this compiler, and the only
 * way an absolute path ever enters this decision.
 *
 * Two failures, told apart. The package simply not being installed is a
 * configuration, not a defect: the table is empty, the plugin claims nothing
 * but `jsx-element@1`, and every non-gea program compiles exactly as it did. A
 * package that IS installed but does not answer -- a load error, a missing
 * factory, a table that is not string-to-string -- is a defect, and it throws.
 *
 * That distinction is the whole point. Swallowing the second case returns an
 * empty table indistinguishable from the first, so every gea program loses
 * every carrier at once and is refused for obligations spelled in TypeScript
 * names (`Document@1`) that nothing was ever going to claim -- a fail-open that
 * reads as a compiler bug for as long as it takes to notice the plugin never
 * loaded. A compiler that substituted a built-in table here would be back to
 * hand-maintaining the data; one that quietly substituted an empty one is
 * worse, because it looks like it read the data and disagreed.
 */
export const geaNativeTypes = (): ReadonlyMap<string, string> => {
  if (loaded !== undefined) return loaded ?? new Map()
  const requested = process.env.GEATSC2_GEA_PLUGIN
  const specifier = requested ?? '@geastack/geatsc-plugin-gea/host-shims'
  let shims: unknown
  try {
    shims = require_(specifier)
  } catch (error) {
    // Not installed is a configuration; anything else is a defect. The
    // override is held to the stricter rule on purpose: naming a plugin
    // explicitly and then not finding it is a wrong path, not an absent
    // package, and silently measuring against an empty table is exactly how a
    // seam gets credited with a result it never produced.
    const absent = (error as { code?: string }).code === 'MODULE_NOT_FOUND'
    if (!absent || requested !== undefined) {
      throw new Error(`gea host shims failed to load from '${specifier}': ${String(error)}`)
    }
    loaded = null
    return new Map()
  }
  const factory = (shims as { createGeaHostShims?: () => GeaHostShimSlice }).createGeaHostShims
  if (typeof factory !== 'function') {
    throw new Error(`gea host shims at '${specifier}' export no createGeaHostShims function`)
  }
  const table = nativeTypesOf(factory().nativeTypes)
  if (table === null) {
    throw new Error(`gea host shims at '${specifier}' provided a nativeTypes table that is not string-to-string`)
  }
  loaded = table
  loadedSlice = factory()
  return table
}

/**
 * The whole shim slice, once the table above has been admitted.
 *
 * Everything below reads a different field of the same statement, so they all
 * go through the one load and the one narrowing gate: a package that answered
 * a bad `nativeTypes` has already thrown by the time any of this is asked, and
 * a package that is simply not installed answers every table empty.
 */
const geaShims = (): GeaHostShimSlice | null => {
  geaNativeTypes()
  return loadedSlice
}

/** The member tables, exactly as the package states them; `null` when the package is not installed. */
export const geaMemberTables = (): GeaHostShimSlice | null => geaShims()

/** A string-to-string table, or nothing -- the same narrowing `nativeTypes` gets, for the flat tables. */
const flatTable = (value: Readonly<Record<string, string>> | undefined): ReadonlyMap<string, string> => {
  const rows = new Map<string, string>()
  for (const [name, emit] of Object.entries(value ?? {})) {
    if (typeof emit === 'string' && emit.length > 0) rows.set(name, emit)
  }
  return rows
}

/**
 * A namespace member table, flattened to one key per member.
 *
 * The package states these two levels deep -- path, then member -- and states
 * a nested namespace by spelling its whole path in the outer key
 * (`navigator.bluetooth.keyboard`). Flattening to `path.member` keeps that
 * spelling intact and makes the two questions this compiler asks -- "what does
 * this member render to" and "is this path itself a namespace" -- one lookup
 * and one prefix test over the same key space.
 */
const nestedTable = (value: Readonly<Record<string, Readonly<Record<string, string>>>> | undefined): ReadonlyMap<string, string> => {
  const rows = new Map<string, string>()
  for (const [path, members] of Object.entries(value ?? {})) {
    for (const [member, emit] of Object.entries(members ?? {})) {
      if (typeof emit === 'string' && emit.length > 0) rows.set(`${path}.${member}`, emit)
    }
  }
  return rows
}

/**
 * The global names that are host namespaces rather than values.
 *
 * `deviceInfo` is not an object the program can hold: every use of it is a
 * path to a C++ spelling, and the value itself never exists at run time. The
 * table's own value -- the C++ prefix -- is deliberately not what this compiler
 * keys by, because the member tables are keyed by the PROGRAM's path
 * (`deviceInfo.deviceId`, `navigator.bluetooth.keyboard.tap`), and following the
 * program's spelling is what makes a nested namespace one lookup rather than a
 * translation step that could disagree.
 *
 * `hostGlobalObjects` names join this set too, but only the ones the package
 * ALSO states members under (`hostNamespaceMethods.localStorage.*`, etc): the
 * same "a path cannot be a namespace here and have no members there" rule
 * `targets/cpp/host-members.ts`'s `isHostNamespacePath` already applies to
 * every nested path, asked here of a top-level one. `localStorage` states
 * only `hostGlobalObjects` -- unlike `navigator`/`window`, which state both,
 * because a program may also want to HOLD one of those as a value -- but every
 * one of its members (`gea::host::Storage.getItem`, `.setItem`, ...) is
 * already spelled the same fixed-path-call shape `Display`'s are, with no
 * `{receiver}` slot, so it is a namespace root by the identical test. Without
 * this a `localStorage.getItem(...)` census-admitted `GeaLocalStorage` as an
 * ordinary host protocol needing its own native boundary, when the host
 * states no carrier for that name at all -- only for the global itself, under
 * a different table.
 */
export const geaHostNamespaceRoots = (): ReadonlySet<string> => {
  const shims = geaShims()
  const roots = new Set(flatTable(shims?.hostNamespaces).keys())
  const methods = shims?.hostNamespaceMethods ?? {}
  const properties = shims?.hostNamespaceProperties ?? {}
  for (const name of Object.keys(shims?.hostGlobalObjects ?? {})) {
    if (Object.keys(methods[name] ?? {}).length > 0 || Object.keys(properties[name] ?? {}).length > 0) roots.add(name)
  }
  // Console belongs to the compiler's core host protocol. The legacy shim
  // table also names it as a namespace; importing that claim bypasses the
  // core variadic renderer and packs statically typed arguments into any[].
  // Keep the core's typed call path, just as coreHostMembers wins collisions.
  roots.delete('console')
  return roots
}

/**
 * The C++ type of the one object a host holds behind a namespace root.
 *
 * A root is a PATH, not a cell: `window.innerWidth` renders
 * `gea::host::window.innerWidth()` and no object named `window` is ever
 * materialized. But a path is not nothing either -- `gea::host::window` is a
 * real `inline constexpr WindowFacade`, and this is the package saying so.
 * Without it, a compiler asked what carries the ambient `window` has only its
 * lib.dom declaration to answer from, and expands `Window & typeof globalThis`
 * into a struct of its own.
 *
 * Restricted to names that really are roots (`geaHostNamespaceRoots`): the
 * package's own table is keyed by global name, and a global it states a type
 * for but no members under is a VALUE this compiler already places as a host
 * constant or singleton -- claiming a path carrier for one would be a second
 * authority over a name the first already answered.
 */
export const geaHostNamespaceRootTypes = (): ReadonlyMap<string, string> => {
  const roots = geaHostNamespaceRoots()
  const rows = new Map<string, string>()
  for (const [name, type] of flatTable(geaShims()?.hostGlobalObjectTypes)) {
    if (roots.has(name)) rows.set(name, type)
  }
  return rows
}

/**
 * What each namespace member renders to when it is CALLED.
 *
 * Both tables the package states, the NATIVE one first: where a member appears
 * in both, the native row is the one that survives.
 *
 * The two tables are not two spellings of one fact. `hostNamespaceMethods`
 * states a bare C++ path, which can only ever be called -- append arguments and
 * that is the whole call. `nativeNamespaceMethods` states a TEMPLATE, which can
 * also place the call inside something else, and the package writes one exactly
 * where the bare path would lose the result's type: `getUserMedia` is
 * `gea::host::MediaStream(gea::host::media::get_user_media_audio({args}))`,
 * because the underlying host function hands back an opaque handle id and the
 * `MediaStream` is what the program was promised.
 *
 * Precedence used to run the other way, with the bare row winning and the
 * template admitted only when it reduced to a bare path (`gea::host::image.make
 * ({args})` does; the `MediaStream` wrapper does not). That is the two-authority
 * failure in its silent form: both tables answered, the LESS informative answer
 * won, and the loss showed up three layers later as a `unsigned int` assigned
 * into a `gea::Promise<gea::host::MediaStream>` that clang refused. A table that
 * states more cannot be outranked by one that states less.
 *
 * Measured blast radius, against the package as it ships: 25 native rows, 21 of
 * which agree with their bare twin exactly (`gea::host::Battery.level` versus
 * `gea::host::Battery.level({args})`) and render identically either way. Of the
 * remaining four, three are members the bare table does not state at all, and
 * `navigator.mediaDevices.getUserMedia` is the single row where the two really
 * disagree -- so flipping the precedence changes exactly the one call this
 * exists to fix, plus `http.createServer`, which no table could reach before
 * because its template does not reduce.
 */
export const geaHostNamespaceMethods = (): ReadonlyMap<string, HostCallSpelling> => {
  const rows = new Map<string, HostCallSpelling>()
  for (const [path, members] of Object.entries(geaShims()?.nativeNamespaceMethods ?? {})) {
    for (const [member, binding] of Object.entries(members ?? {})) {
      if (typeof binding?.emit === 'string' && binding.emit.length > 0)
        rows.set(`${path}.${member}`, { kind: 'template', emit: binding.emit })
    }
  }
  for (const [key, text] of nestedTable(geaShims()?.hostNamespaceMethods)) {
    if (!rows.has(key)) rows.set(key, { kind: 'path', text })
  }
  return rows
}

/**
 * What each namespace member renders to when it is READ.
 *
 * `hostNamespaceProperties` alone, with `()` appended for every member the
 * package also names in `hostNamespacePropertyAccessors`. That second table is
 * a name SET, not a spelling table -- `{ Display: ['ctx', 'width', ...] }` --
 * and what it states is that the C++ behind the spelling is a member function:
 * `DisplayFacade::ctx()` and `DisplayFacade::width()` really are methods, so a
 * read that did not call them would name a member function rather than read a
 * value. v1 answers the same question the same way (`qualified-call` versus
 * `qualified-value` in `host-runtime-protocol.ts`).
 *
 * The SETTER table is deliberately not merged in here. It states a different
 * spelling for a different operation -- `Display.orientation` reads
 * `gea::host::Display.orientation()` and writes
 * `gea::host::Display.setOrientation` -- and every one of its 12 rows collides
 * with a read row, so merging made the setter win and turned every one of those
 * reads into a reference to the setter. It is its own table instead, right
 * below (`geaHostNamespacePropertySetters`), for the write side of exactly
 * this same member -- dropping it entirely left a namespace WRITE
 * (`Display.autoRotate = true`) with nowhere to resolve, so `emitFieldStore`
 * fell through to the ordinary struct-field path, asked `operandText` for a
 * namespace receiver's value, and hit the "host namespace used as a value"
 * refusal that path states for exactly this reason.
 */
export const geaHostNamespaceProperties = (): ReadonlyMap<string, string> => {
  const shims = geaShims()
  const accessors = new Set<string>()
  for (const [path, members] of Object.entries(shims?.hostNamespacePropertyAccessors ?? {})) {
    if (!Array.isArray(members)) continue
    for (const member of members) if (typeof member === 'string') accessors.add(`${path}.${member}`)
  }
  const rows = new Map<string, string>()
  for (const [key, emit] of nestedTable(shims?.hostNamespaceProperties)) {
    rows.set(key, accessors.has(key) ? `${emit}()` : emit)
  }
  return rows
}

/**
 * What each namespace member renders to when it is WRITTEN.
 *
 * The write-side twin of `geaHostNamespaceProperties`, over
 * `hostNamespacePropertySetters` instead of `hostNamespaceProperties`. Every
 * row here is already a full call spelling -- `gea::host::Display.setAutoRotate`
 * -- the same shape `hostNamespaceMethods` rows are, so nothing here appends a
 * trailing `()` the way the read side's accessor rows do: the value argument
 * fills that call's own parentheses at the write site instead.
 */
export const geaHostNamespacePropertySetters = (): ReadonlyMap<string, string> => nestedTable(geaShims()?.hostNamespacePropertySetters)

/** The host's free functions, by the name the program writes. */
export const geaHostFunctions = (): ReadonlyMap<string, string> => flatTable(geaShims()?.embeddedHostFunctions)

/**
 * `new <AmbientConstructor>(...)` spellings, transposed from the package's own
 * `nativeConstructors` -- one of the two tables the package states a
 * construction in, unioned with the other by `geaHostConstructors`
 * (constructors.ts). This one (keyed by the constructor interface's declared name --
 * `AudioConstructor`) to a `HostConstructorTable` (keyed by the CARRIER
 * `nativeTypes` gives that same declared name, falling back to the declared
 * name itself for a row `nativeTypes` does not also carry -- the identical
 * fallback `HostConstructorTable`'s own doc comment states, and the same
 * lookup `nativeHandleInvocationText` performs at the call site:
 * `callee.native ?? protocol`).
 *
 * Arity is never stated by the package: it is counted off the template's own
 * highest `{argN}` slot (`templateArity`, the same helper `addDocumentRows`,
 * members.ts, already uses for a template with no receiver), so the arity a
 * construction is checked against can never drift from the template that
 * actually renders it.
 */
export const geaAmbientConstructors = (): HostConstructorTable => {
  const rows = new Map<string, HostConstructor>()
  const types = geaNativeTypes()
  for (const [declaredName, emit] of Object.entries(geaShims()?.nativeConstructors ?? {})) {
    if (typeof emit !== 'string' || emit.length === 0) continue
    const carrier = types.get(declaredName) ?? declaredName
    rows.set(carrier, { emit, arity: templateArity(emit) })
  }
  return rows
}

/** The host's global constants, by the name the program writes. */
export const geaHostConstants = (): ReadonlyMap<string, string> => {
  const rows = new Map<string, string>()
  for (const [name, constant] of Object.entries(geaShims()?.embeddedHostConstants ?? {})) {
    if (typeof constant?.emit === 'string' && constant.emit.length > 0) rows.set(name, constant.emit)
  }
  return rows
}

/**
 * One of the package's templates, as this backend spells its slots.
 *
 * The package writes `$receiver` / `$args` / `$value`; `fillHostTemplate` reads
 * `{receiver}` / `{args}` / `{value}`. Two spellings of the same three slots,
 * so this is the transposition every other table here already gets -- not a
 * rewrite of the template, whose text is otherwise carried through unchanged,
 * comments and all. Shared with `members.ts` so the key a preamble is stored
 * under and the row it belongs to are the same string by construction.
 */
export const canvasSlotSpelling = (emit: string): string =>
  emit.split('$receiver').join('{receiver}').split('$args').join('{args}').split('$value').join('{value}')

/**
 * The plugin package's own canvas dispatch, as C++ this unit carries.
 *
 * Every canvas row states a `gea_ir::canvas*` wrapper, and this is what defines
 * them: `directCanvasInteropSource`, the same generator v1 emits into every
 * canvas program. It is called with `boxedValueModel: false`, which drops the
 * four overloads that exist only to accept geatsc v1's boxed carrier and its
 * `gea_f32` scalar -- neither type is in a unit this compiler emits -- and
 * changes nothing else.
 *
 * Loaded from a sibling of the shim module, so an explicitly pointed-at build
 * of the plugin answers both questions. If it cannot answer, that throws: a
 * package that states canvas MEMBERS but ships no generator for them would
 * otherwise emit calls to an undefined namespace, and a link error names the
 * symbol rather than the cause.
 */
export const geaCanvasInterop = (): readonly string[] => {
  if (loadedInterop !== null) return loadedInterop
  const requested = process.env.GEATSC2_GEA_PLUGIN
  const shimSuffix = 'host-shims'
  const specifier =
    requested === undefined
      ? '@geastack/geatsc-plugin-gea/cpp-ir'
      : requested.endsWith(shimSuffix)
        ? `${requested.slice(0, requested.length - shimSuffix.length)}cpp-ir`
        : requested
  const loaded: unknown = require_(specifier)
  const generate = (loaded as { directCanvasInteropSource?: (uses: boolean, options: { boxedValueModel: boolean }) => readonly string[] })
    .directCanvasInteropSource
  if (typeof generate !== 'function') {
    throw new Error(`gea canvas interop at '${specifier}' exports no directCanvasInteropSource function`)
  }
  // The namespace the templates name. The generator produces the members
  // only -- v1 opens `namespace gea_ir` around a larger block that also holds
  // its stores and mounted renderers, none of which this compiler emits.
  loadedInterop = ['namespace gea_ir {', ...generate(true, { boxedValueModel: false }), '}  // namespace gea_ir']
  return loadedInterop
}

/**
 * The declarations a unit must carry before it may name a host spelling.
 *
 * Keyed by the spelling, because that is the question: a unit that emits
 * `gea::host::device_info::deviceId` needs whatever declares it, and a unit that does
 * not must not carry it. Every row this package states today is the same
 * guarded `#include "gea/embedded.h"`, but they are stated one per spelling and
 * are read that way -- collapsing them to a single preamble here would be this
 * compiler deciding that a fact about 331 symbols is really a fact about one.
 */
/**
 * The guarded `#include "gea/embedded.h"` every one of the package's host
 * spellings opens with, on its own.
 *
 * Taken from the package rather than restated, for the reason `geaHostPreambles`
 * gives below: one spelling of the engine include in this compilation. A unit
 * that needs it for a reactive field's cell but names no host spelling has
 * nowhere else to get it, and one that needs it for both gets the identical
 * string, so the preamble set collapses the two.
 *
 * Empty when the package is absent -- there is then no engine to include, and
 * no reactive cell either.
 */
export const geaEmbeddedIncludeGuard = (): readonly string[] => {
  for (const lines of Object.values(geaShims()?.hostExternDeclarations ?? {})) {
    if (Array.isArray(lines) && lines.length >= 4 && lines.every((line) => typeof line === 'string')) return lines.slice(0, 4)
  }
  return []
}

export const geaHostPreambles = (): ReadonlyMap<string, readonly string[]> => {
  const rows = new Map<string, readonly string[]>()
  const guard: string[] = []
  for (const [spelling, lines] of Object.entries(geaShims()?.hostExternDeclarations ?? {})) {
    if (!Array.isArray(lines) || !lines.every((line) => typeof line === 'string')) continue
    rows.set(spelling, lines)
    // Every one of the package's 331 entries opens with the same guarded
    // include; the canvas block needs it too, and taking it from the package
    // rather than restating it keeps one spelling of it in the compilation.
    if (guard.length === 0 && lines.length >= 4) guard.push(...lines.slice(0, 4))
  }
  const canvas = geaCanvasTemplates()
  if (canvas.length > 0 && guard.length > 0) {
    // The block after the guard, in the same entry, so the include is
    // physically ahead of the C++ that needs it whatever order the spellings
    // are visited in. One string, not one per line: the preamble is unioned
    // into a set, and a 283-line block whose blank lines and closing braces
    // repeat cannot survive that.
    const lines = [...guard, geaCanvasInterop().join('\n')]
    for (const spelling of canvas) rows.set(spelling, lines)
  }
  // A native namespace TEMPLATE is looked up by its own text, and the package
  // keys its declarations by SYMBOL -- so
  // `gea::host::MediaStream(gea::host::media::get_user_media_audio({args}))`
  // finds nothing, and the unit that calls it would carry neither declaration.
  //
  // What the template needs is not a guess: it is a piece of C++ this
  // compilation will emit verbatim, so every declared symbol whose spelling
  // OCCURS IN IT is a symbol the emitted line names, and every one of them is
  // therefore needed. That is why containment is the test rather than a
  // reduction to a single bare path -- the whole reason a template exists is
  // that it names more than one thing (a host function AND the type its result
  // is carried as), and only the full text says which.
  //
  // Stated here rather than in the backend because it is a fact about how this
  // package writes its two tables, and the backend's preamble lookup is one
  // exact-key map for every host it may load.
  const declaredSymbols = [...rows]
  for (const spelling of geaHostNamespaceMethods().values()) {
    if (spelling.kind !== 'template' || rows.has(spelling.emit)) continue
    const lines = new Set<string>()
    for (const [symbol, declared] of declaredSymbols) {
      if (spelling.emit.includes(symbol)) for (const line of declared) lines.add(line)
    }
    if (lines.size > 0) rows.set(spelling.emit, [...lines])
  }
  return rows
}

/**
 * The spellings the canvas block defines, as the package states them.
 *
 * The key a preamble is looked up by is the member row's own template, so
 * these are the templates -- `emit` for the methods and `getContext`, `store`
 * for the settable properties -- exactly as `plugins/gea/members.ts` installs
 * them.
 */
const geaCanvasTemplates = (): readonly string[] => {
  const shims = geaShims()
  if (!shims) return []
  const templates = new Set<string>()
  for (const table of [shims.canvasContextMethods, shims.canvasContextPropertySetters, shims.domElementMethods]) {
    for (const emit of Object.values(table ?? {})) {
      if (typeof emit === 'string' && emit.length > 0) templates.add(canvasSlotSpelling(emit))
    }
  }
  return [...templates]
}

/**
 * The host object model gea installs, and the spellings that render it.
 *
 * TypeScript has no document. `Document`, `Element` and `HTMLElement` are
 * declared in `lib.dom.d.ts`, which is a *host's* description of itself, not
 * the language's -- a generic TypeScript-to-C++ compiler that knew how to
 * render `document.getElementById` would be asserting something about the
 * program's environment that nothing in the program says. So the backend does
 * not know these, and this plugin does.
 *
 * The claim and the template live together on purpose. `nativeProtocols` says
 * which protocols may be read at all and `hostMembers` says what each member
 * renders to; when those two sit in different layers they become two
 * authorities over one question, and the way they fail is silent -- preflight
 * certifies a program on the strength of the claim, and emission then refuses
 * it by name because the template was never there. Stating both here means a
 * protocol cannot be claimed without its spelling arriving with it.
 *
 * What is deliberately *not* claimed matters as much as what is. Each interface
 * below is a small, real subset -- the members corpus programs actually call --
 * rather than the full `lib.dom.d.ts` surface. A member nothing renders is
 * refused by name at the call site, which is the failure this table exists to
 * produce instead of a call to a symbol the runtime never declared.
 */
export const geaHostMembers: HostMemberTable = new Map<string, HostMember>([
  // The document singleton. `gea::host::document` is a real node table in
  // `gea_runtime.h`, mirroring the engine's own singleton-of-nodes shape the
  // way `gea::jsx` already does, so emitted C++ runs standalone in the corpus
  // and is replaced by the engine binding on device.
  // Keyed by the CARRIER, not by the declared type name. `nativeTypes` maps
  // `Document` to `gea::embedded::ui::Document` and thirteen DOM interface
  // names to one `NodeHandle`, so a carrier-keyed row is stated once and
  // answers for every name that reaches it. A name-keyed table could not:
  // `HTMLElement.getAttribute` is declared one inheritance step away on
  // `Element`, and `hostMemberOf`'s flat lookup does not walk up -- the exact
  // miss `emit-properties.ts` records in its own comment. There is no step to
  // walk once both names carry `NodeHandle`.
  ['gea::embedded::ui::Document.getElementById', { kind: 'method', emit: 'gea::host::document::getElementById({arg0})', arity: 1 }],
  ['gea::embedded::ui::Document.querySelector', { kind: 'method', emit: 'gea::host::document::querySelector({arg0})', arity: 1 }],
  ['gea::embedded::ui::Document.createElement', { kind: 'method', emit: 'gea::host::document::createElement({arg0})', arity: 1 }],
  ['gea::embedded::ui::Document.createTextNode', { kind: 'method', emit: 'gea::host::document::createTextNode({arg0})', arity: 1 }],
  ['gea::embedded::ui::Document.body', { kind: 'property', store: null, emit: 'gea::host::document::body()' }],

  // Element instance members. Flat free functions taking the handle first,
  // not dot-calls on `NativeHandle`: the handle is a shared carrier spelling
  // for every protocol, so the member set belongs to the protocol's namespace
  // rather than to the handle type, which has no idea which protocol it is
  // carrying.
  [
    'gea::embedded::ui::NodeHandle.setAttribute',
    { kind: 'method', emit: 'gea::host::element::setAttribute({receiver}, {arg0}, {arg1})', arity: 2 }
  ],
  [
    'gea::embedded::ui::NodeHandle.getAttribute',
    { kind: 'method', emit: 'gea::host::element::getAttribute({receiver}, {arg0})', arity: 1 }
  ],
  [
    'gea::embedded::ui::NodeHandle.removeAttribute',
    { kind: 'method', emit: 'gea::host::element::removeAttribute({receiver}, {arg0})', arity: 1 }
  ],
  [
    'gea::embedded::ui::NodeHandle.hasAttribute',
    { kind: 'method', emit: 'gea::host::element::hasAttribute({receiver}, {arg0})', arity: 1 }
  ],
  ['gea::embedded::ui::NodeHandle.appendChild', { kind: 'method', emit: 'gea::host::element::appendChild({receiver}, {arg0})', arity: 1 }],
  ['gea::embedded::ui::NodeHandle.remove', { kind: 'method', emit: 'gea::host::element::remove({receiver})', arity: 0 }]
])

/**
 * The protocols this plugin's runtime installs.
 *
 * `jsx-element@1` is here because JSX is not a TypeScript *value* form at all:
 * the language parses it and hands back a type the host decides the meaning of,
 * and the meaning here is this plugin's element. `AudioContext@1` and
 * `HTMLElement@1` are `lib.dom.d.ts` interfaces on the same footing as
 * `Document` above.
 *
 * `AudioContext@1` claims no members below, on purpose: the protocol is
 * readable -- a program may hold one and pass it around -- and every call on it
 * refuses by name, which is the honest state of a boundary whose implementation
 * is a tag struct and nothing else.
 */
export const geaNativeProtocols: ReadonlySet<string> = new Set<string>(['jsx-element@1'])

/**
 * The carrier a JSX element value is held in, added to the package's own table
 * under the protocol's own name.
 *
 * `jsx-element@1` is the one protocol this plugin installs that the package
 * states no row for, because it is not a declared TypeScript type: `JSX.Element`
 * is an empty interface the language hands back from an element expression, and
 * what it *is* on this host is an element of the engine's tree -- the same thing
 * `Element`/`GeaElement` already name. So the spelling is read off the package's
 * own `Element` row rather than written here: one authority, and a package that
 * moves its element type moves this with it.
 *
 * Without the row the protocol carries `gea::NativeHandle<gea_native_protocol_jsx_element_v1>`,
 * a tag type with no tree behind it -- C++ that compiles and renders nothing.
 */
export const geaJsxElementCarrier = (): string | null => geaNativeTypes().get('Element') ?? null

/**
 * The declared name a *component function's* return type spells the element
 * marker under, bound to the identical carrier `geaJsxElementCarrier` reads
 * off `Element` above -- a second row for the same fact, not a second fact.
 *
 * `@geastack/core`'s `index.d.ts` declares `export interface GeaJsxElement
 * {}`, has `namespace JSX { interface Element extends GeaJsxElement {} }`,
 * and types every component (`function Image(props: ImageProps):
 * GeaJsxElement`) by the base name rather than by `JSX.Element` -- two
 * distinct declarations, structurally identical and semantically the one
 * concept, but two different symbols the checker never unifies. A value-form
 * JSX element (`<Image .../>`, `plugins/gea/lower.ts`'s `lowerElement`)
 * desugars to a direct call of that function, so the CALL's result carries
 * `Image`'s own declared return type -- `GeaJsxElement`'s declaration, not
 * `JSX.Element`'s -- and `hostProtocolBindings`'s per-element census walk
 * (`semantics/host-protocols.ts`), keyed on the JSX *expression* node's own
 * type, never reaches it.
 *
 * Without this row `GeaJsxElement`'s declaration binds nothing, and
 * `derive.ts`'s ambient/empty-body branch answers a `native-record-ref` to a
 * zero-field struct -- code that compiles and renders nothing, the exact
 * failure `geaJsxElementCarrier`'s own comment already names for the sibling
 * case. Naming it here, rather than teaching the census walk to follow a
 * type's own `extends` chain, keeps the fact singular: both spellings of
 * "this is the host's element" resolve to the one carrier the package states
 * for `Element`, and a package that moves its element type moves both rows
 * with it.
 */
const geaJsxElementReturnCarrier = (): string | null => geaNativeTypes().get('Element') ?? null

/**
 * The engine class a 2D canvas context is held in.
 *
 * The second carrier the package states no row for, and for a reason worth
 * writing down: v1 never needed one. It reaches the canvas through a `gea_ir::`
 * namespace it GENERATES into each program -- `gea_ir::canvasFillRect(ctx, ...)`
 * and friends, produced by the plugin package's own `cpp-ir.ts` from a v1 IR
 * bundle -- so the context's own C++ type is a fact that block knows and the
 * shim tables never had to. This compiler has no such bundle and emits no such
 * block: it calls the engine's class directly, and so it has to know what the
 * class is.
 *
 * The name is the engine's own, from `core/packages/engine/ui/canvas_element.h`,
 * and it is the same one the package's generated block names in the direct
 * (unboxed) canvas mode `GEA_EMBEDDED_DIRECT_CANVAS_CONTEXT` selects:
 * `gea::embedded::ui::CanvasElement(node.id()).getContext2D()` yields exactly
 * this type. It belongs in the package beside the canvas member tables, and it
 * is here rather than there because adding a `nativeTypes` row changes what v1
 * does with the name too, and that is not a change this compiler's work should
 * make on v1's behalf.
 */
export const geaCanvasContextCarrier = 'gea::embedded::ui::CanvasRenderingContext2D'

/**
 * The package's table, plus the carriers it states no explicit `nativeTypes`
 * row for.
 *
 * `WebSocket`, `RTCPeerConnection` and `Audio` are the third such case, beside
 * the two below. The package states these three only in `embeddedHostClasses`
 * (a `wrapper` to construct, no `nativeTypes` entry), and this is not an
 * oversight to route around: v1's own compiler resolves a carrier the
 * identical way, `nativeTypeName(sourceName) ?? embeddedHostClassBindings[
 * sourceName]?.wrapper` (`nativeCarrierRoles`, `geatsc/src/host-shims/
 * host-runtime-protocol.ts`), because these three are `lib.dom.d.ts`
 * `interface X` + `declare var X: { new(...): X }` pairs (not `declare
 * class`), and this compiler's own `bindNativeType` (`semantics/host-
 * protocols.ts`) has exactly one lookup for any of them: the flat
 * `nativeTypes` map, keyed by the declared name. Reading the package's own
 * fallback here is the transposition this file already performs for every
 * other table, not a rule invented for these three names.
 */
export const geaProtocolCarriers = (): ReadonlyMap<string, string> => {
  const carriers = new Map<string, string>(geaNativeTypes())
  const element = geaJsxElementCarrier()
  if (element !== null) carriers.set('jsx-element', element)
  const returnElement = geaJsxElementReturnCarrier()
  if (returnElement !== null) carriers.set('GeaJsxElement', returnElement)
  // Only where the package really does claim the canvas: its member tables are
  // what say this host has one, so a package that ships none claims no carrier
  // either and a program naming `CanvasRenderingContext2D` keeps whatever the
  // language's own `lib.dom` declaration makes of it.
  if (Object.keys(geaMemberTables()?.canvasContextMethods ?? {}).length > 0) {
    carriers.set('CanvasRenderingContext2D', geaCanvasContextCarrier)
  }
  for (const [className, entry] of Object.entries(geaMemberTables()?.embeddedHostClasses ?? {})) {
    const wrapper = entry.wrapper
    if (typeof wrapper !== 'string' || wrapper.length === 0) continue
    if (!carriers.has(className)) carriers.set(className, wrapper)
    // `declare var MediaStream: { new(): MediaStream; ... }` -- an anonymous
    // constructor object type, not a named interface -- and this compiler's
    // own census gives that anonymous type's `class-constructor` shape the
    // display name `${className}Constructor` (`MediaStreamConstructor`,
    // `AudioConstructor`, ...) once it has no real declared name of its own,
    // the same way `lib.es5.d.ts`'s named `ErrorConstructor`/`DateConstructor`
    // already read here through the flat `nativeTypes` lookup. Measured
    // directly (`node scripts/corpus.mjs --only=voice-notes`): without this
    // row, `new MediaStream()`/`new MediaRecorder(...)`/`new Audio(...)`
    // refuse on `native-boundary:MediaStreamConstructor@1` even though the
    // INSTANCE carrier (`MediaStream` above) is already claimed -- the
    // constructor reference and the instance it hands back are two different
    // checker types needing two different claims.
    if (!carriers.has(`${className}Constructor`)) carriers.set(`${className}Constructor`, wrapper)
  }
  return carriers
}

/**
 * The globals this host holds one instance of and reaches by name.
 *
 * `document` is derived, not written: the package ships `nativeDocumentMethods`
 * -- a member table with no receiver list, every spelling going through
 * `gea::embedded::ui::Document::instance()` -- and a receiverless member table
 * for an object IS the statement that the object is reached by name. A package
 * that stops shipping one stops claiming this, which is the correct answer.
 *
 * Left as a value, a read of `document` emitted `extern gea::embedded::ui::Document
 * document;` (a cell the engine never defines) and copied it into a local of a
 * type whose default constructor is private.
 */
export const geaHostSingletons = (): ReadonlySet<string> => {
  const methods = geaMemberTables()?.nativeDocumentMethods
  const stated = methods !== undefined && Object.keys(methods).length > 0
  return stated ? new Set<string>(['document']) : new Set<string>()
}

/**
 * What `<>...</>` builds on this host, read from the package rather than named
 * here.
 *
 * A fragment has no tag, so there is nothing for the intrinsic recipe to pass
 * and no way to derive the answer from the syntax. gea's answer is its
 * document's own `createDocumentFragment`, which the package already ships as
 * a receiverless document method returning a `NodeHandle` -- the engine's
 * `Document::createDocumentFragment` (`engine/ui/document.h`), whose node
 * `appendChild` splices into the parent instead of nesting.
 *
 * Reading the package's row rather than writing the call here is the same rule
 * every other spelling in this file follows: a second copy of
 * `gea::embedded::ui::Document::instance().createDocumentFragment()` would be a
 * second authority over a question the package answers, free to drift from it.
 * A package that stops shipping the row leaves this `null`, and every fragment
 * is then refused by name at emission rather than rendered through a call the
 * host no longer has.
 */
export const geaElementFragment = (): string | null => {
  const emit = geaMemberTables()?.nativeDocumentMethods?.createDocumentFragment?.emit
  return typeof emit === 'string' && emit.length > 0 ? emit : null
}

/**
 * The intrinsic tags gea builds as a TEXT NODE when they hold one text run.
 *
 * Read from the package rather than restated here, for the same reason every
 * other host spelling is: `isTextNodeTag` in its `cpp-template-renderer.ts` is
 * the list v1 has always used, and a second copy in this compiler is a second
 * authority that can drift from it.
 *
 * Lowercased and de-duplicated on the way through, because the tag this
 * compiler compares against is the one the SOURCE wrote and JSX intrinsics are
 * lowercase by convention rather than by rule -- the same normalization the
 * engine's own `Document::createElement` does before it dispatches.
 */
export const geaElementTextLeafTags = (): readonly string[] => {
  const tags = new Set<string>()
  for (const tag of geaMemberTables()?.elementTextLeafTags ?? []) {
    if (typeof tag === 'string' && tag.length > 0) tags.add(tag.toLowerCase())
  }
  return [...tags]
}
