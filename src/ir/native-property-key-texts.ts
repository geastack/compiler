import type { DeclarationId, IrValueId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import { propertyKeyTextOf } from '../semantics/property-key.js'
import type { IrOperand, IrOperation } from './model.js'
import { resultOfIrOperation } from './queries.js'

/** The canonical property key a key operand's constant definition states,
 * or null for a computed key. The one IR reading of a constant key.
 */
export const constantPropertyKeyTextOf = (definition: IrOperation | null | undefined): string | null =>
  definition?.kind === 'constant' ? propertyKeyTextOf(definition.literal, definition.text) : null

/** A finite primitive key, including a call to the installed String constructor.
 * An arbitrary callable returning string does not supply a key proof.
 */
export const nativePropertyKeyTextsOf = (
  operand: IrOperand,
  operations: readonly IrOperation[],
  placements: ReadonlyMap<DeclarationId, BindingPlacement>
): readonly string[] | null => {
  const definitions = new Map<IrValueId, IrOperation>()
  for (const operation of operations) {
    const result = resultOfIrOperation(operation)
    if (result !== null) definitions.set(result.id, operation)
  }
  const seen = new Set<IrValueId>()
  const visit = (value: IrValueId): readonly string[] | null => {
    if (seen.has(value)) return null
    seen.add(value)
    const operation = definitions.get(value)
    if (operation?.kind === 'constant') {
      const text = constantPropertyKeyTextOf(operation)
      return text === null ? null : [text]
    }
    if (operation?.kind !== 'call' || operation.argumentsAreSpread || operation.arguments.length !== 1) return null
    const callee = operation.callee.representation
    const producer = definitions.get(operation.callee.value)
    if (
      callee.kind !== 'native-handle' ||
      callee.protocol !== 'StringConstructor' ||
      callee.native !== null ||
      producer?.kind !== 'binding-read' ||
      placements.get(producer.declaration)?.storage.kind !== 'host-class' ||
      operations.some((candidate) => candidate.kind === 'binding-write' && candidate.declaration === producer.declaration)
    )
      return null
    return visit(operation.arguments[0]!.value)
  }
  return visit(operand.value)
}
