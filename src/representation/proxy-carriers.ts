import type { DeclarationId, FunctionId, SemanticResultId, StructuralTypeId } from '../identity/ids.js'
import { callableOriginsOf } from '../semantics/callable-origins.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { operandOf, resultOf, type SemanticOperand } from '../semantics/model/operands.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import type { RepresentationDeriver } from './derive.js'
import { representationKey, type CallableAbi, type Representation, type TaggedUnionArm } from './model.js'
import { staticMembersOf, type StaticMembers } from './static-field-cells.js'

/**
 * Which values hold an object `new Proxy(target, handler)` made, and the
 * carrier each one therefore needs.
 *
 * A proxy is not its target. ECMA-262 10.5 routes every internal method
 * through the handler first, so a value that may be a proxy needs a carrier
 * that still has the handler in it -- `proxy-object`, which holds the target
 * in the target's own native carrier and the handler in the handler's. The
 * checker cannot say which values those are: `new Proxy(t, h)` is typed `T`
 * (or `any`, when a trap's own parameter is `any`), exactly the type of the
 * target. So this is decided by PROVENANCE, never by type: a value gets the
 * carrier because it can flow from a `new Proxy` site, and every other value
 * of the same type stays the plain native carrier it always had. Keying the
 * decision by structural type would give every `{ x: number }` in the
 * program a handler it does not have.
 *
 * The flow followed is the one the program writes: a local or module cell
 * written by a proxy, a function every return of which may yield one, a call
 * of such a function, and the value an assignment expression evaluates to. A
 * slot that holds a proxy and something else (an optional dependency, written
 * by `require('mod')` on one path and `makeErrorModule(...)` on the other)
 * keeps its declared carrier with a `proxy-object` arm beside the others. A
 * proxy reaching any position this does not follow -- a record field, an
 * array element, an argument -- keeps that position's own carrier, and the
 * conversion into it has no recipe, so it refuses by name rather than
 * dropping the handler.
 */
export interface ProxyCarriers {
  /** The carrier of every result that may hold a proxy. */
  readonly results: ReadonlyMap<SemanticResultId, Representation>
  /**
   * The storage carrier of every static field a proxy may be written into,
   * by the field's declaration. A static field is one cell per class -- the
   * constructor object's own property -- so it is followed exactly like a
   * module cell; its storage is laid out by `projection/classes.ts`, which
   * reads this instead of the field's declared type alone.
   */
  readonly staticFields: ReadonlyMap<DeclarationId, Representation>
}

