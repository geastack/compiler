import type { HostMember, HostMemberTable } from '../../targets/cpp/host/host-members.js'
import { templateArity } from '../../targets/cpp/host/host-members.js'
import {
  appleBridgeMetadata,
  appleMemberTables,
  appleNativeTypes,
  type AppleClassMetadata,
  type AppleHostShimSlice,
  type AppleMemberBinding,
  type AppleMethodParameter
} from './host.js'

/**
 * The carriers a binding applies to.
 *
 * A binding lists every spelling of every receiver it accepts -- the bare
 * ObjC name (`NSView`), the pointer form (`NSView *`), the C++ wrapper
 * (`gea::apple::AppKit::NSView`), and `gea_cpp_value`. Only the wrapper form is
 * kept, because that is the carrier this compiler keys a host member by, and
 * the bare and pointer forms are the same type under two other names.
 *
 * `gea_cpp_value` is dropped deliberately and permanently. It is v1's boxed
 * receiver -- the dynamic fallback that lets a member resolve off a value whose
 * type was erased -- and admitting it here would make every AppKit member
 * reachable through the box this compiler exists not to produce.
 */
const carriersOf = (binding: AppleMemberBinding): readonly string[] =>
  (binding.receiverTypes ?? []).filter((name) => name.startsWith('gea::apple::'))

/**
 * The other spelling convention this host states: a thunk, not a message send.
 *
 * Fifty of the Apple member rows carry `extern` instead of `emit` -- a C++ free
 * function the generated bridge declares and defines, rather than an inline
 * ObjC template. The calling convention is the package's own, stated in v1's
 * `native-global-function-bindings.ts` where these tables are declared: "Reads
 * and writes lower to configured extern names with the receiver as the first
 * argument." The generated header says the same thing in C++ --
 * `MTKView_get_currentRenderPassDescriptor(MTKView self)`,
 * `MTKView_set_device(MTKView self, MTLDevice value)`.
 *
 * So the template is that call, and the only thing it needs beyond the row is
 * how many arguments to pass. A getter takes none and a setter takes the value;
 * a method takes what the class DECLARES, which the metadata one step upstream
 * still knows (`appleMethodParameters`) and these tables no longer do. A method
 * whose declaration cannot be found renders nothing rather than a call with a
 * guessed arity: that would be a link error naming a symbol the program never
 * wrote, in place of a refusal naming the member it could not spell.
 */
const externTemplate = (
  name: string,
  binding: AppleMemberBinding,
  carrier: string,
  slots: 'none' | 'value' | 'declared'
): string | null => {
  const symbol = binding.extern
  if (symbol === undefined || symbol.length === 0) return null
  if (slots === 'none') return `${symbol}({receiver})`
  if (slots === 'value') return `${symbol}({receiver}, {value})`
  const parameters = appleMethodParameters(carrier, name)
  if (parameters === null) return null
  const args = parameters.map((_, position) => `, {arg${position}}`).join('')
  return `${symbol}({receiver}${args})`
}

const addRows = (
  rows: Map<string, HostMember>,
  table: Readonly<Record<string, readonly AppleMemberBinding[]>> | undefined,
  slots: 'none' | 'value' | 'declared',
  member: (emit: string, existing: HostMember | undefined) => HostMember | null
): void => {
  for (const [name, bindings] of Object.entries(table ?? {})) {
    for (const binding of bindings) {
      for (const carrier of carriersOf(binding)) {
        const emit = binding.emit !== undefined && binding.emit.length > 0 ? binding.emit : externTemplate(name, binding, carrier, slots)
        if (emit === null || emit === undefined || emit.length === 0) continue
        const key = `${carrier}.${name}`
        const row = member(emit, rows.get(key))
        if (row) rows.set(key, row)
      }
    }
  }
}

/**
 * Apple's host members, keyed the way this backend keys every host member:
 * `<carrier>.<member>`.
 *
 * The package states them the other way round -- keyed by member name, each
 * binding listing the receiver types it accepts -- because that is the shape
 * its own emitter looks members up in. Transposing here is not restating the
 * data: every template, every receiver list and every cast stays in the package
 * that generates it, and this is the one place that says which of the two
 * indexes this compiler reads.
 *
 * A getter and a setter for one member are two rows in the package and one row
 * here, merged by key, because a read and a write of `view.frame` are two
 * directions of a single property and `HostMember` states them as such. The
 * first binding to claim a key wins; a later one with different text for the
 * same carrier and member would be the package disagreeing with itself, and
 * silently overwriting would hide that.
 */
