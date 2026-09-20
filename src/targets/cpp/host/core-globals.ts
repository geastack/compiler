/**
 * The ECMAScript/WHATWG GLOBAL FUNCTIONS this backend implements itself, on
 * the STANDARD-LIBRARY gate.
 *
 * ## Its sibling, and how the two divide
 *
 * `host-members.ts` has `coreHostFunctions`/`coreHostConstants`, which answer
 * the same shape of question for `parseInt`/`parseFloat`/`isNaN`/`isFinite`
 * and for `NaN`/`Infinity`. They are NOT this table: they are unioned into the
 * PLUGIN maps (`compiler.ts`'s `hostFunctions`/`hostConstants`) and so are
 * consulted for any declaration of that name, while every row here is gated on
 * `standardLibraryExternals` -- the declaration's own file carrying
 * `/// <reference no-default-lib="true"/>`.
 *
 * A NAME BELONGS IN EXACTLY ONE OF THE TWO. Two rows for one name would be two
 * authorities over one question, and `hostStorageOf` consults the ungated pair
 * first, so the gated row would silently never be reached. `NaN` and
 * `Infinity` were briefly stated in both and are stated only in
 * `coreHostConstants` now.
 *
 * `btoa`, `encodeURIComponent` and the rest are not a host's protocol: nothing
 * installs them, no plugin declares them, and no target may decline them --
 * they are part of the language surface the standard library declares, in
 * exactly the same category as `Math`, `JSON` and the eight typed-array
 * constructors (`native-protocols.ts`'s own comment says so of `JSON@1`). So
 * their C++ spellings belong here, in the compiler's own table, and never in
 * the gea plugin package: a plugin row would make an ECMAScript builtin
 * conditional on which host happens to be installed.
 *
 * The table is the same shape a plugin's `hostFunctions` is -- an ambient NAME
 * to the C++ path a call renders -- and `compiler.ts` unions it into the same
 * `hostFunctions` map, so a name here reaches `projection/bindings.ts`'s
 * `host-function` storage and `emit-callable.ts`'s host-call path with no
 * second mechanism.
 *
 * ## Why a name is safe to key on here
 *
 * It is not, on its own. `projection/bindings.ts` consults this table ONLY for
 * a declaration the frontend recorded in `standardLibraryBindings` -- an
 * ambient declaration whose source file carries
 * `/// <reference no-default-lib="true"/>`, which is the checker's own
 * "this file IS a standard library" flag. A program that declares its own
 * `btoa` keeps its own cell, both because it introduces one (the first
 * placement loop wins) and because, if it merely *declares* one ambiently in
 * its own `.d.ts`, that file is not a default library and this table is never
 * reached.
 *
 * ## What is NOT here, and why
 *
 * `parseInt`, `parseFloat`, `isNaN` and `isFinite` are the other four
 * ECMAScript global functions. Each has a real implementation available --
 * `gea::host::detail::toNumber` is ECMAScript's own `ToNumber` -- but
 * `parseInt`'s two-argument radix form and `parseFloat`'s prefix-parse rule
 * (ECMA-262 19.2.5/19.2.4) are NOT `ToNumber`, and rendering them as it would
 * be a silently different answer for `parseInt('08')`, `parseInt('0x10')` and
 * `parseFloat('3px')`. They stay absent, which leaves them exactly where they
 * were: an unresolved external cell whose link fails by name.
 *
 * `escape`/`unescape` (ECMA-262 B.2.1) ARE implemented in the runtime
 * (`gea::runtime::uri::escapeImpl`/`unescapeImpl`, ported with the rest of
 * v1's `uri.cpp`) but are deliberately not claimed here: `lib.es5.d.ts` does
 * not declare them at all, so no program this compiler sees can name one, and
 * a row for a name that cannot be reached would claim a surface nothing tests.
 */
