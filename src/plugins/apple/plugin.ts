import { noHostNamespaces } from '../../targets/cpp/host/host-members.js'
import type { CompilerPlugin, PluginInstance, PluginOptions } from '../model.js'
import { appleNativeTypes, writeAppleBridgeArtifacts } from './host.js'
import {
  appleHostConstructors,
  appleHostFunctions,
  appleHostFunctionsByDeclaration,
  appleNativeBases,
  appleNativeBridgeHeader,
  appleNativeConstants,
  appleNativeIncludes
} from './constructors.js'
import { appleHostMembers } from './members.js'
import { appleJsxTransform } from './jsx.js'

/**
 * Apple's native frameworks, as a plugin.
 *
 * Data only, for now, and deliberately so. `AppKit`, `Foundation` and their
 * siblings are a *host's* description of itself: nothing about `NSView` or
 * `NSTextField` is TypeScript, so a generic TypeScript-to-C++ compiler that
 * knew how to render one would be asserting something about the program's
 * environment that nothing in the program says. What it needs to be told is
 * which declared type names that host owns and what its runtime carries their
 * values in -- and that is exactly `nativeTypes`, which the Apple packages
 * already generate for v1's build.
 *
 * No producer and no lowering: unlike gea, this host adds no meaning to a
 * language form. An AppKit program is ordinary TypeScript calling methods on
 * host objects, and the core compiles it as such the moment it knows those
 * objects are host objects.
 *
 * The claim and the spelling travel together, as they must: `nativeTypes` is
 * what makes a protocol claimable and `hostMembers` is what renders a member of
 * it, and a plugin that stated one without the other would certify a program at
 * preflight that emission then refuses by name.
 */
/**
 * The `writeArtifacts` half of this plugin, present only when the build stated
 * where its Apple metadata is.
 *
 * Spread into the instance rather than defined on it so a non-Apple build has
 * no such property at all, which is the same thing `PluginInstance` says an
 * absent hook means -- rather than a function that is installed and then
 * decides at write time to do nothing, which is a second place for the
 * condition to be stated and to drift from the first.
 */
const appleMetadataPath = (options: PluginOptions): string | null => {
  const path = options.get('apple.metadata')
  return path === undefined || path.length === 0 ? null : path
}

const appleBridgeArtifacts = (options: PluginOptions): { readonly writeArtifacts?: (outDir: string) => void } => {
  const metadataPath = appleMetadataPath(options)
  if (metadataPath === null) return {}
  return { writeArtifacts: (outDir: string): void => writeAppleBridgeArtifacts(metadataPath, outDir) }
}

