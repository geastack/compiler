import type { DeclarationId, IrValueId } from '../identity/ids.js'
import type { Representation } from '../representation/model.js'
import { controlFlowGraphOf, dominatorTreeOf } from './dominance.js'
import { allOperationsOf, type IrBlock, type IrBlockId, type IrBody, type IrOperation } from './model.js'

/**
 * Which loads out of an `optional` carrier the program itself proves present.
 *
 * A `convert` from `optional(T, absence)` to `T` is a load: `has_value`
 * classifies and `operator*` reads the payload without testing it. The
 * checker's type at the consumer is what asked for `T`, and the checker's type
 * is not evidence -- `@type {number}` on a field three.js also writes
 * `undefined` into says nothing about what the cell holds. Presence is a fact
 * about the program's own control flow, and this module reads it off the
 * lowered IR, where the test and the load are both instructions:
 *
 * - `guard`: a branch on a presence test of the loaded value itself --
 *   `test` (`to-boolean`/`is-present`/`is-defined`), `!`, or a comparison
 *   with the `undefined`/`null` constant -- whose proving edge dominates the
 *   load. An SSA value never changes, so nothing between the test and the
 *   load can undo it. `a || b`, `a ?? b` and a default's present arm all
 *   reach their loads this way.
 * - `cell`: the loaded value is a `binding-read` of a cell a forward
 *   must-analysis proves present at that read -- every path to it passes a
 *   write of a present value, or a presence test of an earlier read of the
 *   same cell with nothing able to write the cell in between. A cell some
 *   other body writes (a closure's capture, a global) loses its facts at
 *   every operation that can run code.
 *
 * Nothing else proves presence. A load neither rule reaches is unproven,
 * however confident the checker was.
 */

/** @semanticCategory generic-primitive */
export type PresenceProof = 'guard' | 'cell'

/** The absent values a fact rules out, as bits. */
const UNDEFINED = 1
const NULL = 2
const BOTH = UNDEFINED | NULL

/** The bit a load out of this carrier needs ruled out, or 0 for a carrier with no absence to load past. */
const neededBitOf = (source: Representation): number => (source.kind === 'optional' ? (source.absence === 'null' ? NULL : UNDEFINED) : 0)

/** The absent values a value in this carrier can never be. */
const excludedByCarrier = (representation: Representation): number => {
  switch (representation.kind) {
    case 'optional':
      return representation.absence === 'null' ? UNDEFINED : NULL
    case 'undefined':
      return NULL
    case 'null':
      return UNDEFINED
    case 'dynamic':
      return 0
    case 'borrowed-ref':
      return excludedByCarrier(representation.referent)
    case 'tagged-union': {
      let mask = BOTH
      for (const arm of representation.arms) mask &= excludedByCarrier(arm.value)
      return mask
    }
    default:
      return BOTH
  }
}

/**
 * Operations that cannot run program code, so a cell another body writes
 * keeps its facts across them. Everything else may call out -- a getter, a
 * coercion's `valueOf`, a generator's resumption -- and drops those facts.
 */
const inertKinds = new Set<IrOperation['kind']>([
  'constant',
  'binding-read',
  'binding-write',
  'parameter',
  'receiver',
  'global-this',
  'phi',
  'test',
  'catch-binding',
  'allocate-ordinary-object',
  'allocate-array-object',
  'allocate-callable',
  'bind-callable',
  'allocate-record',
  'allocate-template-object',
  'allocate-regexp',
  'merge-live-arm-rebuild',
  'iterator-done',
  'jump',
  'branch',
  'switch',
  'return',
  'throw'
])

const runsNoCode = (operation: IrOperation): boolean =>
  inertKinds.has(operation.kind) ||
  (operation.kind === 'compute' &&
    (operation.form === 'typeof' ||
      (operation.form === 'unary' && operation.operator === '!') ||
      ((operation.form === 'equality' || operation.form === 'binary') && (operation.operator === '===' || operation.operator === '!=='))))

interface Definition {
  readonly operation: IrOperation
  readonly block: IrBlockId
  readonly index: number
}

interface Fact {
  readonly subject: IrValueId
  readonly excludes: number
}

