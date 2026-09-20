import type { DeclarationId, FunctionId, SemanticResultId } from '../identity/ids.js'
import { narrowedOperandView } from '../conversion/operand-view.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { abiKey, type CallableAbi, type Representation } from '../representation/model.js'
import type { SealedRepresentationPlan } from '../representation/plan.js'
import { hostMemberOf, type HostMemberTable } from '../targets/cpp/host/host-members.js'
import type { BindingPlacement } from './bindings.js'
import type { ClassLayout } from './classes.js'
import { classMemberOf, classMethodOverrideOf, classStaticMemberOf } from './fields.js'
import { callableBuiltinIsUnshadowed, callableMutationFactsOf } from '../semantics/callable-origins.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { operandOf, resultOf, type SemanticOperand } from '../semantics/model/operands.js'
import type { InvocationOperation, SemanticOperation } from '../semantics/model/operations.js'

/**
 * What a callee carrier says about the frame a call fills.
 *
 * These queries are asked twice in the pipeline -- once when a call lowers
 * (`ir/lower-invocation.ts`) and once when the slot census states which
 * carrier each argument must arrive in (`projection/slots.ts`). They live
 * here, below both, so the two cannot drift: a lowering that packed
 * arguments against one reading of a callee and a census that checked them
 * against another would be two authorities over one convention.
 */

/** The convention a callable carrier states, or `null` for a carrier that states none. */
export const abiOfCallee = (representation: Representation): CallableAbi | null => {
  switch (representation.kind) {
    case 'function':
    case 'function-family':
    case 'function-value-family':
    case 'function-value-dispatch':
    case 'constructor-family':
    case 'constructor-value-dispatch':
      return representation.abi
    case 'function-and-constructor':
      return representation.call
    default:
      return null
  }
}

/**
 * The `[[Construct]]` convention a callee carries, which is the frame
 * `super(...)` and `new` fill.
 *
 * Distinct from `abiOfCallee` for exactly one carrier: a value that is both
 * callable and constructible states two conventions, and a construction fills
 * the constructing one. Reusing `abiOfCallee` there would pack the arguments
 * against a `[[Call]]` signature the base's initialization never reads.
 */
export const constructAbiOfCallee = (representation: Representation): CallableAbi | null => {
  if (representation.kind === 'function-and-constructor') return representation.construct
  return abiOfCallee(representation)
}

/**
 * The convention a method VALUE carries when a receiver-less slot takes it:
 * the source states a receiver and the slot states the identical convention
 * without one. Such a value is bound to the object it was read from before it
 * enters the slot (`ir/lower-operands.ts`'s `enter`, minting a detached
 * `bind-callable`); `null` for any other pair.
 */
export const detachedMethodAbiOf = (source: Representation, target: Representation): CallableAbi | null => {
  const from = abiOfCallee(source)
  const to = abiOfCallee(target)
  if (from === null || to === null || from.receiver === null || to.receiver !== null) return null
  return abiKey({ ...from, receiver: null }) === abiKey(to) ? from : null
}

/**
 * Whether a rest slot's carrier is a fixed-arity tuple: a record whose keys
 * are exactly `0..n-1` in order. Such a rest slot is filled field by field,
 * never by a runtime-sized array.
 */
export const isClosedContiguousTupleRecord = (
  representation: Representation
): representation is Extract<Representation, { kind: 'record' }> =>
  representation.kind === 'record' &&
  representation.accessors.length === 0 &&
  representation.fields.length > 0 &&
  representation.fields.every((field, index) => field.key === String(index))

/**
 * The value a body's `return` hands back, given the convention's own result:
 * the payload of an async function's promise, the completion of a generator's
 * cursor, and otherwise the result itself.
 */
export const returnPayloadOf = (result: Representation): Representation =>
  result.kind === 'promise' ? result.value : result.kind === 'iterator' ? result.completion : result

