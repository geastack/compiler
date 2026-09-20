import type { ComponentId, OperationId, SemanticResultId } from '../identity/ids.js'
import { componentId, operationOfResult } from '../identity/ids.js'
import { representationKey, type Representation } from '../representation/model.js'
import type { SealedRepresentationPlan } from '../representation/plan.js'
import type { SemanticGraph } from '../semantics/model/graph.js'
import { partitionAuthorityComponents } from '../semantics/model/graph.js'
import type { SemanticOperation } from '../semantics/model/operations.js'
import type { Obligation, ObligationId, ObligationKind, ObligationStatus, TargetRuntimeManifest } from './obligations.js'
import { localStatusOf, obligationId, predicate } from './obligations.js'

/**
 * The read-only plan-level capability census.
 *
 * `runPreflight` takes frozen inputs -- a sealed representation plan, a sealed
 * semantic graph, and a sealed backend manifest -- and returns a report. It
 * never mutates any of them, never selects a carrier, never invokes an
 * emitter; every check below is a membership test against an already-frozen
 * set. That is what makes this a census and not a second solver: nothing it
 * computes could change if run again on the same inputs, and nothing it finds
 * was not already true before this module ran.
 *
 * This is the PLAN's census
 * only: is every selected carrier one the target can spell, does every
 * invocation have a call path, is every `native-handle` behind an
 * authenticated protocol, may an ambient binding be an `extern`. Everything
 * that depended on how a site would LOWER -- which conversion a slot needs,
 * which property recipe a receiver takes, which runtime helper a protocol
 * step calls -- is certified once, off the IR lowering actually built
 * (`ir/certify.ts`), and the seven builders that predicted it here are gone.
 * What remains gates lowering through the diagnostic sweep; the certificate
 * is minted from the IR certification.
 */

/**
 * `into.push(...items)` spreads `items` onto the call stack, and V8 caps a
 * call's argument count. TypeScript's own compiler certifies as ONE component
 * of the checker's size, whose evaluated obligations no longer fit in a
 * single call -- `RangeError: Maximum call stack size exceeded`, 20 minutes
 * in, from a line that only appends to a list. A loop has no such cap.
 */
const appendAll = <T>(into: T[], items: readonly T[]): void => {
  for (const item of items) into.push(item)
}

export interface PreflightInput {
  readonly semanticGraph: SemanticGraph
  readonly representationPlan: SealedRepresentationPlan
  readonly manifest: TargetRuntimeManifest
}

export interface ObligationTally {
  readonly satisfied: number
  readonly missing: number
  readonly unsupported: number
  readonly blockedByUpstream: number
}

export interface EvaluatedObligation extends Obligation {
  readonly status: ObligationStatus
}

export interface PreflightComponentSummary {
  readonly component: ComponentId
  readonly operationCount: number
  readonly obligationCount: number
  readonly mandatory: ObligationTally
  readonly optional: ObligationTally
}

export interface PreflightReport {
  /** Every authority component that was censused, in the order it was processed. */
  readonly components: readonly ComponentId[]
  /** Every obligation row. No caps, no top-N, no clipping -- the complete census. */
  readonly obligations: readonly EvaluatedObligation[]
  readonly componentSummaries: readonly PreflightComponentSummary[]
  readonly totals: { readonly mandatory: ObligationTally; readonly optional: ObligationTally }
  /** True only when every mandatory obligation is `satisfied`. Optional gaps never affect this. */
  readonly clean: boolean
}

const carrierKinds: ReadonlySet<ObligationKind> = new Set(['binding-carrier', 'expression-carrier', 'return-carrier'])

const carrierKindFor = (operation: SemanticOperation): 'binding-carrier' | 'return-carrier' | 'expression-carrier' => {
  if (operation.family === 'binding') return 'binding-carrier'
  if (operation.family === 'control' && operation.form === 'return') return 'return-carrier'
  return 'expression-carrier'
}

/** The result an operation-level obligation anchors to: its value, else its completion, else its first result. */
const primaryResultOf = (operation: SemanticOperation): SemanticResultId | null => {
  const value = operation.results.find((result) => result.role === 'value')
  if (value) return value.id
  const completion = operation.results.find((result) => result.role === 'completion')
  if (completion) return completion.id
  const first = operation.results[0]
  return first ? first.id : null
}
/**
 * The carrier obligation for one published result, plus the backend-capability
 * triplet (physical type, verifier, emitter) once a carrier was actually
 * selected. A result the plan left unresolved gets only the carrier row: there
 * is no carrier kind yet to ask the manifest about.
 */
