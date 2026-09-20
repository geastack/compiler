import type { DeclarationId, FunctionId, IrValueId, PhysicalBodyId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { ClassLayout } from '../projection/classes.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import { closedRecordCallablesOf } from './callable-records.js'
import { closedClassFieldCallablesOf } from './callable-class-flow.js'
import { closedStaticCallablesOf } from './static-callables.js'
import { explicitObjectConstructEntryOf } from './construct-entry.js'
import { closedCallFrameOf, publishOmittedArgumentConversions } from './call-entry.js'
import type { ConversionCensus } from '../conversion/nodes.js'
import { classFamilyOverridesOf, virtualDispatchKey, type VirtualDispatchVerdict } from '../projection/dispatch.js'
import { classMemberOf, classMethodOverrideOf, classPrototypeMethodMutableOf, declaredRecordFieldOf } from '../projection/fields.js'
import { abiKey, representationKey, walkRepresentation, type CallableAbi, type Representation } from '../representation/model.js'
import { abiOfCallee } from '../projection/callee.js'
import { classInstanceTestOf, classViewCarrierKinds } from '../projection/instance-test.js'
import { classPrototypeReadOf } from '../projection/class-prototype.js'
import type { ReflectionExposure } from './reflection-demand.js'
import {
  type CallCalleeIdentity,
  type CallDispatchTarget,
  type CallOperation,
  type CallUnionArmTarget,
  type GetOperation,
  type IrBlock,
  type IrBlockId,
  type IrBody,
  type IrNonTerminatorOperation
} from './model.js'
import { operandsOfIrOperation, resultOfIrOperation } from './queries.js'

/**
 * Fills the post-shake call facts. `CallOperation.target` says which
 * FunctionId (if any) a call's callee can use for physical devirtualization,
 * while `CallOperation.closedCallee` records the same producer/member identity
 * without requiring capture-free physical dispatch. The latter is consumed by
 * semantic censuses; it never changes the emitted call path.
 *
 * Run once, after `splitGeneratorBodies` and after `ir/captures.ts`'s
 * `publishCaptureFacts` (`compiler.ts`), the same body-rewrite pattern
 * `ir/generator-split.ts` uses -- applied to OPERATIONS rather than to whole
 * bodies, because the fact this file adds lives on one `call`, not on a
 * body. It has to run there and not during `lowerToIr` because every non-
 * `unresolved` answer bottoms out in the same test: does the callee's own
 * body capture anything (`IrBody.facts.capturedDeclarations`/
 * `.capturedReceiver`), and that fact is not published until the program has
 * been shaken (this was blocked before `ir/captures.ts` moved to publishing the call
 * target as a sealed fact).
 *
 * Deliberately conservative, like `ir/generator-split.ts`: any callee shape
 * this module does not recognize -- a parameter, a `dynamic` value, a
 * `generic-function-set` tag (that dispatch is `CallOperation.family`'s own,
 * a different question), a computed key, a union arm this program cannot
 * prove is a closed class hierarchy -- is left `unresolved`, which is
 * exactly the ordinary indirect call every callee carrier already supports.
 * A wrong `unresolved` costs an indirect call; a wrong `direct`/`virtual`/
 * `union-arm` would call the wrong body, so every branch here only answers
 * when it can PROVE the target.
 */
export const fillCallDispatchTargets = (
  bodies: ReadonlyMap<PhysicalBodyId, IrBody>,
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  abiOf: (callable: FunctionId) => CallableAbi | null,
  capturesNothing: (callable: FunctionId) => boolean,
  verdict: VirtualDispatchVerdict,
  deriver: RepresentationDeriver | null = null,
  conversions?: ConversionCensus,
  exposure?: ReflectionExposure
): ReadonlyMap<PhysicalBodyId, IrBody> => {
  const bodyList = [...bodies.values()]
  // The one whole-program fact `CallOperation.target`'s `direct` case needs
  // for a callee read out of a binding cell: which module-level cells hold
  // one capture-free callable forever. Mirrors `targets/cpp/captures.ts`'s
  // `buildDirectCallableIndex`, minus the render-time `cppTypeOf` mismatch
  // guard -- `representationKey` is that same identity question asked at the
  // representation layer instead of the printer's, which is the more
  // faithful spelling of "the cell and the held value agree on convention"
  // and is what every OTHER site in this compiler already uses to compare
  // two carriers for equality.
  const callableBindings = callableBindingsOf(bodyList, placements, capturesNothing)
  const observed = new Set<IrValueId>()
  const fieldKeys = new Map<IrValueId, string>()
  for (const body of bodyList)
    for (const block of body.blocks.values())
      for (const operation of [...block.operations, block.terminator]) {
        for (const operand of operandsOfIrOperation(operation)) observed.add(operand.value)
        if (operation.kind === 'constant' && operation.literal === 'string') fieldKeys.set(operation.result.id, operation.text)
        if (conversions && (operation.kind === 'call' || operation.kind === 'construct'))
          publishOmittedArgumentConversions(operation, conversions)
      }
  if (conversions && deriver)
    for (const body of bodyList)
      for (const block of body.blocks.values())
        for (const operation of block.operations) {
          if (operation.kind !== 'get' || operation.receiver.representation.kind !== 'tagged-union') continue
          const key = fieldKeys.get(operation.key.value)
          if (key === undefined) continue
          // A native sum field read converts each selected field into the
          // joined result. Publish those same pairs before field reflection
          // asks whether that transport needs the dynamic protocol.
          for (const arm of operation.receiver.representation.arms) {
            const field = declaredRecordFieldOf(deriver, arm.value, key, classes)
            if (field) conversions.nodeFor(field.value, operation.result.representation)
          }
        }
  const callableMembers = new Map([
    ...closedClassFieldCallablesOf(bodyList, placements, classes, conversions, undefined, deriver),
    ...closedRecordCallablesOf(
      bodyList,
      placements,
      callableBindings.closed,
      deriver,
      conversions,
      exposure ? { classes, exposure } : undefined
    ),
    ...closedStaticCallablesOf(bodyList, placements, classes)
  ])
  const prototypes = materializedClassPrototypesOf(bodyList, classes)
  const viewed = viewedClassesOf(bodyList)
  const next = new Map<PhysicalBodyId, IrBody>()
  for (const body of bodyList) {
    next.set(
      body.owner,
      rewriteBody(
        body,
        classes,
        abiOf,
        capturesNothing,
        verdict,
        callableBindings,
        callableMembers,
        observed,
        prototypes,
        viewed,
        conversions
      )
    )
  }
  return next
}

/**
 * Every class whose native prototype OBJECT this program can materialize.
 * `class-properties/native-prototype.ts` renders exactly the reads
 * `classPrototypeReadOf` admits; a key that is not a known constant is
 * counted too, since it may name `prototype`. Such an object uses its class's
 * native layout without being its instance, which the instance-test census
 * must not answer from the layout alone (`projection/instance-test.ts`).
 */
const materializedClassPrototypesOf = (
  bodies: readonly IrBody[],
  classes: ReadonlyMap<DeclarationId, ClassLayout>
): ReadonlySet<DeclarationId> => {
  const prototypes = new Set<DeclarationId>()
  for (const body of bodies) {
    const producers = producerMapOf(body)
    for (const block of body.blocks.values())
      for (const operation of block.operations) {
        if (operation.kind !== 'get') continue
        const key = constantStringKeyOf(operation.key.value, producers)
        if (key !== null && key !== 'prototype') continue
        const layout = classPrototypeReadOf(classes, operation.receiver.representation, 'prototype', operation.result.representation)
        if (layout !== null) prototypes.add(layout.declaration)
      }
  }
  return prototypes
}

/**
 * Every class a `convert` in this program turns into a structural view.
 *
 * `convert` is where a carrier changes (`conversion/nodes.ts`: the lowering
 * records the node on the instruction and the printer renders that node), so
 * a class instance becomes a record view nowhere else. Nested carriers count:
 * converting an array of instances converts each one. A class anywhere in
 * the source against a view kind anywhere in the target is counted, which
 * over-approximates and can only refuse more.
 */
const leafKeysOf = (carrier: Representation, into: Set<string>): Set<string> => {
  if (carrier.kind === 'optional') return leafKeysOf(carrier.payload, into)
  if (carrier.kind === 'tagged-union') for (const arm of carrier.arms) leafKeysOf(arm.value, into)
  else into.add(representationKey(carrier))
  return into
}

const unionArmKeysOf = (carrier: Representation): ReadonlySet<string> | null => {
  const payload = carrier.kind === 'optional' ? carrier.payload : carrier
  return payload.kind === 'tagged-union' ? leafKeysOf(payload, new Set()) : null
}

/**
 * A load of some of a union's own arms: the arms left out -- a class the
 * guard excluded (`!(init instanceof Headers)`) -- are checked away, not
 * viewed.
 */
const narrowsArms = (source: Representation, target: Representation): boolean => {
  const arms = unionArmKeysOf(source)
  if (arms === null) return false
  const kept = leafKeysOf(target, new Set())
  return [...kept].every((key) => arms.has(key))
}

const viewedClassesOf = (bodies: readonly IrBody[]): ReadonlySet<DeclarationId> => {
  const viewed = new Set<DeclarationId>()
  for (const body of bodies)
    for (const block of body.blocks.values())
      for (const operation of block.operations) {
        if (operation.kind !== 'convert') continue
        const classes = [...walkRepresentation(operation.source.representation)].flatMap((carrier) =>
          carrier.kind === 'class-ref' ? [carrier.declaration] : []
        )
        if (classes.length === 0) continue
        if (narrowsArms(operation.source.representation, operation.result.representation)) continue
        const target = [...walkRepresentation(operation.result.representation)]
        if (!target.some((carrier) => classViewCarrierKinds.has(carrier.kind))) continue
        // A class the target still carries as itself is stored in that arm,
        // not viewed: `HeadersInit` into a wider `HeadersInit` keeps its
        // `Headers` arm beside the dictionary one.
        const kept = new Set(target.flatMap((carrier) => (carrier.kind === 'class-ref' ? [carrier.declaration] : [])))
        for (const declaration of classes) if (!kept.has(declaration)) viewed.add(declaration)
      }
  return viewed
}

/**
 * The class whose prototype object `value` is, when its producer -- through
 * converts, which change only the carrier of the same language value -- is a
 * prototype read the native lowering admits.
 */
const classPrototypeOf = (
  value: IrValueId,
  producers: ReadonlyMap<IrValueId, IrNonTerminatorOperation>,
  classes: ReadonlyMap<DeclarationId, ClassLayout>
): DeclarationId | null => {
  const seen = new Set<IrValueId>()
  for (let current = value; !seen.has(current);) {
    seen.add(current)
    const producer = producers.get(current)
    if (producer === undefined) return null
    if (producer.kind === 'convert') {
      current = producer.source.value
      continue
    }
    if (producer.kind !== 'get' || constantStringKeyOf(producer.key.value, producers) !== 'prototype') return null
    return classPrototypeReadOf(classes, producer.receiver.representation, 'prototype', producer.result.representation)?.declaration ?? null
  }
  return null
}

interface CallableBindingFacts {
  readonly direct: ReadonlyMap<DeclarationId, FunctionId>
  /** Bindings whose unique write names a compiler-owned callable, regardless of captures. */
  readonly closed: ReadonlyMap<DeclarationId, FunctionId>
}

const callableBindingsOf = (
  bodies: readonly IrBody[],
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  capturesNothing: (callable: FunctionId) => boolean
): CallableBindingFacts => {
  const allocated = new Map<IrValueId, FunctionId>()
  const captureFreeAllocated = new Set<IrValueId>()
  const writeCounts = new Map<DeclarationId, number>()
  const writtenCallable = new Map<DeclarationId, FunctionId>()
  const writtenCallableValue = new Map<DeclarationId, IrValueId>()
  const writtenCarriers = new Map<DeclarationId, Representation>()
  for (const body of bodies) {
    for (const blockId of body.blockOrder) {
      const block = body.blocks.get(blockId)
      if (!block) continue
      for (const operation of block.operations) {
        if (operation.kind === 'allocate-callable') {
          allocated.set(operation.result.id, operation.functionId)
          if (capturesNothing(operation.functionId)) captureFreeAllocated.add(operation.result.id)
        } else if (operation.kind === 'binding-write') {
          writeCounts.set(operation.declaration, (writeCounts.get(operation.declaration) ?? 0) + 1)
          const functionId = allocated.get(operation.value.value)
          if (functionId !== undefined) {
            writtenCallable.set(operation.declaration, functionId)
            writtenCallableValue.set(operation.declaration, operation.value.value)
            writtenCarriers.set(operation.declaration, operation.value.representation)
          }
        }
      }
    }
  }
  const direct = new Map<DeclarationId, FunctionId>()
  const closed = new Map<DeclarationId, FunctionId>()
  for (const [declaration, functionId] of writtenCallable) {
    if (writeCounts.get(declaration) !== 1) continue
    // The cell and the function it holds can disagree about the CONVENTION
    // even when the language calls them the same function -- see
    // `targets/cpp/captures.ts`'s `buildDirectCallableIndex` for the worked
    // hono example this guards against.
    const cell = placements.get(declaration)?.representation
    const held = writtenCarriers.get(declaration)
    if (cell && held && representationKey(cell) !== representationKey(held)) continue
    const placement = placements.get(declaration)
    const localOrRegion = placement?.storage.kind === 'local' || placement?.storage.kind === 'region'
    // A host/external cell is a publication boundary even when this IR
    // happens to contain one write citation.  Only a sealed compiler-owned
    // cell can authenticate the callable identity for reflection.
    if (localOrRegion) closed.set(declaration, functionId)
    const writtenValue = writtenCallableValue.get(declaration)
    if (writtenValue !== undefined && captureFreeAllocated.has(writtenValue)) direct.set(declaration, functionId)
  }
  return { direct, closed }
}

const producerMapOf = (body: IrBody): ReadonlyMap<IrValueId, IrNonTerminatorOperation> => {
  const map = new Map<IrValueId, IrNonTerminatorOperation>()
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    for (const operation of block.operations) {
      const result = resultOfIrOperation(operation)
      if (result) map.set(result.id, operation)
    }
  }
  return map
}

