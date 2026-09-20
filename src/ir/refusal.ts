import type { AbiProjectionBlocker } from '../projection/abi.js'
import type { CppEmissionRefusal } from '../targets/cpp/translation-unit.js'
import type { CapabilityKey } from './certify.js'
import type { IrLoweringBlocker } from './lower.js'

/**
 * Why a program, or one body of it, produced no C++.
 *
 * One list for every stage, so a caller counting "what was refused" reads one
 * field rather than four (`censusAccounting`, `abiBlockers`,
 * `loweringBlockers`, `emissionRefusals`, which stay published for the
 * instruments that already read them). The `census` rows arrive last in this
 * refactor and were the ones most obviously missing: a write-discovery census
 * that could not type a cell published a COUNT in a side table, so no caller
 * asking what a compilation refused could see one at all. `stage` says who refused; `owner` is
 * the function, region, declaration or struct the refusal is attributed to;
 * `key` is the refusal's place in the capability namespace. `certify` rows come from
 * `ir/certify.ts` already keyed by the manifest's namespace; a lowering
 * blocker is still keyed `lower:blocked`, because the blocker sites name no
 * capability yet and a key invented here would be a second vocabulary.
 */
export type RefusalStage = 'census' | 'abi' | 'lower' | 'certify' | 'print'

/**
 * A capability key from the manifest's namespace, or one of the three
 * stage-shaped keys the blocker sites still produce because they name no
 * capability yet. Phase 2.3 retires the three as each site learns its key.
 */
export type RefusalKey = CapabilityKey | CensusRefusalKeyShape | 'abi:blocked' | 'lower:blocked' | 'print:refused'

/**
 * `semantics/normalize/census-refusal.ts`'s key shape, restated rather than
 * imported: the frontend settles before there is a plan to certify against, and
 * the IR must not depend on semantics to name a stage it merely forwards. The
 * template keeps the two spellings from drifting into different namespaces
 * without making one layer import the other.
 */
type CensusRefusalKeyShape = `census:${string}`

export interface Refusal {
  readonly stage: RefusalStage
  readonly key: RefusalKey
  readonly reason: string
  readonly owner: string
}

export const refusalsOf = (
  censusRefusals: readonly Refusal[],
  abiBlockers: readonly AbiProjectionBlocker[],
  loweringBlockers: readonly IrLoweringBlocker[],
  certification: readonly Refusal[],
  emissionRefusals: readonly CppEmissionRefusal[]
): readonly Refusal[] => [
  // First because they happen first: a cell the frontend could not type is why
  // a later stage had nothing to certify, so a reader scanning this list top to
  // bottom meets the cause before the symptom.
  ...censusRefusals,
  ...abiBlockers.map((blocker): Refusal => {
    // The identity is kept even when a location is known: unlike a census
    // refusal's ts.Declaration-derived name, nothing at this stage has a
    // human label for the function, only its FunctionId -- and the location
    // supplements that rather than replacing it, the way `build.mjs`'s own
    // `where()` already renders a `Diagnostic`'s `location`.
    const owner = blocker.location ? `${blocker.functionId} @${blocker.location.file}:${blocker.location.line}` : String(blocker.functionId)
    return { stage: 'abi', key: 'abi:blocked', reason: blocker.reason, owner }
  }),
  ...loweringBlockers.map((blocker): Refusal => ({
    stage: 'lower',
    key: 'lower:blocked',
    reason: blocker.reason,
    owner: String(blocker.owner)
  })),
  ...certification,
  ...emissionRefusals.map((refusal): Refusal => ({
    stage: 'print',
    key: refusal.key,
    reason: refusal.reason,
    owner: String(refusal.owner)
  }))
]