/**
 * A call through `Function.prototype.call`/`apply`/`bind` whose real callee
 * is the receiver of the member read, when the builtin is unshadowed and the
 * receiver's own convention is known.
 *
 * `receiver` is the operand of the PROPERTY READ that produced the call's
 * callee -- the function value itself -- not the invocation's own `receiver`
 * operand, which names that same function and is never read as `this`.
 */
export interface DeferredCallee {
  readonly member: 'call' | 'apply' | 'bind'
  readonly receiver: SemanticOperand
  readonly abi: CallableAbi
  readonly functionId: FunctionId | null
  /**
   * WHICH frame the rewritten call fills -- the one question `abi` above does
   * not answer, and the one both consumers of this record were assuming.
   *
   * `abi` is the underlying callable's own physical convention, recovered for
   * a `dynamic` receiver out of `functionId` so that a boxed Function can
   * still be bound and reasoned about. It is NOT the frame such a call fills:
   * `emit-callable.ts`'s `callee.kind === 'dynamic'` arm renders
   * `Value::callWithReceiver` with a flat `std::vector<Value>` and says why in
   * its own comment -- "there is no convention to build a frame against, so
   * the arguments cross as boxes and the callable's own declared parameters
   * are recovered by the thunk". Two authorities on one frame, and the
   * emitter is the one that is right.
   *
   * Measured: `routedFn.call(receiver, 'called', 4, 5)` over a rest-taking
   * `Routed` (`test/runtime/dynamic-callable-abi-recovery.runtime.js`). The
   * slot census converted `4, 5` to the rest ELEMENT carrier and the lowering
   * PACKED them into an `ArrayObject<double>`, which the emitter then boxed as
   * ONE argument -- and the callee's own `DynamicRestCallSignature` thunk,
   * doing the job the boxed convention gives it, packed a second time and
   * unboxed an array where a `double` was declared. `Function.prototype.call`
   * SPREADS; in the boxed frame the packing is the thunk's and the call
   * site's alone would be enough only if the call bypassed the box.
   */
  readonly frame: 'native' | 'boxed'
  /**
   * The RECEIVER's own carrier -- the boxed frame's argument carrier, and the
   * carrier the this-argument must keep its identity in. Carried here because
   * `receiver` above is an operand of the deferred property READ, not of the
   * invocation, so a consumer holding only the invocation cannot ask for it.
   */
  readonly receiverCarrier: Representation
}

export interface DeferredCalleeInput {
  readonly graph: SemanticGraph
  readonly plan: SealedRepresentationPlan
  readonly abis: ReadonlyMap<FunctionId, CallableAbi>
  readonly constructs: ReadonlyMap<FunctionId, CallableAbi>
  readonly callableOrigins: ReadonlyMap<SemanticResultId, FunctionId>
  readonly classes: ReadonlyMap<DeclarationId, ClassLayout>
}

/**
 * The source function a method read as a VALUE names: `host.readFile` read
 * off a class instance, or `Host.create` off its constructor, is the member
 * declaration's own body -- provenance `callableOriginsOf` cannot carry,
 * since it follows allocations and the cells that alias them, and a method
 * is never allocated. `null` for a read that is not that: a computed key, a
 * receiver that is no class, a member that is a field or an accessor, or a
 * value whose convention states no receiver (a bound callable, an arrow
 * field), which the read cannot have produced from a method body.
 *
 * Asked by the property lowering, which records the receiver a method value
 * must be bound to (`LoweringProgram.methodValueReceivers`), and by the
 * `Function.prototype.bind` rewrite below, which binds the same body.
 */
export const methodValueOriginOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  receiver: Representation,
  key: string,
  representation: Representation
): FunctionId | null => {
  if (abiOfCallee(representation)?.receiver === null) return null
  const isStatic = receiver.kind === 'constructor-family'
  const declarations = receiver.kind === 'class-ref' ? [receiver.declaration] : isStatic ? receiver.members : []
  for (const declaration of declarations) {
    if (!isStatic && classMethodOverrideOf(classes, declaration, key)) return null
    const site = isStatic ? classStaticMemberOf(classes, declaration, key) : classMemberOf(classes, declaration, key)
    if (site?.kind === 'method' && site.method.callable) return site.method.callable
  }
  return null
}

