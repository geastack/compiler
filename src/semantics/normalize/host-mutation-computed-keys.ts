import type ts from 'typescript'
import type { ValueFlowIndex } from './flow/model.js'
import { arrayIterationKeys, computedKeySetOf, type ComputedKeySetAuthority } from './flow/computed-key-set.js'
import { deferredIntrinsicProtocolLedgerOf, type IntrinsicProtocolRequirement } from './deferred-intrinsic-protocols.js'

/**
 * A computed write key the host-mutation census may narrow from `every` to a
 * finite set -- three's `this[ key ] = newValue` under `for ( const key in
 * values )` in `Material.setValues` and `Texture.setValues`.
 *
 * `computedKeySetOf` proves the set under intrinsic assumptions. The census
 * cannot publish those as ledger obligations (a failed one would be a
 * certification diagnostic, where a refused key set only costs precision),
 * so it takes them as data and checks them against its own final result:
 *
 * - "Object.prototype has no enumerable key" (the `for-in` arm) is an
 *   INDUCTIVE invariant the census proves itself. The only enumerable keys
 *   Object.prototype can have are keys this program wrote on it -- through a
 *   receiver that may be any intrinsic, or on Object.prototype itself -- so
 *   the census adds every such key to the set, re-running until that set of
 *   keys stops growing. Nothing here assumes the receiver of the write is
 *   anything in particular: the census proves that side independently.
 * - `Object.keys` and the Array iteration protocol are per-key requirements
 *   the census discharges against its own taint; a failed one re-runs the
 *   census with every computed key unknown.
 * - Anything the key-set proof registers on the flow's ledger by itself is
 *   captured here, never published, and checked the same way.
 * @semanticCategory generic-primitive
 */
export interface CensusComputedKeys {
  /** Every key the expression can evaluate to, apart from Object.prototype's inherited enumerable keys. */
  readonly keys: ReadonlySet<string>
  /** The set also holds every enumerable key Object.prototype may carry (a `for-in` binding). */
  readonly inheritsObjectPrototypeKeys: boolean
  /** Intrinsic obligations the proof assumed; the census checks them against its own result. */
  readonly requirements: readonly IntrinsicProtocolRequirement[]
}

export type CensusComputedKeysOf = (key: ts.Expression) => CensusComputedKeys | null

export const createCensusComputedKeysOf = (
  checker: ts.TypeChecker,
  flow: ValueFlowIndex,
  authority: Omit<ComputedKeySetAuthority, 'intrinsicIntact'>
): CensusComputedKeysOf => {
  const ledger = deferredIntrinsicProtocolLedgerOf(flow)
  return (key) => {
    let inherits = false
    const assumed: IntrinsicProtocolRequirement[] = []
    const work = (): ReadonlySet<string> | null =>
      computedKeySetOf(checker, flow, key, {
        ...authority,
        checker,
        intrinsicIntact: (intrinsic, member, location) => {
          if (intrinsic === 'Object' && member === undefined) inherits = true
          else if (intrinsic === 'Object') assumed.push({ intrinsic, member: member!, location })
          else assumed.push({ intrinsic, prototypeKeys: arrayIterationKeys, location })
          return true
        }
      })
    const run = ledger ? ledger.capture(work) : { value: work(), requirements: [] }
    if (run.value === null) return null
    return { keys: run.value, inheritsObjectPrototypeKeys: inherits, requirements: [...assumed, ...run.requirements] }
  }
}
