import type { ConstructOperation, IrOperand } from '../../ir/model.js'
import type { IrValueId } from '../../identity/ids.js'
import type { Representation } from '../../representation/model.js'
import { typedArrayMemberTemplateOf, typedArraySetSourceAccepted, typedArraySetSourceOf } from '../../representation/host-templates.js'
import {
  createCppEmitBlockedError,
  defineValue,
  operandText,
  wellKnownSymbolMemberOf,
  type EmitContext,
  type PrototypeMethodRead
} from './emit-context.js'
import { cppScalarType, cppStringLiteral, cppTypeOf } from './types.js'

const typedArrayTagNames: Readonly<Record<Extract<Representation, { kind: 'typed-array' }>['element'], string>> = {
  int8: 'Int8Array',
  uint8: 'Uint8Array',
  'uint8-clamped': 'Uint8ClampedArray',
  int16: 'Int16Array',
  uint16: 'Uint16Array',
  int32: 'Int32Array',
  uint32: 'Uint32Array',
  float32: 'Float32Array',
  float64: 'Float64Array'
}

/** Builtin `@@toStringTag` values carried directly by the binary-view family. */
export const binaryToStringTagText = (representation: Representation): string | null => {
  if (representation.kind === 'typed-array') return cppStringLiteral(typedArrayTagNames[representation.element])
  if (representation.kind === 'array-buffer') return cppStringLiteral('ArrayBuffer')
  if (representation.kind === 'shared-array-buffer') return cppStringLiteral('SharedArrayBuffer')
  if (representation.kind === 'data-view') return cppStringLiteral('DataView')
  return null
}

/**
 * The `ArrayBuffer`/`DataView` half of the binary family: their constructions,
 * their member reads, and the calls those reads fuse with -- plus the
 * buffer-shaped members of a typed array (`buffer`/`byteLength`/`byteOffset`,
 * `set`/`subarray`/`slice`/`fill`), which belong here rather than with the
 * indexed access in `emit-carrier-members.ts` because every one of them is
 * about the underlying BLOCK rather than about an element.
 *
 * A file of its own, and not a section of `emit-callable.ts` or
 * `emit-prototype-array.ts`: those two are already large, and what this holds
 * is one subject -- ECMA-262 25.1/25.3 plus 23.2's non-indexed surface --
 * whose members and refusals belong beside each other. Each refusal states
 * what is missing and why, because "not built" and "cannot be built without
 * X" are different answers.
 */

/**
 * `new ArrayBuffer(byteLength)` -- ECMA-262 25.1.4.1.
 *
 * Here, beside `emitTypedArrayConstruct` in spirit and for the identical
 * structural reason (`emit-callable.ts`'s own comment states it in full): the
 * checker's overload set for `ArrayBufferConstructor` is
 * `new (byteLength?: number, options?: ArrayBufferOptions)`, whose second
 * parameter is an options bag this compiler derives no carrier for, so
 * `representation/host-abi.ts` cannot join a single physical frame and
 * `.construct` is correctly `null`. This reads the construction's own
 * already-resolved argument instead.
 *
 * The `maxByteLength` option -- ECMAScript 2024's RESIZABLE buffers -- is
 * refused by name rather than ignored. Ignoring it would produce a
 * fixed-length buffer whose later `resize` silently did nothing, which is the
 * kind of quiet divergence this whole family exists to avoid; `gea::ArrayBuffer`
 * is a `std::vector`, so resizing is implementable, but a resize INVALIDATES
 * every view's cached base pointer and nothing here republishes those.
 */
/**
 * The two carriers `core-globals.ts`'s `coreNativeTypes` states for the
 * Encoding Standard's classes, named here so the construct path and that table
 * cannot drift apart on the spelling.
 */
const textEncoderCarrier = 'gea::runtime::textcodec::TextEncoder'
const textDecoderCarrier = 'gea::runtime::textcodec::TextDecoder'

/**
 * The three ambient constructor PROTOCOL NAMES `emitArrayBufferConstruct`,
 * `emitSharedArrayBufferConstruct` and `emitDataViewConstruct` below render.
 *
 * Each dispatches structurally, off the construct operation's own already-
 * resolved result carrier (`result.kind === 'array-buffer'` / `'shared-array-
 * buffer'` / `'data-view'` in `emit-callable.ts`'s `emitConstruct`), never off
 * this name -- so, exactly like the keyed-collection family's own such table,
 * this is not read by the renderers; it is their restatement of which ambient
 * names their own comments already document, exported for
 * `host/native-protocols.ts` to derive a native-boundary claim from.
 */
export const cppBinaryBufferFamilyConstructorProtocols: readonly string[] = [
  'ArrayBufferConstructor',
  'SharedArrayBufferConstructor',
  'DataViewConstructor'
]