const unresolvedTarget: CallDispatchTarget = { kind: 'unresolved' }

const constantStringKeyOf = (key: IrValueId, producers: ReadonlyMap<IrValueId, IrNonTerminatorOperation>): string | null => {
  const producer = producers.get(key)
  return producer !== undefined && producer.kind === 'constant' && producer.literal === 'string' ? producer.text : null
}

interface ResolvedCall {
  readonly target: CallDispatchTarget
  readonly closedCallee?: CallCalleeIdentity
}

const unresolvedCall: ResolvedCall = { target: unresolvedTarget }

const identityOfFunctions = (ids: readonly FunctionId[]): CallCalleeIdentity => {
  const functionIds = [...new Set(ids)]
  return functionIds.length === 1 ? { kind: 'exact', functionId: functionIds[0]! } : { kind: 'closed-family', functionIds }
}

/**
 * Which copy of a same-key method this read means, by the convention the read
 * itself published.
 *
 * A GENERIC method has one body per type argument and every copy installs
 * itself under the method's own name, so the key alone names several bodies.
 * The read is the site that knows: `n.map((v) => 'x!')` publishes
 * `((number) -> string) -> string`, which is the `R = string` copy's frame and
 * no other's. Without this, the first copy answered every read, and the second
 * call site was rendered into the first body's parameter slots -- the
 * conversion that refused was a callback returning `string` being written into
 * a `(number) -> number` formal.
 *
 * The receiver is dropped from both sides of the comparison: a method's
 * physical body states one and the callable value read off it need not.
 * Matching nothing falls back to the first, which is exactly what every site
 * did before there was a preference at all.
 */
