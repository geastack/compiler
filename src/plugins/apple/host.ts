import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'

/**
 * The two fields of the Apple packages this compiler reads, as this compiler
 * needs them.
 *
 * Deliberately NOT `import type { HostShimDefinitions } from
 * '@geastack/geatsc-plugin-apple-native'`: a static type import would make the
 * Apple packages a hard build dependency of the compiler, and this load is a
 * `require` in a `try` precisely so they are not one. The same reasoning
 * `plugins/gea/host.ts` states for its own slice -- restating the shape of the
 * one field read is not restating the data.
 */
export interface AppleMemberBinding {
  readonly emit?: string
  /** A C++ free function the generated bridge declares, taking the receiver first -- see `externTemplate`. */
  readonly extern?: string
  readonly receiverTypes?: readonly string[]
}

/**
 * A member of a *class object* -- `NSColor.clearColor`, `ObjCTarget.create`.
 *
 * Stated by class name rather than by receiver type, and with no receiver slot
 * in the template at all: the spelling names the class outright
 * (`[::NSColor clearColor]`), because the receiver of a class method is the
 * class, which no value carries. `returnType` is the package's own note about
 * what the spelling yields; this compiler reads the carrier from the checker
 * instead and so does not consume it.
 */
export interface AppleNamespaceMember {
  readonly emit?: string
  readonly returnType?: string
}

/** What constructing one of a host's classes costs, as the host spells it. */
export interface AppleHostClass {
  readonly wrapper?: string
  /** The whole `new C(...)` expression, `{argN}`-slotted; absent when the class states no constructor. */
  readonly construct?: string
  /** A thunk name, for a class whose construction is not an ObjC message send. */
  readonly factory?: string
}

export interface AppleHostShimSlice {
  readonly nativeTypes?: Readonly<Record<string, string>>
  readonly nativeMemberMethods?: Readonly<Record<string, readonly AppleMemberBinding[]>>
  readonly nativeMemberPropertyGetters?: Readonly<Record<string, readonly AppleMemberBinding[]>>
  readonly nativeMemberPropertySetters?: Readonly<Record<string, readonly AppleMemberBinding[]>>
  readonly nativeNamespaceMethods?: Readonly<Record<string, Readonly<Record<string, AppleNamespaceMember>>>>
  readonly embeddedHostClasses?: Readonly<Record<string, AppleHostClass>>
  readonly embeddedHostConstants?: Readonly<Record<string, { readonly emit?: string; readonly type?: string }>>
  readonly embeddedHostFunctions?: Readonly<Record<string, string>>
  /**
   * `bareName -> markerName -> spelling`, for the free functions whose bare name
   * more than one framework declares.
   *
   * `installRootView` is UIKit's and AppKit's alike, so the flat map above keeps
   * whichever framework the package happened to process last and the other one
   * is simply gone. This table is the package's own answer to that: every
   * colliding name is restated once per framework, keyed by the marker the
   * framework's runtime module calls. Which marker belongs to which module is a
   * fact the package states too -- see `appleModuleMarkers`.
   */
  readonly embeddedHostFunctionFrameworkVariants?: Readonly<Record<string, Readonly<Record<string, string>>>>
}

const require_ = createRequire(import.meta.url)

/**
 * `nativeTypes`, narrowed at the boundary.
 *
 * Anything that is not a string-to-string record is refused whole rather than
 * partially admitted, exactly as the gea seam refuses its own: a table half of
 * which is a carrier and half of which is something else would put this
 * compiler back in the business of guessing.
 */
const nativeTypesOf = (value: unknown): ReadonlyMap<string, string> | null => {
  if (value === undefined) return new Map()
  if (typeof value !== 'object' || value === null) return null
  const table = new Map<string, string>()
  for (const [name, carrier] of Object.entries(value)) {
    if (typeof carrier !== 'string' || carrier.length === 0) return null
    table.set(name, carrier)
  }
  return table
}

/**
 * One class in the bridge metadata, as this compiler needs it.
 *
 * The metadata is the SDK package's own description of the platform, one step
 * upstream of the shim tables: `createAppleHostShims` reads it to produce the
 * spellings, and it carries one fact the shims do not keep -- which class each
 * class extends. `extends` is spelled `Framework.Class`, which is also a key of
 * `nativeTypes`, so a base resolves to a carrier through the table already read
 * rather than by re-deriving the C++ qualification here.
 */