export const emitArrayBufferConstruct = (
  ctx: EmitContext,
  lines: string[],
  operation: ConstructOperation,
  result: Extract<Representation, { kind: 'array-buffer' }>
): void => {
  if (result.ownership !== 'shared-refcount') {
    throw createCppEmitBlockedError(
      'call-abi:construct:array-buffer',
      `an ArrayBuffer allocation carries ownership "${result.ownership}", but this emitter only spells std::make_shared for "shared-refcount"`
    )
  }
  const name = defineValue(ctx, operation.result)
  const argument = operation.arguments[0]
  if (!argument) {
    lines.push(`${name} = gea::makeRef<gea::ArrayBuffer>();`)
    return
  }
  if (operation.arguments.length > 1) {
    throw createCppEmitBlockedError(
      'call-abi:construct:array-buffer',
      `constructs an ArrayBuffer from ${operation.arguments.length} arguments; the second is ECMAScript 2024's ` +
        '`{ maxByteLength }` resizable-buffer option, which is refused rather than ignored -- a resize reallocates the ' +
        "block and every view's cached base pointer would dangle, and nothing here republishes those"
    )
  }
  const carrier = argument.representation
  if (carrier.kind !== 'scalar' || carrier.domain !== 'number') {
    throw createCppEmitBlockedError(
      'call-abi:construct:array-buffer',
      `constructs an ArrayBuffer from a "${carrier.kind}" argument; ECMA-262 25.1.4.1 takes a byte length (a number) and nothing else`
    )
  }
  lines.push(
    `${name} = gea::makeRef<gea::ArrayBuffer>(gea::detail::typedArrayLengthIndex(${operandText(ctx, argument)}), std::uint8_t{0});`
  )
}

/** `new SharedArrayBuffer(byteLength)`, ECMA-262 25.2.3.1. */
export const emitSharedArrayBufferConstruct = (
  ctx: EmitContext,
  lines: string[],
  operation: ConstructOperation,
  result: Extract<Representation, { kind: 'shared-array-buffer' }>
): void => {
  if (result.ownership !== 'shared-refcount') {
    throw createCppEmitBlockedError(
      'call-abi:construct:shared-array-buffer',
      `a SharedArrayBuffer allocation carries ownership "${result.ownership}", not shared-refcount`
    )
  }
  if (operation.arguments.length !== 1) {
    throw createCppEmitBlockedError(
      'call-abi:construct:shared-array-buffer',
      `constructs a SharedArrayBuffer from ${operation.arguments.length} arguments; only its required byteLength form is implemented`
    )
  }
  const argument = operation.arguments[0]
  if (!argument || argument.representation.kind !== 'scalar' || argument.representation.domain !== 'number') {
    throw createCppEmitBlockedError(
      'call-abi:construct:shared-array-buffer',
      'constructs a SharedArrayBuffer from a non-number byte length'
    )
  }
  lines.push(
    `${defineValue(ctx, operation.result)} = gea::makeRef<gea::SharedArrayBuffer>(gea::detail::typedArrayLengthIndex(${operandText(ctx, argument)}));`
  )
}

/**
 * `new DataView(buffer, byteOffset?, byteLength?)` -- ECMA-262 25.3.2.1.
 *
 * Three parameters of one shape, so unlike its siblings this one COULD have
 * joined an ABI; it is rendered here anyway, beside the buffer family it
 * belongs to, because the absent-argument rule is the specification's rather
 * than C++'s: an omitted `byteLength` means "to the end of the buffer", which
 * the runtime spells as a NaN (v1's own convention, kept), while an omitted
 * `byteOffset` means zero. A C++ default argument cannot express the first
 * without repeating the buffer's length at the call site.
 */
