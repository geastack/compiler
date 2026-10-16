import type { ClassLayout } from '../projection/classes.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { DeclarationId } from '../identity/ids.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import type { AllocateConstructorOperation } from './model.js'

/** Lowering may omit a construct entry only on the exact semantic allocation that proved it unreachable. */
export const classConstructionStatusMatches = (
  operation: AllocateConstructorOperation,
  semantic: SemanticOperation | null,
  context?: { readonly classes: ReadonlyMap<DeclarationId, ClassLayout>; readonly deriver: Pick<RepresentationDeriver, 'derive'> }
): boolean => {
  // A static block has no ordinary receiver ABI. Its existing synthesized
  // class value must consume the same projected construction status, and its
  // semantic receiver carrier authenticates which class owns that status.
  if (semantic?.family === 'reference' && semantic.form === 'this') {
    const receiver = semantic.operands.find((operand) => operand.role === 'static-class-receiver' && operand.source.kind === 'receiver')
    if (!receiver || !context) return false
    const carrier = context.deriver.derive(receiver.type)
    const result = operation.result.representation
    if (
      carrier.kind !== 'constructor-family' ||
      carrier.members.length !== 1 ||
      carrier.members[0] !== operation.declaration ||
      result.kind !== 'constructor-family' ||
      result.members[0] !== operation.declaration
    )
      return false
    const layout = context.classes.get(operation.declaration)
    return layout !== undefined && (operation.constructionDeferred === true) === (layout.constructionDeferred === true)
  }
  if (semantic?.family === 'allocation' && semantic.allocated === 'class-constructor-object') {
    if (!context) return false
    // Derivation already selects the physical generic copy. The semantic
    // declaration spelling may name its unspecialized layout instead.
    const carrier = context.deriver.derive(semantic.shape)
    const result = operation.result.representation
    if (
      carrier.kind !== 'constructor-family' ||
      carrier.members[0] !== operation.declaration ||
      result.kind !== 'constructor-family' ||
      result.members[0] !== operation.declaration
    )
      return false
    return (operation.constructionDeferred === true) === (semantic.classConstructionDeferred === true)
  }
  return operation.constructionDeferred !== true
}
