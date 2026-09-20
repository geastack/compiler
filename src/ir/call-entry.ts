import type { DeclarationId, FunctionId, IrValueId } from '../identity/ids.js'
import { conversionNodeIdOf, type ConversionCensus } from '../conversion/nodes.js'
import { transfersNativeStorage, type ConversionCapability } from '../conversion/algebra.js'
import type { RecordField, Representation } from '../representation/model.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { isNativeCallableCarrier } from '../representation/callable-object.js'
import { isArrayConstantOf, typedArraySetSourceAccepted } from '../representation/host-templates.js'
import { abiOfCallee, constructAbiOfCallee } from '../projection/callee.js'
import type { ClassLayout } from '../projection/classes.js'
import { declaredFieldRepresentationOf, recordFieldsOfShape } from '../projection/fields.js'
import { abiKey, representationKey, type CallableAbi } from '../representation/model.js'
import type { CallCalleeIdentity, CallOperation, ConstructOperation, IrOperand } from './model.js'

/**
 * A fixed frame receives only its declared formals. Normalization publishes a
 * rest parameter for bodies that observe `arguments`, so those frames retain
 * every supplied argument. Argument evaluation lives in preceding IR and is
 * never removed by selecting the received values.
 */
export const receivableArguments = <T>(abi: CallableAbi, args: readonly T[]): readonly T[] =>
  abi.restFrom !== null ? args : args.slice(0, abi.parameters.length)

/** Inputs observable through this call's held convention, even before its
 * implementation is known. Dynamic and spread frames retain every input. */
export const receivedCallArguments = (operation: CallOperation): readonly IrOperand[] => {
  const abi = operation.argumentsAreSpread ? null : abiOfCallee(operation.callee.representation)
  return abi === null ? operation.arguments : receivableArguments(abi, operation.arguments)
}

/**
 * The frame a construction through a bare host constructor fills: the handle's
 * own `[[Construct]]` convention when its overloads join into one, else the
 * overload the checker selected at this site (`ConstructOperation.hostFrame`).
 * `null` for any other callee, and for a construction whose new-target is not
 * its own callee, which emission refuses.
 *
 * A `native-handle` states no convention `constructAbiOfCallee` can read, so
 * without this a host construction published no default-slot conversion and
 * `new Error(message)` -- `options` omitted -- read as an open frame.
 */
export const hostConstructFrameOf = (operation: ConstructOperation): CallableAbi | null => {
  const callee = operation.callee.representation
  if (callee.kind !== 'native-handle' || operation.newTarget.value !== operation.callee.value) return null
  return callee.construct ?? operation.hostFrame ?? null
}

/**
 * Publish default-slot conversions before carrier closure and read-only
 * reflection census, together with the sum selection a union receiver enters
 * its convention through (`publishSumReceiverSelection`). A host construction
 * publishes its omitted formals against `hostConstructFrameOf`.
 */
export const publishOmittedArgumentConversions = (operation: CallOperation | ConstructOperation, conversions: ConversionCensus): void => {
  if (operation.kind === 'call' && operation.argumentsAreSpread) return
  if (operation.kind === 'call') publishSumReceiverSelection(operation, conversions)
  if (operation.kind === 'construct' && operation.callee.representation.kind === 'tagged-union') {
    // A sum invokes the selected arm's convention. Seal its existing native
    // argument/result conversions before provenance and reflection consume
    // them, rather than minting the first citation while printing the arm.
    for (const arm of operation.callee.representation.arms) {
      const abi = constructAbiOfCallee(arm.value)
      if (abi === null || abi.receiver !== null || abi.restFrom !== null) continue
      for (let index = 0; index < abi.parameters.length; index++)
        conversions.nodeFor(operation.arguments[index]?.representation ?? { kind: 'undefined' }, abi.parameters[index]!.value)
      conversions.nodeFor(abi.result, operation.result.representation)
    }
    return
  }
  const abi =
    operation.kind === 'construct'
      ? (hostConstructFrameOf(operation) ?? constructAbiOfCallee(operation.callee.representation))
      : abiOfCallee(operation.callee.representation)
  if (abi === null) return
  for (let index = operation.arguments.length; index < abi.parameters.length; index++) {
    if (abi.restFrom !== null && index >= abi.restFrom) break
    conversions.nodeFor({ kind: 'undefined' }, abi.parameters[index]!.value)
  }
}