export const emitDataViewConstruct = (
  ctx: EmitContext,
  lines: string[],
  operation: ConstructOperation,
  result: Extract<Representation, { kind: 'data-view' }>
): void => {
  if (result.ownership !== 'shared-refcount') {
    throw createCppEmitBlockedError(
      'call-abi:construct:data-view',
      `a DataView allocation carries ownership "${result.ownership}", but this emitter only spells std::make_shared for "shared-refcount"`
    )
  }
  const buffer = operation.arguments[0]
  if (!buffer || buffer.representation.kind !== 'array-buffer') {
    throw createCppEmitBlockedError(
      'call-abi:construct:data-view',
      `constructs a DataView over a "${buffer?.representation.kind ?? 'missing'}" argument; ECMA-262 25.3.2.1 takes an ` +
        'ArrayBuffer, and a SharedArrayBuffer -- the other type its signature admits -- has a concurrent memory model ' +
        'this backend has no threads to honor'
    )
  }
  if (operation.arguments.length > 3) {
    throw createCppEmitBlockedError(
      'call-abi:construct:data-view',
      `constructs a DataView from ${operation.arguments.length} arguments; ECMA-262 25.3.2.1 declares three`
    )
  }
  const name = defineValue(ctx, operation.result)
  const offset = operation.arguments[1]
  const length = operation.arguments[2]
  const offsetText = offset ? numberArgumentText(ctx, offset, 'byteOffset') : '0.0'
  // An omitted `byteLength` is the buffer's remaining bytes, which the runtime
  // reads a NaN as -- see `gea::DataView`'s constructor. Spelled here rather
  // than defaulted in C++ so the two absences stay distinguishable.
  const lengthText = length ? numberArgumentText(ctx, length, 'byteLength') : 'std::numeric_limits<double>::quiet_NaN()'
  lines.push(`${name} = gea::makeRef<gea::DataView>(${operandText(ctx, buffer)}, ${offsetText}, ${lengthText});`)
}

/** One numeric constructor argument, refused by name when the program carries it as anything but a number. */
const numberArgumentText = (ctx: EmitContext, argument: IrOperand, role: string): string => {
  const carrier = argument.representation
  if (carrier.kind !== 'scalar' || carrier.domain !== 'number') {
    throw createCppEmitBlockedError(
      'call-abi:construct:data-view',
      `passes a "${carrier.kind}" as a DataView ${role}, which ECMA-262 25.3.2.1 declares a number`
    )
  }
  return operandText(ctx, argument)
}

/**
 * `new Uint8Array(buffer, byteOffset?, length?)` -- ECMA-262 23.2.5.1's third
 * overload, the one that ALIASES rather than copies.
 *
 * Kept here with the rest of the buffer family rather than inside
 * `emitTypedArrayConstruct`, because what it is about is the block: the result
 * shares `buffer`'s bytes, so a write through either view is seen by the
 * other, which is the whole reason `gea::TypedArray` stores a shared byte
 * vector instead of a `vector<T>` of its own.
 *
 * A `byteOffset` that is not a multiple of the element width, or a length that
 * would run past the block, is a RangeError in the specification and a named
 * abort in `TypedArray::fromBuffer` -- this renders the call and the runtime
 * checks it, rather than this re-deriving the check from constants it may not
 * have.
 */
export const emitTypedArrayBufferConstruct = (ctx: EmitContext, lines: string[], operation: ConstructOperation, target: string): void => {
  const buffer = operation.arguments[0]
  if (!buffer) throw createCppEmitBlockedError('call-abi:construct:typed-array', 'constructs a typed array view over no buffer')
  const name = defineValue(ctx, operation.result)
  if (operation.arguments.length > 3) {
    throw createCppEmitBlockedError(
      'call-abi:construct:typed-array',
      `constructs a typed array from ${operation.arguments.length} arguments; ECMA-262 23.2.5.1's buffer overload declares three`
    )
  }
  const offset = operation.arguments[1]
  const length = operation.arguments[2]
  const offsetText = offset ? `gea::detail::typedArrayLengthIndex(${numberArgumentText(ctx, offset, 'byteOffset')})` : '0'
  // Absent length means "the rest of the block", which the runtime cannot
  // guess from a `0` -- so it is computed here from the buffer the call
  // already names: every remaining byte, divided by this view's element width.
  const lengthText = length
    ? `gea::detail::typedArrayLengthIndex(${numberArgumentText(ctx, length, 'length')})`
    : `(${operandText(ctx, buffer)}->size() - ${offsetText}) / sizeof(${target}::value_type)`
  const block = operandText(ctx, buffer)
  if (buffer.representation.kind === 'shared-array-buffer') {
    lines.push(`${name} = gea::makeRef<${target}>(${target}::fromSharedBuffer(${block}, ${offsetText}, ${lengthText}));`)
    return
  }
  lines.push(`${name} = gea::makeRef<${target}>(${target}::fromBuffer(${block}, ${offsetText}, ${lengthText}));`)
}

/**
 * ECMA-262 25.1's own members. `byteLength` is the only readable data
 * property; `slice` is the only method with a rendering, and it defers to fuse
 * with its call the way every other prototype method in this backend does.
 *
 * What refuses, by name and with the reason: `resize`/`transfer`/
 * `transferToFixedLength`/`resizable`/`maxByteLength`/`detached`
 * (ECMAScript 2024 -- resizing or detaching the block dangles every view's
 * cached base pointer, and nothing here republishes those) and
 * `ArrayBuffer.isView` (a static, not an instance member, and this backend has
 * no brand test that could answer it without a runtime tag every carrier would
 * have to pay for).
 */
