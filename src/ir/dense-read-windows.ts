import type { DeclarationId, IrValueId } from '../identity/ids.js'
import type { Representation } from '../representation/model.js'
import type { IrBody, IrNonTerminatorOperation, SetOperation } from './model.js'
import { operandsOfIrOperation } from './queries.js'

/**
 * One member of a run of constant-index accesses of one array in one block.
 * `initialize` marks the run's first access, which takes the window; `last` is
 * the highest index any member names, so the window is checked once for all;
 * `mutable` says the run stores, so its window also proves the array writable.
 */
export interface DenseReadWindow {
  readonly ordinal: number
  readonly initialize: boolean
  readonly last: number
  readonly mutable: boolean
}

/** Reads keyed by their result; stores, which have none, by the operation. */
export interface DenseWindows {
  readonly reads: ReadonlyMap<IrValueId, DenseReadWindow>
  readonly writes: ReadonlyMap<SetOperation, DenseReadWindow>
}

type Member = { readonly read: IrValueId; readonly index: number } | { readonly write: SetOperation; readonly index: number }
type Run = { readonly members: Member[]; writes: boolean }

const primitiveKinds: ReadonlySet<string> = new Set(['scalar', 'string', 'null', 'undefined', 'symbol', 'record-literal'])
const primitive = (value: Representation): boolean => {
  if (value.kind === 'optional') return primitive(value.payload)
  if (value.kind === 'tagged-union') return value.arms.every((arm) => primitive(arm.value))
  return primitiveKinds.has(value.kind)
}

/**
 * Runs of constant-index accesses of one array with nothing between them that
 * can change the array's storage.
 *
 * A matrix multiply reads sixteen elements of each operand in a row
 * (`const a11 = ae[0], a12 = ae[4], ...`) and stores sixteen into its own,
 * and every access checked the array's live source, descriptors, integrity,
 * bounds, holes and undefined marks again: the check's cold path is a call,
 * after which the backend must reload every field it tested, so it re-tested
 * them all for the next access. Loops already take a dense window once
 * (`dense-loops.ts`); a run in straight-line code takes it at its first access,
 * sized for its highest index, and the rest use the cells.
 *
 * A run is one block's accesses of one receiver -- one SSA value, or one cell
 * that nothing writes in between -- with only operations that run no program
 * code and store nothing between them: constants, cell reads and writes,
 * primitive arithmetic and conversions, tests, and further element reads. A
 * store into a run's array keeps that run open and ends every other: the other
 * array may be the same object, and a store whose window failed takes the
 * plain path, which may grow and so move the cells. Anything else ends every
 * open run, since a call may resize, reshape or replace any array.
 */
export const straightLineArrayWindowsOf = (body: IrBody, excluded: ReadonlySet<IrValueId>, firstOrdinal = 0): DenseWindows => {
  const reads = new Map<IrValueId, DenseReadWindow>()
  const writes = new Map<SetOperation, DenseReadWindow>()
  if (body.tryRegions.length > 0 || (body.iteratorCloseRegions?.length ?? 0) > 0 || body.generator || body.async) return { reads, writes }
  const indices = new Map<IrValueId, number>()
  const cells = new Map<IrValueId, DeclarationId>()
  for (const block of body.blocks.values())
    for (const operation of block.operations) {
      // A canonical array index, however the key was spelled: `m[0]` and `m['0']` name one element.
      if (
        operation.kind === 'constant' &&
        (operation.literal === 'number' || operation.literal === 'string') &&
        /^(0|[1-9]\d{0,8})$/.test(operation.text)
      )
        indices.set(operation.result.id, Number(operation.text))
      if (operation.kind === 'binding-read') cells.set(operation.result.id, operation.declaration)
    }
  let ordinal = firstOrdinal
  const identityOf = (value: IrValueId): string => {
    const cell = cells.get(value)
    return cell === undefined ? `value:${value}` : `cell:${cell}`
  }
  const safe = (operation: IrNonTerminatorOperation): boolean => {
    switch (operation.kind) {
      case 'constant':
      case 'binding-read':
      case 'test':
        return true
      case 'compute':
        return operandsOfIrOperation(operation).every((operand) => primitive(operand.representation))
      case 'convert':
        return primitive(operation.source.representation) && primitive(operation.result.representation)
      default:
        return false
    }
  }
  const finish = (run: Run): void => {
    if (run.members.length < 2) return
    const last = Math.max(...run.members.map((member) => member.index))
    run.members.forEach((member, position) => {
      const window = { ordinal, initialize: position === 0, last, mutable: run.writes }
      if ('read' in member) reads.set(member.read, window)
      else writes.set(member.write, window)
    })
    ordinal++
  }
  for (const blockId of body.blockOrder) {
    const block = body.blocks.get(blockId)
    if (!block) continue
    const open = new Map<string, Run>()
    const closeAll = (except?: string): void => {
      for (const [identity, run] of open) {
        if (identity === except) continue
        finish(run)
        open.delete(identity)
      }
    }
    const runOf = (identity: string): Run => {
      const known = open.get(identity)
      if (known !== undefined) return known
      const run: Run = { members: [], writes: false }
      open.set(identity, run)
      return run
    }
    for (const operation of block.operations) {
      if (operation.kind === 'get' && operation.receiver.representation.kind === 'array-object' && !excluded.has(operation.result.id)) {
        const index = indices.get(operation.key.value)
        if (index !== undefined) {
          runOf(identityOf(operation.receiver.value)).members.push({ read: operation.result.id, index })
          continue
        }
      }
      if (operation.kind === 'set' && operation.receiver.representation.kind === 'array-object') {
        const index = indices.get(operation.key.value)
        if (index !== undefined) {
          const identity = identityOf(operation.receiver.value)
          closeAll(identity)
          const run = runOf(identity)
          run.members.push({ write: operation, index })
          run.writes = true
          continue
        }
      }
      if (operation.kind === 'binding-write') {
        // A write of the receiver's own cell names a different array from here on.
        const identity = `cell:${operation.declaration}`
        const run = open.get(identity)
        if (run !== undefined) {
          finish(run)
          open.delete(identity)
        }
        continue
      }
      if (!safe(operation)) closeAll()
    }
    closeAll()
  }
  return { reads, writes }
}