export const coreGlobalFunctions: ReadonlyMap<string, string> = new Map<string, string>([
  // HTML Standard 8.3. `btoa` is defined over Latin-1 code points and `atob`
  // over the forgiving-base64 grammar; see `gea::runtime::base64` in
  // `runtime/gea_runtime.h` for both, ported from v1's `base64.cpp`.
  ['btoa', 'gea::runtime::base64::encode'],
  ['atob', 'gea::runtime::base64::decode'],
  // ECMA-262 19.2.6.2 / 19.2.6.3 / 19.2.6.1 / 19.2.6.5 -- four spellings of
  // two algorithms (`Encode`/`Decode`) differing only in whether
  // `uriReserved` is preserved. `encodeURIComponent`/`decodeURIComponent`
  // declare `string | number | boolean`, which the program carries as a
  // tagged union; `host/emit-host-arity.ts` picks the live arm at the call
  // and each arm lands on one of the three overloads the runtime states.
  ['encodeURI', 'gea::runtime::uri::encodeUri'],
  ['encodeURIComponent', 'gea::runtime::uri::encodeUriComponent'],
  ['decodeURI', 'gea::runtime::uri::decodeUri'],
  ['decodeURIComponent', 'gea::runtime::uri::decodeUriComponent']
])

/**
 * The standard library CLASSES this backend implements itself, and the C++
 * type each one's values are carried in.
 *
 * The same category as the table above and the same reason for living here:
 * `TextEncoder`/`TextDecoder` are the Encoding Standard's, not a host's, so a
 * plugin row would make them conditional on which host is installed. What is
 * different is only the shape of the answer -- a class has values, so what the
 * compiler needs from this table is a CARRIER, not a call spelling.
 *
 * `compiler.ts` unions this into the same `nativeTypes` map a plugin's stated
 * carriers arrive in, which is what gets each spelling to two places at once:
 * `semantics/host-protocols.ts`'s `bindStandardClasses` (so the declared type
 * derives `native-handle` with the spelling on it) and the manifest's
 * `nativeProtocols` claim set, which is keyed by carrier -- so the protocol is
 * claimed exactly where its implementation is, with no second list to drift.
 *
 * Members are stated in `host-members.ts`'s `coreHostMembers`, keyed by these
 * same carrier strings; a member with no row there refuses by name at its own
 * access (`TextEncoder.encodeInto` is the one this applies to today).
 */
export const coreNativeTypes: ReadonlyMap<string, string> = new Map<string, string>([
  ['TextEncoder', 'gea::runtime::textcodec::TextEncoder'],
  ['TextDecoder', 'gea::runtime::textcodec::TextDecoder']
])

/**
 * The same names again, as the CLASS OBJECTS a program reaches by name.
 *
 * `new TextEncoder()` names two different things: the instance type, bound
 * above, and the constructor VALUE. The constructor's type is an anonymous
 * type literal in `lib.dom.d.ts` (`{ prototype: TextEncoder; new(): TextEncoder }`),
 * unlike `Uint8Array`'s named `Uint8ArrayConstructor` -- and an anonymous type
 * has no declaration the representation layer's declaration-keyed binding can
 * reach, so the class object derived a `constructor-family` carrier over the
 * structural body and linked as `extern gea::ConstructorObject<...>` that
 * nothing defines.
 *
 * `projection/bindings.ts` consults this set, on the same
 * `standardLibraryExternals` gate as the two tables above, and gives those
 * names `host-class` storage: no cell, no extern, the read renders nothing,
 * and the construction is spelled whole at the site that performs it
 * (`targets/cpp/emit-buffers.ts`'s `emitTextCodecConstruct`). The other names
 * below have the same physical answer but need it for a different reason:
 * their overloads deliberately have no single construct ABI.
 */
export const coreGlobalClasses: ReadonlySet<string> = new Set<string>([
  ...coreNativeTypes.keys(),
  // These constructor protocols deliberately have no joined [[Construct]]
  // ABI: their overloads take physically different first arguments, and the
  // construct emitter dispatches from the already-selected result and
  // argument carriers instead. That means the native-handle representation
  // cannot be used as the test for whether the global is a class object. A
  // constructor read that flows through an intersection or generic can lose
  // even the partial construct convention and would otherwise become an
  // `extern Uint8Array`-style cell that no runtime defines. The standard-lib
  // identity gate in `projection/bindings.ts` keeps program declarations with
  // the same names ordinary cells.
  'Int8Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'Int16Array',
  'Uint16Array',
  'Int32Array',
  'Uint32Array',
  'Float32Array',
  'Float64Array',
  'ArrayBuffer',
  'SharedArrayBuffer',
  'DataView',
  'Array',
  'Map',
  'Set',
  'WeakMap',
  'WeakSet',
  'RegExp',
  'Date'
])