/**
 * Omitted fixed formals receive undefined through the existing conversion
 * census; trailing arguments are packed into the rest slot's own array.
 *
 * The rest half used to read the frame as though it were fixed: it compared the
 * argument sitting at the rest INDEX against the rest slot's array carrier --
 * which an element never matches -- and refused outright once a call supplied
 * more arguments than the convention declares parameters, which is precisely
 * what a rest parameter exists to accept. Every variadic call was an unmatched
 * frame for that reason alone.
 *
 * A rest slot "is an `array-object` like any other, and what varies is only who
 * builds the array, which is the caller". So the caller's obligation is exactly
 * that each argument it packs is already the array's ELEMENT carrier; packing
 * natively-typed values into a declared array crosses no dynamic boundary.
 */
export type CallFrameMatch =
  /**
   * Every operand arrives already held in the parameter's own carrier, so the
   * body receives the caller's values themselves. Provenance equates the two,
   * and the native class-initialization entry forwards the received operands
   * into the constructor unchanged -- neither survives a value that has to be
   * converted first, so this is the proof they ask for.
   */
  | 'value-identity'
  /**
   * Every operand reaches its parameter through a conversion that keeps both
   * sides in native storage. A weaker proof, and the one the reflection census
   * actually needs: its question is whether any operand crosses a `gea::Value`
   * boundary, not whose value the body ends up holding. Passing a `number` to a
   * `number | undefined` formal publishes nothing -- it constructs an optional
   * -- yet under `value-identity` it reads as an open callable boundary and
   * promotes the receiver and every argument to an unrestricted field protocol.
   *
   * `transfersNativeStorage` is the authority for a single edge; asking the
   * conversion census is deliberate, because the census is what owns the fact
   * and re-deriving it from carrier shapes here would invent a second opinion.
   */
  | 'native-transfer'

/** The default-slot rule, unchanged: an omitted formal's edge under value identity. */
const nativeDefaultCapability = (capability: ConversionCapability | undefined): boolean =>
  capability?.kind === 'identity' ||
  ((capability?.kind === 'atom' || capability?.kind === 'static' || capability?.kind === 'class-family') &&
    capability.materializer.nativeFieldProtocol === 'unused')

/** Whether the census carries `source` into `target` under this proof. */
const carriedNatively = (
  source: Representation,
  target: Representation,
  proof: CallFrameMatch,
  conversions?: Pick<ConversionCensus, 'nodeById'>
): boolean => {
  if (representationKey(source) === representationKey(target)) return true
  const node = conversions?.nodeById(conversionNodeIdOf(source, target))
  if (node === undefined || node === null || representationKey(node.source) !== representationKey(source)) return false
  if (representationKey(node.target) !== representationKey(target)) return false
  return proof === 'native-transfer' ? transfersNativeStorage(node.capability) : nativeDefaultCapability(node.capability)
}