export const arrayBufferMemberRefusals: ReadonlyMap<string, string> = new Map<string, string>([
  [
    'resize',
    'ECMAScript 2024 resizable buffers reallocate the block, which dangles the cached base pointer every view over it holds; ' +
      'nothing here republishes those, so a resize would corrupt every existing view rather than fail'
  ],
  [
    'resizable',
    'a resizable ArrayBuffer is not constructible here (see "resize"), so answering this would always be a constant false dressed as a query'
  ],
  ['maxByteLength', 'a resizable ArrayBuffer is not constructible here (see "resize")'],
  [
    'transfer',
    'transferring an ArrayBuffer DETACHES the source, after which every view over it must throw on access; this runtime has no detached state and no throw at that boundary'
  ],
  ['transferToFixedLength', 'the same detachment this backend cannot represent -- see "transfer"'],
  ['detached', 'nothing here can detach a buffer (see "transfer"), so this would always be a constant false dressed as a query']
])

/** `ArrayBuffer.prototype` methods that defer at the `[[Get]]` and fuse with the call that follows. */
export const arrayBufferPrototypeMethods: ReadonlySet<string> = new Set<string>(['slice'])

/**
 * The ArrayBuffer reading of a property access, or `null` when the receiver is
 * not one.
 *
 * A computed key refuses rather than indexing: ECMA-262 25.1 gives an
 * ArrayBuffer no exotic `[[Get]]` at all, so `b[0]` really is `undefined` and
 * answering it with a byte would be a wrong answer, not a missing one.
 */
/** Whether an ArrayBuffer member read is a deferred prototype method read. Stated once; the renderer and the prototype-read walk both ask it. */
export const deferredArrayBufferMethodClaim = (
  staticKeyTexts: ReadonlyMap<IrValueId, string>,
  receiver: IrOperand,
  key: IrOperand
): PrototypeMethodRead | null => {
  if (receiver.representation.kind !== 'array-buffer') return null
  const staticKey = staticKeyTexts.get(key.value)
  if (staticKey === undefined || staticKey === 'byteLength') return null
  if (!arrayBufferPrototypeMethods.has(staticKey)) return null
  return { receiverKind: 'array-buffer', member: staticKey, receiver: { kind: 'operand', operand: receiver }, receiverElement: null }
}

export const arrayBufferAccessText = (ctx: EmitContext, receiver: IrOperand, key: IrOperand, result: IrValueId | null): string | null => {
  if (receiver.representation.kind !== 'array-buffer') return null
  const receiverText = operandText(ctx, receiver)
  // Whether this key IS static, and what it names, decides which member is
  // being read (byteLength, a deferred method, or a refusal by name) versus
  // the final computed-key refusal below -- a claim, not a spelling, so it
  // reads the pre-render map rather than `constantTexts`'s render-time accretion.
  const staticKey = ctx.staticKeyTexts.get(key.value)
  if (staticKey === 'byteLength') return `static_cast<double>(${receiverText}->size())`
  if (wellKnownSymbolMemberOf(ctx, key) === 'toStringTag') return cppStringLiteral('ArrayBuffer')
  if (staticKey !== undefined) {
    if (deferredArrayBufferMethodClaim(ctx.staticKeyTexts, receiver, key) !== null) {
      if (result === null) {
        throw createCppEmitBlockedError(
          'property-access:array-buffer:get:false',
          `"${staticKey}" is an ArrayBuffer.prototype method, and this access publishes no value for its call to consume`
        )
      }
      return ''
    }
    const stated = arrayBufferMemberRefusals.get(staticKey)
    throw createCppEmitBlockedError(
      'property-access:array-buffer:get:false',
      stated !== undefined
        ? `"${staticKey}" is an ArrayBuffer member this backend states no rendering for: ${stated}`
        : `an ArrayBuffer property "${staticKey}" is an ordinary property, and ECMA-262 25.1 gives an ArrayBuffer no property table beyond ` +
            'byteLength and slice'
    )
  }
  throw createCppEmitBlockedError(
    'property-access:array-buffer:get:true',
    'an ArrayBuffer has no indexed access at all (ECMA-262 25.1 defines no exotic [[Get]] for one), so a computed key on ' +
      'it is `undefined` rather than a byte, and this backend refuses it instead of answering the byte'
  )
}

