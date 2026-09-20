import type { OperationId } from '../../identity/ids.js'
import { abiOfCallee } from '../../projection/callee.js'
import type { SlotHook } from '../../projection/slots.js'
import { operandOf } from '../../semantics/model/operands.js'
import type { GeaElementFacts } from './contract.js'

/**
 * The slot census's answer for the one element shape this plugin lowers its
 * own way: a CLASS component. Its props object is not the tag's parameter
 * (the class is constructed with none) but the first formal of the render
 * member the library points at, and only this plugin knows which member that
 * is (`contract.ts`'s `elementFactsOf`). The core census answers function
 * components itself, from the tag's own convention.
 *
 * States exactly what `lower.ts`'s `lowerClassComponent` builds: the same
 * layout, keyed by the same member, so the two cannot drift.
 */
export const createGeaSlotHook =
  (facts: ReadonlyMap<OperationId, GeaElementFacts>): SlotHook =>
  (census, operation, operand) => {
    if (operation.family !== 'element' || operation.form !== 'value') return null
    const resolved = facts.get(operation.id)
    if (!resolved || resolved.invocation !== 'construct' || resolved.renderMember === null) return null
    if (operand.role !== 'prop-value' && operand.role !== 'child') return null
    const tagOperand = operandOf(operation, 'tag')
    const tag = tagOperand ? census.carrierOf(operation, tagOperand) : null
    const instance = tag ? abiOfCallee(tag)?.result : undefined
    if (instance?.kind !== 'class-ref') return null
    const member = census.input.classes.get(instance.declaration)?.methods.find((method) => method.key === resolved.renderMember)
    const render = member?.callable ? census.input.abis.get(member.callable) : undefined
    const props = render?.parameters[0]?.value
    if (!props) return null
    if (operand.role === 'child') return operation.childrenKey === null ? null : census.fieldSlot(props, operation.childrenKey)
    const key = operandOf(operation, 'prop-key', operand.ordinal)
    return key?.source.kind === 'constant' ? census.fieldSlot(props, key.source.text) : null
  }
