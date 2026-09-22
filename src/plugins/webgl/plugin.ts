import { noHostNamespaces } from '../../targets/cpp/host/host-members.js'
import type { CompilerPlugin, PluginInstance } from '../model.js'
import {
  webglAbsentGlobals,
  webglAmbientTypeRealizations,
  webglHostFunctions,
  webglHostArraySnapshotFunctions,
  webglHostNativeArrayFunctions,
  webglHostPreambles,
  webglSourceTransform
} from './host.js'

/**
 * ANGLE's WebGL bridge, as a plugin.
 *
 * The third host in this build, and the smallest by a long way: it states its
 * free functions and nothing else. That is not a stub. This host's surface
 * really is 127 ambient functions -- `threeWebGLCreateBuffer`,
 * `threeWebGLDrawElements`, `threeWebGLTexImage2D` -- declared in the package's
 * `nativeWebGLHost.ts` and defined in its `angle_webgl_host.mm`. The
 * `WebGL2RenderingContext` a three.js program actually holds is a TypeScript
 * class in that same package, and this compiler compiles it as one.
 *
 * So there is no `nativeTypes` here, and its absence is a statement rather than
 * a gap. `nativeTypes` says "this declared name is a host object, and here is
 * the C++ type its values are carried in"; `NativeWebGL2RenderingContext` has
 * no such type, because the ANGLE context is a process global and the class is
 * a facade over free calls. Naming a carrier for it would mint an identity the
 * runtime does not have. No constructors either, for the same reason -- `new
 * NativeWebGLCanvas()` constructs an ordinary object -- and no members, no
 * bases, no includes, no constants.
 *
 * `ambientTypeRealizations` is the one non-empty table below, and it exists
 * for a fact `nativeTypes` cannot state: three's own `WebGLRenderer` and its
 * `@types/three` declarations describe the context this program holds as an
 * AMBIENT BROWSER interface (`WebGLRenderingContext`, `WebGL2RenderingContext`)
 * -- structurally unrelated to `NativeWebGL2RenderingContext`, which is why a
 * `renderbufferStorageMultisample`/`blitFramebuffer`/`invalidateFramebuffer`
 * call, or a `DRAW_FRAMEBUFFER`/`READ_FRAMEBUFFER` constant read -- real
 * WebGL2 members `WebGLRenderingContext` (WebGL1) lacks entirely -- typed
 * `any` and boxed every one of the ~230 boxed carriers rooted at
 * `WebGLTextures.js`'s own `_gl` parameter. The fix is not a carrier this
 * layer invents; it is the ambient name meaning the class the value already
 * is. See `webglAmbientTypeRealizations` (`host.ts`).
 *
 * No producer and no lowering: like Apple's, this host adds no meaning to a
 * language form. A three.js program is ordinary TypeScript calling methods on
 * ordinary classes; the only thing the core cannot know is that seven-score
 * bare names are C++ functions somebody else links in.
 */
export const webglPlugin: CompilerPlugin = {
  name: 'native-webgl-angle-host',
  instantiate: (): PluginInstance => ({
    producers: () => [],
    transformSource: webglSourceTransform,
    lower: () => false,
    capabilities: {
      runtimeHelpers: new Set<string>(),
      propertyRecipes: new Set<string>(),
      // Protocols are derived from the carriers in `nativeTypes`, and this host
      // states none -- see the class-is-not-a-host-object note above.
      nativeProtocols: new Set<string>(),
      nativeTypes: new Map(),
      ambientTypeRealizations: webglAmbientTypeRealizations(),
      hostMembers: new Map(),
      hostMemberVoidResults: new Set<string>(),
      hostConstructors: new Map(),
      hostFunctions: webglHostFunctions(),
      hostArraySnapshotFunctions: webglHostArraySnapshotFunctions(),
      hostNativeArrayFunctions: webglHostNativeArrayFunctions(),
      // One name, one function: nothing in this host is declared twice.
      hostFunctionsByDeclaration: new Map(),
      hostNamespaces: noHostNamespaces,
      hostNamespaceRootsByDeclaration: new Map(),
      hostNamespaceRootTypes: new Map(),
      hostSingletons: new Set<string>(),
      hostSingletonsByDeclaration: new Map(),
      // Read at instantiate, never at import: the package's statement is the
      // one `plugins/load.ts` adopted from `--plugin`, and adoption happens
      // after this module is loaded.
      absentGlobals: webglAbsentGlobals(),
      hostPreambles: webglHostPreambles(),
      nativeBases: new Map(),
      // Declarations arrive per spelling through `hostPreambles`, not per
      // carrier -- this host has no carriers to key a header by.
      nativeIncludes: new Map(),
      nativeConstants: new Map(),
      hostConstantsByDeclaration: new Map(),
      // The WebGL constants a program reads (`gl.RGBA`, `gl.TRIANGLES`) are
      // `readonly` fields of the TypeScript class, initialized to their
      // numeric literals in the package's own source. They are the program's
      // own data, and this compiler reads them as such.
      // WebGL's declarations reach a unit through `nativeIncludes`, per
      // carrier the plan actually selected. Nothing about this host is true of
      // a unit that names none of its types, so the support header states
      // nothing on its behalf.
      generatedSupportIncludes: [],
      runtimeDefinitions: [],
      elementFragment: null,
      elementTextTags: [],
      // Nothing this host lowers calls a class member the program does not name.
      reachedMemberKeys: new Set<string>(),
      // three's programs take the host mutation census's `*` wildcard through
      // this host, under which no Object-prototype obligation is ever
      // discharged; see `PluginCapabilities.refusesObjectPrototypeAbsenceProofs`.
      refusesObjectPrototypeAbsenceProofs: true,
      reactiveClassFields: new Map(),
      nativeReactiveCell: null,
      nativeReactiveCellPreamble: []
    }
  })
}