/** SharedArrayBuffer has fixed geometry but intentionally no ArrayBuffer-only slice/transfer surface. */
export const sharedArrayBufferAccessText = (ctx: EmitContext, receiver: IrOperand, key: IrOperand): string | null => {
  if (receiver.representation.kind !== 'shared-array-buffer') return null
  // Same static-key claim as `arrayBufferAccessText` above: the pre-render
  // map, so a render-time-folded text is never mistaken for a static member name.
  const staticKey = ctx.staticKeyTexts.get(key.value)
  const receiverText = operandText(ctx, receiver)
  if (staticKey === 'byteLength') return `static_cast<double>(${receiverText}->size())`
  if (wellKnownSymbolMemberOf(ctx, key) === 'toStringTag') return cppStringLiteral('SharedArrayBuffer')
  if (staticKey !== undefined) {
    throw createCppEmitBlockedError(
      'property-access:shared-array-buffer:get:false',
      `SharedArrayBuffer.${staticKey} is not implemented; only byteLength is admitted`
    )
  }
  throw createCppEmitBlockedError('property-access:shared-array-buffer:get:true', 'SharedArrayBuffer has no indexed access')
}

/**
 * ECMA-262 25.3's `DataView` members: the three geometry accessors, and the
 * sixteen typed accessors this backend renders.
 *
 * `getBigInt64`/`getBigUint64`/`setBigInt64`/`setBigUint64` are deliberately
 * absent and refuse by name. v1 implements all four and returns/accepts a
 * `double`, which loses precision above 2^53 -- silently, which is exactly the
 * failure a BigInt exists to prevent. This backend has no BigInt carrier at
 * all, so refusing is the honest answer.
 */
const dataViewAccessors: ReadonlyMap<string, { readonly spelling: string; readonly endian: boolean; readonly write: boolean }> = new Map([
  ['getInt8', { spelling: 'getInt8', endian: false, write: false }],
  ['getUint8', { spelling: 'getUint8', endian: false, write: false }],
  ['getInt16', { spelling: 'getInt16', endian: true, write: false }],
  ['getUint16', { spelling: 'getUint16', endian: true, write: false }],
  ['getInt32', { spelling: 'getInt32', endian: true, write: false }],
  ['getUint32', { spelling: 'getUint32', endian: true, write: false }],
  ['getFloat32', { spelling: 'getFloat32', endian: true, write: false }],
  ['getFloat64', { spelling: 'getFloat64', endian: true, write: false }],
  ['setInt8', { spelling: 'setInt8', endian: false, write: true }],
  ['setUint8', { spelling: 'setUint8', endian: false, write: true }],
  ['setInt16', { spelling: 'setInt16', endian: true, write: true }],
  ['setUint16', { spelling: 'setUint16', endian: true, write: true }],
  ['setInt32', { spelling: 'setInt32', endian: true, write: true }],
  ['setUint32', { spelling: 'setUint32', endian: true, write: true }],
  ['setFloat32', { spelling: 'setFloat32', endian: true, write: true }],
  ['setFloat64', { spelling: 'setFloat64', endian: true, write: true }]
])

const bigIntAccessorRefusal =
  'its element is a BigInt, and this backend has no BigInt carrier; v1 answers this one with a `double`, which silently ' +
  'rounds every value above 2^53 -- exactly what a BigInt exists to prevent -- so it is refused here rather than ported'

export const dataViewMemberRefusals: ReadonlyMap<string, string> = new Map<string, string>([
  ['getBigInt64', bigIntAccessorRefusal],
  ['getBigUint64', bigIntAccessorRefusal],
  ['setBigInt64', bigIntAccessorRefusal],
  ['setBigUint64', bigIntAccessorRefusal]
])

/** `DataView.prototype` methods that defer at the `[[Get]]` and fuse with the call that follows. */
export const dataViewPrototypeMethods: ReadonlySet<string> = new Set<string>([...dataViewAccessors.keys()])

/** Whether a DataView member read is a deferred prototype method read. Stated once; the renderer and the prototype-read walk both ask it. */
export const deferredDataViewMethodClaim = (
  staticKeyTexts: ReadonlyMap<IrValueId, string>,
  receiver: IrOperand,
  key: IrOperand
): PrototypeMethodRead | null => {
  if (receiver.representation.kind !== 'data-view') return null
  const staticKey = staticKeyTexts.get(key.value)
  if (staticKey === undefined || staticKey === 'byteLength' || staticKey === 'byteOffset' || staticKey === 'buffer') return null
  if (!dataViewPrototypeMethods.has(staticKey)) return null
  return { receiverKind: 'data-view', member: staticKey, receiver: { kind: 'operand', operand: receiver }, receiverElement: null }
}

