import type { DeclarationId, FunctionId, NodeId, SemanticResultId } from '../identity/ids.js'
import { nodeOfOperation, withoutFunctionSpecialization, withoutSpecialization } from '../identity/ids.js'
import type { SemanticGraph } from './model/graph.js'
import { operandOf, resultOf, type SemanticOperand } from './model/operands.js'
import type { InvocationOperation, SemanticOperation } from './model/operations.js'
import { isArrayIndexKey } from './normalize/host-mutation-keys.js'

/**
 * Which semantic values may hold a Proxy, followed from each `new Proxy` site.
 *
 * A proxy can answer every property read, every call and every `typeof` with
 * whatever its handler returns, so a slot that may hold one cannot promise a
 * native layout. The `--dynamic-fallback` census answers that by STRUCTURAL
 * type (`proxyFallbackTypes`), which boxes every value of the proxied type in
 * the whole program: every `NodeBuilder`, every `() => void`. This answers it
 * by provenance instead. The roots are the construction results at the sites
 * the frontend authenticated as the standard `ProxyConstructor`, and a value is
 * reached when it can be one of them: a binding cell any write of which may be
 * one, a conditional or logical result with such an arm, a call of a function
 * that may return one, and a parameter a proxy may be passed to.
 *
 * Values a trap PRODUCES are reached too, because the handler decides them
 * and the checker read their types off the target: the result of calling a
 * proxy (its `apply` trap -- `Fn(...)` is `() => void`, so the checker types
 * its call `void`), any member read off one (its `get` trap), and what
 * iterating or destructuring one yields. They are `dynamic` but not proxies --
 * except the result of calling a member read off a proxy, which runs with the
 * proxy as `this` and may return it, as FnNode's `setLayout` does. Only a proxy
 * decides which member names are read with a proxy as `this` (`proxyKeys`).
 *
 * A proxy passed to a call whose callee is itself `dynamic` escapes this
 * walk: the callee can be any Function object the program boxed. TSL is that
 * case (`jsFunc( inputs, secureNodeBuilder )`, where `jsFunc` is whichever
 * arrow was handed to `Fn`), so the escape reaches the same parameter of every
 * source function whose value is boxed somewhere. Those are mostly `any`
 * already, and the reach is what lets the arrow's body see the proxy it holds.
 *
 * A proxy that reaches no slot of its own -- a field, an element, a typed
 * parameter reached only through a class's method table -- keeps that slot's
 * native carrier, and the store is the checked unbox every dynamic value takes
 * there, which refuses a proxy by name at run time. A program with no site
 * reaches nothing, so every carrier in it is what it was before this fact
 * existed.
 */
export interface ProxyOrigins {
  /** Results that may hold a proxy, or a value one of its traps produced. */
  readonly results: ReadonlySet<SemanticResultId>
  /** The subset of `results` that may be a proxy itself. */
  readonly proxies: ReadonlySet<SemanticResultId>
  /** Functions whose completion value may be a proxy: their convention returns `dynamic`. */
  readonly returning: ReadonlySet<FunctionId>
  /** Parameter positions of source functions a proxy may be passed to: their convention takes `dynamic` there. */
  readonly parameters: ReadonlyMap<FunctionId, ReadonlySet<number>>
  /**
   * Source functions whose REST parameter may receive a proxy among the
   * arguments it gathers: the array is always the fresh one the language binds,
   * so its elements take `dynamic`, never the array itself.
   */
  readonly restElements: ReadonlySet<FunctionId>
  /** Results that are such a rest array: an array whose elements may hold a proxy. */
  readonly elementResults: ReadonlySet<SemanticResultId>
  /** The literal member names read off a value that may be a proxy -- the methods that may run with one as `this`. */
  readonly proxyKeys: ReadonlySet<string>
  /** Whether a member is also read off one through a computed key, which may name any member. */
  readonly computedProxyKey: boolean
}

export const noProxyOrigins: ProxyOrigins = {
  results: new Set(),
  proxies: new Set(),
  returning: new Set(),
  parameters: new Map(),
  restElements: new Set(),
  elementResults: new Set(),
  proxyKeys: new Set(),
  computedProxyKey: false
}

/** A carrier question the representation layer answers for the walk: this layer states flow, not carriers. */
export interface ProxyOriginCarriers {
  /** Whether a result's own structural carrier is `dynamic`. */
  readonly dynamic: (result: SemanticResultId) => boolean
  /** The exact source function a result is proven to be (`callableOriginsOf`). */
  readonly functionOf: (result: SemanticResultId) => FunctionId | undefined
}