const methodCopyPreferenceOf = (
  held: CallableAbi | null,
  abiOf: (callable: FunctionId) => CallableAbi | null
): ((method: { readonly callable: FunctionId | null; readonly representation?: Representation }) => boolean) | undefined => {
  if (held === null) return undefined
  const receiverless = (abi: CallableAbi): string => abiKey({ ...abi, receiver: null })
  const wanted = receiverless(held)
  return (method) => {
    const body = method.callable === null ? null : abiOf(method.callable)
    if (body !== null && receiverless(body) === wanted) return true
    const installed = method.representation?.kind === 'function-value-dispatch' ? method.representation.abi : null
    return installed !== null && receiverless(installed) === wanted
  }
}

/** Resolve the member once; captures affect its physical call convention only. */
const resolveClassMethod = (
  producer: GetOperation,
  body: IrBody,
  producers: ReadonlyMap<IrValueId, IrNonTerminatorOperation>,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  abiOf: (callable: FunctionId) => CallableAbi | null,
  capturesNothing: (callable: FunctionId) => boolean,
  verdict: VirtualDispatchVerdict,
  key: string
): ResolvedCall | null => {
  const receiver = producer.receiver.representation
  if (receiver.kind !== 'class-ref') return null
  const site = classMemberOf(classes, receiver.declaration, key, methodCopyPreferenceOf(abiOfCallee(producer.result.representation), abiOf))
  if (site === null || site.kind !== 'method' || site.method.callable === null) return null
  // Lowering represents super at the base class, distinct from this frame's
  // receiver class. Such a member access binds statically even with overrides.
  const isSuperAccess =
    producers.get(producer.receiver.value)?.kind === 'receiver' &&
    body.abi?.receiver?.kind === 'class-ref' &&
    body.abi.receiver.declaration !== receiver.declaration
  if (
    (!isSuperAccess && classMethodOverrideOf(classes, receiver.declaration, key)) ||
    classPrototypeMethodMutableOf(classes, receiver.declaration, key)
  )
    return unresolvedCall
  if (classFamilyOverridesOf(classes, receiver.declaration, key).length === 0 || isSuperAccess) {
    const functionId = site.method.callable
    return {
      target: capturesNothing(functionId) ? { kind: 'direct', functionId } : unresolvedTarget,
      closedCallee: { kind: 'exact', functionId }
    }
  }
  const family = verdict.dispatched.get(virtualDispatchKey(receiver.declaration, key, 'call'))
  if (family === undefined) return unresolvedCall
  const functionIds = family.family.implementors.map((implementor) => implementor.callable)
  const heldAbi = abiOfCallee(producer.result.representation)
  const nativeEntryAbi =
    family.nativeFieldProtocol === 'unused' && heldAbi !== null && abiKey(heldAbi) === abiKey(family.rootAbi) ? family.rootAbi : undefined
  return {
    target: { kind: 'virtual', owner: receiver.declaration, key, role: 'call' },
    ...(functionIds.length === 0
      ? {}
      : {
          closedCallee: {
            ...identityOfFunctions(functionIds),
            ...(nativeEntryAbi === undefined ? {} : { nativeEntryAbi })
          }
        })
  }
}

