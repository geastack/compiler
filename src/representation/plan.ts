import type { ComponentId, SemanticResultId } from '../identity/ids.js'
import { representationKey, type Representation } from './model.js'

/**
 * The sealed representation plan.
 *
 * The plan is the single authority for what a value physically *is*. Producers
 * never mutate it while a round is running: they add immutable evidence, and
 * selection happens once, per authority component, after that component has
 * reached quiescence. That ordering is what removes the whole category of
 * "later reconciliation" passes -- there is no window in which one consumer can
 * read a weaker answer that another consumer has already replaced.
 */

/**
 * How strong a piece of evidence is.
 *
 * Conservative evidence is a real answer while an operation is unresolved, but
 * it is a *candidate*, never a co-equal authority. When exact evidence arrives
 * for the same coordinate, the transaction selects it and retires the candidate
 * from selection while keeping it for diagnostics.
 */
export type EvidenceStrength = 'conservative' | 'exact'

export interface RepresentationEvidence {
  readonly result: SemanticResultId
  readonly representation: Representation
  readonly strength: EvidenceStrength
  /** Which producer published this, so a conflict names both sides. */
  readonly producer: string
  /**
   * True when the language itself requires a closed family or join at this
   * coordinate. Two exact rows may coexist only under this flag; otherwise
   * disagreement is a conflict, not a menu.
   */
  readonly joinsClosedFamily: boolean
}

/** Two exact publications that disagree at one coordinate. */
export interface RepresentationConflict {
  readonly result: SemanticResultId
  readonly component: ComponentId
  readonly left: RepresentationEvidence
  readonly right: RepresentationEvidence
}

export interface SealedRepresentationPlan {
  /** The selected carrier for every published result. */
  readonly selected: ReadonlyMap<SemanticResultId, Representation>
  /** Every row ever published, retained for diagnostics only. */
  readonly evidence: ReadonlyMap<SemanticResultId, readonly RepresentationEvidence[]>
  readonly conflicts: readonly RepresentationConflict[]
}

export interface RepresentationPlanBuilder {
  /** Add immutable evidence. Never overwrites; selection happens at commit. */
  readonly publish: (evidence: RepresentationEvidence) => void
  /**
   * Select and commit one authority component. A component with a conflict
   * commits nothing: connected members commit together or stay blocked, so no
   * consumer can observe half a component.
   */
  readonly commitComponent: (component: ComponentId, members: readonly SemanticResultId[]) => readonly RepresentationConflict[]
  readonly seal: () => SealedRepresentationPlan
}

const selectFrom = (
  rows: readonly RepresentationEvidence[]
): { selected: Representation | null; conflict: [RepresentationEvidence, RepresentationEvidence] | null } => {
  const exact = rows.filter((row) => row.strength === 'exact')
  if (exact.length === 0) {
    const conservative = rows[0]
    return { selected: conservative ? conservative.representation : null, conflict: null }
  }
  const first = exact[0]
  if (!first) return { selected: null, conflict: null }
  // Hoisted: the loop compares every candidate against this one carrier, and
  // rebuilding its key per candidate made the comparison quadratic in the
  // number of exact rows for a key that never changes.
  const firstKey = representationKey(first.representation)
  for (const candidate of exact.slice(1)) {
    if (representationKey(candidate.representation) === firstKey) continue
    // A closed family is the one case where the language really does produce
    // two exact answers; anything else is two producers disagreeing, and
    // letting a consumer pick would make lookup order a semantic decision.
    if (candidate.joinsClosedFamily && first.joinsClosedFamily) continue
    return { selected: null, conflict: [first, candidate] }
  }
  return { selected: first.representation, conflict: null }
}

export const createRepresentationPlanBuilder = (): RepresentationPlanBuilder => {
  const evidence = new Map<SemanticResultId, RepresentationEvidence[]>()
  const selected = new Map<SemanticResultId, Representation>()
  const committed = new Set<ComponentId>()
  const conflicts: RepresentationConflict[] = []
  let sealed = false

  const publish = (row: RepresentationEvidence): void => {
    if (sealed) throw new Error(`representation plan is sealed; ${row.producer} published ${row.result} after freeze`)
    const rows = evidence.get(row.result) ?? []
    rows.push(row)
    evidence.set(row.result, rows)
  }

  const commitComponent = (component: ComponentId, members: readonly SemanticResultId[]): readonly RepresentationConflict[] => {
    if (sealed) throw new Error(`representation plan is sealed; component ${component} cannot commit after freeze`)
    if (committed.has(component)) throw new Error(`component ${component} committed twice`)
    const found: RepresentationConflict[] = []
    const pending = new Map<SemanticResultId, Representation>()
    for (const member of members) {
      const rows = evidence.get(member) ?? []
      const { selected: choice, conflict } = selectFrom(rows)
      if (conflict) {
        found.push({ result: member, component, left: conflict[0], right: conflict[1] })
        continue
      }
      if (choice) pending.set(member, choice)
    }
    if (found.length > 0) {
      conflicts.push(...found)
      return found
    }
    committed.add(component)
    for (const [member, choice] of pending) selected.set(member, choice)
    return []
  }

  const seal = (): SealedRepresentationPlan => {
    sealed = true
    const frozenEvidence = new Map<SemanticResultId, readonly RepresentationEvidence[]>()
    for (const [result, rows] of evidence) frozenEvidence.set(result, Object.freeze([...rows]))
    return Object.freeze({
      selected: new Map(selected),
      evidence: frozenEvidence,
      conflicts: Object.freeze([...conflicts])
    })
  }

  return { publish, commitComponent, seal }
}