export const nativeArgumentsMatch = (
  abi: CallableAbi,
  args: readonly IrOperand[],
  conversions?: Pick<ConversionCensus, 'nodeById'>,
  match: CallFrameMatch = 'value-identity'
): boolean => {
  const received = receivableArguments(abi, args)
  const restFrom = abi.restFrom
  if (restFrom !== null) {
    const slot = abi.parameters[restFrom]?.value
    if (slot === undefined || slot.kind !== 'array-object') return false
    const element = representationKey(slot.element)
    const rest = received.slice(restFrom)
    // Either the caller hands over the trailing values for this frame to pack,
    // or it hands over the packed array itself -- a spread already materialized
    // into one `array-object` arrives in the slot's own carrier, and reading it
    // as an element is what a lone trailing array would otherwise be mistaken
    // for.
    const carried = rest.length === 1 && representationKey(rest[0]!.representation) === representationKey(slot)
    if (!carried && !rest.every((argument) => representationKey(argument.representation) === element)) return false
  } else if (received.length > abi.parameters.length) return false
  return abi.parameters.every((parameter, index) => {
    if (restFrom !== null && index >= restFrom) return true
    const argument = received[index]
    // A supplied argument under value identity must BE the parameter's carrier;
    // an omitted one has always gone through the census, since the default it
    // receives is a conversion from `undefined` by construction.
    if (argument !== undefined && match === 'value-identity')
      return representationKey(argument.representation) === representationKey(parameter.value)
    return carriedNatively(argument?.representation ?? { kind: 'undefined' }, parameter.value, match, conversions)
  })
}

/** The carrier a callee's convention is stated on, through the wrappers that hold one. */
const unwrappedCalleeOf = (representation: IrOperand['representation']): IrOperand['representation'] =>
  representation.kind === 'optional'
    ? unwrappedCalleeOf(representation.payload)
    : representation.kind === 'borrowed-ref'
      ? unwrappedCalleeOf(representation.referent)
      : representation

/**
 * A method read through a union of classes -- `shadowMaterial.dispose()` on a
 * `MeshDepthMaterial | MeshDistanceMaterial` -- reaches a convention whose
 * receiver is the classes' shared ancestor. Lowering leaves such a receiver in
 * its union carrier: the printer either dispatches per arm (each arm an
 * upcast of its own `Ref`) or selects the payload into the stated receiver
 * through this census's node for the pair. The census node is minted there, at
 * print time -- after the reflection census has already asked `nodeById` for
 * it, found nothing, and read a native selection as an open call boundary that
 * promoted every field of both classes.
 *
 * So the pair is published before that census, exactly as the native sum
 * field reads in `call-dispatch.ts` publish theirs. Publishing decides
 * nothing: whether the frame closes remains `carriedNatively`'s question over
 * the node's own capability, and a node no printer asks for renders nothing.
 * A template-rendered call spells its receiver from the template rather than
 * through the frame, so it publishes no pair for one.
 */
const publishSumReceiverSelection = (operation: CallOperation, conversions: ConversionCensus): void => {
  if (operation.objectValueConversions !== undefined || operation.fixedDataDefinition !== undefined) return
  if (operation.intrinsicReflection !== undefined) return
  const receiver = operation.receiver
  if (receiver === null || receiver.representation.kind !== 'tagged-union') return
  const abi = abiOfCallee(unwrappedCalleeOf(operation.callee.representation))
  if (abi === null || abi.receiver === null || representationKey(receiver.representation) === representationKey(abi.receiver)) return
  conversions.nodeFor(receiver.representation, abi.receiver)
}

/** Publish a closed body's exact frame, including arguments it cannot observe. */
export const closedCallFrameOf = (
  operation: CallOperation,
  identity: CallCalleeIdentity | undefined,
  abiOf: (functionId: FunctionId) => CallableAbi | null,
  observed: ReadonlySet<IrValueId>,
  conversions?: Pick<ConversionCensus, 'nodeById'>,
  match: CallFrameMatch = 'value-identity'
): CallOperation['closedFrame'] => {
  if (identity === undefined || operation.argumentsAreSpread) return undefined
  const ids = identity.kind === 'exact' ? [identity.functionId] : identity.functionIds
  if (identity.nativeEntryAbi !== undefined && ids.length > 0 && ids.every((id) => abiOf(id) !== null))
    return nativeCallFrameOf(operation, identity.nativeEntryAbi, observed, conversions, match)
  const abi = ids[0] === undefined ? null : abiOf(ids[0])
  if (
    abi === null ||
    !ids.every((id) => {
      const candidate = abiOf(id)
      return candidate !== null && abiKey(candidate) === abiKey(abi)
    })
  )
    return undefined
  return nativeCallFrameOf(operation, abi, observed, conversions, match)
}