/** All union arms must resolve through the same closed member authority. */
const resolveUnionArms = (
  representation: Representation,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  key: string,
  path: readonly number[]
): readonly CallUnionArmTarget[] | null => {
  if (representation.kind === 'tagged-union') {
    const arms: CallUnionArmTarget[] = []
    for (const [index, arm] of representation.arms.entries()) {
      const nested = resolveUnionArms(arm.value, classes, key, [...path, index])
      if (nested === null) return null
      arms.push(...nested)
    }
    return arms
  }
  if (representation.kind !== 'class-ref') return null
  if (classMethodOverrideOf(classes, representation.declaration, key)) return null
  const site = classMemberOf(classes, representation.declaration, key)
  if (site === null || site.kind !== 'method' || site.method.callable === null) return null
  if (classFamilyOverridesOf(classes, representation.declaration, key).length > 0) return null
  return [{ path, declaration: representation.declaration, functionId: site.method.callable }]
}

const resolveCall = (
  operation: CallOperation,
  body: IrBody,
  producers: ReadonlyMap<IrValueId, IrNonTerminatorOperation>,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  abiOf: (callable: FunctionId) => CallableAbi | null,
  capturesNothing: (callable: FunctionId) => boolean,
  verdict: VirtualDispatchVerdict,
  callableBindings: CallableBindingFacts,
  callableMembers: ReadonlyMap<IrValueId, CallCalleeIdentity>
): ResolvedCall => {
  const producer = producers.get(operation.callee.value)
  if (producer === undefined) return unresolvedCall
  if (producer.kind === 'allocate-callable') {
    const functionId = producer.functionId
    return {
      target: capturesNothing(functionId) ? { kind: 'direct', functionId } : unresolvedTarget,
      closedCallee: { kind: 'exact', functionId }
    }
  }
  if (producer.kind === 'binding-read') {
    const direct = callableBindings.direct.get(producer.declaration)
    const closed = callableBindings.closed.get(producer.declaration)
    return {
      target: direct === undefined ? unresolvedTarget : { kind: 'direct', functionId: direct },
      ...(closed === undefined ? {} : { closedCallee: { kind: 'exact', functionId: closed } as const })
    }
  }
  if (producer.kind !== 'get') return unresolvedCall
  const memberCallable = callableMembers.get(producer.result.id)
  if (memberCallable !== undefined) return { target: unresolvedTarget, closedCallee: memberCallable }
  const key = constantStringKeyOf(producer.key.value, producers)
  if (key === null) return unresolvedCall
  const classCall = resolveClassMethod(producer, body, producers, classes, abiOf, capturesNothing, verdict, key)
  if (classCall !== null) return classCall
  const arms = resolveUnionArms(producer.receiver.representation, classes, key, [])
  if (arms === null || arms.length === 0) return unresolvedCall
  return {
    target: arms.every((arm) => capturesNothing(arm.functionId) && abiOf(arm.functionId) !== null)
      ? { kind: 'union-arm', arms }
      : unresolvedTarget,
    closedCallee: identityOfFunctions(arms.map((arm) => arm.functionId))
  }
}

