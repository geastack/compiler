import type { DataEqualFlowRequest, NativeCallableFlow } from './callable-class-flow.js'
import type { CallCalleeIdentity } from './model.js'

/**
 * `#flow-reuse` for the JavaScript compiler: the data-equal half of
 * `nativeCallableFlowOf`'s remembered answers. A request whose bodies are the
 * same DATA as a remembered answer's, though not the same objects, reuses that
 * answer re-pointed at the new objects. Pairing and re-pointing walk arbitrary
 * objects by reflection, which a native build cannot certify, so a natively
 * compiled compiler links `callable-flow-reuse-native.ts` instead.
 */

/**
 * One pairing of an old program with a new one.
 *
 * `ambiguous` holds the old objects the old program shares where the new one
 * holds equal but distinct objects: each is paired with its first partner, and
 * an answer that reaches one is not re-pointed (`repointed`), since no single
 * partner stands for it.
 *
 * `skipped` names the operation fields left out of the comparison. An unread
 * field is skipped while it holds no object on either side, so nothing of it
 * can be in an answer. A cited field is skipped only by a pairing whose answer
 * is never re-pointed (`dataEqualValueAnswer`): its objects -- an array
 * entry the flow itself allocated, say -- go unpaired. `citationsDiffer` is
 * set when one differs, and the view nodes must then be the same.
 */
interface Pairing {
  readonly pairs: Map<object, object>
  readonly ambiguous: Set<object>
  readonly skipped: SkippedFields
  readonly state: { citationsDiffer: boolean }
}

interface SkippedFields {
  readonly unread: ReadonlyMap<string, ReadonlySet<string>>
  readonly cited: ReadonlyMap<string, ReadonlySet<string>>
  /** Body fields left out whatever they hold: no answer reaches them. */
  readonly bodies: ReadonlySet<string>
}

const noFields: ReadonlyMap<string, ReadonlySet<string>> = new Map<string, ReadonlySet<string>>()

const pairingOf = (skipped: SkippedFields): Pairing => ({
  pairs: new Map<object, object>(),
  ambiguous: new Set<object>(),
  skipped,
  state: { citationsDiffer: false }
})

const pairingCopyOf = (pairing: Pairing): Pairing => ({
  pairs: new Map(pairing.pairs),
  ambiguous: new Set(pairing.ambiguous),
  skipped: pairing.skipped,
  state: { ...pairing.state }
})

const isEmptyContainer = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.length === 0
  if (value instanceof Map) return value.size === 0
  if (value instanceof Set) return value.size === 0
  if (typeof value !== 'object' || value === null) return false
  const prototype = Object.getPrototypeOf(value) as unknown
  return (prototype === Object.prototype || prototype === null) && Object.keys(value).length === 0
}

/** The fields of `value` -- an IR operation, which alone carries a lineage, or anything else -- a pairing compares with `other`'s. */
const pairedKeysOf = (value: object, other: object, pairing: Pairing): readonly string[] => {
  const keys = Object.keys(value)
  if (!('lineage' in value)) {
    if (pairing.skipped.bodies.size === 0 || !('blocks' in value) || !('sourceOwner' in value)) return keys
    return keys.filter((key) => !pairing.skipped.bodies.has(key))
  }
  const kind = (value as { readonly kind?: unknown }).kind
  if (typeof kind !== 'string') return keys
  const unread = pairing.skipped.unread.get(kind)
  const cited = pairing.skipped.cited.get(kind)
  if (unread === undefined && cited === undefined) return keys
  return keys.filter((key) => {
    const mine = (value as Record<string, unknown>)[key]
    const theirs = (other as Record<string, unknown>)[key]
    if (unread?.has(key) === true) return (typeof mine === 'object' && mine !== null) || (typeof theirs === 'object' && theirs !== null)
    if (cited?.has(key) !== true) return true
    if (mine !== theirs) pairing.state.citationsDiffer = true
    return false
  })
}

/**
 * Pairs every object of `old` with the object at the same position in `next`,
 * answering whether the two are the same data. Only plain objects, arrays,
 * Maps and Sets are looked into; anything else (a function, a class instance)
 * must be the very same object. A shared object is paired once; where the new
 * program holds an equal but distinct object in its place, the old one is
 * `ambiguous` rather than refused: the solve reads data, never which
 * operations share a recipe list, so the sharing changes no answer.
 */