const buildCarrierObligations = (
  cid: ComponentId,
  resultId: SemanticResultId,
  operation: SemanticOperation,
  plan: SealedRepresentationPlan,
  manifest: TargetRuntimeManifest
): Obligation[] => {
  const kind = carrierKindFor(operation)
  const representation = plan.selected.get(resultId)
  const resolved = representation !== undefined && representation.kind !== 'unresolved'
  const actual =
    representation === undefined ? 'absent' : representation.kind === 'unresolved' ? `unresolved(${representation.reason})` : 'resolved'
  const carrierCheck = predicate(`${kind}:selected`, 'resolved', actual)
  const carrierObligation: Obligation = {
    id: obligationId(cid, kind, resultId),
    kind,
    component: cid,
    derivesFrom: resultId,
    predicate: carrierCheck,
    optional: false,
    localStatus: localStatusOf(carrierCheck, false)
  }
  if (!resolved || representation === undefined) return [carrierObligation]

  const key = representationKey(representation)
  const physicalCheck = predicate(`physical-cpp-type:${key}`, 'registered', manifest.physicalTypes.has(key) ? 'registered' : 'absent')
  const verifierCheck = predicate(`verifier-recipe:${key}`, 'registered', manifest.verifierRecipes.has(key) ? 'registered' : 'absent')
  const emitterCheck = predicate(`emitter-recipe:${key}`, 'registered', manifest.emitterRecipes.has(key) ? 'registered' : 'absent')
  return [
    carrierObligation,
    {
      id: obligationId(cid, 'physical-cpp-type', resultId),
      kind: 'physical-cpp-type',
      component: cid,
      derivesFrom: resultId,
      predicate: physicalCheck,
      optional: false,
      localStatus: localStatusOf(physicalCheck, false)
    },
    {
      id: obligationId(cid, 'verifier-recipe', resultId),
      kind: 'verifier-recipe',
      component: cid,
      derivesFrom: resultId,
      predicate: verifierCheck,
      optional: false,
      localStatus: localStatusOf(verifierCheck, false)
    },
    {
      id: obligationId(cid, 'emitter-recipe', resultId),
      kind: 'emitter-recipe',
      component: cid,
      derivesFrom: resultId,
      predicate: emitterCheck,
      optional: false,
      localStatus: localStatusOf(emitterCheck, false)
    }
  ]
}

/**
 * Call ABI obligations. The mandatory row is always the generic dynamic-
 * dispatch call path -- per the doc, `open` "is a complete, correct answer,"
 * so every invocation, whatever its target proof, must be able to fall back
 * to it. `exact`/`closed-family` targets additionally get an `optional`
 * devirtualization row, reported separately so its absence never fails a
 * build the generic path already covers.
 */
const buildCallAbiObligations = (cid: ComponentId, operation: SemanticOperation, manifest: TargetRuntimeManifest): Obligation[] => {
  if (operation.family !== 'invocation') return []
  const anchor = primaryResultOf(operation)
  if (!anchor) return []
  const target = operation.target
  const obligations: Obligation[] = []

  const genericCheck = predicate('call-abi:generic', 'installed', manifest.hasGenericCallPath ? 'installed' : 'absent')
  obligations.push({
    id: obligationId(cid, 'call-abi', `${anchor}:generic`),
    kind: 'call-abi',
    component: cid,
    derivesFrom: anchor,
    predicate: genericCheck,
    optional: false,
    localStatus: localStatusOf(genericCheck, false)
  })

  if (target.kind === 'exact') {
    const registered =
      target.target.kind === 'function'
        ? manifest.functionAbis.has(target.target.functionId)
        : manifest.implicitConstructorAbis.has(target.target.classDeclaration)
    const check = predicate('call-abi:exact', 'registered', registered ? 'registered' : 'absent')
    obligations.push({
      id: obligationId(cid, 'call-abi', `${anchor}:exact`),
      kind: 'call-abi',
      component: cid,
      derivesFrom: anchor,
      predicate: check,
      optional: true,
      localStatus: localStatusOf(check, false)
    })
  } else if (target.kind === 'closed-family') {
    const total = target.targets.length
    const registeredCount = target.targets.filter((member) =>
      member.kind === 'function'
        ? manifest.functionAbis.has(member.functionId)
        : manifest.implicitConstructorAbis.has(member.classDeclaration)
    ).length
    const check = predicate('call-abi:closed-family', `${total}/${total}`, `${registeredCount}/${total}`)
    obligations.push({
      id: obligationId(cid, 'call-abi', `${anchor}:closed-family`),
      kind: 'call-abi',
      component: cid,
      derivesFrom: anchor,
      predicate: check,
      optional: true,
      localStatus: localStatusOf(check, false)
    })
  }
  return obligations
}

