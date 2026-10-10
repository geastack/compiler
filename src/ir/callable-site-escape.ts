import type { DeclarationId, FunctionId, IrValueId } from '../identity/ids.js'
import type { Representation } from '../representation/model.js'
import { stringConstantsOf } from './dead-values.js'
import { allOperationsOf, type CallOperation, type IrBody, type IrOperation } from './model.js'
import { operandsOfIrOperation } from './queries.js'

/**
 * Which callable ALLOCATIONS provably never have their function-object
 * identity asked for, however much the rest of their calling convention is.
 *
 * `callable-identity-demand.ts` answers per CONVENTION: one `===` on a
 * `() => void` anywhere makes every `() => void` closure in the program
 * allocate a `FunctionObjectIdentity` (a pooled heap cell and, once it is
 * buffered, a cycle-collector candidate). In one large program three stray
 * reads of that kind -- a property read on a `{ (): void; version?: string }`
 * global that never exists, an `EventIterator` that removes its own listeners,
 * a module-level box -- made every per-operation `() => ...` closure pay for an identity nothing ever looked at.
 *
 * This is the other half: the VALUE-FLOW answer for one allocation. Starting
 * from the allocation's result it follows every copy -- phi, a non-boxing
 * convert, a local cell and each read of it anywhere in the program, the
 * formal of a directly called function -- and accepts only uses that cannot
 * see which function object they hold: calling it, `fn.call/apply/bind`,
 * handing it to a promise reaction or a `new Promise` executor, a typeof or
 * truthiness test, a comparison with null/undefined. Anything else -- stored
 * into an array, record or `any`, returned, thrown, awaited, yielded, passed
 * to a callee this walk cannot enter, compared, keyed, read or written as an
 * object -- is an escape, and the allocation keeps its identity.
 *
 * Fail-closed by construction: an operation kind not named here is an escape,
 * so a new operation can only ever make the answer smaller.
 */

/** Function.prototype members that invoke or re-wrap the callable rather than inspect it. */
const identityBlindFunctionMembers: ReadonlySet<string> = new Set(['call', 'apply', 'bind'])
/** Promise reaction registration: the callback is stored and later CALLED. */
const identityBlindPromiseMembers: ReadonlySet<string> = new Set(['then', 'catch', 'finally'])

interface ReadInfo {
  readonly receiver: Representation
  readonly key: string | undefined
}