const pairSameData = (old: unknown, next: unknown, pairing: Pairing): boolean => {
  if (old === next) return true
  if (typeof old !== 'object' || typeof next !== 'object' || old === null || next === null) return Object.is(old, next)
  const { pairs } = pairing
  const paired = pairs.get(old)
  if (paired !== undefined) {
    if (paired === next) return true
    // Compared in a pairing of its own: `old` is paired already, and this
    // partner's objects must not displace the pairs its first partner made.
    if (!pairSameData(old, next, { ...pairing, pairs: new Map() })) return false
    // An empty container holds nothing to re-point: whichever partner stands
    // for it, the answer holds the same nothing. A shared empty list is
    // what most programs hold in several places.
    if (!isEmptyContainer(old)) pairing.ambiguous.add(old)
    return true
  }
  const prototype = Object.getPrototypeOf(old) as unknown
  if (prototype !== Object.getPrototypeOf(next)) return false
  pairs.set(old, next)
  if (Array.isArray(old)) {
    const other = next as readonly unknown[]
    if (old.length !== other.length) return false
    for (let index = 0; index < old.length; index++) if (!pairSameData(old[index], other[index], pairing)) return false
    return true
  }
  // One arm per collection kind, so each iterator step has the collection's
  // own element type. The shared prototype above already proved `next` is the
  // same kind; the `instanceof` repeats that proof for the type checker.
  if (old instanceof Map) {
    if (!(next instanceof Map) || old.size !== next.size) return false
    const theirs: Iterator<[unknown, unknown]> = next.entries()
    for (const [key, value] of old.entries()) {
      const step = theirs.next()
      if (step.done === true) return false
      const [otherKey, otherValue] = step.value
      if (!pairSameData(key, otherKey, pairing) || !pairSameData(value, otherValue, pairing)) return false
    }
    return true
  }
  if (old instanceof Set) {
    if (!(next instanceof Set) || old.size !== next.size) return false
    // A Set's entry is [value, value]; pairing the value once is the same test.
    const theirs: Iterator<unknown> = next.values()
    for (const value of old.values()) {
      const step = theirs.next()
      if (step.done === true) return false
      if (!pairSameData(value, step.value, pairing)) return false
    }
    return true
  }
  if (prototype !== Object.prototype && prototype !== null) return false
  const keys = pairedKeysOf(old, next, pairing)
  // Membership in `next`'s compared keys, the same set the filter counted:
  // with equal counts, every key of one present in the other is the same set.
  const nextKeys = new Set(pairedKeysOf(next, old, pairing))
  if (keys.length !== nextKeys.size) return false
  for (const key of keys) {
    if (!nextKeys.has(key)) return false
    if (!pairSameData((old as Record<string, unknown>)[key], (next as Record<string, unknown>)[key], pairing)) return false
  }
  return true
}

/**
 * `value` with every paired object replaced by its partner; a container nothing
 * inside of moved is returned as is. `fresh` holds the objects the new program
 * has where the old one held a different object: a remembered answer that
 * reaches one is holding something a pass wrote into the program after the
 * solve, which a solve of the new program would not share with it.
 */
const repointed = (
  value: unknown,
  pairs: ReadonlyMap<object, object>,
  seen: Map<object, unknown>,
  fresh: {
    readonly objects: ReadonlySet<object>
    reached: boolean
    readonly copy?: boolean
    readonly ambiguous?: ReadonlySet<object>
    refused?: boolean
  }
): unknown => {
  if (typeof value !== 'object' || value === null) return value
  if (fresh.ambiguous?.has(value) === true) fresh.refused = true
  const partner = pairs.get(value)
  if (partner !== undefined) return partner
  if (seen.has(value)) return seen.get(value)
  // An object the new program holds that this answer allocated (`flowOverCopy`):
  // copied when asked to, so the answer holds its own as a solve's would.
  const copied = fresh.objects.has(value)
  if (copied && !fresh.copy) fresh.reached = true
  seen.set(value, value)
  let result: unknown = value
  if (Array.isArray(value)) {
    const items = value.map((item) => repointed(item, pairs, seen, fresh))
    if (copied || items.some((item, index) => item !== value[index])) result = items
  } else if (value instanceof Map) {
    const entries = [...value].map(([key, item]) => [repointed(key, pairs, seen, fresh), repointed(item, pairs, seen, fresh)] as const)
    if (copied || [...value].some(([key, item], index) => entries[index]![0] !== key || entries[index]![1] !== item))
      result = new Map(entries)
  } else if (value instanceof Set) {
    const items = [...value].map((item) => repointed(item, pairs, seen, fresh))
    if (copied || [...value].some((item, index) => items[index] !== item)) result = new Set(items)
  } else {
    const prototype = Object.getPrototypeOf(value) as unknown
    if (prototype === Object.prototype || prototype === null) {
      let copy: Record<string, unknown> | null = copied ? { ...(value as Record<string, unknown>) } : null
      for (const key of Object.keys(value)) {
        const item = (value as Record<string, unknown>)[key]
        const moved = repointed(item, pairs, seen, fresh)
        if (moved !== item) (copy ??= { ...(value as Record<string, unknown>) })[key] = moved
      }
      if (copy !== null) result = copy
    } else if (copied) fresh.reached = true
  }
  seen.set(value, result)
  return result
}

