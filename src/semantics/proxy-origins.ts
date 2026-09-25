import type { DeclarationId, FunctionId, NodeId, SemanticResultId } from '../identity/ids.js'
import { nodeOfOperation, withoutFunctionSpecialization, withoutSpecialization } from '../identity/ids.js'
import type { SemanticGraph } from './model/graph.js'
import { operandOf, resultOf } from './model/operands.js'
import type { InvocationOperation, SemanticOperation } from './model/operations.js'

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
 * Two derived values are reached too, because the handler decides them:
 * the result of CALLING a proxy is what its `apply` trap returns, and a
 * callable read off one is whatever its `get` trap returns, called with the
 * proxy as `this`. Neither has the type the checker read off the target
 * (`Fn(...)` is `() => void`, so its call is `void`).
 *
 * A proxy that reaches no slot of its own -- a field, an element, a typed
 * parameter of a method -- keeps that slot's native carrier, and the store is
 * the checked unbox every dynamic value takes there, which refuses a proxy by
 * name at run time. A program with no site reaches nothing, so every carrier
 * in it is what it was before this fact existed.
 */
export interface ProxyOrigins {
  /** Results that may hold a proxy, or a value one of its traps produced. */
  readonly results: ReadonlySet<SemanticResultId>
  /** Functions whose completion value may be a proxy: their convention returns `dynamic`. */
  readonly returning: ReadonlySet<FunctionId>
  /** Parameter positions of source functions a proxy may be passed to: their convention takes `dynamic` there. */
  readonly parameters: ReadonlyMap<FunctionId, ReadonlySet<number>>
}

export const noProxyOrigins: ProxyOrigins = { results: new Set(), returning: new Set(), parameters: new Map() }

const valueOperandOf = (operation: SemanticOperation) => operation.operands.find((operand) => operand.evaluation.kind !== 'provenance')

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

export const proxyOriginsOf = (
  graph: SemanticGraph,
  sites: ReadonlySet<NodeId>,
  /** Whether a property read produces a callable: its value is then the proxy's `get` trap result, called with the proxy as `this`. */
  isCallableRead: (result: SemanticResultId) => boolean
): ProxyOrigins => {
  if (sites.size === 0) return noProxyOrigins
  const results = new Set<SemanticResultId>()
  const returning = new Set<FunctionId>()
  const parameters = new Map<FunctionId, Set<number>>()
  const cells = new Set<DeclarationId>()
  let changed = true
  const reach = (result: SemanticResultId | undefined): void => {
    if (result === undefined || results.has(result)) return
    results.add(result)
    changed = true
  }
  const reaches = (operand: ReturnType<typeof valueOperandOf>): boolean =>
    operand?.source.kind === 'result' && results.has(operand.source.result)
  const parameterBindings = new Map<FunctionId, Map<number, DeclarationId>>()
  for (const operation of graph.operations.values()) {
    if (operation.family !== 'binding' || operation.action !== 'initialize' || operation.caller.kind !== 'function') continue
    const initializer = operation.operands.find((operand) => operand.source.kind === 'parameter')
    if (initializer?.source.kind !== 'parameter') continue
    const owner = withoutFunctionSpecialization(operation.caller.functionId)
    const bucket = parameterBindings.get(owner) ?? new Map<number, DeclarationId>()
    bucket.set(initializer.source.ordinal, operation.declaration)
    parameterBindings.set(owner, bucket)
  }

  while (changed) {
    changed = false
    for (const operation of graph.operations.values()) {
      const value = resultOf(operation, 'value')
      switch (operation.family) {
        case 'invocation': {
          if (operation.internalMethod === 'construct' && sites.has(withoutSpecialization(nodeOfOperation(operation.id)))) reach(value?.id)
          if (reaches(operandOf(operation, 'callee'))) reach(value?.id)
          const targets = exactTargetsOf(operation)
          if (targets.some((target) => returning.has(withoutFunctionSpecialization(target)))) reach(value?.id)
          for (const argument of operation.operands) {
            if (argument.role !== 'argument' || !reaches(argument)) continue
            for (const target of targets) {
              const owner = withoutFunctionSpecialization(target)
              const declaration = parameterBindings.get(owner)?.get(argument.ordinal)
              if (declaration === undefined) continue
              const positions = parameters.get(owner) ?? new Set<number>()
              if (!positions.has(argument.ordinal)) {
                positions.add(argument.ordinal)
                parameters.set(owner, positions)
                changed = true
              }
              if (!cells.has(declaration)) {
                cells.add(declaration)
                changed = true
              }
            }
          }
          break
        }
        case 'control':
          if (operation.form === 'return' && reaches(operandOf(operation, 'value'))) {
            reach(resultOf(operation, 'completion')?.id)
            if (operation.caller.kind === 'function') {
              const owner = withoutFunctionSpecialization(operation.caller.functionId)
              if (!returning.has(owner)) {
                returning.add(owner)
                changed = true
              }
            }
          }
          break
        case 'binding': {
          if ((operation.action === 'initialize' || operation.action === 'write') && reaches(valueOperandOf(operation))) {
            if (!cells.has(operation.declaration)) {
              cells.add(operation.declaration)
              changed = true
            }
          }
          if (!cells.has(operation.declaration)) break
          reach(value?.id)
          // The reference a read takes GetValue of denotes the same cell, so it
          // is the same value (`callableOriginsOf` says why a view left behind
          // kept a native carrier the cell had not).
          for (const operand of operation.operands) {
            if (operand.source.kind !== 'result') continue
            const cited = graph.operations.get(graph.results.get(operand.source.result) ?? ('' as never))
            if (cited?.family === 'reference' && cited.form === 'identifier') reach(operand.source.result)
          }
          break
        }
        case 'property': {
          const receiver = operandOf(operation, 'receiver')
          if (!reaches(receiver)) break
          // A `[[Set]]` publishes the receiver it wrote into.
          if (operation.internalMethod === 'set') reach(value?.id)
          if (operation.internalMethod === 'get' && value && isCallableRead(value.id)) reach(value.id)
          break
        }
        default:
          if (passesOperandThrough(operation) && operation.operands.some((operand) => reaches(operand))) reach(value?.id)
      }
    }
  }
  return { results, returning, parameters }
}
