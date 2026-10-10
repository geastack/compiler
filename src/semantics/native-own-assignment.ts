import type { FunctionId, OperationId, SemanticResultId, StructuralTypeId } from '../identity/ids.js'
import type { OperandSource } from './model/operands.js'

/** The current source slot's actual producer family, rather than its public
 * intersection or the consumer's required field declaration.
 * @semanticCategory generic-primitive
 */
export interface NativeOwnAssignmentValue {
  readonly type: StructuralTypeId
  readonly source: OperandSource | { readonly kind: 'function'; readonly callable: FunctionId }
}

/** A direct slot projects the same complete source closure as bulk copies.
 * Every root names the original allocation; the consumer's view is not storage.
 * @semanticCategory generic-primitive
 */
export interface NativeOwnSlot {
  readonly key: string
  readonly roots: readonly {
    readonly allocation: SemanticResultId
    readonly values: readonly NativeOwnAssignmentValue[]
    readonly writers: readonly OperationId[]
  }[]
}

/** An intact Object.assign writes these closed source slots into its exact
 * target allocations. Argument order is preserved; each source still walks
 * its current own descriptors at runtime. An absent target key additionally
 * carries the sealed ordinary prototype absence obligation.
 * @semanticCategory generic-primitive
 */
export interface NativeOwnAssignment {
  readonly targets: readonly SemanticResultId[]
  readonly targetSlots: readonly {
    readonly allocation: SemanticResultId
    readonly slots: readonly { readonly key: string; readonly values: readonly NativeOwnAssignmentValue[] }[]
  }[]
  readonly prototype: 'ordinary-intact-absent'
  readonly sources: readonly {
    readonly ordinal: number
    readonly source: OperandSource
    readonly nullable: boolean
    readonly roots: readonly {
      readonly allocation: SemanticResultId
      readonly slots: readonly {
        readonly key: string
        readonly values: readonly NativeOwnAssignmentValue[]
        readonly copyPresent: boolean
      }[]
    }[]
    /** No closed allocation family holds this source: its representation
     * describes its own keys. `keys` are its static type's declared data
     * members, the ones a target can owe native storage for; any other key
     * its carrier holds at run time is enumerated then. `roots` is empty. */
    readonly described?: { readonly keys: readonly string[] }
  }[]
}