/** A shallow copy of `callee`, one spread per kind: a spread of the kind union builds a union-typed literal, which a native build has no allocation for. */
const calleeCopyOf = (callee: CallCalleeIdentity): CallCalleeIdentity => {
  if (callee.kind === 'exact') {
    const exact: Extract<CallCalleeIdentity, { kind: 'exact' }> = { ...callee }
    return exact
  }
  const family: Extract<CallCalleeIdentity, { kind: 'closed-family' }> = { ...callee }
  return family
}

/**
 * A remembered answer re-pointed from the program it was solved over to a
 * same-data copy of it, or null when it cannot stand for a solve of the copy.
 */
const flowOverCopy = (flow: NativeCallableFlow, pairing: Pairing, copy = false): NativeCallableFlow | null => {
  const { pairs } = pairing
  const seen = new Map<object, unknown>()
  const fresh = { objects: new Set(pairs.values()), reached: false, copy, ambiguous: pairing.ambiguous, refused: false }
  const { nativeFieldViewAbsentRoutesOf: absentRoutesOf, callables, ...data } = flow
  const moved = repointed(data, pairs, seen, fresh) as Omit<NativeCallableFlow, 'nativeFieldViewAbsentRoutesOf' | 'callables'>
  // A solve allocates each callee identity afresh, and the dispatch passes then
  // write those very objects into the program, so they are copied rather than
  // re-pointed: handed back as they are, the reused answer would share them
  // with the bodies where a solve's never does.
  const callees = new Map(
    [...callables].map(([value, callee]) => [value, repointed(calleeCopyOf(callee), pairs, seen, fresh) as CallCalleeIdentity] as const)
  )
  // An answer holding an object a pass wrote into the program after the solve
  // is re-pointed once more, copying each such object: a solve of the new
  // program would allocate its own, equal to the copy and shared with
  // nothing. Only a plain object, array, map or set can be copied.
  if (fresh.refused) return null
  if (fresh.reached) return copy ? null : flowOverCopy(flow, pairing, true)
  const answer = { ...moved, callables: callees }
  if (absentRoutesOf === undefined) return answer
  return { ...answer, nativeFieldViewAbsentRoutesOf: repointedAbsentRoutesOf(absentRoutesOf, pairs) }
}

type AbsentRoutesReader = NonNullable<NativeCallableFlow['nativeFieldViewAbsentRoutesOf']>
/** The solved reader and the one pairing a re-pointed reader applies to its answers. */
const repointedReaders = new WeakMap<
  AbsentRoutesReader,
  { readonly base: AbsentRoutesReader; readonly pairs: ReadonlyMap<object, object> }
>()

/**
 * Outside `flowOverCopy` for the reason `expandoStoredReaderOf` (callable-class-flow.ts) states: an
 * arrow made there shared its context with `seen` and `fresh`, every object of
 * both programs.
 *
 * A reader re-pointed again is not wrapped again: the two pairings are
 * composed into one over the solved reader's own program. Wrapping kept every
 * intermediate copy's pairing -- and through it every intermediate program --
 * alive for as long as the newest flow was remembered. Composing is exact:
 * re-pointing through the first pairing and then the second is re-pointing
 * each first-pairing partner through the second, and leaving every object the
 * first did not pair to the second.
 */
const repointedAbsentRoutesOf = (absentRoutesOf: AbsentRoutesReader, pairs: ReadonlyMap<object, object>): AbsentRoutesReader => {
  const earlier = repointedReaders.get(absentRoutesOf)
  const base = earlier?.base ?? absentRoutesOf
  let composed: ReadonlyMap<object, object> = answerReachablePairsOf(pairs)
  if (earlier !== undefined) {
    const seen = new Map<object, unknown>()
    const unreached = { objects: new Set<object>(), reached: false }
    const both = new Map<object, object>()
    for (const [old, partner] of earlier.pairs) both.set(old, repointed(partner, pairs, seen, unreached) as object)
    for (const [old, partner] of composed) if (!both.has(old)) both.set(old, partner)
    composed = both
  }
  const reader = absentRoutesReaderOver(base, composed)
  repointedReaders.set(reader, { base, pairs: composed })
  return reader
}