/** The DataView reading of a property access, or `null` when the receiver is not one. */
export const dataViewAccessText = (ctx: EmitContext, receiver: IrOperand, key: IrOperand, result: IrValueId | null): string | null => {
  if (receiver.representation.kind !== 'data-view') return null
  const receiverText = operandText(ctx, receiver)
  // Same static-key claim as `arrayBufferAccessText` above: the pre-render
  // map, so a render-time-folded text is never mistaken for a static member name.
  const staticKey = ctx.staticKeyTexts.get(key.value)
  if (wellKnownSymbolMemberOf(ctx, key) === 'toStringTag') return cppStringLiteral('DataView')
  if (staticKey === 'byteLength') return `${receiverText}->byteLength()`
  if (staticKey === 'byteOffset') return `${receiverText}->byteOffset()`
  if (staticKey === 'buffer') return `${receiverText}->buffer()`
  if (staticKey !== undefined) {
    if (deferredDataViewMethodClaim(ctx.staticKeyTexts, receiver, key) !== null) {
      if (result === null) {
        throw createCppEmitBlockedError(
          'property-access:data-view:get:false',
          `"${staticKey}" is a DataView.prototype method, and this access publishes no value for its call to consume`
        )
      }
      return ''
    }
    const stated = dataViewMemberRefusals.get(staticKey)
    throw createCppEmitBlockedError(
      'property-access:data-view:get:false',
      stated !== undefined
        ? `"${staticKey}" is a DataView member this backend states no rendering for: ${stated}`
        : `a DataView property "${staticKey}" is an ordinary property, and ECMA-262 25.3 gives a DataView no property table beyond ` +
            'buffer, byteLength, byteOffset and its typed accessors'
    )
  }
  throw createCppEmitBlockedError(
    'property-access:data-view:get:true',
    'a DataView has no indexed access (ECMA-262 25.3 defines no exotic [[Get]] for one); every read goes through a named ' +
      'accessor whose width and byte order it states'
  )
}

/**
 * The DataView call, fused with its deferred `[[Get]]`.
 *
 * `littleEndian` is the point of this family and is passed EXPLICITLY at every
 * width that has one, never left to a C++ default: ECMA-262 25.3.1.1 defaults
 * it to `false` (BIG-endian), which is the opposite of every machine this
 * runs on, so an omission that silently became the host's own order would read
 * different numbers from the same bytes on different targets.
 */
export const dataViewCallText = (ctx: EmitContext, member: string, receiver: string, args: readonly IrOperand[]): string => {
  const accessor = dataViewAccessors.get(member)
  if (!accessor) {
    throw createCppEmitBlockedError(
      `host-member-call:DataView.${member}`,
      `"${member}" was recorded as a deferred DataView read but this file renders no call for it`
    )
  }
  const fixed = accessor.write ? 2 : 1
  const offsetAndValue = args.slice(0, fixed).map((argument) => operandText(ctx, argument))
  if (offsetAndValue.length < fixed) {
    throw createCppEmitBlockedError(
      `host-member-call:DataView.${member}`,
      `DataView.prototype.${member} needs ${fixed} argument(s) and this call passes ${offsetAndValue.length}`
    )
  }
  if (!accessor.endian) {
    if (args.length > fixed) {
      throw createCppEmitBlockedError(
        `host-member-call:DataView.${member}`,
        `DataView.prototype.${member} is single-byte and takes no littleEndian argument, but this call passes one`
      )
    }
    return `${receiver}->${accessor.spelling}(${offsetAndValue.join(', ')})`
  }
  const endian = args[fixed]
  // ECMA-262 25.3.1.1 step 6: `ToBoolean(isLittleEndian)`, with an omitted
  // argument reading `false`. Rendered as the literal so the emitted call
  // states the order it means.
  const endianText = endian === undefined ? 'false' : booleanArgumentText(ctx, endian, member)
  return `${receiver}->${accessor.spelling}(${[...offsetAndValue, endianText].join(', ')})`
}

const booleanArgumentText = (ctx: EmitContext, argument: IrOperand, member: string): string => {
  const carrier = argument.representation
  if (carrier.kind === 'scalar' && carrier.domain === 'boolean') return operandText(ctx, argument)
  throw createCppEmitBlockedError(
    `host-member-call:DataView.${member}`,
    `DataView.prototype.${member} received its littleEndian argument as "${carrier.kind}"; ECMA-262 25.3.1.1 applies ToBoolean ` +
      'to it, and this backend installs that conversion for a boolean carrier only'
  )
}

/**
 * A typed array's BUFFER-shaped members: geometry accessors, element width, and the
 * four methods that operate on ranges of the block rather than on one element.
 *
 * Split from `typedArrayAccessText`'s indexed reading (emit-carrier-members.ts)
 * on that same line: an index is about an element and these are about the
 * block, and the block is what this file is about.
 */
export const typedArrayBufferMembers: ReadonlySet<string> = new Set<string>(['buffer', 'byteLength', 'byteOffset', 'BYTES_PER_ELEMENT'])