export interface AppleClassMetadata {
  readonly name?: string
  readonly wrapper?: string
  readonly extends?: string
  readonly methods?: Readonly<Record<string, AppleMethodMetadata>>
  /**
   * How the class is built, when it states one. Read for its parameter list
   * alone: the shim tables downstream keep the thunk's NAME but not how many
   * arguments it takes, and a thunk called with the wrong count is a link error
   * naming a symbol the program never wrote.
   */
  readonly constructor?: AppleMethodMetadata
}

/**
 * One method's declared parameters, as the SDK states them.
 *
 * Read for one question only: what a parameter an attribute cannot spell would
 * have to be. `{ kind: 'primitive', name: 'number' }` is a control state, an
 * animation flag is `boolean`, and a parameter of any other kind has no value
 * this compiler could supply -- see `plugins/apple/jsx.ts`. The shim tables one
 * step downstream keep only the rendered template and its arity, so this is the
 * nearest authority that still knows what each slot holds.
 */
export interface AppleMethodParameter {
  readonly type?: { readonly kind?: string; readonly name?: string }
}

export interface AppleMethodMetadata {
  readonly parameters?: readonly AppleMethodParameter[]
}

export interface AppleBridgeMetadataSlice {
  readonly classes?: Readonly<Record<string, AppleClassMetadata>>
}

/** A module that failed to resolve because it is not installed, as opposed to one that failed to load. */
const isAbsent = (error: unknown): boolean => (error as { code?: string }).code === 'MODULE_NOT_FOUND'

let loaded: AppleHostShimSlice | null | undefined
let loadedMetadata: AppleBridgeMetadataSlice | null = null

/**
 * The Apple host type table, from the packages that own it.
 *
 * Two packages, because the data is split the way the platform is:
 * `@geastack/apple` holds the SDK definition (`appleSdkFixture`) and the
 * function that turns it into bridge metadata, and
 * `@geastack/geatsc-plugin-apple-native` turns that metadata into the shim
 * definitions a compiler consumes. Neither half is restated here -- the
 * hundreds of AppKit/Foundation rows stay in the packages that generate them,
 * which is the whole point.
 *
 * No platform filter is applied. v1's build script strips the off-platform
 * framework's class MEMBERS (UIKit's, for a macOS build) while keeping the
 * class shells, so that a member name shared by `UIView` and `NSView` resolves
 * to the on-platform one. That filter exists to disambiguate the *member*
 * tables; this compiler reads only `nativeTypes`, whose entry for a shell class
 * is the same either way. Restating the filter here to change nothing would be
 * a second copy of a rule that lives in v1's build script, and it would go
 * stale the first time that rule changed. When the member tables are read, the
 * platform will have to be an input to this function rather than a rule copied
 * into it.
 *
 * `require` rather than `import()`, and the same two-failure distinction the
 * gea seam draws: a package simply not installed is a configuration, and the
 * table is empty. A package that IS installed but does not answer -- a load
 * error, a missing export, a table that is not string-to-string -- is a defect,
 * and it throws. Swallowing the second returns an empty table indistinguishable
 * from the first, and every Apple program then loses every carrier at once and
 * is refused for obligations spelled in names (`NSView@1`) that nothing was
 * ever going to claim.
 */
const appleHostShims = (): AppleHostShimSlice | null => {
  if (loaded !== undefined) return loaded
  const sdkSpecifier = process.env.GEATSC2_APPLE_SDK ?? '@geastack/apple'
  const pluginSpecifier = process.env.GEATSC2_APPLE_PLUGIN ?? '@geastack/geatsc-plugin-apple-native'
  let sdk: unknown
  let plugin: unknown
  try {
    sdk = require_(sdkSpecifier)
    plugin = require_(pluginSpecifier)
  } catch (error) {
    const requested = process.env.GEATSC2_APPLE_SDK !== undefined || process.env.GEATSC2_APPLE_PLUGIN !== undefined
    if (!isAbsent(error) || requested) {
      throw new Error(`apple host shims failed to load from '${sdkSpecifier}' + '${pluginSpecifier}': ${String(error)}`)
    }
    loaded = null
    return null
  }
  const fixture = (sdk as { appleSdkFixture?: unknown }).appleSdkFixture
  const metadataOf = (sdk as { generateAppleBridgeMetadata?: (definition: unknown) => unknown }).generateAppleBridgeMetadata
  const shimsOf = (plugin as { createAppleHostShims?: (metadata: unknown) => AppleHostShimSlice }).createAppleHostShims
  if (fixture === undefined || typeof metadataOf !== 'function') {
    throw new Error(`'${sdkSpecifier}' exports no appleSdkFixture/generateAppleBridgeMetadata pair`)
  }
  if (typeof shimsOf !== 'function') throw new Error(`'${pluginSpecifier}' exports no createAppleHostShims function`)
  const metadata = metadataOf(fixture)
  const shims = shimsOf(metadata)
  if (nativeTypesOf(shims.nativeTypes) === null) {
    throw new Error(`'${pluginSpecifier}' provided a nativeTypes table that is not string-to-string`)
  }
  loaded = shims
  loadedMetadata = (typeof metadata === 'object' && metadata !== null ? metadata : {}) as AppleBridgeMetadataSlice
  return shims
}

