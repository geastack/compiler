import { createRequire } from 'node:module'
import type { AmbientTypeRealization } from '../../semantics/ambient-type-realization-transform.js'
import type { PluginSourceFile } from '../model.js'

const require_ = createRequire(import.meta.url)

/**
 * What the `@geastack/native-webgl-angle` package says about its own host.
 *
 * The package ships the ANGLE bridge, its Objective-C++ implementation and this
 * table together, exactly as gea's does; loading it is what keeps the compiler
 * from holding a second, drifting copy of a list that already exists. See
 * `plugins/gea/host.ts` for the same load and the same two-failures rule.
 */
interface WebGLHostShims {
  /** Additional globals this package explicitly does not install. */
  readonly absentGlobals?: readonly string[]
  /** The ambient name a program writes, to the C++ free function it is. */
  readonly embeddedHostFunctions?: Readonly<Record<string, string>>
  /** Keyed by that C++ spelling: what a unit must declare before naming it. */
  readonly hostArraySnapshotFunctions?: readonly string[]
  readonly hostNativeArrayFunctions?: readonly string[]
  readonly hostExternDeclarations?: Readonly<Record<string, readonly string[]>>
  /**
   * Ambient browser type names three's own JSDoc (and `@types/three`'s
   * mirrored declarations) states for a WebGL context, to the concrete
   * class this package's own runtime actually hands a program -- see
   * `plugins/model.ts`'s `ambientTypeRealizations`.
   */
  readonly ambientTypeRealizations?: Readonly<Record<string, { readonly type: string; readonly importedFrom: string }>>
  /** Package-owned compatibility rewrites applied before the checker parses a source file. */
  readonly transformSource?: (input: PluginSourceFile) => string | null
}

let loaded: WebGLHostShims | null | undefined

/**
 * The package's own statement, loaded once.
 *
 * `require` rather than `import()`, and the same two failures told apart, for
 * the reasons `geaNativeTypes` states in full: not installed is a
 * configuration and answers empty, while a package that IS installed and does
 * not answer is a defect and throws. `GEATSC2_WEBGL_PLUGIN` overrides the
 * specifier with an explicit path, and naming one that does not resolve is a
 * wrong path rather than an absent package -- so it throws too.
 */
const shims = (): WebGLHostShims | null => {
  if (loaded !== undefined) return loaded
  const requested = process.env.GEATSC2_WEBGL_PLUGIN
  const specifier = requested ?? '@geastack/native-webgl-angle/geatsc-plugin'
  let module_: unknown
  try {
    module_ = require_(specifier)
  } catch (error) {
    const absent = (error as { code?: string }).code === 'MODULE_NOT_FOUND'
    if (!absent || requested !== undefined) {
      throw new Error(`native-webgl-angle host shims failed to load from '${specifier}': ${String(error)}`)
    }
    loaded = null
    return null
  }
  const plugin = (module_ as { default?: { configure?: () => { hostShims?: WebGLHostShims } } }).default
  if (typeof plugin?.configure !== 'function') {
    throw new Error(`native-webgl-angle plugin at '${specifier}' exports no default plugin with a configure()`)
  }
  const configured = plugin.configure().hostShims
  if (!configured) {
    throw new Error(`native-webgl-angle plugin at '${specifier}' configured no hostShims`)
  }
  loaded = configured
  return configured
}

/**
 * The ambient free functions this host defines, to the C++ each is.
 *
 * This is the WHOLE of what the plugin has to state, and the reason it is so
 * small is the point. `NativeWebGL2RenderingContext` and `NativeWebGLCanvas`
 * are not host types at all -- they are ordinary TypeScript classes, shipped as
 * source in the package's own `src/nativeWebGL.ts`, whose methods this compiler
 * compiles natively like any other class. What crosses into the host is one
 * layer below them: `threeWebGLCreateBuffer()` and its 126 siblings, ambient
 * names declared in `nativeWebGLHost.ts` and defined in `angle_webgl_host.mm`.
 *
 * v1 states much more -- 88 `runtimeMemberCalls` and 333 `runtimeMemberReads`
 * that recognize a call ON the context object and emit the host call directly,
 * erasing the class. That is an optimization for a compiler that could not
 * compile the class; it is not the meaning of the program, and restating it
 * here would put 421 hand-written rows between this compiler and a class it can
 * already read. If a direct-call fast path is ever worth its cost, it is worth
 * it as a measurement, not as the only way the program compiles.
 */
export const webglHostFunctions = (): ReadonlyMap<string, string> => {
  const rows = new Map<string, string>()
  for (const [name, emit] of Object.entries(shims()?.embeddedHostFunctions ?? {})) {
    if (typeof emit === 'string' && emit.length > 0) rows.set(name, emit)
  }
  return rows
}

/**
 * What a unit must declare before it may name one of those spellings.
 *
 * Keyed by the spelling, which is how the package already states it: a program
 * that calls two of these carries two `extern "C"` lines and not 127.
 */