/** `%TypedArray%.prototype` methods this file renders, which defer at the `[[Get]]` and fuse with the call. */
export const typedArrayPrototypeMethods: ReadonlySet<string> = new Set<string>(['set', 'subarray', 'slice', 'fill', 'toString'])

/** The buffer-shaped reading of a typed-array property, or `null` when the key is not one of them. */
export const typedArrayBufferMemberText = (
  receiverText: string,
  representation: Extract<Representation, { kind: 'typed-array' }>,
  key: string
): string | null => {
  if (key === 'buffer')
    return representation.buffer === 'shared-array-buffer' ? `${receiverText}->sharedBuffer()` : `${receiverText}->buffer()`
  if (key === 'byteLength') return `${receiverText}->byteLength()`
  if (key === 'byteOffset') return `${receiverText}->byteOffset()`
  // The same storage spelling drives TypedArray<T> and this immutable element
  // width. Reading an empty/subarray view must not divide byteLength by length.
  // Both concrete receivers and selected union arms use this member authority.
  if (key === 'BYTES_PER_ELEMENT') return `static_cast<double>(sizeof(${typedArrayElementSpelling(representation)}))`
  return null
}

/**
 * The typed-array range call, fused with its deferred `[[Get]]`.
 *
 * An omitted `end` is rendered as the receiver's own `length()` rather than
 * defaulted in the runtime, because only this call site knows whether an
 * absence was `end` or `start` -- the runtime's relative-index fold reads a
 * `NaN` as 0, which is right for a start and wrong for an end.
 *
 * `fill` is spelled as a comma expression: ECMA-262 23.2.3.9 returns the view
 * itself, and the runtime's `fill` is `void` because a `shared_ptr`-owned
 * object cannot hand out its own owner. The receiver's text is already here,
 * so `(a->fill(...), a)` is the same value with nothing to own.
 */
export const typedArrayCallText = (
  ctx: EmitContext,
  member: string,
  receiver: string,
  element: string,
  args: readonly IrOperand[]
): string => {
  const rangeStart = (index: number): string => (args[index] === undefined ? '0.0' : operandText(ctx, args[index] as IrOperand))
  const rangeEnd = (index: number): string =>
    args[index] === undefined ? `${receiver}->length()` : operandText(ctx, args[index] as IrOperand)
  // ECMA-262 23.2.3.32: `%TypedArray%.prototype.toString` IS
  // `Array.prototype.toString`, which is `join()` with the default separator
  // -- a comma between elements and nothing else. The runtime's own
  // `join(Ref<TypedArray<E>>)` overload is that algorithm, written beside the
  // Array one so a typed array and an Array cannot answer differently; this
  // only routes the explicit member to it.
  //
  // Node's `Buffer` overrides `toString` to DECODE its bytes, which is a
  // different function on a different type. A receiver whose declared type is
  // a Buffer reaches that class's own member; a receiver declared
  // `Uint8Array` -- which is what `@hono/node-server`'s `websocket-types.ts`
  // declares its close `reason` as -- gets the specification's answer, and
  // this renders the type the program actually stated.
  if (member === 'toString') {
    if (args.length !== 0) {
      throw createCppEmitBlockedError(
        'host-member-call:TypedArray.toString',
        `%TypedArray%.prototype.toString takes no arguments and this call passes ${args.length}`
      )
    }
    return `gea::runtime::array::join(${receiver})`
  }
  if (member === 'subarray' || member === 'slice') {
    return `${receiver}->${member}(${rangeStart(0)}, ${rangeEnd(1)})`
  }
  if (member === 'fill') {
    const value = args[0]
    if (!value)
      throw createCppEmitBlockedError(
        'host-member-call:TypedArray.fill',
        'TypedArray.prototype.fill needs a value argument and this call passes none'
      )
    return `(${receiver}->fill(${operandText(ctx, value)}, ${rangeStart(1)}, ${rangeEnd(2)}), ${receiver})`
  }
  // `set`'s template, and which sources it copies from, are stated once in
  // `representation/host-templates.ts` -- the IR's frame for this call reads
  // the same predicates, so the two cannot describe different C++.
  if (typedArrayMemberTemplateOf(member) !== 'typed-array-set')
    throw createCppEmitBlockedError(
      'host-member-call:TypedArray.set',
      `TypedArray.prototype.${member} was deferred to a typed-array call, and no template here renders it`
    )
  const source = args[0]
  if (!source)
    throw createCppEmitBlockedError(
      'host-member-call:TypedArray.set',
      'TypedArray.prototype.set needs a source argument and this call passes none'
    )
  const offset = args[1] === undefined ? '0.0' : operandText(ctx, args[1] as IrOperand)
  const carrier = source.representation
  // Two sources, two ECMA-262 algorithms (23.2.3.26 steps 5 and 6), and the
  // difference is real: a typed-array source is read through its own element
  // type, while an Array source may hold HOLES that read as `undefined`.
  const single = typedArraySetSourceOf(carrier)
  if (single === 'typed-array') {
    return `(${receiver}->setFrom(*${operandText(ctx, source)}, ${offset}), gea::Undefined{})`
  }
  if (single === 'number-array') {
    return `(${receiver}->setFromArray(${operandText(ctx, source)}, ${offset}), gea::Undefined{})`
  }
  if (carrier.kind === 'tagged-union' && typedArraySetSourceAccepted(carrier)) {
    const sourceText = operandText(ctx, source)
    const branches = carrier.arms.map((arm, index) => {
      const value = `${sourceText}.get<${index}>()`
      if (typedArraySetSourceOf(arm.value) === 'typed-array') return `(${receiver}->setFrom(*${value}, ${offset}), gea::Undefined{})`
      return `(${receiver}->setFromArray(${value}, ${offset}), gea::Undefined{})`
    })
    return branches.reduceRight<string>(
      (rest, branch, index) => (index === branches.length - 1 ? branch : `${sourceText}.is<${index}>() ? ${branch} : (${rest})`),
      ''
    )
  }
  throw createCppEmitBlockedError(
    'host-member-call:TypedArray.set',
    `TypedArray.prototype.set of element "${element}" received a "${carrier.kind}" source; ECMA-262 23.2.3.26 takes a typed ` +
      'array or an array-like of numbers, and any other array-like needs the generic length-and-index protocol this backend does not lower'
  )
}

