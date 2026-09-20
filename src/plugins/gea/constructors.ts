import type { HostConstructor, HostConstructorTable } from '../../targets/cpp/host/host-members.js'
import { geaAmbientConstructors, geaMemberTables, geaProtocolCarriers, type GeaHostClass } from './host.js'

/**
 * How gea's host constructs its own classes -- `new WebSocket(url)`,
 * `new RTCPeerConnection(config)`, `new MediaStream()`, `new AudioContext()`.
 *
 * These are real `gea::host` C++ classes (`core/packages/host/include/host/
 * rtc.h`, `websocket.h`, `media.h`, `audio.h`) with a real native runtime
 * behind them (`core/packages/host/src/rtc.cpp` etc., backed by libpeer on
 * ESP32 and a host-side test double elsewhere) -- not something this file
 * invents. The package states two different ways a class comes into being
 * (`GeaHostClass`, host.ts) and this reads both, the same transposition
 * `plugins/apple/constructors.ts` performs over the Apple package's own
 * `embeddedHostClasses`.
 *
 *   - `construct` states the whole `new C(...)` expression already, most of
 *     them naming the single `{args}` slot (`gea::host::MediaStream({args})`):
 *     the real constructor takes the arguments directly, and forwarding
 *     whatever the program wrote lets C++'s own overload resolution decide
 *     which one, exactly as `HostMember`'s `'pass-through'` arm already does
 *     for member calls.
 *   - `factory` + `wrapper`, for a class built from a free function instead of
 *     a constructor call: `new WebSocket(url)` and `new RTCPeerConnection(cfg)`
 *     go through `gea::host::websocket::create_handle`/`gea::host::rtc::
 *     create_handle`, each returning a handle as a `double` that the wrapper
 *     type is then constructed from -- `rtc.h`'s own templated overload
 *     (`template <typename Config> NativeRtcPeerHandle create_handle(const
 *     Config &)`) is what lets a config record pass through and be ignored,
 *     stated in that header's own comment, not reinvented here. Built the
 *     same `'pass-through'` way for the same reason: which factory overload a
 *     call means is a C++ question, not one to answer by counting.
 *
 * Keyed by carrier, not by class name, so a class's constructor row and its
 * member rows (`members.ts`) file under the same key. A class the type table
 * carries no carrier for is skipped -- there is no key to file it under, and
 * inventing one would claim a constructor for a protocol nothing binds.
 *
 * Carriers come from `geaProtocolCarriers`, not the raw `geaNativeTypes`:
 * `WebSocket`/`RTCPeerConnection`/`Audio` state a `wrapper` here with no
 * separate `nativeTypes` row at all, and `geaProtocolCarriers` is where that
 * fallback already lives (see its own doc comment, host.ts) -- reading the
 * narrower table would skip exactly the three classes this function most
 * needs to reach.
 */
const geaHostClassConstructors = (): HostConstructorTable => {
  const shims = geaMemberTables()
  if (!shims) return new Map()
  const carriers = geaProtocolCarriers()
  const rows = new Map<string, HostConstructor>()
  for (const [className, entry] of Object.entries(shims.embeddedHostClasses ?? {})) {
    const carrier = carriers.get(className)
    if (carrier === undefined) continue
    const emit = entry.construct ?? factoryConstruction(entry)
    if (emit === undefined || emit.length === 0) continue
    rows.set(carrier, { emit, arity: 'pass-through' })
  }
  return rows
}

/**
 * The factory convention: a thunk hands back a handle as a `double`, and the
 * wrapper type is constructed from it -- `WebSocket(static_cast<double>(
 * gea::host::websocket::create_handle({args})))`. Both names are the
 * package's own (`GeaHostClass.factory`/`.wrapper`); nothing here invents a
 * spelling.
 */
const factoryConstruction = (entry: GeaHostClass): string | undefined => {
  const { factory, wrapper } = entry
  if (factory === undefined || factory.length === 0 || wrapper === undefined || wrapper.length === 0) return undefined
  return `${wrapper}(static_cast<double>(${factory}({args})))`
}

/**
 * Every way gea's host states a construction, as one table.
 *
 * The package states two, and they are not alternatives: `nativeConstructors`
 * (host.ts's `geaAmbientConstructors`) is keyed by the CONSTRUCTOR INTERFACE's
 * declared name and writes its slots out one by one -- `HTMLAudioElement(
 * {arg0})` -- while `embeddedHostClasses` is keyed by the CLASS's name and
 * passes whatever the call wrote straight through. Both resolve to the same
 * carrier for the four classes both name, and each reaches classes the other
 * does not: only `embeddedHostClasses` states `WebSocket` and
 * `RTCPeerConnection`, which are built from a factory and have no ambient
 * constructor row at all.
 *
 * The ambient row wins where both answer, because a counted `{argN}` template
 * is the stronger statement: it is what lets a call that omits a trailing
 * optional be padded to the arity the C++ constructor actually declares
 * (`paddedArguments`), which `{args}` pass-through cannot express -- it would
 * emit `HTMLAudioElement()` for a `new Audio()` whose real overload takes a
 * string. Nothing is lost the other way: a class the ambient table reaches is
 * one `embeddedHostClasses` states the identical spelling for.
 */
export const geaHostConstructors = (): HostConstructorTable => {
  const rows = new Map<string, HostConstructor>(geaHostClassConstructors())
  for (const [carrier, row] of geaAmbientConstructors()) rows.set(carrier, row)
  return rows
}