/** How far a value reaches: `dynamic` for a trap's product, `proxy` for a value that may be the proxy itself. */
type Reach = 1 | 2
const DYNAMIC: Reach = 1
const PROXY: Reach = 2

const valueOperandOf = (operation: SemanticOperation): SemanticOperand | undefined =>
  operation.operands.find((operand) => operand.evaluation.kind !== 'provenance')

const exactTargetsOf = (operation: InvocationOperation): readonly FunctionId[] => {
  if (operation.target.kind === 'exact') return operation.target.target.kind === 'function' ? [operation.target.target.functionId] : []
  if (operation.target.kind === 'closed-family')
    return operation.target.targets.flatMap((target) => (target.kind === 'function' ? [target.functionId] : []))
  return []
}

/** Operations whose value is one of their operands: a proxy in an arm is a proxy in the result. */
const passesOperandThrough = (operation: SemanticOperation): boolean =>
  operation.family === 'computation' &&
  (operation.form === 'conditional' || operation.form === 'logical' || operation.form === 'assignment' || operation.form === 'comma')

export const proxyOriginsOf = (graph: SemanticGraph, sites: ReadonlySet<NodeId>, carriers: ProxyOriginCarriers): ProxyOrigins => {
  if (sites.size === 0) return noProxyOrigins
  const reached = new Map<SemanticResultId, Reach>()
  const cells = new Map<DeclarationId, Reach>()
  const returning = new Map<FunctionId, Reach>()
  const parameters = new Map<FunctionId, Set<number>>()
  let changed = true
  const raise = <K>(table: Map<K, Reach>, key: K, reach: Reach): void => {
    if ((table.get(key) ?? 0) >= reach) return
    table.set(key, reach)
    changed = true
  }
  const reach = (result: SemanticResultId | undefined, how: Reach): void => {
    if (result !== undefined) raise(reached, result, how)
  }
  const reachOf = (operand: SemanticOperand | undefined): Reach | 0 =>
    operand?.source.kind === 'result' ? (reached.get(operand.source.result) ?? 0) : 0

  // Each source function's rest position, off the signature its function
  // object is allocated with: the arguments from there on land in one fresh
  // array rather than in a cell each.
  const restFrom = new Map<FunctionId, number>()
  for (const operation of graph.operations.values()) {
    if (operation.family !== 'allocation' || operation.allocated !== 'function-object' || !operation.callable) continue
    const shape = graph.structuralTypes.get(operation.shape)?.shape
    const signature = shape?.kind === 'signature' ? shape.call[0] : undefined
    const rest = signature?.parameters.findIndex((parameter) => parameter.rest) ?? -1
    if (rest >= 0) restFrom.set(withoutFunctionSpecialization(operation.callable), rest)
  }
  // Cells whose ELEMENTS a proxy reaches -- a rest array, or a cell an array
  // listing one was stored in -- and the results that read them.
  const restCells = new Map<DeclarationId, Reach>()
  const elementReached = new Map<SemanticResultId, Reach>()
  const elementReachOf = (operand: SemanticOperand | undefined): Reach | 0 =>
    operand?.source.kind === 'result' ? (elementReached.get(operand.source.result) ?? 0) : 0

  const parameterBindings = new Map<FunctionId, Map<number, DeclarationId>>()
  const parameterResults = new Map<FunctionId, Map<number, SemanticResultId>>()
  const parameterOf = new Map<DeclarationId, { readonly owner: FunctionId; readonly ordinal: number }>()
  for (const operation of graph.operations.values()) {
    if (operation.family !== 'binding' || operation.action !== 'initialize' || operation.caller.kind !== 'function') continue
    const initializer = operation.operands.find((operand) => operand.source.kind === 'parameter')
    if (initializer?.source.kind !== 'parameter') continue
    const owner = withoutFunctionSpecialization(operation.caller.functionId)
    const bucket = parameterBindings.get(owner) ?? new Map<number, DeclarationId>()
    bucket.set(initializer.source.ordinal, operation.declaration)
    parameterBindings.set(owner, bucket)
    const bound = resultOf(operation, 'value')
    if (bound) {
      const results = parameterResults.get(owner) ?? new Map<number, SemanticResultId>()
      results.set(initializer.source.ordinal, bound.id)
      parameterResults.set(owner, results)
    }
    parameterOf.set(operation.declaration, { owner, ordinal: initializer.source.ordinal })
  }

  // Source functions whose value is handed to a `dynamic` slot somewhere: an
  // argument of a call into a `dynamic` parameter or through a `dynamic`
  // callee, a store into a `dynamic` cell or property. A dynamic call can
  // reach exactly these.
  const boxed = new Set<FunctionId>()
  const noteBoxed = (operand: SemanticOperand | undefined, depth = 0): void => {
    if (operand?.source.kind !== 'result') return
    const callable = carriers.functionOf(operand.source.result)
    if (callable !== undefined) {
      boxed.add(withoutFunctionSpecialization(callable))
      return
    }
    // `o.f = () => {}` stores the assignment's value, which is its operand's.
    const producer = graph.operations.get(graph.results.get(operand.source.result) ?? ('' as never))
    if (producer && depth < 8 && passesOperandThrough(producer)) for (const inner of producer.operands) noteBoxed(inner, depth + 1)
  }
  for (const operation of graph.operations.values()) {
    if (operation.family === 'invocation') {
      const callee = operandOf(operation, 'callee')
      const dynamicCallee = callee?.source.kind === 'result' && carriers.dynamic(callee.source.result)
      const targets = exactTargetsOf(operation)
      for (const argument of operation.operands) {
        if (argument.role !== 'argument') continue
        const intoDynamic =
          dynamicCallee ||
          targets.some((target) => {
            const bound = parameterResults.get(withoutFunctionSpecialization(target))?.get(argument.ordinal)
            return bound !== undefined && carriers.dynamic(bound)
          })
        if (intoDynamic) noteBoxed(argument)
      }
    }
    if (operation.family === 'binding' && (operation.action === 'initialize' || operation.action === 'write')) {
      const value = resultOf(operation, 'value')
      if (value && carriers.dynamic(value.id)) noteBoxed(valueOperandOf(operation))
    }
    if (operation.family === 'property' && operation.internalMethod === 'set') {
      const receiver = operandOf(operation, 'receiver')
      if (receiver?.source.kind === 'result' && carriers.dynamic(receiver.source.result)) noteBoxed(operandOf(operation, 'value'))
    }
  }

  // The trap functions of each site's handler literal. What a trap returns is
  // the proxy's answer for an arbitrary key, handed to the runtime as it is,
  // so a local cell a trap returns holds every write as written: `let value`
  // in TSL's `get` traps is a generator function for `@@iterator` and
  // `Reflect.get(...)` for every other key, and narrowing it to the one write
  // the checker could type would make every other key a failed unbox.
  const producerOf = (result: SemanticResultId): SemanticOperation | undefined =>
    graph.operations.get(graph.results.get(result) ?? ('' as never))
  const handlerObjects = new Set<SemanticResultId>()
  for (const operation of graph.operations.values()) {
    if (operation.family !== 'invocation' || operation.internalMethod !== 'construct') continue
    if (!sites.has(withoutSpecialization(nodeOfOperation(operation.id)))) continue
    let handler = operandOf(operation, 'argument', 1)?.source
    for (let step = 0; handler?.kind === 'result' && step < 4; step += 1) {
      const producer = producerOf(handler.result)
      if (producer?.family === 'allocation' && producer.allocated === 'object-literal') {
        handlerObjects.add(handler.result)
        break
      }
      handler = producer?.family === 'property' ? operandOf(producer, 'receiver')?.source : undefined
    }
  }
  const traps = new Set<FunctionId>()
  for (const operation of graph.operations.values()) {
    if (operation.family !== 'property' || operation.internalMethod !== 'define-own-property') continue
    const receiver = operandOf(operation, 'receiver')?.source
    if (receiver?.kind !== 'result' || !handlerObjects.has(receiver.result)) continue
    const trap = operandOf(operation, 'value')?.source
    const callable = trap?.kind === 'result' ? carriers.functionOf(trap.result) : undefined
    if (callable !== undefined) traps.add(withoutFunctionSpecialization(callable))
  }
  for (const operation of graph.operations.values()) {
    if (operation.family !== 'control' || operation.form !== 'return' || operation.caller.kind !== 'function') continue
    if (!traps.has(withoutFunctionSpecialization(operation.caller.functionId))) continue
    const returned = operandOf(operation, 'value')?.source
    const producer = returned?.kind === 'result' ? producerOf(returned.result) : undefined
    if (producer?.family === 'binding' && !parameterOf.has(producer.declaration)) raise(cells, producer.declaration, DYNAMIC)
  }

  const reachParameter = (owner: FunctionId, ordinal: number, how: Reach): void => {
    // An argument at or past the rest position is an ELEMENT of the rest
    // array: the array itself is never the proxy, and treating it as one made
    // `If( ...params )`'s own `params` a box that no rest slot can pack.
    const rest = restFrom.get(owner)
    if (rest !== undefined && ordinal >= rest) {
      const declaration = parameterBindings.get(owner)?.get(rest)
      if (declaration !== undefined) raise(restCells, declaration, how)
      return
    }
    const declaration = parameterBindings.get(owner)?.get(ordinal)
    if (declaration === undefined) return
    raise(cells, declaration, how)
  }

  while (changed) {
    changed = false
    for (const operation of graph.operations.values()) {
      const value = resultOf(operation, 'value')
      switch (operation.family) {
        case 'invocation': {
          if (operation.internalMethod === 'construct' && sites.has(withoutSpecialization(nodeOfOperation(operation.id))))
            reach(value?.id, PROXY)
          const callee = operandOf(operation, 'callee')
          const calleeReach = reachOf(callee)
          // Calling a proxy runs its `apply` trap; calling a member read off
          // one runs whatever its `get` trap returned, with the proxy as
          // `this` -- and a method may return `this`.
          if (calleeReach !== 0) {
            const calleeResult = callee?.source.kind === 'result' ? callee.source.result : undefined
            const calleeOperation =
              calleeResult === undefined ? undefined : graph.operations.get(graph.results.get(calleeResult) ?? ('' as never))
            const methodOfProxy = calleeOperation?.family === 'property' && reachOf(operandOf(calleeOperation, 'receiver')) === PROXY
            reach(value?.id, methodOfProxy ? PROXY : DYNAMIC)
          }
          const targets = exactTargetsOf(operation)
          for (const target of targets) {
            const returns = returning.get(withoutFunctionSpecialization(target))
            if (returns !== undefined) reach(value?.id, returns)
          }
          const dynamicCallee = callee?.source.kind === 'result' && (calleeReach !== 0 || carriers.dynamic(callee.source.result))
          for (const argument of operation.operands) {
            // A spread of a rest array whose elements may be proxies hands
            // those elements on, from its own position to the end of the list.
            if (argument.role === 'spread') {
              const elements = elementReachOf(argument)
              if (elements === 0) continue
              for (const target of targets) {
                const owner = withoutFunctionSpecialization(target)
                const last = Math.max(argument.ordinal, restFrom.get(owner) ?? 0, ...(parameterBindings.get(owner)?.keys() ?? []))
                for (let ordinal = argument.ordinal; ordinal <= last; ordinal += 1) reachParameter(owner, ordinal, elements)
              }
              if (elements === PROXY && targets.length === 0 && dynamicCallee)
                for (const escaped of boxed) {
                  const last = Math.max(argument.ordinal, restFrom.get(escaped) ?? 0, ...(parameterBindings.get(escaped)?.keys() ?? []))
                  for (let ordinal = argument.ordinal; ordinal <= last; ordinal += 1) reachParameter(escaped, ordinal, PROXY)
                }
              continue
            }
            if (argument.role !== 'argument') continue
            const how = reachOf(argument)
            if (how === 0) continue
            for (const target of targets) reachParameter(withoutFunctionSpecialization(target), argument.ordinal, how)
            if (how === PROXY && targets.length === 0 && dynamicCallee)
              for (const escaped of boxed) reachParameter(escaped, argument.ordinal, PROXY)
          }
          break
        }
        case 'control':
          if (operation.form === 'return') {
            const how = reachOf(operandOf(operation, 'value'))
            if (how === 0) break
            reach(resultOf(operation, 'completion')?.id, how)
            if (operation.caller.kind === 'function') raise(returning, withoutFunctionSpecialization(operation.caller.functionId), how)
          }
          break
        case 'binding': {
          if (operation.action === 'initialize' || operation.action === 'write') {
            const how = reachOf(valueOperandOf(operation))
            if (how !== 0) raise(cells, operation.declaration, how)
            const elements = elementReachOf(valueOperandOf(operation))
            if (elements !== 0) raise(restCells, operation.declaration, elements)
          }
          const elements = restCells.get(operation.declaration)
          if (elements !== undefined) {
            if (value) raise(elementReached, value.id, elements)
            for (const operand of operation.operands) {
              if (operand.source.kind !== 'result') continue
              const cited = graph.operations.get(graph.results.get(operand.source.result) ?? ('' as never))
              if (cited?.family === 'reference' && cited.form === 'identifier') raise(elementReached, operand.source.result, elements)
            }
          }
          const how = cells.get(operation.declaration)
          if (how === undefined) break
          reach(value?.id, how)
          // The reference a read takes GetValue of denotes the same cell, so it
          // is the same value (`callableOriginsOf` says why a view left behind
          // kept a native carrier the cell had not).
          for (const operand of operation.operands) {
            if (operand.source.kind !== 'result') continue
            const cited = graph.operations.get(graph.results.get(operand.source.result) ?? ('' as never))
            if (cited?.family === 'reference' && cited.form === 'identifier') reach(operand.source.result, how)
          }
          break
        }
        case 'property': {
          // An element read off an array a proxy was gathered into may be that
          // proxy. A named member is the Array's own (`join`, `length`), never
          // an element, so it keeps its carrier.
          const elements = elementReachOf(operandOf(operation, 'receiver'))
          const key = operandOf(operation, 'key')?.source
          const named = key?.kind === 'constant' && key.literal === 'string' && !isArrayIndexKey(key.text)
          if (elements !== 0 && operation.internalMethod === 'get' && !named) reach(value?.id, elements)
          const how = reachOf(operandOf(operation, 'receiver'))
          if (how === 0) break
          // A `[[Set]]` publishes the receiver it wrote into.
          if (operation.internalMethod === 'set') reach(value?.id, how)
          // A read through one is whatever its `get` trap returns.
          if (operation.internalMethod === 'get') reach(value?.id, DYNAMIC)
          break
        }
        case 'allocation': {
          // An array literal listing a proxy holds it as an element, the way a
          // rest array gathers one: three's `_shadowFilterLib = [
          // BasicShadowFilter, ... ]` lists TSL `Fn()` proxies, and a call
          // through an element read runs the `apply` trap, whose answer the
          // checker's `() => void` element type does not state.
          if (operation.allocated !== 'array-literal') break
          let how: Reach | 0 = 0
          for (const operand of operation.operands) {
            const held = operand.role === 'spread' ? elementReachOf(operand) : operand.role === 'element' ? reachOf(operand) : 0
            if (held > how) how = held
          }
          if (how !== 0 && value) raise(elementReached, value.id, how)
          break
        }
        case 'protocol':
        case 'destructuring':
          // Iterating or destructuring a proxy runs its `get` trap for
          // `@@iterator` or for each key, and then whatever that returned: the
          // checker's element and member types are the target's, which the
          // trap need not honor (TSL's builder proxy answers `@@iterator`
          // with a generator yielding `undefined`).
          if (operation.operands.some((operand) => reachOf(operand) !== 0 || elementReachOf(operand) !== 0))
            for (const result of operation.results) reach(result.id, DYNAMIC)
          break
        default:
          if (passesOperandThrough(operation)) {
            const how = Math.max(0, ...operation.operands.map(reachOf)) as Reach | 0
            if (how !== 0) reach(value?.id, how)
          }
      }
    }
  }

  // A parameter cell a proxy reaches -- through an argument or a write inside
  // the body -- is bound from the convention's slot, so the slot says `dynamic`.
  for (const declaration of cells.keys()) {
    const parameter = parameterOf.get(declaration)
    if (!parameter) continue
    const positions = parameters.get(parameter.owner) ?? new Set<number>()
    positions.add(parameter.ordinal)
    parameters.set(parameter.owner, positions)
  }
  const restElements = new Set<FunctionId>()
  for (const declaration of restCells.keys()) {
    const parameter = parameterOf.get(declaration)
    if (parameter) restElements.add(parameter.owner)
  }
  const proxyKeys = new Set<string>()
  let computedProxyKey = false
  for (const operation of graph.operations.values()) {
    if (operation.family !== 'property' || operation.internalMethod !== 'get' || reachOf(operandOf(operation, 'receiver')) !== PROXY)
      continue
    const key = operandOf(operation, 'key')
    if (key?.source.kind === 'constant' && key.source.literal === 'string') proxyKeys.add(key.source.text)
    else computedProxyKey = true
  }
  return {
    results: new Set(reached.keys()),
    proxies: new Set([...reached].filter(([, how]) => how === PROXY).map(([result]) => result)),
    returning: new Set(returning.keys()),
    parameters,
    restElements,
    elementResults: new Set(elementReached.keys()),
    proxyKeys,
    computedProxyKey
  }
}
