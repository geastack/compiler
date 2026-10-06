import type { DeclarationId, FunctionId, IrValueId, PhysicalBodyId } from '../identity/ids.js'
import { isRegionId, withoutFunctionSpecialization } from '../identity/ids.js'
import type { Representation } from '../representation/model.js'
import { callableMemberSlot } from './callable-member-candidates.js'
import { stringConstantsOf } from './dead-values.js'
import { allOperationsOf, type IrBody, type IrOperand } from './model.js'

/** The one function a callee value was seen to hold, in the carrier it was allocated at. */
export interface CallableFlowCandidate {
  readonly functionId: FunctionId
  readonly allocated: Representation
}

const conflict = Symbol('conflict')
type Cell = CallableFlowCandidate | typeof conflict

/**
 * A candidate for a guarded call through a callable PARAMETER, CAPTURE or
 * FIELD, keyed by each body's call-site callee value. `mapReduce(fn, combine)`
 * calls `combine(accumulator, fn(read(index), index))` once per element through
 * three callables nothing proves constant, so each costs an indirect call
 * where Rayon inlines its closure.
 *
 * A candidate is never a proof. The emitter compares the callable's `invoke`
 * with the candidate's own entry before calling the entry by name
 * (`CallableObject::callKnown`), and a mismatch -- another caller, a later
 * write, an alias this census never saw -- runs the original callable
 * unchanged. So this census needs no exclusion rules and no escape analysis:
 * a wrong guess costs one compare. It joins every function it sees flow into
 * one cell, and a cell that receives two different functions has none.
 * Nothing here specializes or copies a body.
 */
export const callableFlowCandidatesOf = (
  bodies: readonly IrBody[],
  directBindings: ReadonlyMap<DeclarationId, FunctionId>
): ReadonlyMap<PhysicalBodyId, ReadonlyMap<IrValueId, CallableFlowCandidate>> => {
  const cells = new Map<string, Cell>()
  let changed = true
  const join = (key: string, incoming: Cell | undefined): void => {
    if (incoming === undefined) return
    const held = cells.get(key)
    if (held === conflict) return
    if (held === undefined) {
      cells.set(key, incoming)
      changed = true
      return
    }
    if (incoming === conflict || held.functionId !== incoming.functionId) {
      cells.set(key, conflict)
      changed = true
    }
  }
  const keysOf = new Map<IrBody, ReadonlyMap<IrValueId, string>>()
  for (const body of bodies) keysOf.set(body, stringConstantsOf(body))
  const valueKey = (body: IrBody, operand: IrOperand): string => `v|${body.owner}|${operand.value}`
  const parameterKey = (owner: FunctionId | string, ordinal: number): string => `p|${owner}|${ordinal}`
  while (changed) {
    changed = false
    for (const body of bodies) {
      const keys = keysOf.get(body)!
      const read = (operand: IrOperand): Cell | undefined => cells.get(valueKey(body, operand))
      for (const block of body.blocks.values()) {
        for (const operation of allOperationsOf(block)) {
          switch (operation.kind) {
            case 'allocate-callable':
              join(`v|${body.owner}|${operation.result.id}`, {
                functionId: operation.functionId,
                allocated: operation.result.representation
              })
              break
            case 'binding-read': {
              const direct = directBindings.get(operation.declaration)
              const result = `v|${body.owner}|${operation.result.id}`
              if (direct !== undefined) join(result, { functionId: direct, allocated: operation.result.representation })
              else join(result, cells.get(`d|${operation.declaration}`))
              break
            }
            case 'binding-write':
              join(`d|${operation.declaration}`, read(operation.value))
              break
            case 'convert':
              join(`v|${body.owner}|${operation.result.id}`, read(operation.source))
              break
            case 'phi':
              for (const incoming of operation.incoming) join(`v|${body.owner}|${operation.result.id}`, read(incoming.value))
              break
            case 'parameter': {
              // A construction names the constructor's source function; each
              // specialized copy of it reads what every construction passed.
              const result = `v|${body.owner}|${operation.result.id}`
              join(result, cells.get(parameterKey(body.sourceOwner, operation.ordinal)))
              if (!isRegionId(body.sourceOwner))
                join(result, cells.get(parameterKey(withoutFunctionSpecialization(body.sourceOwner), operation.ordinal)))
              break
            }
            case 'get': {
              const key = keys.get(operation.key.value)
              if (key !== undefined)
                join(`v|${body.owner}|${operation.result.id}`, cells.get(`s|${callableMemberSlot(operation.receiver.representation, key)}`))
              break
            }
            case 'set':
            case 'define-own-property': {
              const key = keys.get(operation.key.value)
              if (key !== undefined) join(`s|${callableMemberSlot(operation.receiver.representation, key)}`, read(operation.value))
              break
            }
            case 'call': {
              const target = operation.target
              if (target?.kind !== 'direct' || operation.argumentsAreSpread === true) break
              operation.arguments.forEach((argument, ordinal) => join(parameterKey(target.functionId, ordinal), read(argument)))
              break
            }
            case 'construct':
              if (operation.target.kind === 'exact' && operation.target.target.kind === 'function') {
                const constructor = operation.target.target.functionId
                operation.arguments.forEach((argument, ordinal) => join(parameterKey(constructor, ordinal), read(argument)))
              }
              break
          }
        }
      }
    }
  }
  const result = new Map<PhysicalBodyId, Map<IrValueId, CallableFlowCandidate>>()
  for (const body of bodies) {
    for (const block of body.blocks.values()) {
      for (const operation of allOperationsOf(block)) {
        if (operation.kind !== 'call' || operation.target?.kind === 'direct') continue
        const held = cells.get(valueKey(body, operation.callee))
        if (held === undefined || held === conflict) continue
        const own = result.get(body.owner) ?? new Map<IrValueId, CallableFlowCandidate>()
        own.set(operation.callee.value, held)
        result.set(body.owner, own)
      }
    }
  }
  return result
}