const resultOf = (operation: IrOperation): IrValueId | null => ('result' in operation && operation.result ? operation.result.id : null)

/**
 * The value itself and every value it was converted from. A widening or
 * boxing `convert` hands on the SAME value in another carrier, so what is
 * proven of one is proven of the others.
 */
const aliasesOf = (definitions: ReadonlyMap<IrValueId, Definition>, value: IrValueId): readonly IrValueId[] => {
  const chain = [value]
  for (let current = definitions.get(value)?.operation; current?.kind === 'convert' && chain.length < 8;) {
    chain.push(current.source.value)
    current = definitions.get(current.source.value)?.operation
  }
  return chain
}

/** The absent constant a value is, through its conversions, or `null`. */
const absentConstantOf = (definitions: ReadonlyMap<IrValueId, Definition>, value: IrValueId): 'undefined' | 'null' | null => {
  for (const alias of aliasesOf(definitions, value)) {
    const operation = definitions.get(alias)?.operation
    if (operation?.kind === 'constant' && (operation.literal === 'undefined' || operation.literal === 'null')) return operation.literal
  }
  return null
}

/** The absent values `value` can never be: its carrier's own answer, or what the values it merges or converts all rule out. */
const excludedByValue = (
  definitions: ReadonlyMap<IrValueId, Definition>,
  value: IrValueId,
  representation: Representation,
  depth = 0
): number => {
  const own = excludedByCarrier(representation)
  const operation = definitions.get(value)?.operation
  if (own === BOTH || !operation || depth > 8) return own
  if (operation.kind === 'convert')
    return own | excludedByValue(definitions, operation.source.value, operation.source.representation, depth + 1)
  if (operation.kind === 'phi' && operation.incoming.length > 0)
    return (
      own |
      operation.incoming.reduce(
        (mask, incoming) => mask & excludedByValue(definitions, incoming.value.value, incoming.value.representation, depth + 1),
        BOTH
      )
    )
  return own
}

interface BranchSite {
  readonly block: IrBlockId
  readonly whenTrue: IrBlockId
  readonly whenFalse: IrBlockId
}

interface Flow {
  readonly definitions: ReadonlyMap<IrValueId, Definition>
  /** Every branch on a value, by the value. */
  readonly branches: ReadonlyMap<IrValueId, readonly BranchSite[]>
  /** Every `to-boolean` test of a value, by the value tested. */
  readonly truthinessTests: ReadonlyMap<IrValueId, readonly IrValueId[]>
  /** Whether a phi's incoming from `incoming` into `join` can only have come through the edge `from -> to`. */
  readonly arrivesThrough: (from: IrBlockId, to: IrBlockId, incoming: IrBlockId, join: IrBlockId) => boolean
}

/**
 * `a || b` and `a && b` as a branch condition: a two-armed phi one of whose
 * arms is `a` itself, arriving only through one edge of a branch on `a`'s
 * truth, the other arm only through the other. `a || b` is falsy only past
 * `a` falsy and `b` falsy; `a && b` is truthy only past both truthy. The other
 * direction proves nothing. A presence branch (`??`) is not a truth branch and
 * never matches.
 */
const logicalFactsWhen = (flow: Flow, phiId: IrValueId, polarity: boolean, depth: number): readonly Fact[] => {
  const definition = flow.definitions.get(phiId)
  const phi = definition?.operation
  if (!definition || phi?.kind !== 'phi' || phi.incoming.length !== 2) return []
  const join = definition.block
  for (const [kept, other] of [
    [phi.incoming[0]!, phi.incoming[1]!],
    [phi.incoming[1]!, phi.incoming[0]!]
  ] as const)
    for (const guard of aliasesOf(flow.definitions, kept.value.value))
      for (const test of [guard, ...(flow.truthinessTests.get(guard) ?? [])])
        for (const branch of flow.branches.get(test) ?? []) {
          const keptTruthy =
            flow.arrivesThrough(branch.block, branch.whenTrue, kept.block, join) &&
            flow.arrivesThrough(branch.block, branch.whenFalse, other.block, join)
          const keptFalsy =
            flow.arrivesThrough(branch.block, branch.whenFalse, kept.block, join) &&
            flow.arrivesThrough(branch.block, branch.whenTrue, other.block, join)
          if (keptTruthy && !polarity)
            return [...factsWhen(flow, test, false, depth + 1), ...factsWhen(flow, other.value.value, false, depth + 1)]
          if (keptFalsy && polarity)
            return [...factsWhen(flow, test, true, depth + 1), ...factsWhen(flow, other.value.value, true, depth + 1)]
        }
  return []
}