/**
 * The part of a pairing an absent-routes answer can reach. An answer holds
 * storage domains over representations and conversion nodes, and none of those
 * ever holds an IR operation, block or body, or a container of one. So the
 * pairing's entries for the program's own structure are never consulted when
 * an answer is re-pointed. Kept whole, a reader pinned both programs it paired
 * -- every block, operation and operand list, up to a million entries per
 * reader on a large app -- for the rest of the compile.
 */
const answerReachablePairsOf = (pairs: ReadonlyMap<object, object>): ReadonlyMap<object, object> => {
  const structural = new Map<object, boolean>()
  const isStructure = (value: unknown): boolean => {
    if (typeof value !== 'object' || value === null) return false
    const known = structural.get(value)
    if (known !== undefined) return known
    structural.set(value, false)
    let answer: boolean
    if (Array.isArray(value)) answer = value.some(isStructure)
    else if (value instanceof Map) answer = [...value.values()].some(isStructure) || [...value.keys()].some(isStructure)
    else if (value instanceof Set) answer = [...value].some(isStructure)
    else answer = 'lineage' in value || ('operations' in value && 'terminator' in value) || ('blocks' in value && 'sourceOwner' in value)
    structural.set(value, answer)
    return answer
  }
  const kept = new Map<object, object>()
  for (const [old, partner] of pairs) if (!isStructure(old)) kept.set(old, partner)
  return kept
}

const absentRoutesReaderOver =
  (base: AbsentRoutesReader, pairs: ReadonlyMap<object, object>): AbsentRoutesReader =>
  (receiver, key) =>
    repointed(base(receiver, key), pairs, new Map<object, unknown>(), {
      objects: new Set<object>(),
      reached: false
    }) as ReturnType<AbsentRoutesReader>

/**
 * The first remembered entry, in `entries` order, whose inputs are the same
 * data as the request's under `skipped` and that `accept` takes, and what
 * `accept` made of it; null when none is.
 */
const firstSameDataEntry = <T>(
  request: DataEqualFlowRequest,
  skipped: SkippedFields,
  accept: (entry: DataEqualFlowRequest['entries'][number], index: number, pairing: Pairing) => T | null
): T | null => {
  const { entries, sameContext, bodies, programConversions, constructionTopology, viewNodesOfRequest, sameViewNodes } = request
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!
    if (
      !sameContext(entry) ||
      entry.bodies.length !== bodies.length ||
      (entry.constructionTopology === null) !== (constructionTopology === undefined)
    )
      continue
    let pairing = pairingOf(skipped)
    if (!pairSameData(entry.bodies, bodies, pairing)) continue
    // Program conversions reach the answer only through its view nodes
    // (`flowViewNodesOf`): recipes that differ -- or are given on one side
    // only -- but leave the view nodes the solve acts on (`sameViewNodes`)
    // leave the same answer.
    const withConversions = pairingCopyOf(pairing)
    if (pairSameData(entry.programConversions, programConversions ?? null, withConversions)) pairing = withConversions
    else if (!sameViewNodes(entry.viewNodes, viewNodesOfRequest())) continue
    if (!pairSameData(entry.constructionTopology, constructionTopology ?? null, pairing)) continue
    // A cited field reaches the answer only through the view nodes it cites.
    if (pairing.state.citationsDiffer && !sameViewNodes(entry.viewNodes, viewNodesOfRequest())) continue
    const accepted = accept(entry, index, pairing)
    if (accepted !== null) return accepted
  }
  return null
}

/**
 * The first remembered answer whose inputs are the same data as the request's,
 * re-pointed at the request's objects and remembered in its entry's place;
 * null when none is.
 */
export const dataEqualFlowReuse = (request: DataEqualFlowRequest): NativeCallableFlow | null => {
  const { programConversions, remember, unreadOperationFields } = request
  return firstSameDataEntry(
    request,
    { unread: unreadOperationFields, cited: noFields, bodies: request.unreadBodyFields },
    (entry, index, pairing) => {
      const reused = flowOverCopy(entry.flow, pairing)
      if (reused === null) return null
      // An answer of the other kind stays remembered beside this one, as a solve
      // of this kind would have left it.
      return remember(reused, (entry.programConversions === null) === (programConversions === undefined) ? index : -1, entry.viewNodes)
    }
  )
}

/**
 * A remembered answer, as solved and not re-pointed, whose inputs are the same
 * data as the request's apart from fields it reads only as citations; null
 * when none is. Only a caller reading nothing of it but value and function
 * ids may take it: every object in it belongs to the program it was solved
 * over.
 */
export const dataEqualValueAnswer = (request: DataEqualFlowRequest): NativeCallableFlow | null => {
  return firstSameDataEntry(
    request,
    { unread: request.unreadOperationFields, cited: request.citedOperationFields, bodies: request.unreadBodyFields },
    (entry) => entry.flow
  )
}
