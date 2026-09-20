import type { HostMember, HostMemberTable } from '../../targets/cpp/host/host-members.js'
import { templateArity } from '../../targets/cpp/host/host-members.js'
import { canvasSlotSpelling, geaCanvasContextCarrier, geaMemberTables, type GeaMemberBinding } from './host.js'

/**
 * gea's host member spellings, from the package that generates them.
 *
 * The same transposition `plugins/apple/members.ts` performs, over a different
 * package: the tables are keyed by member name with each binding listing the
 * receiver types it accepts, because that is the shape the package's own
 * emitter looks a member up in, and this backend keys by `<carrier>.<member>`.
 * Transposing is not restating -- every template stays in the package.
 *
 * What this replaces is eleven rows written by hand here, which was a second
 * authority over a question the package already answers, and which answered it
 * with this compiler's OWN spellings (`gea::host::document::getElementById`)
 * rather than the engine's (`gea::embedded::ui::Document::instance()
 * .getElementById(...)`). Two spellings for one member is how an emitted unit
 * compiles against this compiler's runtime header and fails to link against the
 * engine it is actually built into.
 */
const addRows = (
  rows: Map<string, HostMember>,
  table: Readonly<Record<string, readonly GeaMemberBinding[]>> | undefined,
  member: (emit: string, existing: HostMember | undefined) => HostMember | null,
  defaultEmit?: (name: string) => string
): void => {
  for (const [name, bindings] of Object.entries(table ?? {})) {
    for (const binding of bindings) {
      const emit = typeof binding.emit === 'string' && binding.emit.length > 0 ? binding.emit : defaultEmit?.(name)
      if (typeof emit !== 'string' || emit.length === 0) continue
      for (const carrier of binding.receiverTypes ?? []) {
        // `gea_cpp_value` is v1's boxed receiver -- the dynamic fallback that
        // lets a member resolve off a value whose type was erased. Admitting it
        // would make every member reachable through the box this compiler
        // exists not to produce, so it is dropped here as it is for Apple.
        if (carrier === 'gea_cpp_value') continue
        const key = `${carrier}.${name}`
        const row = member(emit, rows.get(key))
        if (row) rows.set(key, row)
      }
    }
  }
}

/**
 * The document's own methods, which the package states without a receiver list.
 *
 * There is one document, so the table names the member and the spelling and
 * leaves the receiver implied. The carrier it is implied to be is the one
 * `nativeTypes` gives the `Document` declaration, read from the same statement
 * rather than written out here -- a program whose `Document` carries something
 * else would then file these rows under that, which is the correct answer and
 * not a coincidence.
 */
const addDocumentRows = (rows: Map<string, HostMember>, carrier: string | undefined): void => {
  if (carrier === undefined) return
  for (const [name, method] of Object.entries(geaMemberTables()?.nativeDocumentMethods ?? {})) {
    const emit = method?.emit
    if (typeof emit !== 'string' || emit.length === 0) continue
    rows.set(`${carrier}.${name}`, { kind: 'method', emit, arity: templateArity(emit) })
  }
}

/**
 * The 2D canvas context, through the plugin package's own dispatch.
 *
 * These call `gea_ir::canvasFillRect(ctx, ...)` and its siblings -- the
 * package's shipped wrappers, emitted into the unit by `geaCanvasInterop` --
 * rather than the engine method each one forwards to. The difference is not
 * cosmetic. The wrappers carry decisions the engine requires of any caller and
 * that the member name alone does not state:
 *
 *   - a colour argument is authored `0xRRGGBBAA` and the engine takes a native
 *     pixel, so `fillCircleRgb565`'s fill goes through `canvasRgb565`. A direct
 *     call converts `double` to `std::uint16_t` instead and draws the WRONG
 *     COLOUR, silently;
 *   - `fillStyle` is `string | number` and the engine has two setters
 *     (`setFillStyle`, `setFillStyleRgb565`);
 *   - `fillCirclesRgb565` has a pointer+count overload that a per-frame scratch
 *     view must reach, and a `std::vector` overload for everything else, and
 *     the choice is made from the argument's element type;
 *   - `drawImage`'s first argument is an image handle, not an id.
 *
 * A second copy of that in this compiler would be a second authority over a
 * question the package already answers, free to drift from it. So the row is
 * the package's own template, and what defines it is the package's own
 * generator.
 *
 * `pass-through`, not a fixed arity: several wrappers take a trailing
 * `count = -1`, `fillCircle`'s fill is optional, and which overload a call
 * means is what C++ answers from the argument types rather than something to
 * decide by counting here.
 *
 * The properties are stated write-only, which is what the package states: it
 * ships `canvasContextPropertySetters` and no getter table, and the engine has
 * `setFillStyle` with no `fillStyle()`. A read is refused by name at the access
 * rather than rendered through the setter's text.
 */
