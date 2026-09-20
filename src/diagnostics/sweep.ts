import type { ComponentId, NodeId, OperationFamily, OperationId } from '../identity/ids.js'
import { componentId, nodeOfOperation, operationOfResult } from '../identity/ids.js'
import type { PreflightReport } from '../preflight/run.js'
import type { RepresentationPublication } from '../representation/publish.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { partitionAuthorityComponents } from '../semantics/model/graph.js'
import type { Diagnostic, DiagnosticEvidence, DiagnosticLocation, DiagnosticReport } from './model.js'
import { createDiagnosticSink } from './model.js'

/**
 * The authority-connected diagnostic sweep.
 *
 * Every layer that can fail reports here, and every layer reports *all* of its
 * failures. Aborting at the first one is what produces the fix-one-recompile
 * loop the architecture exists to remove: a component with four independent
 * gaps should cost one run, not four.
 *
 * A row is `root` when it is independently provable, and `derived` when it only
 * exists because a root row upstream failed. That distinction is what stops one
 * missing carrier from reading as fifty unrelated language defects -- and it is
 * why derived rows carry the roots they follow from instead of being dropped.
 */

/** See `SweepInput.locationOfNode`. */
type Locate = (node: NodeId) => DiagnosticLocation | null

export interface SweepInput {
  readonly graph: SemanticGraph
  readonly representations: RepresentationPublication
  /** Absent when preflight did not run, which is itself not a failure to report. */
  readonly preflight: PreflightReport | null
  /** Diagnostics the frontend already produced, merged in rather than re-derived. */
  readonly frontend: readonly DiagnosticEvidence[]
  /**
   * Where a node identity is, for display -- `FrontendResult.locationOfNode`.
   *
   * Every row below carried `location: null` before this existed, so a build
   * that failed 334 mandatory obligations printed 334 component ids and named
   * no file. The component is a semantic identity and cannot be turned into a
   * place in the program; only the frontend's own identity walk can, which is
   * why this arrives as a function rather than being derived here.
   */
  readonly locationOfNode?: (node: NodeId) => DiagnosticLocation | null
}

/**
 * The component a blocked census candidate belongs to.
 *
 * A candidate that never became an operation never joined a component, so there
 * is no real one to name. The synthetic id is per family and says so; deriving a
 * plausible-looking real component would let a reader join these rows against
 * the graph and get an answer that is wrong.
 */
const censusComponent = (family: OperationFamily): ComponentId => componentId(`op|census|${family}|0` as OperationId)

const componentIndexOf = (graph: SemanticGraph): ReadonlyMap<OperationId, ComponentId> => {
  const index = new Map<OperationId, ComponentId>()
  for (const members of partitionAuthorityComponents(graph)) {
    const representative = members[0]
    if (!representative) continue
    const id = componentId(representative)
    for (const member of members) index.set(member, id)
  }
  return index
}

const censusDiagnostics = (graph: SemanticGraph, locate: Locate): readonly Diagnostic[] =>
  [...graph.coverage.values()].flatMap((report) =>
    report.blockers.map((blocker): Diagnostic => ({
      id: `census/${report.family}/${blocker.source}/${blocker.reason}`,
      // A withheld member states that it was withheld, so it is derived from
      // the blocked member of its component rather than a defect of its own.
      severity: blocker.reason.startsWith('withheld:') ? 'derived' : 'root',
      component: censusComponent(report.family),
      operation: null,
      missingPrimitive: blocker.missingPrimitive,
      // The candidate is named in the message because the component is
      // synthetic and identical for every row of a family; without it, thirteen
      // distinct blocked candidates print as thirteen identical lines.
      message: `${blocker.reason} (candidate ${blocker.source})`,
      location: locate(blocker.source as NodeId),
      causedBy: []
    }))
  )

const representationDiagnostics = (
  publication: RepresentationPublication,
  components: ReadonlyMap<OperationId, ComponentId>,
  locate: Locate
): readonly Diagnostic[] =>
  publication.violations.map((violation): Diagnostic => {
    const operation = violation.result ? operationOfResult(violation.result) : null
    return {
      id: `representation/${violation.guard}/${violation.result ?? 'plan'}`,
      severity: 'root',
      component: (operation ? components.get(operation) : null) ?? censusComponent('reference'),
      operation,
      missingPrimitive: null,
      message: violation.message,
      location: operation ? locate(nodeOfOperation(operation)) : null,
      causedBy: []
    }
  })

const preflightDiagnostics = (report: PreflightReport, locate: Locate): readonly Diagnostic[] => {
  // Optional rows are excluded here, not merely de-emphasized. An optional
  // obligation names a fast path the mandatory generic one already covers, so
  // an unbuilt devirtualization is not a defect in the program or the backend
  // -- and a report that fails a build over one trains its reader to ignore it.
  const rows = report.obligations.filter((obligation) => !obligation.optional && obligation.status !== 'satisfied')
  // A blocked row is explained by the failing rows of its own component, so the
  // roots are collected per component before the derived rows cite them.
  const rootsByComponent = new Map<ComponentId, string[]>()
  for (const obligation of rows) {
    if (obligation.status === 'blocked-by-upstream') continue
    const bucket = rootsByComponent.get(obligation.component) ?? []
    bucket.push(`preflight/${obligation.id}`)
    rootsByComponent.set(obligation.component, bucket)
  }

  return rows.map((obligation): Diagnostic => {
    const derived = obligation.status === 'blocked-by-upstream'
    const operation = operationOfResult(obligation.derivesFrom)
    return {
      id: `preflight/${obligation.id}`,
      severity: derived ? 'derived' : obligation.status === 'unsupported' ? 'unsupported' : 'root',
      component: obligation.component,
      operation,
      missingPrimitive: null,
      message:
        `${obligation.kind} obligation ${obligation.predicate.id} is ${obligation.status}: ` +
        `expected ${obligation.predicate.expected}, found ${obligation.predicate.actual}`,
      location: locate(nodeOfOperation(operation)),
      causedBy: derived ? [...(rootsByComponent.get(obligation.component) ?? [])].sort() : []
    }
  })
}

/**
 * Collect every layer's failures into one deterministically ordered report.
 *
 * Optional preflight obligations are deliberately absent: an unavailable fast
 * path is not a defect, and reporting one as a failure would train a reader to
 * ignore the report.
 */
export const sweepDiagnostics = (input: SweepInput): DiagnosticReport => {
  const components = componentIndexOf(input.graph)
  const locate: Locate = input.locationOfNode ?? (() => null)
  const sink = createDiagnosticSink()
  for (const evidence of input.frontend) sink.report({ ...evidence, severity: 'root', causedBy: [] })
  for (const diagnostic of censusDiagnostics(input.graph, locate)) sink.report(diagnostic)
  for (const diagnostic of representationDiagnostics(input.representations, components, locate)) sink.report(diagnostic)
  // Everything above is the plan's own verdict; everything below is
  // preflight's plan-level census (carriers, call paths, native boundaries).
  // Lowering runs on the first alone (`DiagnosticReport.planClean`); the
  // site-level capabilities are certified off the IR afterwards and are
  // `CompileResult.refusals`, not diagnostics.
  const planClean = sink.cleanSoFar()
  if (input.preflight) for (const diagnostic of preflightDiagnostics(input.preflight, locate)) sink.report(diagnostic)
  return sink.finish([...new Set(components.values())], planClean)
}