/**
 * A class object's own members, added under the carrier its instances use.
 *
 * `NSColor.clearColor` is a message to the class and `color.blendedColorWith`
 * is a message to an object, but the declaration file names the class and the
 * instance type with one identifier, so `nativeTypes` maps that one name to one
 * C++ wrapper and both member sets are reached under one key.
 *
 * That is safe only while no class states a static and an instance member of
 * the same name -- measured: zero collisions across all 58 Apple statics. It is
 * not safe by construction, and the failure would be silent: the wrong template
 * renders and clang accepts it, because both spell a valid message send. So the
 * invariant is enforced rather than assumed. A collision means the packages now
 * state something this key space cannot hold, and the fix is upstream of here.
 */
const addNamespaceRows = (rows: Map<string, HostMember>, shims: AppleHostShimSlice): void => {
  const carriers = appleNativeTypes()
  for (const [className, members] of Object.entries(shims.nativeNamespaceMethods ?? {})) {
    const carrier = carriers.get(className)
    // A class the type table does not carry has no key to file its statics
    // under, and inventing one would claim a member of a protocol nothing
    // binds. Skipping is the honest answer: no claim, so no drift.
    if (carrier === undefined) continue
    for (const [name, member] of Object.entries(members)) {
      const emit = member.emit
      if (emit === undefined || emit.length === 0) continue
      const key = `${carrier}.${name}`
      if (rows.has(key)) {
        throw new Error(
          `apple host members: "${key}" is stated both as a member of ${className} instances and as a member of the ` +
            `${className} class object; one key cannot render both, and choosing either silently renders the wrong message send`
        )
      }
      rows.set(key, { kind: 'method', emit, arity: templateArity(emit) })
    }
  }
}

export const appleHostMembers = (): HostMemberTable => {
  const shims = appleMemberTables()
  if (!shims) return new Map()
  const rows = new Map<string, HostMember>()
  addRows(rows, shims.nativeMemberMethods, 'declared', (emit, existing) =>
    existing ? null : { kind: 'method', emit, arity: templateArity(emit) }
  )
  addRows(rows, shims.nativeMemberPropertyGetters, 'none', (emit, existing) =>
    existing?.kind === 'property' ? (existing.emit === null ? { ...existing, emit } : null) : { kind: 'property', emit, store: null }
  )
  addRows(rows, shims.nativeMemberPropertySetters, 'value', (emit, existing) =>
    existing?.kind === 'property'
      ? existing.store === null
        ? { ...existing, store: emit }
        : null
      : existing
        ? null
        : { kind: 'property', emit: null, store: emit }
  )
  // Last, so the collision guard above sees every instance member already
  // filed: a static added first would be the thing an instance member
  // overwrote, and the overwrite is exactly what must not happen quietly.
  addNamespaceRows(rows, shims)
  return rows
}

/**
 * The metadata classes, indexed by the C++ wrapper each one's values carry.
 *
 * The metadata keys a class by `Framework.Class`, which is the spelling
 * `extends` uses and so the one the chain walk below follows; the carrier is
 * what every other table here is keyed by. Both indexes come from the same
 * rows, so this is the metadata's own `wrapper` field read backwards rather
 * than a second naming rule that could disagree with it.
 */
let byCarrier: ReadonlyMap<string, string> | null = null

const carrierIndex = (): ReadonlyMap<string, string> => {
  if (byCarrier) return byCarrier
  const index = new Map<string, string>()
  for (const [key, entry] of Object.entries(appleBridgeMetadata().classes ?? {})) {
    if (typeof entry.wrapper === 'string' && entry.wrapper.length > 0) index.set(entry.wrapper, key)
  }
  byCarrier = index
  return index
}

/**
 * The parameters a class declares for one of its methods.
 *
 * Walked up the chain the class extends, because a method is declared once, on
 * the class that introduces it, while the member tables list every receiver
 * that inherits it -- so "this carrier accepts `setTitle`" and "this class
 * declares `setTitle`" are answered by two different rows, and only the second
 * one carries the parameter list.
 *
 * `null` when nothing in the chain declares the method, which is a real answer
 * and not an empty parameter list: a method with no parameters states `[]`.
 */
export const appleMethodParameters = (carrier: string, method: string): readonly AppleMethodParameter[] | null => {
  const classes: Readonly<Record<string, AppleClassMetadata>> = appleBridgeMetadata().classes ?? {}
  let key = carrierIndex().get(carrier)
  const seen = new Set<string>()
  while (key !== undefined && !seen.has(key)) {
    seen.add(key)
    const entry = classes[key]
    if (entry === undefined) return null
    const declared = entry.methods?.[method]
    if (declared !== undefined) return declared.parameters ?? []
    key = entry.extends
  }
  return null
}