/** Frame selection shared by direct bodies and conversion-census native adapters. */
export const nativeCallFrameOf = (
  operation: CallOperation,
  abi: CallableAbi,
  observed: ReadonlySet<IrValueId>,
  conversions?: Pick<ConversionCensus, 'nodeById'>,
  match: CallFrameMatch = 'value-identity'
): CallOperation['closedFrame'] => {
  // A callee held as `optional`/`borrowed-ref` states the same convention its
  // payload does -- `abiOfCallee` answers only for the bare carrier, so the
  // wrapper alone used to read as "no convention at all" while every caller
  // that reaches here has already unwrapped it to find this `abi`.
  const heldAbi = abiOfCallee(unwrappedCalleeOf(operation.callee.representation))
  if (operation.argumentsAreSpread || heldAbi === null || abiKey(heldAbi) !== abiKey(abi)) return undefined
  const received = receivableArguments(abi, operation.arguments)
  // The receiver is an operand of this frame like any other, and the same
  // proof applies to it: a `Cat | Dog` narrowed to the `Animal` handle its
  // convention states crosses no dynamic boundary, and refusing it on carrier
  // spelling alone was the second-largest refusal this census reported.
  if (
    !nativeArgumentsMatch(abi, operation.arguments, conversions, match) ||
    (abi.receiver === null
      ? operation.receiver !== null
      : operation.receiver === null || !carriedNatively(operation.receiver.representation, abi.receiver, match, conversions))
  )
    return undefined
  const result = operation.result
  const disposition =
    result === null || !observed.has(result.id)
      ? 'ignored'
      : representationKey(result.representation) === representationKey(abi.result)
        ? 'exact'
        : // A void convention returns nothing, and JavaScript reads nothing as
          // `undefined`. The cell that receives it carries `undefined` when the
          // program typed the call, and `dynamic` when it typed it `any` -- the
          // same value either way, so the same disposition describes both. Only
          // the `undefined` spelling was admitted, which left every `any`-typed
          // call of a void body reading as an open boundary and promoting its
          // receiver and every argument.
          abi.result.kind === 'void' && (result.representation.kind === 'undefined' || result.representation.kind === 'dynamic')
          ? 'undefined'
          : null
  if (disposition === null) return undefined
  return { abi, receivedArguments: received.length, result: disposition }
}

/**
 * The frame of a call the printer spells from a HOST TEMPLATE rather than
 * through the callee's declared convention (`CallOperation.hostTemplate`).
 *
 * `true`: the template this call is printed by uses every operand in place, in
 * its own carrier, and puts nothing in a `gea::Value`. `false`: that cannot be
 * stated for these operands, and the call stays the open boundary it was. The
 * declared convention is NOT asked instead, because the printer never fills
 * it: `Object.assign`'s `(target: T, source: U) => T & U` matches a dictionary
 * source exactly while `assignText` walks that dictionary's runtime key table.
 * `undefined`: the call records no template -- or, for `Array.isArray` only,
 * its argument reaches the template's `gea::Value` overload, where the
 * declared `(arg: any)` convention IS what is printed and keeps deciding.
 *
 * Each arm states only what its template prints:
 *
 * - `array-is-array` -- `isArrayText` (emit-host-invoke.ts) answers from the
 *   argument's own carrier: a constant by kind, `has_value()` for an optional,
 *   the discriminant for a union. Nothing is converted and nothing is read
 *   through the carrier, and the C++ `bool` is the result, assigned as it is
 *   (`hostResultText`).
 * - `typed-array-set` -- `typedArrayCallText` (emit-buffers.ts):
 *   `setFrom(*source, offset)` for a typed-array source, `setFromArray(source,
 *   offset)` for an array of numbers, an `is<i>()`/`get<i>()` chain over a
 *   union of only those, and the offset operand's own text as the runtime's
 *   `double`. The expression's value is `gea::Undefined{}`. A third argument is
 *   never read; it is refused here rather than argued about.
 * - `object-assign` -- `assignText` (emit-host-object.ts), which returns the
 *   target itself. Into a Function object (`assignIntoCallableText`) each
 *   source field is stored through `callableDynamicSet` after the conversion
 *   `objectValueConversions` cites for it, so each of those must keep its value
 *   in native storage. Into a known struct each field is read off the source's
 *   own slot and stored into the target's declared slot through the census's
 *   node for that pair (`setOwnText`; `objectAssignFieldPairsOf`). The
 *   dictionary and dynamic arms walk runtime key tables through the dynamic
 *   protocol, and a key with no declared slot is boxed into the target's
 *   sidecar; none of those is stated here.
 */
