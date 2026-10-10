import type { DeclarationId, SemanticResultId } from '../identity/ids.js'
import type { OperandSource } from './model/operands.js'

/** A source-authenticated readonly descriptor at one actual PutValue boundary.
 * Source stock method identity, entry order and evaluated SSA remain explicit.
 * @semanticCategory generic-primitive
 */
export interface NativeCallableReadonlySetSource {
  readonly receiver: SemanticResultId
  readonly key: OperandSource
  readonly keys: readonly ('name' | 'length')[]
  readonly sources: readonly {
    readonly read: SemanticResultId
    readonly declaration: DeclarationId
    readonly member: string
  }[]
  readonly entries: readonly SemanticResultId[]
}
