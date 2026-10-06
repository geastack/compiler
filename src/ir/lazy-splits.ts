import type { DeclarationId, IrValueId } from '../identity/ids.js'
import { stringConstantsOf } from './dead-values.js'
import { localIteratorValuesOf } from './local-iterators.js'
import { allOperationsOf, type IrBody, type IrOperand, type IrOperation } from './model.js'
import { operandsOfIrOperation } from './queries.js'

export interface LazySplit {
  /** The string being split. */
  readonly receiver: IrOperand
  /** The binding the receiver was read from, when it was read from one. */
  readonly receiverDeclaration: DeclarationId | null
  readonly separator: IrOperand
}

/**
 * The `s.split(separator)` calls whose array nothing reads but one local
 * `for`-`of` (`localIteratorValuesOf`), keyed by the call's result: the array
 * value the loop opens. The loop sees exactly the elements `split` would have
 * made, in order, so the emitter walks the string instead of building them
 * (`gea::runtime::string::SplitCursor`).
 *
 * A string separator only: a RegExp one has its own runtime path, and a
 * `limit` argument is not a shape this lowers.
 */
export const lazySplitsOf = (body: IrBody): ReadonlyMap<IrValueId, LazySplit> => {
  const keys = stringConstantsOf(body)
  const localIterators = localIteratorValuesOf(body)
  const definitions = new Map<IrValueId, IrOperation>()
  const uses = new Map<IrValueId, IrOperation[]>()
  for (const block of body.blocks.values())
    for (const operation of allOperationsOf(block)) {
      if ('result' in operation && operation.result) definitions.set(operation.result.id, operation)
      for (const operand of operandsOfIrOperation(operation)) {
        const list = uses.get(operand.value)
        if (list === undefined) uses.set(operand.value, [operation])
        else list.push(operation)
      }
    }
  const result = new Map<IrValueId, LazySplit>()
  for (const call of definitions.values()) {
    if (call.kind !== 'call' || call.result === null || call.arguments.length !== 1) continue
    const separator = call.arguments[0]!
    if (separator.representation.kind !== 'string') continue
    const read = definitions.get(call.callee.value)
    if (read?.kind !== 'get' || read.receiver.representation.kind !== 'string' || keys.get(read.key.value) !== 'split') continue
    const readers = uses.get(call.result.id) ?? []
    const loop = readers[0]
    if (readers.length !== 1 || loop?.kind !== 'get-iterator') continue
    if (loop.protocol !== 'iterator' || loop.method !== null || loop.receiver.value !== call.result.id) continue
    if (!localIterators.has(loop.result.id)) continue
    const source = definitions.get(read.receiver.value)
    result.set(call.result.id, {
      receiver: read.receiver,
      receiverDeclaration: source?.kind === 'binding-read' ? source.declaration : null,
      separator
    })
  }
  return result
}