/** The element spelling a deferred typed-array read carries to its call, so `set`'s refusal can name it. */
export const typedArrayElementSpelling = (representation: Extract<Representation, { kind: 'typed-array' }>): string =>
  cppScalarType(representation.element)

/** The pointee a typed-array construction allocates -- shared by both construct paths so the two cannot spell it differently. */
export const typedArrayTargetSpelling = (representation: Extract<Representation, { kind: 'typed-array' }>): string =>
  cppTypeOf({ ...representation, ownership: 'owned' })

/**
 * `new TextEncoder()` / `new TextDecoder([label])`, or `null` when this
 * construction is not one of the two.
 *
 * Rendered here rather than through the host CONSTRUCTOR table
 * (`ctx.hosts.constructors`) for a reason the table's own shape states: its
 * fixed-arity rows are checked against the checker's PADDED frame, and
 * `new (label?: string, options?: TextDecoderOptions)` pads to two arguments
 * for every call site including `new TextDecoder()`. A `'pass-through'` row
 * would take any count and hand the options bag to C++, where the failure is
 * a template error rather than a refusal naming what is missing. Counting the
 * arguments the program actually WROTE is the only way both to accept the two
 * real forms and to refuse the third by name, which is the same reason
 * `ArrayBuffer` and `DataView` above are rendered here and not stated as rows.
 */
export const emitTextCodecConstruct = (ctx: EmitContext, lines: string[], operation: ConstructOperation): boolean => {
  const result = operation.result.representation
  if (result.kind !== 'native-handle') return false
  const spelling = result.native
  if (spelling !== textEncoderCarrier && spelling !== textDecoderCarrier) return false
  const count = operation.arguments.length
  if (spelling === textEncoderCarrier) {
    // Encoding Standard 6.1: `new TextEncoder()` takes nothing, and the
    // checker's own signature says so, so any argument at all is a program
    // this backend has no reading of rather than one to silently discard.
    if (count !== 0) {
      throw createCppEmitBlockedError(
        `host-invocation:${textEncoderCarrier}`,
        `constructs a TextEncoder from ${count} argument(s); the Encoding Standard's constructor takes none`
      )
    }
    lines.push(`${defineValue(ctx, operation.result)} = ${textEncoderCarrier}{};`)
    return true
  }
  if (count > 1) {
    throw createCppEmitBlockedError(
      `host-invocation:${textDecoderCarrier}`,
      `constructs a TextDecoder from ${count} arguments; the second is the ` +
        '`{ fatal, ignoreBOM }` options bag, and reading it needs either the boxed dynamic carrier this compiler forbids or a ' +
        'compile-time probe of a program-generated struct declared after the runtime header -- so it is refused rather than ' +
        'ignored, which would silently decode malformed input the opposite way'
    )
  }
  const label = operation.arguments[0]
  // The label is validated, not stored: `TextDecoder::create` accepts exactly
  // the Encoding Standard's three utf-8 labels and aborts by name on any
  // other, which is where the specification raises a RangeError.
  const argument = label === undefined ? '' : operandText(ctx, label)
  lines.push(`${defineValue(ctx, operation.result)} = ${textDecoderCarrier}::create(${argument});`)
  return true
}