/** The declared type names Apple's frameworks own, to the C++ wrapper their runtime carries values of each in. */
export const appleNativeTypes = (): ReadonlyMap<string, string> => nativeTypesOf(appleHostShims()?.nativeTypes) ?? new Map()

/** The member tables, exactly as the plugin package states them; `null` when the packages are not installed. */
export const appleMemberTables = (): AppleHostShimSlice | null => appleHostShims()

/** The SDK's own platform description, one step upstream of the shim tables; empty when the packages are not installed. */
export const appleBridgeMetadata = (): AppleBridgeMetadataSlice => {
  appleHostShims()
  return loadedMetadata ?? {}
}

/**
 * One entry of a package's `exports` map, as this compiler reads it.
 *
 * Two fields, because the pairing is the whole point: `types` is the file a
 * TypeScript program's declaration resolves to, and `import` is the module that
 * implements the same subpath. A framework's identity is stated in the second
 * and observed in the first, and nothing else here relates them.
 */
interface PackageExportEntry {
  readonly types?: unknown
  readonly import?: unknown
}

let loadedMarkers: ReadonlyMap<string, string> | null = null

/** The directory of the package a resolved entry point belongs to, by its own manifest. */
const packageRootOf = (entry: string, name: string): string | null => {
  let directory = dirname(entry)
  for (;;) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(resolvePath(directory, 'package.json'), 'utf8'))
      if (typeof manifest === 'object' && manifest !== null && (manifest as { name?: unknown }).name === name) return directory
    } catch {
      // Not this directory's manifest, or none here at all. Keep walking up.
    }
    const parent = dirname(directory)
    if (parent === directory) return null
    directory = parent
  }
}

/**
 * Each declaration file of the Apple SDK package, to the native-only marker the
 * module implementing that same subpath calls.
 *
 * This is what makes a per-framework variant selectable. v1 never has to ask:
 * it compiles the *bundled* program, where the placeholder body has been inlined
 * and the marker call is right there in the source. v2 compiles the unbundled
 * program against the package's `.d.ts`, where the body is not present at all --
 * so the same fact has to be read from the package instead of from the program.
 *
 * And it is read, not assumed. The `exports` map pairs each subpath's `types`
 * with its `import`; the implementation module is opened and asked which of the
 * markers the variants table actually uses appear in it. No marker spelling is
 * constructed here and no file-naming convention is relied on: a module that
 * mentions exactly one marker identifies itself, a module that mentions none
 * (every framework whose functions collide with nobody) contributes nothing, and
 * a module that mentions more than one is ambiguous and contributes nothing
 * either. Every one of those three is the same outcome as before this existed --
 * the flat table's answer -- so the failure mode is the old behaviour, never a
 * wrong framework.
 */
export const appleModuleMarkers = (): ReadonlyMap<string, string> => {
  if (loadedMarkers !== null) return loadedMarkers
  const markers = new Map<string, string>()
  loadedMarkers = markers
  const shims = appleHostShims()
  if (!shims) return markers
  const used = new Set<string>()
  for (const variants of Object.values(shims.embeddedHostFunctionFrameworkVariants ?? {})) {
    for (const marker of Object.keys(variants)) used.add(marker)
  }
  if (used.size === 0) return markers
  const specifier = process.env.GEATSC2_APPLE_SDK ?? '@geastack/apple'
  const root = packageRootOf(require_.resolve(specifier), specifier)
  if (root === null) return markers
  const manifest: unknown = JSON.parse(readFileSync(resolvePath(root, 'package.json'), 'utf8'))
  const exports_ = (manifest as { exports?: unknown }).exports
  if (typeof exports_ !== 'object' || exports_ === null) return markers
  for (const entry of Object.values(exports_) as readonly PackageExportEntry[]) {
    if (typeof entry !== 'object' || entry === null) continue
    if (typeof entry.types !== 'string' || typeof entry.import !== 'string') continue
    let implementation: string
    try {
      implementation = readFileSync(resolvePath(root, entry.import), 'utf8')
    } catch {
      continue
    }
    const mentioned = [...used].filter((marker) => implementation.includes(marker))
    if (mentioned.length !== 1) continue
    markers.set(resolvePath(root, entry.types), mentioned[0] as string)
  }
  return markers
}