export const unobservedCallableAllocationsOf = (
  bodies: readonly IrBody[],
  boxesCallables: (representation: Representation) => boolean,
  identityBlindHostFunction: (declaration: DeclarationId) => boolean = () => false
): ReadonlySet<IrValueId> => {
  // ---- Indexes, built once over the whole program. ----
  const uses = new Map<IrValueId, IrOperation[]>()
  const reads = new Map<IrValueId, ReadInfo>()
  const blindHostReads = new Set<IrValueId>()
  const cellReads = new Map<string, IrValueId[]>()
  const formalsOf = new Map<string, IrValueId[][]>()
  const allocations: IrValueId[] = []
  for (const body of bodies) {
    const keys = stringConstantsOf(body)
    const formals: IrValueId[] = []
    for (const block of body.blocks.values()) {
      for (const operation of allOperationsOf(block)) {
        for (const operand of operandsOfIrOperation(operation)) {
          const list = uses.get(operand.value)
          if (list) list.push(operation)
          else uses.set(operand.value, [operation])
        }
        switch (operation.kind) {
          case 'get': {
            const receiver = operation.receiver.representation
            reads.set(operation.result.id, {
              receiver: receiver.kind === 'optional' ? receiver.payload : receiver,
              key: keys.get(operation.key.value)
            })
            break
          }
          case 'binding-read': {
            if (identityBlindHostFunction(operation.declaration)) blindHostReads.add(operation.result.id)
            const list = cellReads.get(String(operation.declaration))
            if (list) list.push(operation.result.id)
            else cellReads.set(String(operation.declaration), [operation.result.id])
            break
          }
          case 'parameter':
            formals[operation.ordinal] = operation.result.id
            break
          case 'allocate-callable':
            allocations.push(operation.result.id)
            break
          default:
            break
        }
      }
    }
    const owner = String(body.sourceOwner)
    const list = formalsOf.get(owner)
    if (list) list.push(formals)
    else formalsOf.set(owner, [formals])
  }

  const isNullish = (operand: { readonly representation: Representation }): boolean =>
    operand.representation.kind === 'null' || operand.representation.kind === 'undefined'

  /**
   * Classifies one use of `value`: `false` for an escape, otherwise the values
   * this use hands the callable on to (possibly none).
   */
  const flowOf = (value: IrValueId, operation: IrOperation): IrValueId[] | false => {
    switch (operation.kind) {
      case 'branch':
        return []
      case 'phi':
        return [operation.result.id]
      case 'binding-write': {
        if (operation.value.value !== value) return false
        return cellReads.get(String(operation.declaration as DeclarationId)) ?? []
      }
      case 'convert':
        return boxesCallables(operation.result.representation) ? false : [operation.result.id]
      case 'compute':
        if (operation.form === 'in' || operation.form === 'instanceof') return false
        if (operation.form === 'equality') return operation.operands.some(isNullish) ? [] : false
        return []
      case 'get': {
        if (operation.key.value === value || operation.receiver.value !== value) return false
        const key = reads.get(operation.result.id)?.key
        return key !== undefined && identityBlindFunctionMembers.has(key) ? [] : false
      }
      case 'bind-callable':
        return operation.source.value === value &&
          operation.thisArgument?.value !== value &&
          operation.receiver?.value !== value &&
          !operation.bound.some((argument) => argument.value === value)
          ? []
          : false
      case 'construct': {
        // `new Promise(executor)` only calls it, once, and keeps nothing.
        const callee = operation.callee.representation
        const executorOnly =
          operation.arguments.length === 1 &&
          operation.arguments[0]?.value === value &&
          operation.callee.value !== value &&
          operation.newTarget.value !== value
        return executorOnly && callee.kind === 'native-handle' && callee.protocol === 'PromiseConstructor' ? [] : false
      }
      case 'call':
        return callFlowOf(value, operation)
      default:
        return false
    }
  }

  const enteredFormals = (functionId: FunctionId, index: number): IrValueId[] | false => {
    const found: IrValueId[] = []
    for (const formals of formalsOf.get(String(functionId)) ?? []) {
      const formal = formals[index]
      // An argument past the declared formals lands in a rest parameter or the
      // `arguments` object, where it is stored rather than named.
      if (formal === undefined) return false
      found.push(formal)
    }
    return found
  }

  const callFlowOf = (value: IrValueId, operation: CallOperation): IrValueId[] | false => {
    if (operation.receiver?.value === value || operation.thisArgument?.value === value) return false
    const flows: IrValueId[] = []
    if (blindHostReads.has(operation.callee.value)) return flows
    const calleeInfo = reads.get(operation.callee.value)
    const reaction =
      calleeInfo !== undefined &&
      calleeInfo.receiver.kind === 'promise' &&
      calleeInfo.key !== undefined &&
      identityBlindPromiseMembers.has(calleeInfo.key)
    for (const [index, argument] of operation.arguments.entries()) {
      if (argument.value !== value) continue
      if (reaction) continue
      const target = operation.target
      const entries: FunctionId[] = []
      if (target?.kind === 'direct') entries.push(target.functionId)
      else if (target?.kind === 'union-arm') for (const arm of target.arms) entries.push(arm.functionId)
      else if (operation.family !== undefined && operation.family.length > 0)
        for (const member of operation.family) entries.push(member.functionId)
      else return false
      for (const functionId of entries) {
        const formals = enteredFormals(functionId, index)
        if (formals === false) return false
        flows.push(...formals)
      }
    }
    // The callee position itself (calling the closure) reads no identity.
    return flows
  }

  // ---- Per allocation: every reachable use must be blind. ----
  // A walk that finishes blind has checked every use of every value it
  // reached, so each of them is blind for any later walk that arrives at it.
  const blindValues = new Set<IrValueId>()
  const unobserved = new Set<IrValueId>()
  for (const allocation of allocations) {
    const visited = new Set<IrValueId>([allocation])
    const queue: IrValueId[] = [allocation]
    let blind = true
    for (let cursor = 0; blind && cursor < queue.length; cursor++) {
      const value = queue[cursor]!
      if (blindValues.has(value)) continue
      for (const operation of uses.get(value) ?? []) {
        const flow = flowOf(value, operation)
        if (flow === false) {
          blind = false
          break
        }
        for (const next of flow) {
          if (visited.has(next)) continue
          visited.add(next)
          queue.push(next)
        }
      }
    }
    if (!blind) continue
    for (const value of visited) blindValues.add(value)
    unobserved.add(allocation)
  }
  return unobserved
}