export const hostTemplateFrameOf = (
  operation: CallOperation,
  conversions: Pick<ConversionCensus, 'nodeById'> | undefined,
  deriver: RepresentationDeriver | null,
  classes: ReadonlyMap<DeclarationId, ClassLayout> | null
): boolean | undefined => {
  const template = operation.hostTemplate
  if (template === undefined) return undefined
  const result = operation.result?.representation
  if (template === 'array-is-array') {
    const argument = operation.arguments[0]
    return !operation.argumentsAreSpread &&
      operation.arguments.length === 1 &&
      argument !== undefined &&
      isArrayAnsweredByCarrier(argument.representation) &&
      (result === undefined || (result.kind === 'scalar' && result.domain === 'boolean'))
      ? true
      : undefined
  }
  if (operation.argumentsAreSpread) return false
  if (template === 'typed-array-set') {
    const [source, offset] = operation.arguments
    return (
      source !== undefined &&
      operation.arguments.length <= 2 &&
      typedArraySetSourceAccepted(source.representation) &&
      (offset === undefined || (offset.representation.kind === 'scalar' && offset.representation.domain === 'number')) &&
      (result === undefined || result.kind === 'undefined' || result.kind === 'void')
    )
  }
  const target = operation.arguments[0]?.representation
  if (target === undefined || operation.arguments.length < 2 || deriver === null) return false
  if (result !== undefined && representationKey(result) !== representationKey(target)) return false
  if (isNativeCallableCarrier(target.kind)) return callablePropertiesStayNative(operation, conversions, deriver)
  const pairs = objectAssignFieldPairsOf(operation.arguments, deriver, classes)
  return pairs !== null && pairs.every((pair) => carriedNatively(pair.source, pair.target, 'native-transfer', conversions))
}

/**
 * Whether `isArrayText` answers this carrier without its `gea::Value` overload,
 * through the optional and union it also answers. The per-kind answer is the
 * printer's own table (`isArrayConstantOf`).
 */
const isArrayAnsweredByCarrier = (carrier: Representation): boolean =>
  carrier.kind === 'optional'
    ? isArrayAnsweredByCarrier(carrier.payload)
    : carrier.kind === 'tagged-union'
      ? carrier.arms.length > 0 && carrier.arms.every((arm) => isArrayAnsweredByCarrier(arm.value))
      : isArrayConstantOf(carrier.kind) !== null

/**
 * The fields of a carrier `objectViewFrom` gives a known view whose own keys
 * are exactly those fields: a record, a class, and a record-shaped
 * `native-record-ref` naming no host struct. A `record-with-index` is left out:
 * its index half is not among the fields the copy walks.
 */
const knownObjectFieldsOf = (carrier: Representation, deriver: RepresentationDeriver): readonly RecordField[] | null => {
  if (carrier.kind === 'record') return carrier.fields
  if (carrier.kind === 'class-ref' || (carrier.kind === 'native-record-ref' && carrier.native === null))
    return recordFieldsOfShape(deriver, carrier.shapeId)
  return null
}