/** `methodValueOriginOf` for a property read operation, from the carriers the plan selected. */
const methodValueOriginOfRead = (input: DeferredCalleeInput, producer: SemanticOperation): FunctionId | null => {
  if (producer.family !== 'property' || producer.internalMethod !== 'get' || producer.keyIsComputed) return null
  const key = operandOf(producer, 'key')
  const receiver = operandOf(producer, 'receiver')
  const value = resultOf(producer, 'value')
  if (!key || key.source.kind !== 'constant' || !receiver || receiver.source.kind !== 'result' || !value) return null
  const held = input.plan.selected.get(receiver.source.result)
  const read = input.plan.selected.get(value.id)
  return held && read ? methodValueOriginOf(input.classes, held, key.source.text, read) : null
}

const callAbiOfCallableReceiver = (representation: Representation): CallableAbi | null => {
  switch (representation.kind) {
    case 'function':
    case 'function-family':
    case 'function-value-family':
    case 'function-value-dispatch':
      return representation.abi
    case 'function-and-constructor':
      return representation.call
    default:
      return null
  }
}

const bindAbiOfCallableReceiver = (representation: Representation): CallableAbi | null => {
  switch (representation.kind) {
    case 'function':
    case 'function-family':
    case 'function-value-family':
    case 'function-value-dispatch':
      return representation.abi
    default:
      return null
  }
}

const memberNames = ['call', 'apply', 'bind'] as const

export const deferredCalleeOf = (input: DeferredCalleeInput, operation: InvocationOperation): DeferredCallee | null => {
  if (operation.internalMethod !== 'call' || operation.optionalChain) return null
  const callee = operandOf(operation, 'callee')
  if (!callee || callee.source.kind !== 'result') return null
  const producerId = input.graph.results.get(callee.source.result)
  const producer = producerId === undefined ? undefined : input.graph.operations.get(producerId)
  if (!producer || producer.family !== 'property' || producer.internalMethod !== 'get' || producer.keyIsComputed) return null
  const key = operandOf(producer, 'key')
  if (!key || key.source.kind !== 'constant') return null
  const keyText = key.source.text
  const member = memberNames.find((name) => name === keyText)
  if (!member) return null
  const receiver = operandOf(producer, 'receiver')
  if (!receiver || receiver.source.kind !== 'result') return null
  const representation = input.plan.selected.get(receiver.source.result)
  if (!representation) return null
  const receiverProducerId = input.graph.results.get(receiver.source.result)
  const receiverProducer = receiverProducerId === undefined ? undefined : input.graph.operations.get(receiverProducerId)
  const functionId =
    input.callableOrigins.get(receiver.source.result) ?? (receiverProducer ? methodValueOriginOfRead(input, receiverProducer) : null)
  const facts = callableMutationFactsOf(input.graph, input.plan, input.callableOrigins)
  if (!callableBuiltinIsUnshadowed(facts, functionId, member)) return null
  // Read off the receiver's own carrier, which is what decides how the call
  // renders -- see `DeferredCallee.frame`.
  const frame = representation.kind === 'dynamic' ? 'boxed' : 'native'
  if (member === 'bind') {
    // `functionId` names the checker-authenticated DECLARATION a `dynamic`
    // receiver's own-property facts are read off -- needed only to recover a
    // boxed Function's native ABI (`emit-callable.ts`'s `bindCallable`, the
    // `operation.source.representation.kind === 'dynamic'` branch). A
    // `function-value-dispatch` receiver already carries its own physical
    // ABI on the representation itself and needs no such lookup: a bind
    // chained off ANOTHER bind's result (`bound.bind(...)`) has no known
    // origin -- `callableOriginsOf` traces identity through ordinary
    // allocations and bindings, never through a prior `.bind()` -- and
    // unconditionally refusing for `functionId === null` bailed out of the
    // native fast path for exactly that non-dynamic, well-typed case, onto
    // an ordinary property-read whose STATIC checker type (`.bind`'s own
    // generic signature, `thisArg: T` inferred from the call's actual
    // argument) is a completely different, wrong convention for calling the
    // already-typed receiver directly.
    const abi =
      representation.kind === 'dynamic'
        ? functionId !== null && !input.constructs.has(functionId)
          ? (input.abis.get(functionId) ?? null)
          : null
        : bindAbiOfCallableReceiver(representation)
    return abi ? { member, receiver, abi, functionId, frame, receiverCarrier: representation } : null
  }
  if (functionId === null && representation.kind !== 'function-value-dispatch') return null
  const abi =
    representation.kind === 'dynamic' && functionId !== null
      ? (input.abis.get(functionId) ?? null)
      : callAbiOfCallableReceiver(representation)
  return abi ? { member, receiver, abi, functionId, frame, receiverCarrier: representation } : null
}

