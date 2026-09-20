import type { ComponentId } from '../identity/ids.js'
import type { EvaluatedObligation, ObligationTally, PreflightReport } from './run.js'

/**
 * Canonical NDJSON serialization.
 *
 * The stream is header, then component rows, then obligation rows, then
 * summary rows, then one completion row -- always in that order, and each
 * group sorted independently of whatever order the report happened to be
 * assembled in. That is what "canonical" buys: two callers holding the same
 * `PreflightReport` object always produce byte-identical output, which is
 * what makes the artifact diffable and what `certificate.ts` hashes to bind a
 * certificate to "the report object."
 *
 * There are no row caps, no top-N views, and no message clipping: every
 * component and every obligation this run censused gets a line.
 */

interface HeaderRow {
  readonly row: 'header'
  readonly version: 1
  readonly componentCount: number
  readonly obligationCount: number
}

interface ComponentRow {
  readonly row: 'component'
  readonly component: ComponentId
  readonly operationCount: number
  readonly obligationCount: number
  readonly mandatory: ObligationTally
  readonly optional: ObligationTally
}

interface ObligationRow {
  readonly row: 'obligation'
  readonly id: string
  readonly kind: string
  readonly component: ComponentId
  readonly derivesFrom: string
  readonly optional: boolean
  readonly status: string
  readonly predicate: EvaluatedObligation['predicate']
}

interface SummaryRow {
  readonly row: 'summary'
  readonly scope: 'total'
  readonly mandatory: ObligationTally
  readonly optional: ObligationTally
}

interface CompletionRow {
  readonly row: 'completion'
  readonly clean: boolean
  readonly componentCount: number
  readonly obligationCount: number
}

type PreflightRow = HeaderRow | ComponentRow | ObligationRow | SummaryRow | CompletionRow

const compareComponentId = (left: ComponentId, right: ComponentId): number => (left < right ? -1 : left > right ? 1 : 0)

/**
 * The report, one NDJSON line at a time, each with its newline.
 *
 * A generator rather than an array of rows: TypeScript's own compiler has
 * ~3 million obligations, and the joined report is longer than V8 allows a
 * single string to be (`RangeError: Invalid string length`, thrown after the
 * census had already printed, losing only the report). Every consumer either
 * writes lines as they come (`cli.ts`) or digests them as they come
 * (`certificate.ts`); nothing needs the whole text in one piece. The order
 * and the bytes of each line are exactly what the joined form produced, so
 * the digest a certificate binds to is unchanged.
 */
export function* preflightReportLines(report: PreflightReport): Generator<string, void, undefined> {
  const line = (row: PreflightRow): string => `${JSON.stringify(row)}\n`

  yield line({ row: 'header', version: 1, componentCount: report.components.length, obligationCount: report.obligations.length })

  const sortedComponentSummaries = [...report.componentSummaries].sort((left, right) => compareComponentId(left.component, right.component))
  for (const summary of sortedComponentSummaries) {
    yield line({
      row: 'component',
      component: summary.component,
      operationCount: summary.operationCount,
      obligationCount: summary.obligationCount,
      mandatory: summary.mandatory,
      optional: summary.optional
    })
  }

  const sortedObligations = [...report.obligations].sort((left, right) => {
    const byComponent = compareComponentId(left.component, right.component)
    if (byComponent !== 0) return byComponent
    if (left.kind !== right.kind) return left.kind < right.kind ? -1 : 1
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })
  for (const obligation of sortedObligations) {
    yield line({
      row: 'obligation',
      id: obligation.id,
      kind: obligation.kind,
      component: obligation.component,
      derivesFrom: obligation.derivesFrom,
      optional: obligation.optional,
      status: obligation.status,
      predicate: obligation.predicate
    })
  }

  yield line({ row: 'summary', scope: 'total', mandatory: report.totals.mandatory, optional: report.totals.optional })
  yield line({
    row: 'completion',
    clean: report.clean,
    componentCount: report.components.length,
    obligationCount: report.obligations.length
  })
}

/**
 * The whole report as one string -- for tests and small reports only. A
 * report the size of a large program's does not fit in a string at all; use
 * `preflightReportLines`.
 */
export const serializePreflightReport = (report: PreflightReport): string => [...preflightReportLines(report)].join('')