/** `native-handle` is admissible only behind a versioned, authenticated host protocol -- never generically. */
const buildNativeBoundaryObligation = (
  cid: ComponentId,
  resultId: SemanticResultId,
  representation: Representation,
  manifest: TargetRuntimeManifest
): Obligation[] => {
  if (representation.kind !== 'native-handle') return []
  // The carrier is the claim wherever the host stated one. A target either has
  // `gea::embedded::ui::NodeHandle` or it does not; claiming it thirteen times
  // under thirteen declared names is thirteen chances for the answers to differ.
  const key = `${representation.native ?? representation.protocol}@${representation.version}`
  const check = predicate(`native-boundary:${key}`, 'registered', manifest.nativeProtocols.has(key) ? 'registered' : 'absent')
  return [
    {
      id: obligationId(cid, 'native-boundary', resultId),
      kind: 'native-boundary',
      component: cid,
      derivesFrom: resultId,
      predicate: check,
      optional: false,
      localStatus: localStatusOf(check, false)
    }
  ]
}

/**
 * An ambient value declaration's introduction (`BindingOperation.external`,
 * semantics/model/operations.ts) is the other way a result crosses into host
 * territory, alongside `native-handle`. It censuses against
 * `manifest.supportsExternalBindings` rather than `nativeProtocols`: see that
 * field's own comment (preflight/obligations.ts) for why this is one flag and
 * not a set keyed per declaration. Raising the obligation per result rather
 * than once globally still names exactly which declaration would be blocked
 * if the flag were ever false, the same way every other obligation in this
 * file anchors to the result it is actually about.
 */
const buildExternalBindingObligation = (
  cid: ComponentId,
  resultId: SemanticResultId,
  operation: SemanticOperation,
  manifest: TargetRuntimeManifest
): Obligation[] => {
  if (operation.family !== 'binding' || !operation.external) return []
  const check = predicate('native-boundary:external-binding', 'installed', manifest.supportsExternalBindings ? 'installed' : 'absent')
  return [
    {
      id: obligationId(cid, 'native-boundary', `${resultId}:external-binding`),
      kind: 'native-boundary',
      component: cid,
      derivesFrom: resultId,
      predicate: check,
      optional: false,
      localStatus: localStatusOf(check, false)
    }
  ]
}

/**
 * Raise a locally-satisfied carrier obligation to `blocked-by-upstream` when
 * either (a) a sibling obligation on the same result -- its call ABI,
 * property access, native boundary, or conversion capability -- did not
 * itself pass, or (b) the carrier obligation of a result this operation
 * consumes as an operand did not resolve. This is the one place a status can
 * differ from `localStatus`, and it is a monotone closure over an already-
 * computed, finite obligation set: no obligation here invents a fact, and the
 * loop is bounded by the obligation count, so it is propagation, not solving.
 */
const closeBlockedByUpstream = (obligations: readonly Obligation[], graph: SemanticGraph): EvaluatedObligation[] => {
  const byResult = new Map<SemanticResultId, ObligationId[]>()
  for (const obligation of obligations) {
    const siblings = byResult.get(obligation.derivesFrom) ?? []
    siblings.push(obligation.id)
    byResult.set(obligation.derivesFrom, siblings)
  }

  const optionalById = new Set<ObligationId>(obligations.filter((obligation) => obligation.optional).map((obligation) => obligation.id))

  const carrierByResult = new Map<SemanticResultId, ObligationId>()
  for (const obligation of obligations) {
    if (carrierKinds.has(obligation.kind)) carrierByResult.set(obligation.derivesFrom, obligation.id)
  }

  const upstreamOf = new Map<ObligationId, ObligationId[]>()
  for (const obligation of obligations) {
    if (!carrierKinds.has(obligation.kind)) continue
    const deps: ObligationId[] = []
    for (const siblingId of byResult.get(obligation.derivesFrom) ?? []) {
      // An optional sibling is a fast path the mandatory one already covers.
      // Depending on it would make an unbuilt devirtualization block the
      // carrier of every value the generic path already carries -- which is
      // exactly the reading `Obligation.optional` exists to forbid.
      if (siblingId === obligation.id || optionalById.has(siblingId)) continue
      deps.push(siblingId)
    }
    const operation = graph.operations.get(operationOfResult(obligation.derivesFrom))
    if (operation) {
      for (const operand of operation.operands) {
        if (operand.source.kind !== 'result') continue
        const upstreamCarrier = carrierByResult.get(operand.source.result)
        if (upstreamCarrier) deps.push(upstreamCarrier)
      }
    }
    upstreamOf.set(obligation.id, deps)
  }

  const status = new Map<ObligationId, ObligationStatus>()
  for (const obligation of obligations) status.set(obligation.id, obligation.localStatus)

  let changed = true
  let iterations = 0
  const limit = obligations.length + 1
  while (changed && iterations <= limit) {
    changed = false
    iterations += 1
    for (const [id, deps] of upstreamOf) {
      if (status.get(id) !== 'satisfied') continue
      if (deps.some((dep) => status.get(dep) !== 'satisfied')) {
        status.set(id, 'blocked-by-upstream')
        changed = true
      }
    }
  }

  return obligations.map((obligation) => ({ ...obligation, status: status.get(obligation.id) ?? obligation.localStatus }))
}