/**
 * The parameters a class declares for its own constructor, or `null` when the
 * metadata states none.
 *
 * Keyed by the class's own name, which is how `embeddedHostClasses` is keyed --
 * the metadata is keyed by `Framework.Class`, so the two are joined on the
 * `name` each metadata row carries rather than by re-deriving either spelling.
 */
export const appleClassConstructorParameters = (className: string): readonly AppleMethodParameter[] | null => {
  for (const entry of Object.values(appleBridgeMetadata().classes ?? {})) {
    if (entry.name !== className) continue
    const declared = entry.constructor
    // `constructor` is inherited from `Object.prototype` on any plain object,
    // so a class that states none answers with a FUNCTION here rather than
    // with `undefined`. Own-property, or nothing.
    if (!Object.prototype.hasOwnProperty.call(entry, 'constructor') || typeof declared !== 'object' || declared === null) return null
    return declared.parameters ?? []
  }
  return null
}

/**
 * Writes `gea/apple/native_bridge.{h,mm}` next to the emitted unit, by driving
 * the Apple plugin package's own generator.
 *
 * The unit this compiler emits opens with `#include "gea/apple/native_bridge.h"`
 * and the target links `native_bridge.mm`, so both files are part of what a
 * generated Apple program is compiled against -- the same kind of fact as the
 * runtime header `cli-emit.ts` copies in, owned by a host rather than by the
 * core. Nothing else in the tree writes them: v1's pipeline gets them from
 * `createCppBackend(...).transformGeneratedSources(...)`, a hook this compiler's
 * plugin seam does not have and should not grow, because the thing that hook
 * exists to do to v1's SOURCES is not wanted here (see below).
 *
 * Measured, and this is why it is a defect worth a memory: with no one writing
 * them, a build succeeded only where a *stale* bridge from a v1 build happened
 * to still be sitting in the gitignored output directory. Moving it aside made
 * the macOS build fail immediately, and the five iOS apps -- which had no
 * leftover -- all stopped at `'gea/apple/native_bridge.h' file not found`.
 *
 * The metadata is the one the *pipeline* passed, not the fixture-derived table
 * `appleHostShims` reads above, and the difference is load-bearing: v1's build
 * script filters the SDK fixture by platform before writing the file, so a
 * macOS build's metadata declares `AppKit.installRootView` and an iOS build's
 * declares `UIKit.installRootView`. Generating the bridge from the unfiltered
 * fixture would declare both, and the header would name five AppKit free
 * functions no iOS target defines.
 *
 * Only the file-writing half of v1's hook is driven. The other half inserts a
 * preamble of `gea::apple::bridge` helpers into `generated_support.hpp`, for
 * calls v1's emitter makes; this compiler's units reference no such helper
 * (measured: zero occurrences of `gea::apple::bridge::` across every emitted
 * Apple unit), so an empty source list is handed over and the transformed
 * result is discarded rather than a preamble being inserted for nothing.
 */
export const writeAppleBridgeArtifacts = (metadataPath: string, outDir: string): void => {
  const pluginSpecifier = process.env.GEATSC2_APPLE_PLUGIN ?? '@geastack/geatsc-plugin-apple-native'
  const plugin = require_(pluginSpecifier) as {
    appleNativePlugin?: (options: { readonly metadata: unknown }) => {
      createCppBackend?: (context: {
        readonly outDir: string
      }) => { transformGeneratedSources?: (sources: readonly never[]) => unknown } | undefined
    }
  }
  const factory = plugin.appleNativePlugin
  if (typeof factory !== 'function') throw new Error(`'${pluginSpecifier}' exports no appleNativePlugin function`)
  // Read here rather than through the package's own `loadMetadata`, which is
  // private to it and resolves relative to the compiled ENTRY -- a path this
  // seam does not have. The pipeline states an absolute path
  // (`build-gea-vite-geatsc.mjs` resolves `--out-dir` before joining), so
  // resolving against the working directory is the same answer for every real
  // build and a defined one otherwise.
  const metadata: unknown = JSON.parse(readFileSync(resolvePath(metadataPath), 'utf8'))
  const backend = factory({ metadata }).createCppBackend?.({ outDir })
  if (backend?.transformGeneratedSources === undefined) {
    throw new Error(`'${pluginSpecifier}' produced no C++ backend for the metadata at '${metadataPath}'`)
  }
  backend.transformGeneratedSources([])
}
