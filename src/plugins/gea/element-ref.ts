import { operationOfResult, type SemanticResultId } from '../../identity/ids.js'
import { IrLoweringBlockedError } from '../../ir/lower-graph.js'
import { namedOperand, resolveRequiredOperand, type LoweringContext } from '../../ir/lower-operands.js'
import type { IrBlockId, IrOperand } from '../../ir/model.js'
import type { SemanticOperand } from '../../semantics/model/operands.js'
import { geaRefAttributeName } from './contract.js'

/**
 * `ref={this.canvasEl}`, lowered as the store it actually is.
 *
 * Every other attribute on an intrinsic element is data the node receives, and
 * the core lowers all of them the one way: evaluate the value, write it on the
 * node. `ref` reverses the direction. Its declared type is the element itself
 * (`NativeViewProps.ref?: GeaElement | null`), so what the author wrote is not
 * a value for the node but a designator for where the node goes -- and lowering
 * it as a property write puts the *old* contents of that slot onto the node and
 * leaves the slot untouched, which is a silently wrong program rather than a
 * refused one.
 *
 * The designator arrives here already lowered, because JSX evaluates its
 * attribute expressions: `this.canvasEl` is an ordinary `[[Get]]` that ran
 * before the element was created, and its result is what this prop's value
 * operand names. So the receiver and key of the store are not re-derived from
 * syntax -- they are that same get's own operands, resolved through the one
 * function every other lowering resolves operands with. Reading them back this
 * way is what makes `ref={this.a.b}` work for free and what makes
 * `ref={someExpression}` refuse by name instead of compiling into a write
 * nobody can find.
 *
 * The get itself stays lowered. It is a real evaluation the source performed,
 * its value is dead afterwards, and suppressing it from here would mean this
 * plugin reaching into an operation the core owns.
 */
export const lowerGeaElementRef = (
  ctx: LoweringContext,
  block: IrBlockId,
  lineage: SemanticResultId,
  node: IrOperand,
  key: SemanticOperand,
  value: SemanticOperand
): boolean => {
  if (key.source.kind !== 'constant' || key.source.text !== geaRefAttributeName) return false
  if (value.source.kind !== 'result') {
    throw new IrLoweringBlockedError(
      `a "${geaRefAttributeName}" attribute must name a property to store the node in; this one names ` +
        `a ${value.source.kind} operand, which designates no slot`
    )
  }
  const designator = ctx.graph.operations.get(operationOfResult(value.source.result))
  if (!designator || designator.family !== 'property' || designator.internalMethod !== 'get') {
    throw new IrLoweringBlockedError(
      `a "${geaRefAttributeName}" attribute must name a property to store the node in; this one names ` +
        `the result of ${designator ? `a ${designator.family} operation` : 'an operation this body did not lower'}`
    )
  }
  ctx.builder.set(
    block,
    lineage,
    resolveRequiredOperand(ctx, block, lineage, namedOperand(designator, 'receiver')),
    resolveRequiredOperand(ctx, block, lineage, namedOperand(designator, 'key')),
    node,
    true,
    null
  )
  return true
}