/** What a branch on `condition` proves about other values when it goes the `polarity` way. */
const factsWhen = (flow: Flow, condition: IrValueId, polarity: boolean, depth = 0): readonly Fact[] => {
  const operation = flow.definitions.get(condition)?.operation
  if (!operation || depth > 8) return []
  if (operation.kind === 'phi') return logicalFactsWhen(flow, condition, polarity, depth)
  if (operation.kind === 'test') {
    // A truthy value is present; its truth also answers whatever it computed.
    const own = polarity
      ? aliasesOf(flow.definitions, operation.value.value).map((subject) => ({
          subject,
          excludes: operation.predicate === 'is-defined' ? UNDEFINED : BOTH
        }))
      : []
    return operation.predicate === 'to-boolean' ? [...own, ...factsWhen(flow, operation.value.value, polarity, depth + 1)] : own
  }
  if (operation.kind !== 'compute') return []
  const [left, right] = operation.operands
  if (operation.form === 'unary' && operation.operator === '!' && left && !right) return factsWhen(flow, left.value, !polarity, depth + 1)
  if (operation.form !== 'equality' && operation.form !== 'binary') return []
  if (!left || !right || operation.operands.length !== 2) return []
  const strict = operation.operator === '===' || operation.operator === '!=='
  const negated = operation.operator === '!==' || operation.operator === '!='
  if (!strict && operation.operator !== '==' && operation.operator !== '!=') return []
  // `x !== c` proves `x` is not `c` when true; `x === c` when false.
  if (polarity !== negated) return []
  const leftAbsence = absentConstantOf(flow.definitions, left.value)
  const rightAbsence = absentConstantOf(flow.definitions, right.value)
  const absence = leftAbsence ?? rightAbsence
  const subject = leftAbsence ? right : rightAbsence ? left : null
  if (absence === null || subject === null) return []
  const excludes = strict ? (absence === 'undefined' ? UNDEFINED : NULL) : BOTH
  return aliasesOf(flow.definitions, subject.value).map((alias) => ({ subject: alias, excludes }))
}

/**
 * What holds at a program point on every path to it: the absent values each
 * cell cannot hold, which SSA values each cell still holds (so a later test of
 * one is a test of the cell), and the truth of every branch condition passed.
 */
interface CellState {
  readonly masks: Map<DeclarationId, number>
  readonly contents: Map<DeclarationId, Set<IrValueId>>
  readonly truths: Map<IrValueId, boolean>
}

const emptyState = (): CellState => ({ masks: new Map(), contents: new Map(), truths: new Map() })

const copyState = (state: CellState): CellState => ({
  masks: new Map(state.masks),
  contents: new Map([...state.contents].map(([declaration, values]) => [declaration, new Set(values)])),
  truths: new Map(state.truths)
})

const meet = (left: CellState, right: CellState): CellState => {
  const out = emptyState()
  for (const [declaration, mask] of left.masks) {
    const joined = mask & (right.masks.get(declaration) ?? 0)
    if (joined !== 0) out.masks.set(declaration, joined)
  }
  for (const [declaration, values] of left.contents) {
    const other = right.contents.get(declaration)
    const joined = other ? new Set([...values].filter((value) => other.has(value))) : null
    if (joined && joined.size > 0) out.contents.set(declaration, joined)
  }
  for (const [value, truth] of left.truths) if (right.truths.get(value) === truth) out.truths.set(value, truth)
  return out
}

const sameState = (left: CellState, right: CellState): boolean =>
  left.masks.size === right.masks.size &&
  [...left.masks].every(([declaration, mask]) => right.masks.get(declaration) === mask) &&
  left.contents.size === right.contents.size &&
  [...left.contents].every(([declaration, values]) => {
    const other = right.contents.get(declaration)
    return other !== undefined && other.size === values.size && [...values].every((value) => other.has(value))
  }) &&
  left.truths.size === right.truths.size &&
  [...left.truths].every(([value, truth]) => right.truths.get(value) === truth)