export const applePlugin: CompilerPlugin = {
  name: 'apple-native',
  instantiate: (options: PluginOptions): PluginInstance => ({
    producers: () => [],
    lower: () => false,
    // The bridge the emitted unit includes and the target links -- see
    // `writeAppleBridgeArtifacts`. Installed only for a build that stated
    // `apple.metadata`, which is exactly the build whose unit includes it:
    // this plugin is installed unconditionally (its tables are data, and a
    // program that names no Apple type reads none of them), so writing a
    // bridge on the strength of installation alone would drop an AppKit header
    // into every web and embedded app's output directory.
    ...appleBridgeArtifacts(options),
    // The one thing this host cannot state as data: JSX over its classes has to
    // become construction before the checker runs, because the checker cannot
    // type an element as its tag. See `jsx.ts` for what was measured.
    transformSource: appleJsxTransform,
    capabilities: {
      runtimeHelpers: new Set<string>(),
      propertyRecipes: new Set<string>(),
      // Every protocol this plugin claims is derived from the carriers in
      // `nativeTypes` (`compiler.ts` unions `${carrier}@1` in), so there is
      // nothing to state twice here. A name absent from that table is not
      // host-owned, and no protocol is claimed for it.
      nativeProtocols: new Set<string>(),
      nativeTypes: appleNativeTypes(),
      declarationModules: new Set([
        process.env.GEATSC2_APPLE_SDK ?? '@geastack/apple',
        `${process.env.GEATSC2_APPLE_SDK ?? '@geastack/apple'}/*`
      ]),
      // Apple's classes are ambient host declarations to begin with -- there
      // is no OTHER, wrongly-stated ambient name for one of them to replace,
      // which is the gap `ambientTypeRealizations` closes. See its own
      // doc comment (`plugins/model.ts`) and `webgl/plugin.ts` for the host
      // that actually needs one.
      ambientTypeRealizations: new Map(),
      hostMembers: appleHostMembers(),
      // `AppleMemberBinding` (host.ts) states no `returnType` at all -- unlike
      // gea's `GeaMemberBinding`, this plugin's member-method table carries no
      // note of a real C++ return diverging from the checker's declared one --
      // so there is nothing here for `emitCall` to force void from.
      hostMemberVoidResults: new Set<string>(),
      hostConstructors: appleHostConstructors(),
      hostFunctions: appleHostFunctions(),
      // UIKit and AppKit each declare an `installRootView`, and the flat table
      // above can hold only one. See `appleHostFunctionsByDeclaration`.
      hostFunctionsByDeclaration: appleHostFunctionsByDeclaration(),
      // The Apple packages state no namespace globals: every AppKit entry
      // point this compiler reaches is a member of a class or a free function,
      // and a class object is already carried by `nativeTypes`.
      hostNamespaces: noHostNamespaces,
      // No namespace roots claimed at all, so no per-file collision to state either.
      hostNamespaceRootsByDeclaration: new Map(),
      // No namespace roots, so nothing to state a type for either.
      hostNamespaceRootTypes: new Map(),
      // Every AppKit singleton this compiler reaches (`NSApplication.shared`)
      // is a static member of a class object, which `host-class` already
      // renders; no global name on this host is one.
      hostSingletons: new Set<string>(),
      // No singletons claimed, so no per-file collision to state either.
      hostSingletonsByDeclaration: new Map(),
      // AppKit describes its own classes and says nothing about the web
      // platform's globals; a program that also names one is describing a
      // second host, and that host is the one that should answer for it.
      absentGlobals: new Set<string>(),
      // Apple's declarations arrive through `nativeIncludes` -- one header per
      // carrier -- rather than per spelling.
      hostPreambles: new Map(),
      nativeBases: appleNativeBases(),
      nativeIncludes: appleNativeIncludes(),
      nativeConstants: appleNativeConstants(),
      // `embeddedHostConstants` (host.ts) carries no per-declaration-file
      // variant the way `embeddedHostFunctionFrameworkVariants` does for
      // functions -- the package states one ambient value per constant name,
      // not one per framework -- so there is no collision to state here.
      hostConstantsByDeclaration: new Map(),
      // AppKit asks nothing of a generated unit: the target's own `macos_main.mm`
      // defines every host function this plugin names, and the bridge is written
      // by the plugin package next to the unit rather than into it.
      // The unit is compiled against the bridge exactly when the bridge is
      // written beside it, so this reads the same option `appleBridgeArtifacts`
      // does, through the same helper: the two are one condition and a build
      // that got one without the other would either include a header nothing
      // wrote or write one nothing includes. Not derived from which carriers
      // the plan selected -- an apple-native app whose program happens to name
      // no Apple type is still an apple-native app, and the target decides that
      // by reading this line out of `generated_support.hpp`.
      generatedSupportIncludes: appleMetadataPath(options) === null ? [] : [appleNativeBridgeHeader],
      runtimeDefinitions: [],
      // AppKit/UIKit have no fragment node: a view is added to a superview, and
      // there is nothing that splices its own children into whatever it is
      // added to. So this host states none, and `<>...</>` is refused by name
      // rather than rendered as some other container that would change the
      // view hierarchy the program asked for.
      elementFragment: null,
      elementTextTags: [],
      // Nothing this host lowers calls a class member the program does not name.
      reachedMemberKeys: new Set<string>(),
      // AppKit's own state is not reactive in this sense: a control is read and
      // written through the host, and nothing in the apple package declares a
      // base whose fields re-render anything. Stating no fields is the truthful
      // answer, not a gap -- an empty table is what makes a class here keep
      // plain members.
      reactiveClassFields: new Map(),
      nativeReactiveCell: null,
      nativeReactiveCellPreamble: []
    }
  })
}
