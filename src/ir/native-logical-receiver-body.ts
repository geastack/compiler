import type { SemanticOperation } from '../semantics/model/operations.js'
import { operandOf, resultOf } from '../semantics/model/operands.js'
import { allOperationsOf, type ReceiverOperation, type IrBody } from './model.js'

/** A physical nil receiver frame cannot consume incoming this. A receiver
 * read in that frame is valid only when it reads the declared lexical capture.
 */
export const nativeBodyIgnoresLogicalReceiver = (body: IrBody): boolean => {
  if (body.abi?.receiver !== null) return false
  for (const block of body.blocks.values())
    for (const operation of allOperationsOf(block)) if (operation.kind === 'receiver' && operation.origin !== 'lexical') return false
  return true
}

/** The lexical marker consumes normalization's exact captured-receiver role. */
export const lexicalReceiverOriginMatches = (operation: ReceiverOperation, semantic: SemanticOperation | null): boolean => {
  const receiver = semantic === null ? undefined : operandOf(semantic, 'captured-receiver')
  return (
    operation.origin === 'lexical' &&
    semantic?.family === 'reference' &&
    (semantic.form === 'this' || semantic.form === 'super-property') &&
    resultOf(semantic, 'value')?.id === operation.lineage &&
    receiver?.source.kind === 'receiver'
  )
}