export const proxyCarriersOf = (
  graph: SemanticGraph,
  deriver: Pick<RepresentationDeriver, 'derive' | 'deriveStored' | 'dynamicFallback'>,
  statics: StaticMembers = staticMembersOf(graph, deriver)
): ProxyCarriers => {
  const sites = new Map<SemanticResultId, Representation>()
  for (const operation of graph.operations.values()) {
    const carrier = proxyConstructionCarrierOf(operation, deriver)
    const value = carrier ? resultOf(operation, 'value') : undefined
    if (carrier && value) sites.set(value.id, carrier)
  }
  if (sites.size === 0) return { results: new Map(), staticFields: new Map() }

  const callables = callableOriginsOf(graph)
  // What each node may hold: the proxy carriers, keyed by representation, and
  // whether anything that is not a proxy may reach it too.
  interface Held {
    readonly proxies: Map<string, Representation>
    other: boolean
  }
  const results = new Map<SemanticResultId, Held>()
  const cells = new Map<DeclarationId, Held>()
  const returns = new Map<FunctionId, Held>()
  const heldOf = <K>(table: Map<K, Held>, key: K): Held => {
    const known = table.get(key)
    if (known) return known
    const fresh: Held = { proxies: new Map(), other: false }
    table.set(key, fresh)
    return fresh
  }
  let changed = true
  const join = (into: Held, from: Held | undefined): void => {
    if (from === undefined) {
      if (!into.other) {
        into.other = true
        changed = true
      }
      return
    }
    for (const [key, carrier] of from.proxies)
      if (!into.proxies.has(key)) {
        into.proxies.set(key, carrier)
        changed = true
      }
    if (from.other && !into.other) {
      into.other = true
      changed = true
    }
  }
  for (const [result, carrier] of sites) results.set(result, { proxies: new Map([[representationKey(carrier), carrier]]), other: false })
  // The results this follows. Any other result holds only what its own type
  // says -- "other" -- which is also what a parameter, a declaration with no
  // initializer and a constant are. A followed result starts EMPTY instead,
  // because what reaches it is not known until the walk below settles; reading
  // "not yet" as "other" would make the answer depend on operation order.
  const followed = new Set<SemanticResultId>(sites.keys())
  const calleeOf = (operation: SemanticOperation): FunctionId | undefined => {
    if (operation.family !== 'invocation' || operation.internalMethod !== 'call') return undefined
    const callee = operandOf(operation, 'callee')
    return callee?.source.kind === 'result' ? callables.get(callee.source.result) : undefined
  }
  const staticFieldByDeclaration = new Map([...statics.fields.values()].map((field) => [field.declaration, field]))
  const staticGetterOf = (member: string): FunctionId | undefined => {
    const getter = statics.getters.get(member)
    return getter === undefined ? undefined : callables.get(getter)
  }
  const staticCells = new Map<DeclarationId, Held>()
  const returning = new Set<FunctionId>()
  for (const operation of graph.operations.values()) {
    const value = resultOf(operation, 'value')
    if (operation.family === 'control' && operation.form === 'return' && operation.caller.kind === 'function')
      returning.add(operation.caller.functionId)
    if (!value) continue
    if (operation.family === 'binding') followed.add(value.id)
    else if (operation.family === 'computation' && operation.form === 'assignment' && operation.operator === '=') followed.add(value.id)
    else if (calleeOf(operation) !== undefined) followed.add(value.id)
    else if (operation.family === 'property' && operation.internalMethod === 'set') followed.add(value.id)
    else if (operation.family === 'computation' && operation.form === 'logical') followed.add(value.id)
    else if (operation.family === 'property' && operation.internalMethod === 'get') {
      const member = statics.memberOf(operation)
      if (member !== null && (statics.fields.has(member) || staticGetterOf(member) !== undefined)) followed.add(value.id)
    }
  }
  // A body with no `return` at all completes with `undefined`.
  for (const functionId of new Set(callables.values())) if (!returning.has(functionId)) heldOf(returns, functionId).other = true
  const sourceOf = (operand: SemanticOperand | undefined): Held | undefined =>
    operand?.source.kind === 'result' && followed.has(operand.source.result) ? heldOf(results, operand.source.result) : undefined
  while (changed) {
    changed = false
    for (const operation of graph.operations.values()) {
      if (operation.family === 'binding') {
        const cell = heldOf(cells, operation.declaration)
        if (operation.action === 'initialize' || operation.action === 'write') {
          const written = operation.operands.find((operand) => operand.evaluation.kind !== 'provenance')
          join(cell, sourceOf(written))
        } else if (operation.action === 'declare') join(cell, undefined)
        // Every binding operation's value IS the cell.
        const value = resultOf(operation, 'value')
        if (value) join(heldOf(results, value.id), cell)
        continue
      }
      if (operation.family === 'computation' && operation.form === 'assignment' && operation.operator === '=') {
        const value = resultOf(operation, 'value')
        if (value) join(heldOf(results, value.id), sourceOf(operandOf(operation, 'value')))
        continue
      }
      if (operation.family === 'control' && operation.form === 'return' && operation.caller.kind === 'function') {
        join(heldOf(returns, operation.caller.functionId), sourceOf(operandOf(operation, 'value')))
        continue
      }
      // `a ?? b` and `a || b` evaluate to either operand; `a && b` to `b` or
      // a falsy `a`, which a proxy -- an object -- never is.
      if (operation.family === 'computation' && operation.form === 'logical') {
        const value = resultOf(operation, 'value')
        if (!value) continue
        const merged = heldOf(results, value.id)
        join(merged, operation.operator === '&&' ? undefined : sourceOf(operandOf(operation, 'left')))
        join(merged, sourceOf(operandOf(operation, 'right')))
        continue
      }
      if (operation.family === 'class-lifecycle' && operation.event === 'define-field' && operation.placement === 'static') {
        const field = staticFieldByDeclaration.get(operation.declaration)
        if (!field) continue
        // A field declared without an initializer starts `undefined`.
        const initializer = field.initializer === null ? undefined : callables.get(field.initializer)
        join(heldOf(staticCells, operation.declaration), initializer === undefined ? undefined : heldOf(returns, initializer))
        continue
      }
      if (operation.family === 'property' && (operation.internalMethod === 'get' || operation.internalMethod === 'set')) {
        const member = statics.memberOf(operation)
        const field = member === null ? undefined : statics.fields.get(member)
        const getter = member === null ? undefined : staticGetterOf(member)
        const value = resultOf(operation, 'value')
        if (operation.internalMethod === 'get') {
          if (value && field) join(heldOf(results, value.id), heldOf(staticCells, field.declaration))
          else if (value && getter !== undefined) join(heldOf(results, value.id), heldOf(returns, getter))
          continue
        }
        if (field) join(heldOf(staticCells, field.declaration), sourceOf(operandOf(operation, 'value')))
        // A `[[Set]]` publishes the receiver it wrote into (`producers/properties.ts`).
        if (value) join(heldOf(results, value.id), sourceOf(operandOf(operation, 'receiver')))
        continue
      }
      const target = calleeOf(operation)
      const value = resultOf(operation, 'value')
      if (target !== undefined && value) join(heldOf(results, value.id), heldOf(returns, target))
    }
  }
  // The reference a read takes `GetValue` of denotes the same cell, so it
  // carries the cell's carrier wherever that is a proxy's.
  for (const operation of graph.operations.values()) {
    if (operation.family !== 'binding' || operation.action !== 'read') continue
    const cell = cells.get(operation.declaration)
    const reference = operandOf(operation, 'reference')
    if (cell && cell.proxies.size > 0 && reference?.source.kind === 'result') results.set(reference.source.result, cell)
  }

  const carriers = new Map<SemanticResultId, Representation>()
  const carrierOf = (held: Held, declared: Representation, type: StructuralTypeId): Representation | null => {
    if (held.proxies.size === 0) return null
    const proxies = [...held.proxies.values()]
    const [sole] = proxies
    if (!held.other && proxies.length === 1 && sole) return sole
    return withProxyArms(declared, proxies, type)
  }
  const stored = (operation: SemanticOperation | undefined): boolean => operation?.family === 'binding' || operation?.family === 'property'
  for (const [result, held] of results) {
    const operation = graph.operations.get(graph.results.get(result) ?? ('' as never))
    const own = operation?.results.find((candidate) => candidate.id === result)
    if (!own) continue
    // A binding's value is the cell, and the cell's own history decides it --
    // not the one write this operation performs.
    const effective = operation?.family === 'binding' ? (cells.get(operation.declaration) ?? held) : held
    const declared = stored(operation) ? deriver.deriveStored(own.type) : deriver.derive(own.type)
    const carrier = carrierOf(effective, declared, own.type)
    if (carrier) carriers.set(result, carrier)
  }
  // A function whose return may be a proxy states that in its own convention,
  // so its body returns the proxy and every caller receives it as one.
  for (const [functionId, held] of returns) {
    if (held.proxies.size === 0) continue
    // A body that can also fall off its end returns `undefined` there, which
    // its declared result says and no \`return\` operand does.
    const withAbsence = (declared: Representation): Held =>
      declared.kind === 'optional' || declared.kind === 'undefined' || declared.kind === 'void' ? { ...held, other: true } : held
    for (const [result, origin] of callables) {
      if (origin !== functionId) continue
      const operation = graph.operations.get(graph.results.get(result) ?? ('' as never))
      const own = operation?.results.find((candidate) => candidate.id === result)
      if (!own) continue
      const callable = carriers.get(result) ?? deriver.derive(own.type)
      const abi = abiOfCallable(callable)
      if (abi === null) continue
      const returned = carrierOf(withAbsence(abi.result), abi.result, own.type)
      if (returned === null) continue
      carriers.set(result, withResult(callable, { ...abi, result: returned }))
    }
    for (const operation of graph.operations.values()) {
      if (operation.family !== 'control' || operation.form !== 'return') continue
      if (operation.caller.kind !== 'function' || operation.caller.functionId !== functionId) continue
      const completion = resultOf(operation, 'completion')
      if (!completion) continue
      const declared = deriver.derive(completion.type)
      const returned = carrierOf(withAbsence(declared), declared, completion.type)
      if (returned) carriers.set(completion.id, returned)
    }
  }
  const staticFields = new Map<DeclarationId, Representation>()
  for (const { declaration, type } of statics.fields.values()) {
    const held = staticCells.get(declaration)
    const carrier = held ? carrierOf(held, deriver.derive(type), type) : null
    if (carrier) staticFields.set(declaration, carrier)
  }
  return { results: carriers, staticFields }
}

