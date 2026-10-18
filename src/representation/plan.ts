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

const EXACT = 1
const JOINS_CLOSED_FAMILY = 2

/**
 * The sealed evidence table, held column-wise and handed out row by row.
 *
 * Nothing in a compile reads the evidence after selection: it is kept for
 * diagnostics and for the certificate's plan digest, which walks it once. As
 * one frozen array of row objects per result it cost about 160 bytes a row
 * -- some 48 MB on a large application, alive from the representation stage
 * to the end of the compile -- for rows that are almost always one per result.
 * The columns keep exactly what a row says, and every read materializes the
 * same rows, with the same keys in the same order, as the producers published,
 * so the digest and every consumer see the table they saw before.
 */
class SealedEvidence extends Map<SemanticResultId, readonly RepresentationEvidence[]> {
  readonly #results: readonly SemanticResultId[]
  /** Exclusive end of each result's rows in the row columns. */
  readonly #ends: Uint32Array
  readonly #representations: readonly Representation[]
  readonly #producers: readonly string[]
  readonly #flags: Uint8Array
  #index: Map<SemanticResultId, number> | null = null

  constructor(published: ReadonlyMap<SemanticResultId, readonly RepresentationEvidence[]>) {
    super()
    const results: SemanticResultId[] = []
    const representations: Representation[] = []
    const producers: string[] = []
    const flags: number[] = []
    this.#ends = new Uint32Array(published.size)
    for (const [result, rows] of published) {
      for (const row of rows) {
        representations.push(row.representation)
        producers.push(row.producer)
        flags.push((row.strength === 'exact' ? EXACT : 0) | (row.joinsClosedFamily ? JOINS_CLOSED_FAMILY : 0))
      }
      this.#ends[results.length] = representations.length
      results.push(result)
    }
    this.#results = results
    this.#representations = representations
    this.#producers = producers
    this.#flags = Uint8Array.from(flags)
  }

  #rowsAt(at: number): readonly RepresentationEvidence[] {
    const result = this.#results[at] as SemanticResultId
    const rows: RepresentationEvidence[] = []
    for (let row = at === 0 ? 0 : (this.#ends[at - 1] as number); row < (this.#ends[at] as number); row++) {
      const flags = this.#flags[row] as number
      rows.push({
        result,
        representation: this.#representations[row] as Representation,
        strength: flags & EXACT ? 'exact' : 'conservative',
        producer: this.#producers[row] as string,
        joinsClosedFamily: (flags & JOINS_CLOSED_FAMILY) !== 0
      })
    }
    return Object.freeze(rows)
  }

  #indexOf(result: SemanticResultId): number | undefined {
    if (this.#index === null) this.#index = new Map(this.#results.map((key, at) => [key, at]))
    return this.#index.get(result)
  }

  override get size(): number {
    return this.#results.length
  }

  override get(result: SemanticResultId): readonly RepresentationEvidence[] | undefined {
    const at = this.#indexOf(result)
    return at === undefined ? undefined : this.#rowsAt(at)
  }

  override has(result: SemanticResultId): boolean {
    return this.#indexOf(result) !== undefined
  }

  override *entries(): MapIterator<[SemanticResultId, readonly RepresentationEvidence[]]> {
    for (let at = 0; at < this.#results.length; at++) yield [this.#results[at] as SemanticResultId, this.#rowsAt(at)]
  }

  override *keys(): MapIterator<SemanticResultId> {
    yield* this.#results
  }

  override *values(): MapIterator<readonly RepresentationEvidence[]> {
    for (let at = 0; at < this.#results.length; at++) yield this.#rowsAt(at)
  }

  override [Symbol.iterator](): MapIterator<[SemanticResultId, readonly RepresentationEvidence[]]> {
    return this.entries()
  }

  override forEach(
    visit: (
      rows: readonly RepresentationEvidence[],
      result: SemanticResultId,
      map: Map<SemanticResultId, readonly RepresentationEvidence[]>
    ) => void,
    thisArg?: unknown
  ): void {
    for (const [result, rows] of this.entries()) visit.call(thisArg, rows, result, this)
  }

  override set(): this {
    throw new Error('the sealed evidence table is read-only')
  }

  override delete(): boolean {
    throw new Error('the sealed evidence table is read-only')
  }

  override clear(): void {
    throw new Error('the sealed evidence table is read-only')
  }
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
    return Object.freeze({
      selected: new Map(selected),
      evidence: new SealedEvidence(evidence),
      conflicts: Object.freeze([...conflicts])
    })
  }

  return { publish, commitComponent, seal }
}
