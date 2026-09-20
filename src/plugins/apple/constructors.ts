import type {
  HostBaseTable,
  HostConstructor,
  HostConstructorTable,
  HostFunctionFileTable,
  HostFunctionTable,
  HostIncludeTable
} from '../../targets/cpp/host/host-members.js'
import { templateArity } from '../../targets/cpp/host/host-members.js'
import {
  appleBridgeMetadata,
  appleClassConstructorParameters,
  appleMemberTables,
  appleModuleMarkers,
  appleNativeTypes,
  type AppleHostClass
} from './host.js'

/**
 * How Apple's frameworks construct their own objects.
 *
 * `new NSStackView()` is not a member of anything -- it is the one expression
 * that brings the view into existence -- so it cannot be a `hostMembers` row,
 * and a compiler with no table for it refuses every program that builds a host
 * object while preflight happily certifies the same program.
 *
 * The spelling is the package's, verbatim: an ObjC `alloc`/`init` message
 * wrapped in the retain that hands the object to the C++ wrapper. Nothing here
 * assembles one -- a constructor whose selector takes arguments
 * (`NSClickGestureRecognizer(target, action)`) states its own `{argN}` slots,
 * and the arity is read back off the template for the same reason
 * `templateArity` exists: the text that renders is the only authority on how
 * many arguments it consumes.
 *
 * Keyed by carrier rather than by class name, so a host's constructor rows and
 * its member rows are filed under one name.
 */
export const appleHostConstructors = (): HostConstructorTable => {
  const shims = appleMemberTables()
  if (!shims) return new Map()
  const carriers = appleNativeTypes()
  const rows = new Map<string, HostConstructor>()
  for (const [className, entry] of Object.entries(shims.embeddedHostClasses ?? {})) {
    const carrier = carriers.get(className)
    // A class the type table does not carry has no key to file under, and
    // inventing one would claim a constructor for a protocol nothing binds.
    if (carrier === undefined) continue
    const emit = entry.construct ?? factoryConstruction(entry, className)
    // A class that states neither convention is skipped rather than guessed.
    if (emit === undefined || emit.length === 0) continue
    rows.set(carrier, { emit, arity: templateArity(emit) })
  }
  return rows
}

/**
 * The other construction convention this host states: a thunk, not a message
 * send.
 *
 * Four Metal classes are built by a C function the generated bridge defines
 * (`MTKView_init`) rather than by an inline `alloc`/`init`, and they say so
 * with `factory` instead of `construct`. The call is the host package's own
 * rule, quoted from where it states it: "`new X(args)` against an identifier
 * registered here lowers to `wrapper(static_cast<double>(factory(args)))`" --
 * the thunk hands back a retained handle as a `double`, and the wrapper struct
 * is constructed from it.
 *
 * Nothing is invented: the wrapper and the thunk are both the package's, and
 * the argument count is the class's own declared constructor parameter list, so
 * a factory taking arguments renders them and one taking none renders none. A
 * class whose parameters the metadata does not state is skipped -- a call with
 * the wrong arity would be a link error naming a symbol the program never
 * wrote.
 */
const factoryConstruction = (entry: AppleHostClass, className: string): string | undefined => {
  const factory = entry.factory
  const wrapper = entry.wrapper
  if (factory === undefined || factory.length === 0 || wrapper === undefined || wrapper.length === 0) return undefined
  const parameters = appleClassConstructorParameters(className)
  if (parameters === null) return undefined
  const args = parameters.map((_, position) => `{arg${position}}`).join(', ')
  return `${wrapper}(static_cast<double>(${factory}(${args})))`
}

/**
 * Apple's own class hierarchy, carrier to immediate base carrier.
 *
 * `NSStackView` IS an `NSView`, and the generated bridge says so in C++ by
 * giving the wrapper structs the same inheritance the ObjC classes have
 * (`struct NSStackView : gea::apple::AppKit::NSView`, written by
 * `appleNativeBridgeHeader`). So passing one where the other is declared costs
 * nothing at all at the target -- but nothing in TypeScript's structural view
 * relates two opaque handles, so without this table the backend refuses an
 * upcast the target performs implicitly.
 *
 * The base is spelled `Framework.Class` in the metadata, which is also a key of
 * `nativeTypes` -- the shim builder files every class under both its bare and
 * its qualified name -- so the carrier is looked up rather than re-derived. A
 * base the type table does not carry is dropped: an unresolvable base is a
 * chain this compiler cannot follow, and half a chain would answer "unrelated"
 * for a pair that is related, which is the same refusal with a worse reason.
 */
export const appleNativeBases = (): HostBaseTable => {
  const carriers = appleNativeTypes()
  const rows = new Map<string, string>()
  for (const entry of Object.values(appleBridgeMetadata().classes ?? {})) {
    const wrapper = entry.wrapper
    const base = entry.extends
    if (wrapper === undefined || base === undefined) continue
    const baseCarrier = carriers.get(base)
    if (baseCarrier === undefined || baseCarrier === wrapper) continue
    rows.set(wrapper, baseCarrier)
  }
  return rows
}

