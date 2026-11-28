import type { SemanticResultId } from '../identity/ids.js'
import type { CapabilityKey } from './certify.js'

/**
 * The refusal a target printer throws for a capability it cannot lower
 * (`targets/cpp/emit-context.ts`'s `createCppEmitBlockedError`). Declared here
 * because `src/targets/` may not declare a class, and an `Error` given its
 * brand and key by `Object.assign` has no fixed layout: a native build sees an
 * untyped bulk assignment onto a host object rather than two typed fields.
 */
export class EmitBlockedError extends Error {
  /** Filled by the emitter with the operation it was rendering, when it had one. */
  lineage?: SemanticResultId
  readonly cppEmitBlocked = true as const
  /**
   * The capability this refusal lacked, in `ir/certify.ts`'s one key
   * namespace. Typed by that union rather than `string` so a renderer cannot
   * refuse with a kind the certifier could never have demanded: a print-stage
   * refusal of a certified program is then always attributable to a demand
   * the certifier failed to raise (the certifier has already passed).
   */
  readonly kind: CapabilityKey

  constructor(message: string, kind: CapabilityKey) {
    super(message)
    this.kind = kind
  }
}