/**
 * The carrier `new Proxy(target, handler)` mints, or `null` when this
 * operation is not that construction.
 *
 * Recognized by the callee's protocol identity, never its spelling: the
 * ambient `ProxyConstructor` is the only value whose carrier states that
 * protocol. A spread argument has no fixed position to be the target or the
 * handler, and `new Proxy` with any other arity throws, so both are left to
 * refuse on the ordinary construct path.
 */
export const proxyConstructionCarrierOf = (
  operation: SemanticOperation,
  deriver: Pick<RepresentationDeriver, 'derive' | 'dynamicFallback'>
): Extract<Representation, { kind: 'proxy-object' }> | null => {
  if (operation.family !== 'invocation' || operation.internalMethod !== 'construct') return null
  const callee = operandOf(operation, 'callee')
  if (!callee) return null
  const constructor = deriver.derive(callee.type)
  if (constructor.kind !== 'native-handle' || constructor.protocol !== 'ProxyConstructor') return null
  if (operation.operands.some((operand) => operand.role === 'spread-argument')) return null
  // A construction whose own result is already the box (`--dynamic-fallback`
  // marks every Proxy result so) keeps the dynamic proxy runtime it asked for.
  // Without the opt-in a dynamic result says only that the checker inferred
  // `T = any` -- a trap parameter annotated `any` does that -- and `any` that no single use narrows derives to the
  // box. That is a fact about the checker's `T`, not about the object: the
  // target and handler still have their own carriers, and the proxy is minted
  // from those. Where it then reaches a position this walk does not follow,
  // the conversion into that position refuses by name.
  const own = resultOf(operation, 'value')
  if (!own || (deriver.dynamicFallback === true && deriver.derive(own.type).kind === 'dynamic')) return null
  const target = operandOf(operation, 'argument', 0)
  const handler = operandOf(operation, 'argument', 1)
  if (!target || !handler || operandOf(operation, 'argument', 2)) return null
  return { kind: 'proxy-object', target: deriver.derive(target.type), handler: deriver.derive(handler.type) }
}