/**
 * How a call reaches its callee: through a callable VALUE with a physical
 * convention (`callable`), or through a TEMPLATE the backend spells from the
 * call's own operands (`template`) -- a host member on a native handle, a
 * `String`/`Array`/`Promise`/`RegExp` prototype method, a host-placed
 * function, a generator cursor's `next`. A template never sees the declared
 * convention: `substring`'s optional `end` is a C++ overload there, not a
 * `gea::Optional<double>` formal, so an argument reaching one must stay in
 * its own carrier. The slot census reads this to answer `host-overload` for
 * those arguments instead of the lib.d.ts formal the callee's carrier states.
 *
 * Decided from the callee's provenance -- the read that produced it and the
 * carrier that read went through -- which is the same fact the printer's
 * property-read emitters decide it from when they defer a read into
 * `hostMemberReads`/`prototypeMethodReads` rather than materializing a
 * value. A receiver this cannot see is read as `callable`, which is the
 * conservative side for nothing: a template rendered for an argument the
 * census converted is a C++ overload mismatch, so every receiver kind the
 * printer spells from a template must be named here.
 */
export type CalleeRendering = 'callable' | 'template'

/**
 * `hasOwnProperty`/`propertyIsEnumerable` reached as instance methods off a
 * known-shape receiver (`record`/`class-ref`/a `native-record-ref` naming no
 * native type) -- the two ambient `Object.prototype` members the C++
 * backend's object-shape protocol (`targets/cpp/host/object-protocol.ts`'s
 * `objectShapePrototypeMemberRead`) claims regardless of the receiver's own
 * layout: the GET renders nothing and the CALL fuses receiver, key and field
 * list into one expression, never going through `Object.prototype`'s
 * declared `(v: PropertyKey) => boolean` convention. `calleeRenderingOf`
 * below is the ONE authority for whether a call renders from a template or a
 * convention, so it states this claim too, rather than leaving the printer
 * as a second, silent authority the census cannot see: a census that let
 * this call's ABI apply would convert a literal string key into the
 * `PropertyKey` tagged union, which `objectShapeCallText` explicitly refuses.
 */
export const objectShapePrototypeMethods: ReadonlySet<string> = new Set(['hasOwnProperty', 'propertyIsEnumerable'])

export interface CalleeRenderingInput {
  readonly graph: SemanticGraph
  readonly plan: SealedRepresentationPlan
  readonly deriver: RepresentationDeriver
  readonly placements: ReadonlyMap<DeclarationId, BindingPlacement>
  /** Declarations that hold one host method forever -- see `hostMethodAliasDeclarations`. */
  readonly hostMethodAliasDeclarations: ReadonlySet<DeclarationId>
  readonly hostMembers?: HostMemberTable
}