const addCanvasRows = (
  rows: Map<string, HostMember>,
  methods: Readonly<Record<string, string>> | undefined,
  setters: Readonly<Record<string, string>> | undefined
): void => {
  for (const [name, emit] of Object.entries(methods ?? {})) {
    if (typeof emit !== 'string' || emit.length === 0) continue
    rows.set(`${geaCanvasContextCarrier}.${name}`, { kind: 'method', emit: canvasSlotSpelling(emit), arity: 'pass-through' })
  }
  for (const [name, emit] of Object.entries(setters ?? {})) {
    if (typeof emit !== 'string' || emit.length === 0) continue
    rows.set(`${geaCanvasContextCarrier}.${name}`, { kind: 'property', emit: null, store: canvasSlotSpelling(emit) })
  }
}

/**
 * How a program gets a 2D context off an element it holds.
 *
 * `domElementMethods` is one row, `getContext`, and its template is another of
 * the package's wrappers -- `gea_ir::getCanvasContext(node, kind)`, which tests
 * `kind == "2d"` and hands back `CanvasElement(node.id()).getContext2D()`. It
 * is carried through for the same reason the context's own members are: the
 * wrapper is where the acquisition is decided, including the overloads that
 * unwrap a `Component<T>`'s nullable `el`.
 *
 * The receiver carrier comes from the package's `nativeTypes`, which is what
 * says which declared type this member hangs off.
 */
const addElementMethodRows = (
  rows: Map<string, HostMember>,
  methods: Readonly<Record<string, string>> | undefined,
  elementCarrier: string | undefined
): void => {
  if (elementCarrier === undefined || elementCarrier.length === 0) return
  for (const [name, emit] of Object.entries(methods ?? {})) {
    if (typeof emit !== 'string' || emit.length === 0) continue
    rows.set(`${elementCarrier}.${name}`, { kind: 'method', emit: canvasSlotSpelling(emit), arity: 'pass-through' })
  }
}