/** Every declaration each body writes, so a body can tell which of its cells someone else may change. */
const writersOf = (bodies: readonly IrBody[]): ReadonlyMap<DeclarationId, ReadonlySet<string>> => {
  const writers = new Map<DeclarationId, Set<string>>()
  for (const body of bodies)
    for (const block of body.blocks.values())
      for (const operation of block.operations) {
        if (operation.kind !== 'binding-write') continue
        const owners = writers.get(operation.declaration) ?? new Set<string>()
        owners.add(body.owner)
        writers.set(operation.declaration, owners)
      }
  return writers
}

const proofsOfBody = (
  body: IrBody,
  writers: ReadonlyMap<DeclarationId, ReadonlySet<string>>,
  proofs: Map<IrValueId, PresenceProof>
): void => {
  const definitions = new Map<IrValueId, Definition>()
  const loads: { readonly operation: Extract<IrOperation, { kind: 'convert' }>; readonly block: IrBlockId }[] = []
  for (const block of body.blocks.values())
    allOperationsOf(block).forEach((operation, index) => {
      const result = resultOf(operation)
      if (result !== null) definitions.set(result, { operation, block: block.id, index })
      if (
        operation.kind === 'convert' &&
        neededBitOf(operation.source.representation) !== 0 &&
        operation.result.representation.kind !== 'optional'
      )
        loads.push({ operation, block: block.id })
    })
  if (loads.length === 0) return
  const graph = controlFlowGraphOf(body)
  const dominance = dominatorTreeOf(body)
  const sharedElsewhere = (declaration: DeclarationId): boolean =>
    [...(writers.get(declaration) ?? [])].some((owner) => owner !== body.owner)

  const soleEntry = (from: IrBlockId, to: IrBlockId): boolean => {
    const predecessors = graph.predecessors.get(to) ?? []
    return predecessors.length === 1 && predecessors[0] === from
  }
  const branches = new Map<IrValueId, BranchSite[]>()
  const truthinessTests = new Map<IrValueId, IrValueId[]>()
  for (const [id, definition] of definitions)
    if (definition.operation.kind === 'test' && definition.operation.predicate === 'to-boolean') {
      const tested = definition.operation.value.value
      truthinessTests.set(tested, [...(truthinessTests.get(tested) ?? []), id])
    }
  for (const block of body.blocks.values()) {
    const terminator = block.terminator
    if (terminator.kind !== 'branch' || terminator.whenTrue === terminator.whenFalse) continue
    const condition = terminator.condition.value
    branches.set(condition, [
      ...(branches.get(condition) ?? []),
      { block: block.id, whenTrue: terminator.whenTrue, whenFalse: terminator.whenFalse }
    ])
  }
  const flow: Flow = {
    definitions,
    branches,
    truthinessTests,
    arrivesThrough: (from, to, incoming, join) =>
      (incoming === from && to === join) || (soleEntry(from, to) && dominance.dominates(to, incoming))
  }

  // Edge facts: what each branch proves on each of its two edges.
  const edgeFacts = new Map<string, readonly Fact[]>()
  const edgeKey = (from: IrBlockId, to: IrBlockId): string => `${from}->${to}`
  for (const [condition, sites] of branches)
    for (const site of sites) {
      edgeFacts.set(edgeKey(site.block, site.whenTrue), factsWhen(flow, condition, true))
      edgeFacts.set(edgeKey(site.block, site.whenFalse), factsWhen(flow, condition, false))
    }

  // `guard`: a fact about the loaded value on an edge into a block with no
  // other way in, which dominates the load.
  const guardProves = (value: IrValueId, bit: number, at: IrBlockId): boolean => {
    for (const [key, facts] of edgeFacts) {
      if (!facts.some((fact) => fact.subject === value && (fact.excludes & bit) !== 0)) continue
      const [from, to] = key.split('->') as [IrBlockId, IrBlockId]
      if (soleEntry(from, to) && dominance.dominates(to, at)) return true
    }
    return false
  }

  // `cell`: a forward must-analysis over binding cells. `null` is "not yet
  // reached", the identity of the meet; an unreachable predecessor contributes
  // nothing, so a path the CFG cannot see (an exceptional edge) proves nothing.
  const order = body.blockOrder.filter((id) => dominance.reachable.has(id))
  const entry = body.blockOrder[0]
  const exits = new Map<string, CellState>()
  const readMasks = new Map<IrValueId, number>()
  const transfer = (blockId: IrBlockId, incoming: CellState, record: boolean): CellState => {
    const state = copyState(incoming)
    const block = body.blocks.get(blockId)
    if (!block) return state
    for (const operation of allOperationsOf(block)) {
      // A value defined again (a loop's next iteration) is no longer the one
      // any earlier fact was about.
      const result = resultOf(operation)
      if (result !== null) {
        state.truths.delete(result)
        for (const [declaration, values] of state.contents)
          if (values.delete(result) && values.size === 0) state.contents.delete(declaration)
      }
      if (operation.kind === 'binding-read') {
        if (record) readMasks.set(operation.result.id, state.masks.get(operation.declaration) ?? 0)
        const values = state.contents.get(operation.declaration) ?? new Set<IrValueId>()
        values.add(operation.result.id)
        state.contents.set(operation.declaration, values)
        continue
      }
      if (operation.kind === 'binding-write') {
        const mask = excludedByValue(definitions, operation.value.value, operation.value.representation)
        if (mask === 0) state.masks.delete(operation.declaration)
        else state.masks.set(operation.declaration, mask)
        state.contents.set(operation.declaration, new Set(aliasesOf(definitions, operation.value.value)))
        continue
      }
      if (!runsNoCode(operation))
        for (const declaration of new Set([...state.masks.keys(), ...state.contents.keys()]))
          if (sharedElsewhere(declaration)) {
            state.masks.delete(declaration)
            state.contents.delete(declaration)
          }
    }
    return state
  }
  const factsMemo = new Map<string, readonly Fact[]>()
  const factsOf = (condition: IrValueId, polarity: boolean): readonly Fact[] => {
    const key = `${condition}|${polarity}`
    const known = factsMemo.get(key)
    if (known) return known
    const facts = factsWhen(flow, condition, polarity)
    factsMemo.set(key, facts)
    return facts
  }
  // Past a branch, a fact about a value a cell still holds -- read from it,
  // or just written into it, as `if (m = re.exec(s))` does -- is a fact about
  // the cell.
  const refine = (state: CellState, condition: IrValueId, polarity: boolean): CellState => {
    for (const fact of factsOf(condition, polarity))
      for (const [declaration, values] of state.contents)
        if (values.has(fact.subject)) state.masks.set(declaration, (state.masks.get(declaration) ?? 0) | fact.excludes)
    for (const alias of aliasesOf(definitions, condition)) state.truths.set(alias, polarity)
    return state
  }
  const entering = (blockId: IrBlockId): CellState | null => {
    if (blockId === entry) return emptyState()
    let state: CellState | null = null
    for (const predecessor of graph.predecessors.get(blockId) ?? []) {
      if (!dominance.reachable.has(predecessor)) return emptyState()
      const exit = exits.get(edgeKey(predecessor, blockId))
      if (!exit) continue
      state = state === null ? exit : meet(state, exit)
    }
    return state
  }
  /**
   * The state on `from -> to`. A branch on a phi merged in `from` itself --
   * `a || b`, `a && b` -- is threaded: each incoming path is refined by what
   * its own arm's truth proves, a path whose arm cannot have that truth is
   * dropped, and only then are the paths met. `a === undefined || b ===
   * undefined` falsy proves `b` only along the path that evaluated `b`.
   */
  const exitOf = (from: IrBlockId, to: IrBlockId, state: CellState): CellState | null => {
    const terminator = body.blocks.get(from)?.terminator
    if (terminator?.kind !== 'branch' || terminator.whenTrue === terminator.whenFalse) return state
    const polarity = to === terminator.whenTrue
    const condition = terminator.condition.value
    const merged = definitions.get(condition)
    const predecessors = graph.predecessors.get(from) ?? []
    if (
      merged?.block === from &&
      merged.operation.kind === 'phi' &&
      predecessors.length === merged.operation.incoming.length &&
      merged.operation.incoming.every((arm) => predecessors.includes(arm.block))
    ) {
      let threaded: CellState | null = null
      for (const arm of merged.operation.incoming) {
        const reaching = dominance.reachable.has(arm.block) ? exits.get(edgeKey(arm.block, from)) : emptyState()
        if (!reaching) continue
        const armState = transfer(from, reaching, false)
        const arms = aliasesOf(definitions, arm.value.value)
        if (arms.some((value) => armState.truths.get(value) === !polarity)) continue
        refine(armState, arm.value.value, polarity)
        threaded = threaded === null ? armState : meet(threaded, armState)
      }
      return threaded === null ? null : refine(threaded, condition, polarity)
    }
    return refine(copyState(state), condition, polarity)
  }
  const publishExits = (blockId: IrBlockId, state: CellState): boolean => {
    let changed = false
    for (const successor of graph.successors.get(blockId) ?? []) {
      const exit = exitOf(blockId, successor, state)
      if (exit === null) continue
      const key = edgeKey(blockId, successor)
      const known = exits.get(key)
      if (known && sameState(known, exit)) continue
      exits.set(key, exit)
      changed = true
    }
    return changed
  }
  let settled = false
  for (let round = 0; !settled && round < 64; round++) {
    settled = true
    for (const blockId of order) {
      const incoming = entering(blockId)
      if (incoming === null) continue
      if (publishExits(blockId, transfer(blockId, incoming, false))) settled = false
    }
  }
  // An unsettled must-analysis is still optimistic somewhere: it proves nothing.
  if (settled)
    for (const blockId of order) {
      const incoming = entering(blockId)
      if (incoming !== null) transfer(blockId, incoming, true)
    }

  for (const { operation, block } of loads) {
    const bit = neededBitOf(operation.source.representation)
    const sources = aliasesOf(definitions, operation.source.value)
    if (sources.some((source) => guardProves(source, bit, block))) proofs.set(operation.result.id, 'guard')
    else if (
      sources.some((source) => definitions.get(source)?.operation.kind === 'binding-read' && ((readMasks.get(source) ?? 0) & bit) !== 0)
    )
      proofs.set(operation.result.id, 'cell')
  }
}