/** A direct read of a host callable whose numeric rest frame need not escape to an array. */
export const numericRestHostCallOf = (
  input: CalleeRenderingInput,
  operation: InvocationOperation
): { readonly protocol: string; readonly member: string } | null => {
  if (operation.internalMethod !== 'call' || operation.optionalChain || !input.hostMembers) return null
  const callee = operandOf(operation, 'callee')
  if (callee?.source.kind !== 'result') return null
  const producerId = input.graph.results.get(callee.source.result)
  const producer = producerId === undefined ? undefined : input.graph.operations.get(producerId)
  if (producer?.family !== 'property' || producer.internalMethod !== 'get' || producer.keyIsComputed) return null
  const receiver = operandOf(producer, 'receiver')
  const key = operandOf(producer, 'key')
  if (receiver?.source.kind !== 'result' || key?.source.kind !== 'constant') return null
  const held = input.plan.selected.get(receiver.source.result)
  if (held?.kind !== 'native-handle') return null
  const protocol = held.native ?? held.protocol
  const member = key.source.text
  const host = hostMemberOf(input.hostMembers, protocol, member)
  return host?.kind === 'property' && host.numericRestCall !== undefined ? { protocol, member } : null
}

/**
 * Declarations written exactly once, from a direct read of a host METHOD --
 * `var __isArray = Array.isArray`, the shape test262's propertyHelper and any
 * program guarding a later monkey-patch names a builtin through.
 *
 * `targets/cpp/host/host-method-aliases.ts` proves the identical fact, but
 * over the LOWERED ir, for the printer to fold a read of the cell back into a
 * bare host-member name. `calleeRenderingOf` needs the same fact one stage
 * earlier, over the semantic graph and its sealed plan -- before lowering
 * builds a call's argument `convert`s -- because a call through such a cell
 * renders as a host call-site template exactly like `Array.isArray(v)`
 * itself, and a template's arguments enter their OWN carrier
 * (`invocationSlot`'s `host-overload`), never the `dynamic` an ordinary
 * callable's declared-`any` formal would otherwise ask the census for. Both
 * live on the sealed plan, which is why this can answer without waiting for
 * a lowered body: a `native-handle` receiver and a host member table are
 * exactly what the plan and `hosts.members` already state.
 */
export const hostMethodAliasDeclarations = (
  graph: SemanticGraph,
  plan: SealedRepresentationPlan,
  deriver: RepresentationDeriver,
  hostMembers: HostMemberTable
): ReadonlySet<DeclarationId> => {
  const methodReads = new Set<SemanticResultId>()
  for (const operation of graph.operations.values()) {
    if (operation.family !== 'property' || operation.internalMethod !== 'get' || operation.keyIsComputed) continue
    const key = operandOf(operation, 'key')
    if (!key || key.source.kind !== 'constant') continue
    const receiver = operandOf(operation, 'receiver')
    if (!receiver) continue
    const held =
      receiver.source.kind === 'result'
        ? (plan.selected.get(receiver.source.result) ?? null)
        : receiver.source.kind === 'constant'
          ? deriver.derive(receiver.type)
          : null
    if (held === null) continue
    const view = narrowedOperandView(held, receiver, deriver)
    const carrier = view.kind === 'borrowed-ref' ? view.referent : view
    if (carrier.kind !== 'native-handle') continue
    const protocol = carrier.native ?? carrier.protocol
    if (hostMemberOf(hostMembers, protocol, key.source.text)?.kind !== 'method') continue
    const result = resultOf(operation, 'value')
    if (result) methodReads.add(result.id)
  }
  const writeCounts = new Map<DeclarationId, number>()
  const written = new Set<DeclarationId>()
  for (const operation of graph.operations.values()) {
    if (operation.family !== 'binding' || (operation.action !== 'write' && operation.action !== 'initialize')) continue
    writeCounts.set(operation.declaration, (writeCounts.get(operation.declaration) ?? 0) + 1)
    // `var x = Array.isArray` publishes an `initialize` whose operand is the
    // `initializer`; a later `x = ...` is a `write` of a `value`.
    const value = operandOf(operation, 'initializer') ?? operandOf(operation, 'value')
    if (value?.source.kind === 'result' && methodReads.has(value.source.result)) written.add(operation.declaration)
  }
  const aliases = new Set<DeclarationId>()
  for (const declaration of written) if (writeCounts.get(declaration) === 1) aliases.add(declaration)
  return aliases
}