export const geaHostMembers = (): HostMemberTable => {
  const shims = geaMemberTables()
  if (!shims) return new Map()
  const rows = new Map<string, HostMember>()
  // `templateArity` counts `{argN}` occurrences, and a template that instead
  // names the single `{args}` slot -- `({receiver}).createOscillator({args})`,
  // `({receiver}).connect({args})`, thirteen of the thirty rows the package
  // states here -- has none, so it derived a FIXED arity of 0 for every one of
  // them regardless of how many arguments the C++ overload actually takes.
  // `hostCallText` (emit-host-invoke.ts) only ever fills `{args}` on a
  // `variadic` or `pass-through` row; a fixed-arity row never passes a
  // `variadicArgs` string, so `fillHostTemplate` found `{args}` unfillable and
  // refused every one of these calls by name ("host template names a slot this
  // call cannot fill") -- including `createOscillator`, which takes none.
  // `{args}` is exactly `pass-through`'s own slot -- "each argument in order,
  // however many there are", host-members.ts's own words -- so a template
  // naming it gets that arity instead of a count `templateArity` cannot derive
  // from a slot name it does not recognise.
  addRows(
    rows,
    shims.nativeMemberMethods,
    (emit, existing) => (existing ? null : { kind: 'method', emit, arity: emit.includes('{args}') ? 'pass-through' : templateArity(emit) }),
    // A method row with NO template is not an incomplete row -- it is the
    // package saying this member is an ordinary native method, called the way
    // C++ calls one. The package's own comments say so in as many words
    // ("`play()`/`pause()`/`seek()`/`dispose()` are methods (handled by the
    // default native method-call path)"), and its `NativeMemberBinding.emit`
    // is declared optional for exactly this. A template is stated only where
    // the call is NOT the obvious one -- a differently-spelled engine
    // function, a wrapper that makes a conversion, a free function taking the
    // receiver first.
    //
    // Dropping these rows -- which is what this table did until now -- turns
    // "the package states this member" into "no host member table claims it",
    // and a program calling one is refused for a member the package plainly
    // ships. `await fetch(url).text()` is the case that found it: `text`,
    // `bytes`, `arrayBuffer`, `getTracks` and `getAudioTracks` are the five
    // members stated this way, and `examples/weather` refuses on the first.
    //
    // Methods ONLY. A property getter with no template has no such default: a
    // native data member is read as `({receiver}).name` and a native accessor
    // as `({receiver}).name()`, the package's own comments show it ships both
    // kinds, and nothing in the row says which. Guessing there would emit a
    // call to a field or a read of a function; those rows stay dropped and
    // refuse by name.
    (name) => `({receiver}).${name}({args})`
  )
  addRows(rows, shims.nativeMemberPropertyGetters, (emit, existing) =>
    existing?.kind === 'property' ? (existing.emit === null ? { ...existing, emit } : null) : { kind: 'property', emit, store: null }
  )
  addRows(rows, shims.nativeMemberPropertySetters, (emit, existing) =>
    existing?.kind === 'property'
      ? existing.store === null
        ? { ...existing, store: emit }
        : null
      : existing
        ? null
        : { kind: 'property', emit: null, store: emit }
  )
  addDocumentRows(rows, shims.nativeTypes?.Document)
  addCanvasRows(rows, shims.canvasContextMethods, shims.canvasContextPropertySetters)
  addElementMethodRows(rows, shims.domElementMethods, shims.nativeTypes?.GeaCanvasElement)
  return rows
}

/**
 * `<carrier>.<member>` keys whose real C++ return is `void`, read from the
 * same `nativeMemberMethods` table `geaHostMembers` derives its rows from.
 *
 * A second, narrower pass over the same data rather than a field folded into
 * `HostMember` itself: 19 rows across the package state `returnType: "void"`
 * (`removeAttribute`, `insertBefore`, the audio node family, ...), and most of
 * those already agree with the checker's own declared (void) return -- this
 * set is a superset of the actual mismatches, which costs nothing, because a
 * member the checker already declares void publishes no `operation.result`
 * for `emitCall` to discard either way. `OscillatorNode.connect` is the row
 * that is NOT redundant: the ambient declaration states the Web Audio
 * chaining convention (`connect(destination): AudioDestinationNode`), the
 * real `gea::host::OscillatorNode::connect` is `void`, and only this table
 * knows it. `emitCall` (emit-callable.ts) consults it to
 * render the call as a bare statement, discarding whatever `operation.result`
 * the checker's ABI would otherwise have this backend capture -- see
 * `HostSpellings.voidResults` for the "no viable overloaded '='" this cures.
 */
export const geaHostMemberVoidResults = (): ReadonlySet<string> => {
  const shims = geaMemberTables()
  const keys = new Set<string>()
  for (const [name, bindings] of Object.entries(shims?.nativeMemberMethods ?? {})) {
    for (const binding of bindings) {
      if (binding.returnType !== 'void') continue
      for (const carrier of binding.receiverTypes ?? []) {
        if (carrier === 'gea_cpp_value') continue
        keys.add(`${carrier}.${name}`)
      }
    }
  }
  return keys
}