export const webglHostPreambles = (): ReadonlyMap<string, readonly string[]> => {
  const rows = new Map<string, readonly string[]>()
  for (const [emit, declarations] of Object.entries(shims()?.hostExternDeclarations ?? {})) {
    const lines = (declarations ?? []).filter((line): line is string => typeof line === 'string' && line.length > 0)
    if (lines.length > 0) rows.set(emit, lines)
  }
  return rows
}

/** Source compatibility owned by the native WebGL package itself. */
export const webglSourceTransform = (input: PluginSourceFile): string | null => shims()?.transformSource?.(input) ?? null

/**
 * The browser globals a native ANGLE context does not provide.
 *
 * Scoped deliberately to this host's own neighbourhood -- the image, canvas and
 * video element types a WebGL renderer reaches for when it uploads a texture.
 * That is the surface this plugin replaces: `NativeWebGLCanvas` is the canvas,
 * and there is no DOM behind it.
 *
 * Every name here is one three.js itself guards with `typeof X !== 'undefined'`,
 * because three is written to run where they may not exist. Stating the absence
 * is what makes that guard mean what it says; without it the guard folds to
 * `true`, three takes a branch that reads `image.displayWidth` off something
 * that is not a `VideoFrame`, and the unit emits an `extern` for a symbol no
 * object file defines.
 *
 * Names deliberately NOT here, and why -- absence is a CLAIM about the target,
 * so a name goes in only when this host is sure:
 *
 * - `performance`, `URL`, `Blob`, `fetch` and the network types: nothing about
 *   an ANGLE context says whether the target implements them, and `three` calls
 *   `performance.now()` unguarded. That is a different host's answer.
 * - `WebGL2RenderingContext`: its constructor identity needs a native binding
 *   for programs that use it to detect WebGL 2. The WebGL 1 constructor is
 *   absent: this host only creates NativeWebGL2RenderingContext. In three's
 *   WebGL 1 rejection guard, absence correctly skips the rejected path.
 * - `self`, `postMessage`, `importScripts`: worker globals, and whether this
 *   target has workers is not a fact about its GL context.
 */
export const webglAbsentGlobals: ReadonlySet<string> = new Set<string>([
  ...(shims()?.absentGlobals ?? []),
  'WebGLRenderingContext',
  'ImageData',
  'ImageBitmap',
  'VideoFrame',
  'OffscreenCanvas',
  'HTMLCanvasElement',
  'HTMLImageElement',
  'HTMLVideoElement',
  'createImageBitmap',
  // WebXR. A native ANGLE context can no more start an XR session than it can
  // decode an `ImageBitmap`, and three says so in its own source the same way:
  // `const supportsGlBinding = typeof XRWebGLBinding !== 'undefined'`
  // (`renderers/webxr/WebXRManager.js`, `renderers/common/XRManager.js`).
  //
  // These arrive from `@types/webxr` rather than `lib.dom.d.ts`, which is why
  // `absent-globals.ts` asks whether a declaration is the PLATFORM's rather
  // than whether TypeScript ships it -- see `platformDeclarationTest`. Both are
  // `declare class`, the form that made a `declare var`-only value test unable
  // to deny a single WebXR name.
  'XRWebGLBinding',
  'XRWebGLLayer'
])

/**
 * The ambient WebGL context names three's own source (and `@types/three`'s
 * mirrored declarations) states, to the concrete class
 * `@geastack/native-webgl-angle` actually hands a program.
 *
 * Both `WebGLRenderingContext` (`@types/three`'s stale declared type for
 * three's internal `_gl` parameters -- see `WebGLRenderer`'s own comment in
 * a three.js app's entry module) and `WebGL2RenderingContext` (what
 * three's own JSDoc states for `WebGLRenderer~Options.context`) name it: two
 * ambient interfaces, one real replacement, so both keys route to the same
 * `NativeWebGL2RenderingContext`. A package with nothing to state here
 * answers an empty map, and every ambient name keeps whatever the census
 * already does with it -- exactly `nativeTypes`'s own convention.
 */
export const webglAmbientTypeRealizations = (): ReadonlyMap<string, AmbientTypeRealization> => {
  const rows = new Map<string, AmbientTypeRealization>()
  for (const [name, realization] of Object.entries(shims()?.ambientTypeRealizations ?? {})) {
    if (realization && typeof realization.type === 'string' && typeof realization.importedFrom === 'string') {
      rows.set(name, { type: realization.type, importedFrom: realization.importedFrom })
    }
  }
  return rows
}

export const webglHostArraySnapshotFunctions = (): ReadonlySet<string> => new Set(shims()?.hostArraySnapshotFunctions ?? [])

export const webglHostNativeArrayFunctions = (): ReadonlySet<string> => new Set(shims()?.hostNativeArrayFunctions ?? [])