/**
 * Every store `assignText`'s known-struct arm prints for these operands, as the
 * pair of carriers `setOwnText` reconciles through the conversion census -- or
 * `null` when the target or some source takes another arm, or when a source key
 * has no declared slot on the target (the printer then boxes the value into the
 * target's sidecar, or refuses).
 *
 * A source is copied as `assignOperandText` copies it: `null`/`undefined` copy
 * nothing, an optional copies its payload, and a union copies whichever arm is
 * live -- each arm `null`, `undefined` or a known shape.
 */
export const objectAssignFieldPairsOf = (
  args: readonly IrOperand[],
  deriver: RepresentationDeriver,
  classes: ReadonlyMap<DeclarationId, ClassLayout> | null
): readonly { readonly source: Representation; readonly target: Representation }[] | null => {
  const target = args[0]?.representation
  if (target === undefined || args.length < 2 || knownObjectFieldsOf(target, deriver) === null) return null
  const pairs: { readonly source: Representation; readonly target: Representation }[] = []
  const copied = (source: Representation): boolean => {
    const fields = knownObjectFieldsOf(source, deriver)
    if (fields === null) return false
    for (const field of fields) {
      const held = declaredFieldRepresentationOf(deriver, target, field.key, classes)
      if (held === null) return false
      pairs.push({ source: field.value, target: held })
    }
    return true
  }
  const absent = (source: Representation): boolean => source.kind === 'null' || source.kind === 'undefined'
  for (const argument of args.slice(1)) {
    const source = argument.representation
    const copies =
      absent(source) ||
      (source.kind === 'optional'
        ? copied(source.payload)
        : source.kind === 'tagged-union'
          ? source.arms.every((arm) => absent(arm.value) || copied(arm.value))
          : copied(source))
    if (!copies) return null
  }
  return pairs
}

/**
 * `assignIntoCallableText`'s stores: every field of every source, each through
 * the conversion `objectValueConversions` cites for it. The sources must be the
 * known shapes that arm accepts, and the citations exactly theirs.
 */
const callablePropertiesStayNative = (
  operation: CallOperation,
  conversions: Pick<ConversionCensus, 'nodeById'> | undefined,
  deriver: RepresentationDeriver
): boolean => {
  const cited = operation.objectValueConversions ?? []
  let stored = 0
  for (let index = 1; index < operation.arguments.length; index++) {
    const argument = operation.arguments[index]!.representation
    const fields = knownObjectFieldsOf(argument.kind === 'optional' ? argument.payload : argument, deriver)
    if (fields === null) return false
    for (const field of fields) {
      stored++
      const citation = cited.find((entry) => entry.argument === index && entry.field === field.key)
      if (citation === undefined || representationKey(citation.source) !== representationKey(field.value)) return false
      const node = conversions?.nodeById(citation.conversion)
      if (node === undefined || node === null || !transfersNativeStorage(node.capability)) return false
    }
  }
  return cited.length === stored
}

/**
 * Mint the pairs `objectAssignFieldPairsOf` states before the reflection census
 * asks for them. The printer mints each one while printing (`setOwnText`
 * through `alignedValueText`), after that census has already asked `nodeById`
 * and read a native slot copy as an open boundary. Publishing decides nothing:
 * whether the frame closes remains each node's own capability.
 */
export const publishObjectAssignFieldConversions = (
  args: readonly IrOperand[],
  deriver: RepresentationDeriver,
  classes: ReadonlyMap<DeclarationId, ClassLayout> | null,
  conversions: ConversionCensus
): void => {
  for (const pair of objectAssignFieldPairsOf(args, deriver, classes) ?? [])
    if (representationKey(pair.source) !== representationKey(pair.target)) conversions.nodeFor(pair.source, pair.target)
}
