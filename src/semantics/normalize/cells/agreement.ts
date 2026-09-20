import type { StructuralTypeId } from '../../../identity/ids.js'
import type { StructuralMapper } from '../structural.js'
import type { CellFactsTable } from './model.js'

/**
 * The instrument phase 4.1 asks for: per program, how many declarations the
 * new table answers IDENTICALLY to `structural.ts`'s existing `typeAt` chain,
 * how many DIFFERENTLY, and how many this table has no opinion on at all.
 *
 * Compared as interned `StructuralTypeId`s, not as `ts.Type`s: two checker
 * types the mapper's own `typeOf` collapses onto one structural shape (a
 * literal and its widened form, say) are the SAME answer for every purpose
 * downstream of `structural.ts`, and comparing raw `ts.Type` identity would
 * report disagreement `structural.ts` itself does not have.
 *
 * This is diagnostic only -- nothing downstream reads it, and it changes
 * nothing about what `types.typeAt` returns. `bagShape`/`collectionArguments`
 * facts count as NOT COMPARABLE rather than as an unanswered cell: the table
 * did answer, just not in the `ts.Type` language `typeAt` speaks, and folding
 * that into "unanswered" would make phase 4.2's two-owner audit undercount
 * how much of the table this instrument can actually check today.
 */
export interface CellFactsAgreement {
  readonly total: number
  readonly identical: number
  readonly different: number
  readonly unanswered: number
  readonly notComparable: number
}

/**
 * What `FrontendResult.cellFacts` actually publishes: the table, plus the
 * agreement instrument when it was asked for.
 *
 * `agreement` is `null` unless a caller asked to measure, and that is not a
 * convenience: `cellFactsAgreementOf` asks `types.typeAt` about declarations
 * the compilation itself never asks about, and `typeAt` MINTS -- it interns a
 * `StructuralTypeId` on first sight. Interning an id nobody needed shifts every
 * later id, which renumbers the derived representations, which renumbers
 * `gea_record_type_N` in the emitted C++. Measuring 68 corpus programs
 * renumbered exactly that way is what found this. An instrument that changes
 * the artifact it measures is not an instrument, so it runs only when asked.
 */
export interface CellFactsPublication {
  readonly table: CellFactsTable
  readonly agreement: CellFactsAgreement | null
}

export const publishCellFacts = (table: CellFactsTable, types: StructuralMapper, measure: boolean): CellFactsPublication => ({
  table,
  agreement: measure ? cellFactsAgreementOf(table, types) : null
})

export const cellFactsAgreementOf = (table: CellFactsTable, types: StructuralMapper): CellFactsAgreement => {
  let identical = 0
  let different = 0
  let unanswered = 0
  let notComparable = 0
  for (const facts of table.all) {
    if (facts.resolved === null) {
      unanswered++
      continue
    }
    if (facts.resolved.kind !== 'type') {
      notComparable++
      continue
    }
    let chainAnswer: StructuralTypeId
    try {
      chainAnswer = types.typeAt(facts.declaration)
    } catch {
      unanswered++
      continue
    }
    const cellAnswer = types.typeOf(facts.resolved.type)
    if (cellAnswer === chainAnswer) identical++
    else different++
  }
  return { total: table.all.length, identical, different, unanswered, notComparable }
}