const templateReceiverKinds: ReadonlySet<Representation['kind']> = new Set<Representation['kind']>([
  'native-handle',
  'string',
  'scalar',
  'array-object',
  'typed-array',
  'keyed-collection',
  'promise',
  'iterator',
  'dictionary',
  'array-buffer',
  'shared-array-buffer',
  'data-view',
  'dense-buffer',
  'native-sequence',
  'proxy-object',
  'dynamic',
  'optional',
  'tagged-union',
  'symbol'
])

export const calleeRenderingOf = (input: CalleeRenderingInput, operation: InvocationOperation): CalleeRendering => {
  // `Object.keys`/`getOwnPropertyNames`/`getOwnPropertySymbols`/`Reflect.ownKeys`
  // are already checker-authenticated above this call
  // (`intrinsic-property-call.ts`'s `intrinsicPropertyCallOf`, gated on
  // standard-library provenance for both the owner and the member, with no
  // global host-mutation taint) -- `operation.intrinsicOwnKeys` IS that
  // authentication, not a guess about this callee's shape. Without this, the
  // generic receiver-kind walk below has to answer for the OWNER of the
  // property read (`Object`/`Reflect` itself) rather than the call's real
  // subject, and neither read as a `template` receiver: the ambient
  // `ObjectConstructor`/`Reflect` singleton is never given a `native-handle`
  // tag the way `Math`/`Date`/`JSON` are (`host-protocols.ts` binds those by a
  // plugin-supplied native-protocol table; `Object`'s own statics are answered
  // by this backend's dedicated `[[OwnPropertyKeys]]` primitives in
  // `targets/cpp/host/object-protocol.ts` instead, which never registers a
  // handle tag for the receiver `Object` itself). Falling through to
  // `'callable'` published the intrinsic's *declared* `(o: object) => string[]`
  // ABI as the call's convention, whose vacuous `object` parameter this
  // program models soundly on its own (an empty `record`, per
  // `representation/derive.ts`'s `deriveObject`) but which the generic
  // argument-conversion path cannot honor without erasing the real argument's
  // type to match it -- exactly the "intrinsic accepts any object, so the
  // argument becomes dynamic" defect this authentication exists to prevent.
  // `lower-invocation.ts` already licenses `intrinsicOwnKeys` through to the
  // IR ONLY when this function answers `'template'`
  // (`operation.intrinsicOwnKeys && calleeRenderingOf(...) === 'template'`) --
  // so answering it here, directly from the same authenticated fact, closes
  // the license this function was always supposed to grant instead of gating
  // it behind a receiver classification that was never going to recognize it.
  if (operation.intrinsicOwnKeys) return 'template'
  // `Object.defineProperty` on a closed data descriptor is the same shape of
  // authenticated fact, one call later: `intrinsic-data-definition.ts`'s
  // `intrinsicDataDefinitionTargetOf` (consumed by `producers/invocations.ts`
  // as `operation.intrinsicDataDefinition`, alongside the host-mutation
  // census's own `operation.intrinsicMutation === 'object-define-property'`)
  // has ALREADY proven the receiver is not published by this call and the
  // descriptor names only `value`/`writable`/`enumerable`/`configurable`.
  // `lower-invocation.ts`'s `fixedDataDefinition` is written to consume
  // exactly that pair through `fixedDataDefinitionRecipeOf`, gated on this
  // function answering `'template'` -- but nothing here ever did, so every
  // authenticated call still fell through to the generic receiver-kind walk
  // below. `Object` itself is not a `native-handle` (same reason
  // `intrinsicOwnKeys` names above), so it answered `'callable'`, publishing
  // `defineProperty`'s OWN ambient `(o, p, attributes: PropertyDescriptor &
  // ThisType<any>) => any` signature as the call's ABI -- `PropertyDescriptor`
  // types `value` as `any`, so THAT declared signature, not the literal
  // descriptor each call site actually writes, became the carrier: three's
  // `Object3D` constructor defines `position`/`rotation`/`quaternion`/`scale`
  // this way, and every one of those `Object.defineProperty` call sites
  // selected a `dynamic` `.value` field for a descriptor whose own literal
  // states a concrete `Vector3`/`Euler`/`Quaternion`. Answering `'template'`
  // here closes the same license `intrinsicOwnKeys` closes above, from the
  // same authenticated fact, instead of a receiver classification that was
  // never going to recognize `Object` as one either.
  if (operation.intrinsicMutation === 'object-define-property' && operation.intrinsicDataDefinition === true) return 'template'
  const callee = operandOf(operation, 'callee')
  if (!callee) return 'callable'
  if (callee.source.kind === 'parameter' || callee.source.kind === 'constant') return 'callable'
  if (callee.source.kind !== 'result') return 'callable'
  const producerId = input.graph.results.get(callee.source.result)
  const producer = producerId === undefined ? undefined : input.graph.operations.get(producerId)
  if (!producer) return 'callable'
  if (producer.family === 'binding' && producer.action === 'read') {
    // A host FUNCTION is called through the convention its declaration
    // states -- the printer's host-function path fills that frame with
    // `argumentText` like any callable -- so its arguments have slots. A
    // host class, singleton or namespace read is a member path the printer
    // spells from a template.
    const storage = input.placements.get(producer.declaration)?.storage.kind
    if (storage === 'host-class' || storage === 'host-singleton' || storage === 'host-namespace') return 'template'
    // A cell that holds one host METHOD forever (`var __isArray =
    // Array.isArray`) is the same template shape one indirection later --
    // see `hostMethodAliasDeclarations`.
    return input.hostMethodAliasDeclarations.has(producer.declaration) ? 'template' : 'callable'
  }
  if (producer.family !== 'property' || producer.internalMethod !== 'get') return 'callable'
  if (producer.hostMethod !== undefined) return 'template'
  const receiver = operandOf(producer, 'receiver')
  if (!receiver) return 'callable'
  const held =
    receiver.source.kind === 'result'
      ? (input.plan.selected.get(receiver.source.result) ?? null)
      : receiver.source.kind === 'constant'
        ? input.deriver.derive(receiver.type)
        : null
  if (held === null) return 'template'
  const view = narrowedOperandView(held, receiver, input.deriver)
  // A receiver with no storage (`undefined`/`null`, the carrier of a branch
  // flow analysis proved dead) registers no template read at all, so the
  // printer falls through to the callable path and the ABI's slots apply.
  const carrier = view.kind === 'borrowed-ref' ? view.referent : view
  // `hasOwnProperty`/`propertyIsEnumerable` off a shape the object-shape
  // protocol claims (see `objectShapePrototypeMethods`'s own comment) render
  // from a template no matter which of those shapes the receiver is, ahead
  // of the general per-kind answer below -- a `record`/`class-ref` is not in
  // `templateReceiverKinds` at all (its OTHER members are real ABI calls),
  // and a `native-record-ref` naming no native type answers 'callable' next.
  const key = operandOf(producer, 'key')
  const staticKey = key?.source.kind === 'constant' ? key.source.text : null
  const knownObjectShape =
    carrier.kind === 'record' || carrier.kind === 'class-ref' || (carrier.kind === 'native-record-ref' && carrier.native === null)
  if (staticKey !== null && knownObjectShape && objectShapePrototypeMethods.has(staticKey)) return 'template'
  if (carrier.kind === 'native-record-ref') return carrier.native === null ? 'callable' : 'template'
  return templateReceiverKinds.has(carrier.kind) ? 'template' : 'callable'
}