const emptyTally = (): { satisfied: number; missing: number; unsupported: number; blockedByUpstream: number } => ({
  satisfied: 0,
  missing: 0,
  unsupported: 0,
  blockedByUpstream: 0
})

const tallyOf = (obligations: readonly EvaluatedObligation[], optional: boolean): ObligationTally => {
  const tally = emptyTally()
  for (const obligation of obligations) {
    if (obligation.optional !== optional) continue
    switch (obligation.status) {
      case 'satisfied':
        tally.satisfied += 1
        break
      case 'missing':
        tally.missing += 1
        break
      case 'unsupported':
        tally.unsupported += 1
        break
      case 'blocked-by-upstream':
        tally.blockedByUpstream += 1
        break
    }
  }
  return tally
}

/**
 * Preflight reuses `partitionAuthorityComponents` verbatim -- the same
 * partition the diagnostic sweep traverses -- and processes components in the
 * order it returns them. Components are, by construction, connected and
 * disjoint: no edge crosses two of them, so there is no cross-component
 * dependency left to order by, and this order already is the SCC/dependency
 * order the doc requires.
 */
/**
 * The whole-graph result table, dealt out to the component that owns each row.
 *
 * The result builders are filters: each keeps the rows whose producer this
 * component owns. Handing each of them the entire table made the census cost
 * components x table -- on one measured application, 14,681 components against
 * 193,082 rows -- so one forward pass deals every row to its own component,
 * in the table's own order, which is the order the report serializes and the
 * certificate hashes.
 */
const indexResults = (
  graph: SemanticGraph,
  partition: readonly (readonly OperationId[])[]
): readonly (readonly (readonly [SemanticResultId, OperationId])[])[] => {
  const componentOf = new Map<OperationId, number>()
  for (const [index, members] of partition.entries()) for (const member of members) componentOf.set(member, index)
  const results: (readonly [SemanticResultId, OperationId])[][] = partition.map(() => [])
  for (const entry of graph.results) {
    const index = componentOf.get(entry[1])
    if (index !== undefined) results[index]?.push(entry)
  }
  return results
}

export const runPreflight = (input: PreflightInput): PreflightReport => {
  const { semanticGraph, representationPlan, manifest } = input
  const partition = partitionAuthorityComponents(semanticGraph)
  const indexed = indexResults(semanticGraph, partition)
  const components: ComponentId[] = []
  const componentSummaries: PreflightComponentSummary[] = []
  const allObligations: EvaluatedObligation[] = []

  for (const [componentIndex, memberOperations] of partition.entries()) {
    const representative = memberOperations[0]
    if (representative === undefined) continue
    const cid = componentId(representative)
    components.push(cid)
    const operationSet = new Set(memberOperations)
    const componentResults = indexed[componentIndex] ?? []
    const componentObligations: Obligation[] = []

    for (const operationId of operationSet) {
      const operation = semanticGraph.operations.get(operationId)
      if (!operation) continue
      appendAll(componentObligations, buildCallAbiObligations(cid, operation, manifest))
    }

    for (const [resultId, operationId] of componentResults) {
      if (!operationSet.has(operationId)) continue
      const operation = semanticGraph.operations.get(operationId)
      if (!operation) continue
      appendAll(componentObligations, buildCarrierObligations(cid, resultId, operation, representationPlan, manifest))
      const representation = representationPlan.selected.get(resultId)
      if (representation) appendAll(componentObligations, buildNativeBoundaryObligation(cid, resultId, representation, manifest))
      appendAll(componentObligations, buildExternalBindingObligation(cid, resultId, operation, manifest))
    }

    const evaluated = closeBlockedByUpstream(componentObligations, semanticGraph)
    appendAll(allObligations, evaluated)
    componentSummaries.push({
      component: cid,
      operationCount: memberOperations.length,
      obligationCount: evaluated.length,
      mandatory: tallyOf(evaluated, false),
      optional: tallyOf(evaluated, true)
    })
  }

  const totals = { mandatory: tallyOf(allObligations, false), optional: tallyOf(allObligations, true) }
  const clean = totals.mandatory.missing === 0 && totals.mandatory.unsupported === 0 && totals.mandatory.blockedByUpstream === 0

  return Object.freeze({
    components: Object.freeze(components),
    obligations: Object.freeze(allObligations),
    componentSummaries: Object.freeze(componentSummaries),
    totals: Object.freeze(totals),
    clean
  })
}
