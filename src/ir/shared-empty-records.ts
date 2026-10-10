import type { DeclarationId, FunctionId, IrValueId, PhysicalBodyId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import type { Representation } from '../representation/model.js'
import { stringConstantsOf } from './dead-values.js'
import {
  allOperationsOf,
  type AllocateRecordOperation,
  type CallOperation,
  type IrBlock,
  type IrBlockId,
  type IrBody,
  type IrOperation
} from './model.js'
import { operandsOfIrOperation } from './queries.js'

/**
 * An empty object literal that nothing can ever write to, retain, or tell apart
 * from another empty object is one shared immutable instance.
 *
 * `inherit ?? {}` is the shape: an options default that exists so the reads
 * after it do not have to test for absence. The program then asks it for a
 * field or two, hands it to a callee that does the same, and drops it. Built
 * for real that is a pooled block the size of the whole options record (one
 * large library's is 1.5 KB, 134 optional fields), its initialization, its
 * destruction and a cycle-collector dip, per call -- to answer reads whose
 * answer is "absent" every time.
 *
 * The allocation is replaced only when the value-flow walk below proves every
 * use of it, through every copy it makes, cannot tell a shared instance from a
 * private one:
 *
 * - reads: a get of a declared data field (an absent field is absent in the
 *   shared instance too), a truthiness/presence test, a typeof, an
 *   `instanceof` test, a nullish comparison;
 * - copies: a phi, a conversion to a structural carrier, a local or region
 *   binding cell and each read of it anywhere in the program, the formal of a
 *   directly called function (walked in turn);
 * - a spread whose SOURCE it is (the copy reads it, the receiver is what
 *   changes).
 *
 * Anything else is an escape and keeps the real allocation: a write, a
 * delete or a define on it or on any copy of it (the one object every holder
 * would then see), a store of it into a field, an array or a closure, a
 * return, a throw, an await, a comparison by identity, a boxing conversion, a
 * call through a callee this walk cannot enter (indirect, virtual, host), its
 * use as a receiver. An operation kind not named here is an escape, so a new
 * operation can only make the answer smaller.
 */

interface Indexes {
  readonly uses: ReadonlyMap<IrValueId, readonly IrOperation[]>
  readonly keys: ReadonlyMap<IrValueId, string>
  readonly cellReads: ReadonlyMap<string, readonly IrValueId[]>
  readonly formalsOf: ReadonlyMap<string, readonly (readonly (IrValueId | undefined)[])[]>
}

const indexesOf = (bodies: Iterable<IrBody>): Indexes => {
  const uses = new Map<IrValueId, IrOperation[]>()
  const keys = new Map<IrValueId, string>()
  const cellReads = new Map<string, IrValueId[]>()
  const formalsOf = new Map<string, (IrValueId | undefined)[][]>()
  for (const body of bodies) {
    for (const [value, text] of stringConstantsOf(body)) keys.set(value, text)
    const formals: (IrValueId | undefined)[] = []
    for (const block of body.blocks.values()) {
      for (const operation of allOperationsOf(block)) {
        for (const operand of operandsOfIrOperation(operation)) {
          const list = uses.get(operand.value)
          if (list) list.push(operation)
          else uses.set(operand.value, [operation])
        }
        if (operation.kind === 'binding-read') {
          const list = cellReads.get(String(operation.declaration))
          if (list) list.push(operation.result.id)
          else cellReads.set(String(operation.declaration), [operation.result.id])
        } else if (operation.kind === 'parameter') formals[operation.ordinal] = operation.result.id
      }
    }
    const owner = String(body.sourceOwner)
    const list = formalsOf.get(owner)
    if (list) list.push(formals)
    else formalsOf.set(owner, [formals])
  }
  return { uses, keys, cellReads, formalsOf }
}

/**
 * Whether a value carried as this representation can only be a structural
 * object, a primitive or absent -- never a boxed dynamic value, a dictionary or
 * a host handle, which are the carriers a record converts into by aliasing.
 */
const structuralOnly = (representation: Representation): boolean => {
  switch (representation.kind) {
    case 'record':
    case 'class-ref':
    case 'scalar':
    case 'string':
    case 'symbol':
    case 'null':
    case 'undefined':
    case 'void':
      return true
    case 'native-record-ref':
      return representation.native === null && representation.recursive === undefined
    case 'optional':
      return structuralOnly(representation.payload)
    case 'borrowed-ref':
      return structuralOnly(representation.referent)
    case 'tagged-union':
      return representation.arms.every((arm) => structuralOnly(arm.value))
    default:
      return false
  }
}

/** The shape ids of every plain record a carrier can hold, looking through presence, borrows and unions. */
const recordShapesOf = (representation: Representation, into: Set<string>): void => {
  switch (representation.kind) {
    case 'record':
    case 'native-record-ref':
      into.add(representation.shapeId)
      return
    case 'optional':
      recordShapesOf(representation.payload, into)
      return
    case 'borrowed-ref':
      recordShapesOf(representation.referent, into)
      return
    case 'tagged-union':
      for (const arm of representation.arms) recordShapesOf(arm.value, into)
      return
    default:
      return
  }
}

/** Whether a carrier can only be a plain record or absent -- no class, primitive or union with either. */
const recordOnly = (representation: Representation): boolean => {
  switch (representation.kind) {
    case 'record':
      return true
    case 'native-record-ref':
      return representation.native === null
    case 'optional':
      return recordOnly(representation.payload)
    case 'borrowed-ref':
      return recordOnly(representation.referent)
    default:
      return false
  }
}

export interface SharedEmptyRecordInputs {
  readonly placements: ReadonlyMap<DeclarationId, BindingPlacement>
  /** Whether `key` is a declared data field of the plain record carrier with this shape. */
  readonly declaresField: (shapeId: string, key: string) => boolean
  /** Whether an allocation of this carrier is a plain pooled record with no accessor, index sidecar or host layout. */
  readonly plainSharedRecord: (representation: Representation) => boolean
}

export const shareReadOnlyEmptyRecords = (
  bodies: ReadonlyMap<PhysicalBodyId, IrBody>,
  inputs: SharedEmptyRecordInputs
): ReadonlyMap<PhysicalBodyId, IrBody> => {
  const candidates: AllocateRecordOperation[] = []
  for (const body of bodies.values()) {
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) {
        if (
          operation.kind === 'allocate-record' &&
          operation.fields.length === 0 &&
          inputs.plainSharedRecord(operation.result.representation)
        )
          candidates.push(operation)
      }
    }
  }
  if (candidates.length === 0) return bodies
  const { uses, keys, cellReads, formalsOf } = indexesOf(bodies.values())

  const localCell = (declaration: DeclarationId): boolean => {
    const kind = inputs.placements.get(declaration)?.storage.kind
    return kind === 'local' || kind === 'region'
  }
  const isNullish = (operand: { readonly representation: Representation }): boolean =>
    operand.representation.kind === 'null' || operand.representation.kind === 'undefined'

  const enteredFormals = (functionId: FunctionId, index: number): IrValueId[] | false => {
    const found: IrValueId[] = []
    for (const formals of formalsOf.get(String(functionId)) ?? []) {
      const formal = formals[index]
      if (formal === undefined) return false
      found.push(formal)
    }
    return found
  }

  const callFlowOf = (value: IrValueId, operation: CallOperation): IrValueId[] | false => {
    if (operation.receiver?.value === value || operation.callee.value === value) return false
    const flows: IrValueId[] = []
    for (const [index, argument] of operation.arguments.entries()) {
      if (argument.value !== value) continue
      const target = operation.target
      const entries: FunctionId[] = []
      if (target?.kind === 'direct') entries.push(target.functionId)
      else if (target?.kind === 'union-arm') for (const arm of target.arms) entries.push(arm.functionId)
      else if (operation.family !== undefined && operation.family.length > 0)
        for (const member of operation.family) entries.push(member.functionId)
      // A call through a callable value (`Concern.fromOptions(options)`
      // reads the method off its class object) has no physical target, but the
      // call-identity census may still have named every body it can enter.
      else if (operation.closedCallee?.kind === 'exact') entries.push(operation.closedCallee.functionId)
      else if (operation.closedCallee?.kind === 'closed-family')
        for (const functionId of operation.closedCallee.functionIds) entries.push(functionId)
      else return false
      for (const functionId of entries) {
        const formals = enteredFormals(functionId, index)
        if (formals === false) return false
        flows.push(...formals)
      }
    }
    return flows
  }

  /** The values this use hands the record on to, or `false` when the use could tell a shared instance from a private one. */
  const flowOf = (value: IrValueId, shapes: ReadonlySet<string>, operation: IrOperation): IrValueId[] | false => {
    switch (operation.kind) {
      case 'branch':
        return operation.condition.value === value ? [] : false
      case 'phi':
        return [operation.result.id]
      case 'binding-write':
        return operation.value.value === value && localCell(operation.declaration)
          ? [...(cellReads.get(String(operation.declaration)) ?? [])]
          : false
      case 'convert': {
        if (operation.source.value !== value || operation.rebuild !== undefined || !structuralOnly(operation.result.representation))
          return false
        // A record converted to a record of ANOTHER shape is a view built
        // field by field in the target's layout (`emit-record-view.ts`): a
        // fresh object that shares nothing with this one, so its uses say
        // nothing about it.
        const produced = new Set<string>()
        recordShapesOf(operation.result.representation, produced)
        const fresh = produced.size > 0 && [...produced].every((shape) => !shapes.has(shape)) && recordOnly(operation.result.representation)
        return fresh ? [] : [operation.result.id]
      }
      case 'merge-live-arm-rebuild':
        return operation.source.value === value && structuralOnly(operation.result.representation) ? [operation.result.id] : false
      case 'test':
        return operation.value.value === value ? [] : false
      case 'compute': {
        const first = operation.operands[0]
        switch (operation.form) {
          case 'typeof':
            return []
          case 'instanceof':
            return first?.value === value && operation.operands[1]?.value !== value ? [] : false
          case 'equality':
            return operation.operands.some(isNullish) ? [] : false
          case 'unary':
            return operation.operator === '!' ? [] : false
          case 'require-object-coercible':
          case 'require-iterable-present':
          case 'require-tagged-union-arm':
            return structuralOnly(operation.result.representation) ? [operation.result.id] : false
          default:
            return false
        }
      }
      case 'get': {
        if (operation.receiver.value !== value || operation.key.value === value) return false
        if (
          operation.hostMethod !== undefined ||
          operation.typedComputedRead !== undefined ||
          operation.callableOwnPrototype !== undefined ||
          operation.reactive === true
        )
          return false
        const key = keys.get(operation.key.value)
        if (key === undefined) return false
        const receiver = new Set<string>()
        recordShapesOf(operation.receiver.representation, receiver)
        // A read of anything but a declared data field of the record is a
        // member of its prototype -- `hasOwnProperty`, `toString` -- which is
        // a method bound to the record, so the record escapes into it.
        for (const shape of shapes) if (receiver.has(shape) && !inputs.declaresField(shape, key)) return false
        return receiver.size > 0 ? [] : false
      }
      case 'spread-copy':
        return operation.source.value === value && operation.receiver.value !== value ? [] : false
      case 'call':
        return callFlowOf(value, operation)
      default:
        return false
    }
  }

  // A walk that finishes clean has checked every use of every value it
  // reached, so each of them is clean for any later walk that arrives there.
  const clean = new Set<IrValueId>()
  const shared = new Set<IrValueId>()
  for (const allocation of candidates) {
    const shapes = new Set<string>()
    recordShapesOf(allocation.result.representation, shapes)
    const visited = new Set<IrValueId>([allocation.result.id])
    const queue: IrValueId[] = [allocation.result.id]
    let blind = true
    for (let cursor = 0; blind && cursor < queue.length; cursor++) {
      const value = queue[cursor]!
      if (clean.has(value)) continue
      for (const operation of uses.get(value) ?? []) {
        const flow = flowOf(value, shapes, operation)
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
    for (const value of visited) clean.add(value)
    shared.add(allocation.result.id)
  }
  if (shared.size === 0) return bodies

  let output: Map<PhysicalBodyId, IrBody> | null = null
  for (const [id, body] of bodies) {
    let blocks: Map<IrBlockId, IrBlock> | null = null
    for (const [blockId, block] of body.blocks) {
      if (!block.operations.some((operation) => operation.kind === 'allocate-record' && shared.has(operation.result.id))) continue
      blocks ??= new Map(body.blocks)
      blocks.set(blockId, {
        ...block,
        operations: block.operations.map((operation) =>
          operation.kind === 'allocate-record' && shared.has(operation.result.id) ? { ...operation, sharedEmpty: true as const } : operation
        )
      })
    }
    if (blocks === null) continue
    output ??= new Map(bodies)
    output.set(id, { ...body, blocks })
  }
  return output ?? bodies
}