/** The declared carrier with one `proxy-object` arm per proxy that may also reach it. */
const withProxyArms = (declared: Representation, proxies: readonly Representation[], type: StructuralTypeId): Representation | null => {
  if (declared.kind === 'optional') {
    const payload = withProxyArms(declared.payload, proxies, type)
    return payload === null ? null : { ...declared, payload }
  }
  // A box already answers every internal method through its own table; a
  // typed proxy entering one is a conversion the census owns, not an arm.
  if (declared.kind === 'dynamic' || declared.kind === 'unresolved' || declared.kind === 'void') return null
  const existing: readonly TaggedUnionArm[] =
    declared.kind === 'tagged-union'
      ? declared.arms
      : [{ tag: '0', value: declared, semanticType: type, runtimeDiscriminator: { kind: 'carrier' } }]
  const present = new Set(existing.map((arm) => representationKey(arm.value)))
  const added = proxies
    .filter((proxy) => !present.has(representationKey(proxy)))
    .map((proxy, index): TaggedUnionArm => ({
      tag: `proxy${index}`,
      value: proxy,
      semanticType: type,
      runtimeDiscriminator: { kind: 'carrier' }
    }))
  return added.length === 0 ? declared : { kind: 'tagged-union', arms: [...existing, ...added] }
}

const abiOfCallable = (carrier: Representation): CallableAbi | null =>
  carrier.kind === 'function' || carrier.kind === 'function-value-dispatch' ? carrier.abi : null

const withResult = (carrier: Representation, abi: CallableAbi): Representation =>
  carrier.kind === 'function' || carrier.kind === 'function-value-dispatch' ? { ...carrier, abi } : carrier

/**
 * A `proxy-object` arm the target has no place for.
 *
 * A narrowing is a load the CHECKER proved: its guard ruled the other arms
 * out. A proxy arm is minted by provenance (`proxyCarriersOf` above), never
 * by the checker, so no checker narrowing can rule one out -- narrowed
 * reads keep it (`conversion/operand-view.ts`) -- and a pair that drops one is
 * a value of the checker's type flowing into a slot that never heard of the
 * proxy: an optional module passed to a `(codec: Codec)` parameter. The
 * unchecked load would read another arm's payload while the proxy is live.
 */
export const proxyArmWithoutHome = (source: Representation, target: Representation): boolean => {
  const union = source.kind === 'optional' ? source.payload : source
  if (union.kind !== 'tagged-union') return false
  const selected = target.kind === 'optional' ? target.payload : target
  const homes = new Set((selected.kind === 'tagged-union' ? selected.arms.map((arm) => arm.value) : [selected]).map(representationKey))
  return union.arms.some(({ value }) => value.kind === 'proxy-object' && !homes.has(representationKey(value)))
}
