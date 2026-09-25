import type { DeclarationId, FunctionId, PhysicalBodyId, SemanticResultId } from '../identity/ids.js'
import { withoutFunctionSpecialization } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { ClassLayout } from '../projection/classes.js'
import type { CallableAbi, Representation } from '../representation/model.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { operandOf, resultOf } from '../semantics/model/operands.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import type { ProxyOrigins } from '../semantics/proxy-origins.js'
import type { IrBlock, IrBlockId, IrBody, IrNonTerminatorOperation } from './model.js'

/**
 * Receiver-generic copies of the class methods a proxy may run with itself as
 * `this`.
 *
 * `proxy.m(...)` reads `m` through the proxy's `get` trap -- TSL's traps
 * forward it to the native object behind the proxy -- and calls it with the
 * PROXY as `this`. The method's own body is typed for a native receiver, and
 * substituting the object behind the proxy would be wrong: FnNode's
 * `setLayout` and `once` end in `return this`, which must stay the callable
 * proxy for `Fn(...).setLayout(...)(a, b)` to call anything, and every
 * `this.x` must run the trap. So such a method gets a second body, lowered from
 * the same operations with a `dynamic` receiver: `this` and whatever is read
 * or called through it are `dynamic`, every other value keeps its carrier, and
 * the result is `dynamic` because it may be the receiver itself. The method
 * value a dynamic read produces (`targets/cpp/virtual-methods.ts`) calls the
 * typed body for a native receiver and this copy for any other.
 *
 * Only the member names read off a value that may be a proxy are copied
 * (`ProxyOrigins.proxyKeys`), closed over `this.m()` inside each copy. A
 * method whose body allocates a closure or reads `super` is left out: both
 * capture the typed receiver. A name no copy answers still reaches the typed
 * body, whose receiver unbox refuses a proxy by name at run time -- the
 * failure is loud, never a silent substitution.
 */
export const receiverGenericCopySuffix = '#dynamic-this'

export const receiverGenericCopyOf = (callable: FunctionId): FunctionId => `${callable}${receiverGenericCopySuffix}` as FunctionId

const dynamicReceiver: Representation = { kind: 'dynamic', reason: 'proxy-origin' }

/** The convention of a copy: the method's own parameters, a `dynamic` receiver and a `dynamic` result. */
export const receiverGenericAbiOf = (abi: CallableAbi): CallableAbi => ({ ...abi, receiver: dynamicReceiver, result: dynamicReceiver })

const isThisReference = (operation: SemanticOperation): boolean =>
  operation.family === 'reference' && operation.form === 'this' && operandOf(operation, 'receiver') !== undefined

/** Whether a body captures or re-reads its receiver in a way a second convention cannot rebind. */
const bindsReceiverElsewhere = (operations: readonly SemanticOperation[]): boolean =>
  operations.some(
    (operation) =>
      (operation.family === 'allocation' && operation.allocated === 'function-object') ||
      (operation.family === 'reference' && (operation.form === 'super-property' || operandOf(operation, 'captured-receiver') !== undefined))
  )

/**
 * The results of a copied body that carry its receiver or what was read or
 * called through it -- the values the copy's `dynamic` receiver makes dynamic.
 */
export const receiverDependentResultsOf = (operations: readonly SemanticOperation[]): ReadonlySet<SemanticResultId> => {
  const dependent = new Set<SemanticResultId>()
  const cites = (operation: SemanticOperation, role: string): boolean => {
    const source = operandOf(operation, role)?.source
    return source?.kind === 'result' && dependent.has(source.result)
  }
  let changed = true
  const add = (result: SemanticResultId | undefined): void => {
    if (result === undefined || dependent.has(result)) return
    dependent.add(result)
    changed = true
  }
  while (changed) {
    changed = false
    for (const operation of operations) {
      if (isThisReference(operation)) add(resultOf(operation, 'value')?.id)
      else if (operation.family === 'property' && (operation.internalMethod === 'get' || operation.internalMethod === 'set')) {
        if (cites(operation, 'receiver')) add(resultOf(operation, 'value')?.id)
      } else if (operation.family === 'invocation') {
        if (cites(operation, 'callee')) add(resultOf(operation, 'value')?.id)
      } else if (operation.family === 'control' && operation.form === 'return') {
        // The copy returns `dynamic`, whatever it returns.
        add(resultOf(operation, 'completion')?.id)
      } else if (
        operation.family === 'computation' &&
        (operation.form === 'conditional' || operation.form === 'logical' || operation.form === 'comma') &&
        operation.operands.some((operand) => operand.source.kind === 'result' && dependent.has(operand.source.result))
      ) {
        add(resultOf(operation, 'value')?.id)
      }
    }
  }
  return dependent
}

export interface ReceiverGenericCopyInput {
  readonly graph: SemanticGraph
  readonly classes: ReadonlyMap<DeclarationId, ClassLayout>
  readonly abis: ReadonlyMap<FunctionId, CallableAbi>
  readonly origins: ProxyOrigins
}