const rewriteBody = (
  body: IrBody,
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  abiOf: (callable: FunctionId) => CallableAbi | null,
  capturesNothing: (callable: FunctionId) => boolean,
  verdict: VirtualDispatchVerdict,
  callableBindings: CallableBindingFacts,
  callableMembers: ReadonlyMap<IrValueId, CallCalleeIdentity>,
  observed: ReadonlySet<IrValueId>,
  prototypes: ReadonlySet<DeclarationId>,
  viewed: ReadonlySet<DeclarationId>,
  conversions?: Pick<ConversionCensus, 'nodeById'>
): IrBody => {
  const producers = producerMapOf(body)
  let bodyChanged = false
  const blocks = new Map<IrBlockId, IrBlock>()
  for (const [blockId, block] of body.blocks) {
    let blockChanged = false
    const operations = block.operations.map((operation) => {
      if (operation.kind === 'compute' && operation.form === 'instanceof') {
        const [left, right] = operation.operands
        const classInstanceTest =
          left && right
            ? classInstanceTestOf(left.representation, right.representation, classes, {
                prototypeOf: classPrototypeOf(left.value, producers, classes),
                materialized: prototypes,
                viewed
              })
            : undefined
        if (classInstanceTest === undefined) return operation
        blockChanged = true
        return { ...operation, classInstanceTest }
      }
      if (operation.kind === 'construct') {
        const target = operation.target
        const abi = target.kind === 'exact' && target.target.kind === 'function' ? abiOf(target.target.functionId) : null
        const entry = explicitObjectConstructEntryOf(operation, abi)
        if (entry === undefined) return operation
        blockChanged = true
        return { ...operation, entry }
      }
      if (operation.kind === 'get') {
        const key = constantStringKeyOf(operation.key.value, producers)
        const method = key === null ? null : resolveClassMethod(operation, body, producers, classes, abiOf, capturesNothing, verdict, key)
        const closedCallable = callableMembers.get(operation.result.id) ?? method?.closedCallee
        if (closedCallable === undefined) return operation
        blockChanged = true
        return { ...operation, closedCallable }
      }
      if (operation.kind === 'binding-read') {
        const functionId = callableBindings.closed.get(operation.declaration)
        if (functionId === undefined) return operation
        blockChanged = true
        return { ...operation, closedCallable: { kind: 'exact' as const, functionId } }
      }
      if (operation.kind !== 'call') return operation
      const { target, closedCallee } = resolveCall(
        operation,
        body,
        producers,
        classes,
        abiOf,
        capturesNothing,
        verdict,
        callableBindings,
        callableMembers
      )
      if (target.kind === 'unresolved' && closedCallee === undefined) return operation
      // A closed static body whose ABI has no receiver cannot observe the
      // constructor used for method syntax. Keep its evaluation in preceding
      // IR, but normalize the invocation to the body's actual convention.
      // Frame verification still requires exact receiver agreement afterward.
      const heldAbi = abiOfCallee(operation.callee.representation)
      const bodyAbi = closedCallee?.kind === 'exact' ? abiOf(closedCallee.functionId) : null
      const received =
        !operation.argumentsAreSpread &&
        operation.receiver?.representation.kind === 'constructor-family' &&
        heldAbi?.receiver === null &&
        bodyAbi?.receiver === null &&
        abiKey(heldAbi) === abiKey(bodyAbi)
          ? { ...operation, receiver: null }
          : operation
      const closedFrame = closedCallFrameOf(received, closedCallee, abiOf, observed, conversions)
      blockChanged = true
      return {
        ...received,
        ...(closedFrame === undefined ? {} : { closedFrame }),
        ...(target.kind === 'unresolved' ? {} : { target }),
        ...(closedCallee === undefined ? {} : { closedCallee })
      }
    })
    if (blockChanged) {
      bodyChanged = true
      blocks.set(blockId, { ...block, operations })
    } else {
      blocks.set(blockId, block)
    }
  }
  return bodyChanged ? { ...body, blocks } : body
}