/**
 * The one header every Apple carrier is declared by.
 *
 * Named as a constant rather than written twice because a second reader of the
 * same spelling exists outside the carrier table: `generatedSupportIncludes`
 * (plugin.ts) states it in `generated_support.hpp`, and
 * `apple/targets/macos/build-macos.sh` -- through
 * `finalize-apple-native-output.mjs` and
 * `apple_native_cached_output_is_current` -- greps that file for exactly the
 * `#include` line built from it to decide whether an app is apple-native. Two
 * places that must agree on one string is what the constant is for; `cli-emit.ts`
 * used to hold its own copy and search the rendered C++ for it.
 *
 * `native_bridge.h` is written by the plugin package itself
 * (`writeAppleNativeBridgeRuntime`) next to the emitted unit, and it declares
 * every wrapper struct, the `objc::object`/`objc::retain` handle functions the
 * templates call, and the framework imports behind an `__OBJC__` guard. One
 * header for all of them because one generator writes all of them; the table is
 * still keyed by carrier so a program that uses no Apple type includes nothing.
 */
export const appleNativeBridgeHeader = 'gea/apple/native_bridge.h'

export const appleNativeIncludes = (): HostIncludeTable =>
  new Map([...new Set(appleNativeTypes().values())].map((carrier) => [carrier, appleNativeBridgeHeader]))

/**
 * Apple's ambient constants, to the C++ text each one is.
 *
 * `NSBoxCustom`, `NSLayoutAttributeLeading` and the hundred others are
 * Objective-C enumerators. Nothing declares a C++ global of those names, so a
 * program that reads one and gets an `extern double` does not link -- and in
 * Objective-C++ it does not even compile, because the enumerator is already a
 * name at that scope and the declaration is a redefinition as a different kind
 * of symbol. The host states the value instead, and the read renders it.
 */
export const appleNativeConstants = (): ReadonlyMap<string, string> => {
  const shims = appleMemberTables()
  if (!shims) return new Map()
  const rows = new Map<string, string>()
  for (const [name, entry] of Object.entries(shims.embeddedHostConstants ?? {})) {
    const emit = entry.emit
    if (emit === undefined || emit.length === 0) continue
    rows.set(name, emit)
  }
  return rows
}

/**
 * Apple's ambient free functions, to the C++ function each one is.
 *
 * `installRootViewController(vc)`, `CGRectMake(x, y, w, h)`,
 * `dispatchAsyncMain(f)` -- names a program writes bare, that resolve to
 * functions the target's own runtime defines (`macos_main.mm` defines the
 * first; CoreGraphics defines the second). None of them is a member of
 * anything, so `hostMembers` cannot state one, and none of them constructs a
 * host object, so `hostConstructors` cannot either.
 *
 * Without this table the backend has one shape left for a value that is
 * called -- a callable carrier -- and so it declares
 * `extern gea::CallableObject<void(NSViewController)> installRootViewController;`
 * and invokes `.call(...)` on it. That is not a near miss: the host exports a
 * FUNCTION, this declares a global VARIABLE of the same name, and the program
 * compiles and then fails to link against the very runtime that implements it.
 *
 * The spelling is the package's own `embeddedHostFunctions`, verbatim -- the
 * same table v1's build has consumed all along, and the same one the bridge
 * metadata records as each function's `thunk`.
 */
export const appleHostFunctions = (): HostFunctionTable => {
  const shims = appleMemberTables()
  if (!shims) return new Map()
  const rows = new Map<string, string>()
  for (const [name, emit] of Object.entries(shims.embeddedHostFunctions ?? {})) {
    if (typeof emit !== 'string' || emit.length === 0) continue
    rows.set(name, emit)
  }
  return rows
}

/**
 * The free functions whose spelling depends on which declaration the program
 * read, keyed by the file that declaration lives in.
 *
 * `installRootView` is the whole of the case: UIKit declares one and AppKit
 * declares another, they are different functions with different parameter types
 * and different thunks, and they share a bare name. A table keyed by name alone
 * cannot hold both, so the flat one holds whichever the package wrote last --
 * and an iOS program calling UIKit's got AppKit's spelling, which is not a
 * near miss but a call into a framework the program never imported.
 *
 * The name a program wrote is not the coordinate; the declaration it resolved to
 * is. `appleModuleMarkers` says which marker each declaration file belongs to
 * and the package says which spelling each marker names, so this is those two
 * facts joined -- nothing about frameworks is decided here.
 */
export const appleHostFunctionsByDeclaration = (): HostFunctionFileTable => {
  const shims = appleMemberTables()
  if (!shims) return new Map()
  const variants = shims.embeddedHostFunctionFrameworkVariants ?? {}
  const rows = new Map<string, Map<string, string>>()
  for (const [file, marker] of appleModuleMarkers()) {
    const spellings = new Map<string, string>()
    for (const [name, byMarker] of Object.entries(variants)) {
      const emit = byMarker[marker]
      if (typeof emit !== 'string' || emit.length === 0) continue
      spellings.set(name, emit)
    }
    if (spellings.size > 0) rows.set(file, spellings)
  }
  return rows
}