/** Each copied method, keyed by the method's own FunctionId, with the copy's convention. */
export const receiverGenericCopiesOf = (input: ReceiverGenericCopyInput): ReadonlyMap<FunctionId, CallableAbi> => {
  const copies = new Map<FunctionId, CallableAbi>()
  if (input.origins.proxies.size === 0 || (input.origins.proxyKeys.size === 0 && !input.origins.computedProxyKey)) return copies
  const bodies = new Map<FunctionId, SemanticOperation[]>()
  for (const operation of input.graph.operations.values()) {
    if (operation.caller.kind !== 'function') continue
    const owner = withoutFunctionSpecialization(operation.caller.functionId)
    const bucket = bodies.get(owner)
    if (bucket) bucket.push(operation)
    else bodies.set(owner, [operation])
  }
  // The classes a method of one class may be reached through: its ancestors
  // (inherited) and its descendants (overrides a `this.m()` may dispatch to).
  const descendants = new Map<DeclarationId, DeclarationId[]>()
  for (const [declaration, layout] of input.classes) {
    if (layout.base === null) continue
    const bucket = descendants.get(layout.base)
    if (bucket) bucket.push(declaration)
    else descendants.set(layout.base, [declaration])
  }
  const chainOf = (declaration: DeclarationId): readonly DeclarationId[] => {
    const chain = new Set<DeclarationId>()
    for (let base: DeclarationId | null = declaration; base !== null && !chain.has(base); base = input.classes.get(base)?.base ?? null)
      chain.add(base)
    const below = [declaration]
    for (let next = below.pop(); next !== undefined; next = below.pop())
      for (const child of descendants.get(next) ?? []) {
        if (chain.has(child)) continue
        chain.add(child)
        below.push(child)
      }
    return [...chain]
  }
  const queue: { readonly callable: FunctionId; readonly declaration: DeclarationId }[] = []
  const consider = (declarations: readonly DeclarationId[], key: string): void => {
    for (const declaration of declarations) {
      for (const method of input.classes.get(declaration)?.methods ?? []) {
        if (method.key !== key || method.callable === null || copies.has(method.callable)) continue
        const abi = input.abis.get(method.callable)
        if (!abi || abi.receiver === null) continue
        if (bindsReceiverElsewhere(bodies.get(method.callable) ?? [])) continue
        copies.set(method.callable, receiverGenericAbiOf(abi))
        queue.push({ callable: method.callable, declaration })
      }
    }
  }
  const everyClass = [...input.classes.keys()]
  for (const key of input.origins.proxyKeys) consider(everyClass, key)
  for (let next = queue.pop(); next !== undefined; next = queue.pop()) {
    const operations = bodies.get(next.callable) ?? []
    const receivers = new Set(operations.filter(isThisReference).flatMap((operation) => resultOf(operation, 'value')?.id ?? []))
    const chain = chainOf(next.declaration)
    for (const operation of operations) {
      if (operation.family !== 'property' || operation.internalMethod !== 'get') continue
      const receiver = operandOf(operation, 'receiver')?.source
      if (receiver?.kind !== 'result' || !receivers.has(receiver.result)) continue
      const key = operandOf(operation, 'key')?.source
      if (key?.kind === 'constant' && key.literal === 'string') consider(chain, key.text)
    }
  }
  return copies
}

/**
 * A copy's own cells: its parameters and locals are placed in the METHOD's
 * frame, which the copy is not, so each is renamed into the copy's frame
 * (`generator-split.ts` does the same for an inner coroutine). A cell of
 * another frame the copy reaches -- a module binding -- keeps its placement.
 */
export const relocateReceiverGenericCopies = (
  bodies: ReadonlyMap<PhysicalBodyId, IrBody>,
  placements: ReadonlyMap<DeclarationId, BindingPlacement>,
  copies: ReadonlyMap<FunctionId, CallableAbi>
): { readonly bodies: ReadonlyMap<PhysicalBodyId, IrBody>; readonly placements: ReadonlyMap<DeclarationId, BindingPlacement> } => {
  if (copies.size === 0) return { bodies, placements }
  const nextBodies = new Map(bodies)
  const nextPlacements = new Map(placements)
  const methodOf = new Map<string, FunctionId>([...copies.keys()].map((callable) => [receiverGenericCopyOf(callable), callable]))
  for (const [id, body] of bodies) {
    const method = methodOf.get(body.sourceOwner)
    if (method === undefined) continue
    const renamed = new Map<DeclarationId, DeclarationId>()
    const rename = (declaration: DeclarationId): DeclarationId => {
      const known = renamed.get(declaration)
      if (known !== undefined) return known
      const placement = placements.get(declaration)
      if (placement?.storage.kind !== 'local' || placement.storage.owner !== method) return declaration
      const own = `${declaration}${receiverGenericCopySuffix}` as DeclarationId
      renamed.set(declaration, own)
      nextPlacements.set(own, { storage: { kind: 'local', owner: body.sourceOwner }, representation: placement.representation })
      return own
    }
    const rewrite = (operation: IrNonTerminatorOperation): IrNonTerminatorOperation =>
      operation.kind === 'binding-read' || operation.kind === 'binding-write' || operation.kind === 'binding-renew'
        ? { ...operation, declaration: rename(operation.declaration) }
        : operation
    const blocks = new Map<IrBlockId, IrBlock>()
    for (const [blockId, block] of body.blocks) blocks.set(blockId, { ...block, operations: block.operations.map(rewrite) })
    nextBodies.set(id, { ...body, blocks })
  }
  return { bodies: nextBodies, placements: nextPlacements }
}