/** The proof, if any, behind every present-optional load in `bodies`, keyed by the load's result. */
export const presenceProofsOf = (bodies: Iterable<IrBody>): ReadonlyMap<IrValueId, PresenceProof> => {
  const all = [...bodies]
  const writers = writersOf(all)
  const proofs = new Map<IrValueId, PresenceProof>()
  for (const body of all) proofsOfBody(body, writers, proofs)
  return proofs
}

/**
 * `bodies` with every unchecked load no proof reaches marked
 * `presence: 'checked'`. Which conversions read a payload without testing its
 * flag is the target's fact, not this module's -- `readsUnchecked` asks the
 * conversion census that installed them.
 */
export const withPresenceChecks = <K>(
  bodies: ReadonlyMap<K, IrBody>,
  readsUnchecked: (operation: Extract<IrOperation, { kind: 'convert' }>) => boolean
): ReadonlyMap<K, IrBody> => {
  const proofs = presenceProofsOf(bodies.values())
  const checked = new Map<K, IrBody>()
  for (const [key, body] of bodies) {
    let changed = false
    const blocks = new Map<IrBlockId, IrBlock>()
    for (const [id, block] of body.blocks) {
      let blockChanged = false
      const operations = block.operations.map((operation) => {
        if (
          operation.kind !== 'convert' ||
          operation.presence !== undefined ||
          operation.source.representation.kind !== 'optional' ||
          proofs.has(operation.result.id) ||
          !readsUnchecked(operation)
        )
          return operation
        blockChanged = true
        return { ...operation, presence: 'checked' as const }
      })
      blocks.set(id, blockChanged ? { ...block, operations } : block)
      if (blockChanged) changed = true
    }
    checked.set(key, changed ? { ...body, blocks } : body)
  }
  return checked
}
