import type { ComponentId, OperationId } from '../identity/ids.js'
import type { PrimitiveFamily } from '../semantics/model/coverage.js'

/**
 * Diagnostics.
 *
 * A diagnostic is keyed by semantic identity. A source location may accompany
 * it for a human to read, but it never flows back into admission: the moment a
 * location decides whether something compiles, the compiler has started
 * recognizing programs instead of implementing a language.
 *
 * The sweep collects every independently provable failure in an authority
 * component rather than throwing at the first one, and it marks derived
 * failures as derived so one missing carrier does not read as fifty unrelated
 * language defects.
 */

export type DiagnosticSeverity = 'root' | 'derived' | 'unsupported'

export interface DiagnosticLocation {
  /** Display only. Never an admission input. */
  readonly file: string
  readonly line: number
  readonly column: number
}

export interface Diagnostic {
  /** Stable identity, so repeated sweeps can be compared row by row. */
  readonly id: string
  readonly severity: DiagnosticSeverity
  readonly component: ComponentId
  readonly operation: OperationId | null
  /** The primitive family whose absence explains this row, when known. */
  readonly missingPrimitive: PrimitiveFamily | null
  readonly message: string
  readonly location: DiagnosticLocation | null
  /** For a derived row, the root rows it follows from. */
  readonly causedBy: readonly string[]
}

/** Failure evidence produced before the sweep assigns root/derived severity. */
export type DiagnosticEvidence = Omit<Diagnostic, 'severity' | 'causedBy'>

/** A complete sweep result. Bounded views may be derived; this is the whole set. */
export interface DiagnosticReport {
  readonly diagnostics: readonly Diagnostic[]
  readonly components: readonly ComponentId[]
  /** True only when the transaction proved every obligation it censused. */
  readonly clean: boolean
  /**
   * True when the frontend, the census and the plan raised nothing, before
   * preflight's obligations were consulted. This is the gate lowering runs
   * on: a program whose plan verifies lowers whether or not it certifies, and
   * what it cannot lower is a refusal row, because certification covers the
   * lowered IR. `clean` implies `planClean`; the converse is the uncertified,
   * lowerable program.
   */
  readonly planClean: boolean
}

const severityOrder: Readonly<Record<DiagnosticSeverity, number>> = Object.freeze({ root: 0, unsupported: 1, derived: 2 })

/**
 * Deterministic ordering: roots first, then by component, then by identity.
 *
 * Determinism is what makes two sweeps comparable. Ordering by discovery time
 * or by source position would make an unchanged compiler produce different
 * reports on different machines.
 */
export const orderDiagnostics = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] =>
  [...diagnostics].sort((left, right) => {
    const bySeverity = severityOrder[left.severity] - severityOrder[right.severity]
    if (bySeverity !== 0) return bySeverity
    if (left.component !== right.component) return left.component < right.component ? -1 : 1
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0
  })

/**
 * Merge exact duplicates by identity while keeping every component they arose
 * from, so a shared root reported from two components stays one row.
 */
export const mergeDiagnostics = (diagnostics: readonly Diagnostic[]): readonly Diagnostic[] => {
  const byId = new Map<string, Diagnostic>()
  for (const diagnostic of diagnostics) {
    const existing = byId.get(diagnostic.id)
    if (!existing) {
      byId.set(diagnostic.id, diagnostic)
      continue
    }
    byId.set(diagnostic.id, {
      ...existing,
      causedBy: [...new Set([...existing.causedBy, ...diagnostic.causedBy])].sort()
    })
  }
  return orderDiagnostics([...byId.values()])
}

/** Group a report by authority component for planning. */
export const groupByComponent = (report: DiagnosticReport): ReadonlyMap<ComponentId, readonly Diagnostic[]> => {
  const grouped = new Map<ComponentId, Diagnostic[]>()
  for (const diagnostic of orderDiagnostics(report.diagnostics)) {
    const bucket = grouped.get(diagnostic.component) ?? []
    bucket.push(diagnostic)
    grouped.set(diagnostic.component, bucket)
  }
  return grouped
}

/** A collector that gathers a whole component's failures before aborting. */
export interface DiagnosticSink {
  readonly report: (diagnostic: Diagnostic) => void
  /** Whether nothing reported so far survives merging -- asked once, between the plan's rows and preflight's, for `DiagnosticReport.planClean`. */
  readonly cleanSoFar: () => boolean
  readonly finish: (components: readonly ComponentId[], planClean?: boolean) => DiagnosticReport
}

export const createDiagnosticSink = (): DiagnosticSink => {
  const collected: Diagnostic[] = []
  const cleanSoFar = (): boolean => mergeDiagnostics(collected).length === 0
  return {
    report: (diagnostic) => {
      collected.push(diagnostic)
    },
    cleanSoFar,
    finish: (components, planClean) => {
      const diagnostics = mergeDiagnostics(collected)
      const clean = diagnostics.length === 0
      return { diagnostics, components: [...components].sort(), clean, planClean: planClean ?? clean }
    }
  }
}
