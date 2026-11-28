import { firstMemberOf } from './model.js'

/** A lazily expanded graph solved as strongly connected components. */
export interface DependencyComponentNode<K, R> {
  /** Facts local to this node are complete, without assuming dependencies. */
  readonly locallyComplete: boolean
  /** Every node whose answer this node requires. */
  readonly dependencies: readonly K[]
  /** Terminal reasons that made this node locally incomplete. */
  readonly causes?: readonly R[]
  /** Domain-specific grounding witness, used by the seeded-origin policy. */
  readonly seed?: boolean
  /** Grounding domains that must have a witness if this node is in a cycle. */
  readonly groundingRequirements?: readonly DependencyGroundingDomain[]
  /** Domain-specific witnesses local to this node. */
  readonly groundingSeeds?: readonly DependencyGroundingDomain[]
  /**
   * Edges that may carry the named grounding domain. Each edge must also be a
   * regular dependency. Untagged dependencies never propagate grounding.
   */
  readonly groundingDependencies?: readonly {
    readonly domain: DependencyGroundingDomain
    readonly dependency: K
  }[]
  /**
   * More grounding edges, all carrying `groundingDomain`, given as their
   * dependencies alone (see `DependencyGroundingKeys`). They follow
   * `groundingDependencies` in edge order.
   */
  readonly groundingDomain?: DependencyGroundingDomain
  readonly groundingKeys?: DependencyGroundingKeys<K>
}

export type DependencyGroundingDomain = string | symbol

/**
 * Grounding dependencies in one domain: a lone key as itself, more in an
 * array (a key that is itself an array goes inside one). A seal is kept for
 * the life of the solve, and a 48K-line app's ~100K grounded seals carry
 * ~147K edges in its one domain: a `{ domain, dependency }` record per edge is
 * 40 bytes, and a one-element array 56 more to hold a pointer.
 */
export type DependencyGroundingKeys<K> = K | readonly K[]
// A guard rather than a bare `Array.isArray`: that narrows `K | readonly K[]` to
// `K & any[]`, so the array arm would read through the lone key's carrier.
const isList = <K>(keys: K | readonly K[]): keys is readonly K[] => Array.isArray(keys)
const groundingKeysOf = <K>(node: {
  readonly groundingDomain?: DependencyGroundingDomain
  readonly groundingKeys?: DependencyGroundingKeys<K>
}): readonly K[] => {
  const keys = node.groundingKeys
  // A fresh empty list of the caller's own key type: a shared `never[]`
  // carries no element type for a natively compiled list of keys to adopt.
  if (keys === undefined) return []
  // Fail closed: keys with no domain to carry are a malformed node, not an empty one.
  if (node.groundingDomain === undefined) throw new Error('grounding keys need a grounding domain')
  return isList(keys) ? keys : [keys]
}

export type DependencyComponentMode = 'all-dependencies' | 'seeded-origin' | 'grounding-domains'

// Each arm a named generic interface, not an object literal in the alias: an
// alias's literal arms are re-created on every instantiation path, and a native
// build has no conversion between two records of the same fields under
// different shapes. An interface's instantiations are one type per argument list.
export interface OpaqueRootCause<K, R> {
  readonly kind: 'opaque'
  readonly root: K
  readonly cause: R
  readonly path: readonly K[]
}
export interface IncompleteNodeRootCause<K> {
  readonly kind: 'incomplete-node'
  readonly root: K
  readonly path: readonly K[]
}
export interface UnseededCycleRootCause<K> {
  readonly kind: 'unseeded-cycle'
  readonly members: readonly K[]
  readonly path: readonly K[]
}
export interface UngroundedCycleRootCause<K> {
  readonly kind: 'unseeded-cycle'
  readonly domain: DependencyGroundingDomain
  readonly members: readonly K[]
  /** The members whose own grounding requirement no walk witnessed: where to look. */
  readonly unmet: readonly K[]
  readonly path: readonly K[]
}
export type DependencyRootCause<K, R> =
  OpaqueRootCause<K, R> | IncompleteNodeRootCause<K> | UnseededCycleRootCause<K> | UngroundedCycleRootCause<K>

export interface DependencyComponentResult<K, R> {
  readonly status: 'complete' | 'refused'
  /** Legacy aggregate witness flag retained for seeded-origin clients. */
  readonly grounded: boolean
  /** Witness domains reached over explicitly labelled edges. */
  readonly groundedDomains: ReadonlySet<DependencyGroundingDomain>
  /** Materialize root causes and one shortest dependency path to each only when needed. */
  readonly explain: () => readonly DependencyRootCause<K, R>[]
}

/**
 * Solve a lazily discovered dependency graph. `all-dependencies` admits a
 * recursive component when every member has complete local facts and every
 * dependency outside it is complete. `seeded-origin` preserves the legacy
 * seed rule. `grounding-domains` enforces only domains required by members of
 * a cycle and propagates witnesses over explicitly labelled dependency edges.
 * An acyclic unseeded node remains a complete, vacuous answer.
 */
export const dependencyComponentSolver = <K, R>(
  expand: (key: K) => DependencyComponentNode<K, R>,
  mode: DependencyComponentMode
): ((key: K) => DependencyComponentResult<K, R>) => {
  const expanded = new Map<K, ExpandedComponentNode<K, R>>()
  return componentEngine<K, R, ExpandedComponentNode<K, R>>(
    {
      slotOf: (key) => {
        const existing = expanded.get(key)
        if (existing !== undefined) return existing
        const slot: ExpandedComponentNode<K, R> = {
          node: expand(key),
          componentRead: false,
          componentAnswer: null,
          groundedInNoDomain: false,
          groundedInFirstDomain: UNSETTLED
        }
        expanded.set(key, slot)
        return slot
      },
      existingSlotOf: (key) => expanded.get(key),
      localOf: (slot) => slot.node,
      dependenciesOf: (slot) => slot.node.dependencies
    },
    mode
  ).solve
}

// The four answers a solved node can have, shared: a fresh pair per node was
// ~200K objects on a 48K-line app, and every reader only reads them.
type ComponentAnswer = { readonly status: 'complete' | 'refused'; readonly grounded: boolean }
const componentAnswers = {
  completeGrounded: Object.freeze({ status: 'complete', grounded: true }),
  complete: Object.freeze({ status: 'complete', grounded: false }),
  refusedGrounded: Object.freeze({ status: 'refused', grounded: true }),
  refused: Object.freeze({ status: 'refused', grounded: false })
} as const
const componentAnswer = (complete: boolean, grounded: boolean): ComponentAnswer =>
  complete
    ? grounded
      ? componentAnswers.completeGrounded
      : componentAnswers.complete
    : grounded
      ? componentAnswers.refusedGrounded
      : componentAnswers.refused

/** What `explain` needs of a component: kept only for one that has something to explain. */
interface Component<K> {
  readonly members: readonly K[]
  readonly unseededCycle: boolean
  readonly unseededDomains: ReadonlySet<DependencyGroundingDomain>
  readonly unmet: readonly K[]
}

/**
 * What the component solve remembers about one node, kept on the record the
 * caller already holds for that node rather than in maps of its own. Five
 * maps keyed by node (the expanded node as a copy of the caller's facts, its
 * answer, its component, its grounding, and whether it was expanded) were
 * each a hash entry per node of a graph that, on a 48K-line app, has ~224K
 * nodes: ~80 MB, a quarter of the whole solver.
 */
interface ComponentSlot {
  /** A cached answer has read this node (`invalidate` stops at a node no answer read). */
  componentRead: boolean
  componentAnswer: ComponentAnswer | null
  /** `groundingDomainsFrom` settled on no domain, the answer nearly every node it reaches has. */
  groundedInNoDomain: boolean
  /** `groundedFor`'s settled answer for the first domain the engine walks (`GroundedIn`). */
  groundedInFirstDomain: GroundedIn
}
/**
 * Whether a node reaches a witness of a domain: not settled, or settled
 * either way. Kept on the node for the first domain the engine walks (there
 * is one in this compiler), where a table of settled nodes per domain held
 * an entry per value-origin node -- ~60K on a 48K-line app.
 */
type GroundedIn = 0 | 1 | 2
const UNSETTLED = 0
const GROUNDED = 1
const UNGROUNDED = 2

type ComponentLocalFacts<K, R> = Omit<DependencyComponentNode<K, R>, 'dependencies'>

// Declared here rather than inside `dependencyComponentSolver`: an interface
// local to a generic function is a distinct record type per mention in a
// native build, so its slots did not convert between the two.
interface ExpandedComponentNode<K, R> extends ComponentSlot {
  readonly node: DependencyComponentNode<K, R>
}

/**
 * The graph a component solve reads, through the caller's own records: its
 * local facts and its required edges are read live, never copied. A copy per
 * node was a second object and a second dependency array for every node.
 * Reading live is the same answer because a cached answer only stands while
 * nothing it read has changed: the caller invalidates every node whose local
 * facts or required edges moved before it solves again.
 */
interface ComponentGraph<K, R, S extends ComponentSlot> {
  /** The node's record, created if need be. */
  readonly slotOf: (key: K) => S
  /** The node's record, only if it already exists. */
  readonly existingSlotOf: (key: K) => S | undefined
  readonly localOf: (slot: S) => ComponentLocalFacts<K, R>
  /** Required edges, in the order they were first required. */
  readonly dependenciesOf: (slot: S) => Iterable<K>
}

/**
 * The same solver, plus eviction for a graph that keeps growing underneath it.
 * `invalidate` forgets every cached answer that could have read a changed
 * node: the changed nodes themselves and everything that reaches them over
 * required edges. A node nothing cached ever read cannot have contributed
 * to a cached answer, so the walk stops there. Every other answer is a pure
 * function of nodes that did not change, and stays.
 */
const componentEngine = <K, R, S extends ComponentSlot>(
  graph: ComponentGraph<K, R, S>,
  mode: DependencyComponentMode
): {
  readonly solve: (key: K) => DependencyComponentResult<K, R>
  readonly invalidate: (changed: ReadonlySet<K>, requiredDependentsOf: (key: K) => readonly K[]) => void
} => {
  // No `groundedDomains` in an answer. It is a pure function of the graph
  // (`groundingDomainsFrom`, memoized per node), never of how components
  // closed, so storing it per node only meant computing it for every node of
  // every component -- the whole value-origin subgraph walked ~115,000 times
  // on a large program -- when the only places it can change an answer are a
  // cyclic component's requirement check and the published result of a node
  // someone actually asks about.
  const { existingSlotOf, localOf, dependenciesOf } = graph
  // `groundingDomainsFrom`'s memo: a bit of the node for the empty answer and
  // this table for any other. A field per node holding the set was ~1.8 MB on
  // a 48K-line app's source-value solve (~224K nodes), and a table holding
  // every answer was as large again, since ~45K of them are the empty one.
  const domainsByRoot = new Map<K, ReadonlySet<DependencyGroundingDomain>>()
  const nodeOf = (key: K): S => {
    const slot = graph.slotOf(key)
    if (!slot.componentRead) {
      slot.componentRead = true
      // Checked here, once per node, rather than inside the grounding walk.
      // There it was `dependencies.includes(...)` per grounding edge, so a node
      // carrying g grounding edges over d required ones paid g*d comparisons --
      // and paid them again for every root whose walk reached it. One Set of
      // the node's own dependencies answers all g in O(d + g), and moving the
      // check to expansion makes it cover EVERY node the solver sees instead of
      // only the ones some grounding walk happened to reach.
      const local = localOf(slot)
      const grounding = local.groundingDependencies
      const keyed = groundingKeysOf(local)
      if ((grounding !== undefined && grounding.length > 0) || keyed.length > 0) {
        // Filled by iteration: `new Set(iterable)` from an arbitrary Iterable needs
        // the dynamic @@iterator protocol natively; a for-of over it does not.
        const declared = new Set<K>()
        for (const dependency of dependenciesOf(slot)) declared.add(dependency)
        for (const edge of grounding ?? [])
          if (!declared.has(edge.dependency)) throw new Error('grounding dependency must also be a closure dependency')
        for (const dependency of keyed)
          if (!declared.has(dependency)) throw new Error('grounding dependency must also be a closure dependency')
      }
    }
    return slot
  }

  /**
   * Grounding walks only the domain-labelled subgraph, never all closure edges.
   *
   * One walk, labelled by the domain of the edge it arrived on -- not a walk to
   * collect the domain universe followed by a per-domain walk to search it. The
   * collecting walk visited every node reachable over ANY grounding edge and
   * could not stop early, because its purpose was to enumerate; the searching
   * walk stops at the first witness. In this compiler there is exactly one
   * domain (`source-value-session.ts`'s `VALUE_ORIGIN`), so the enumeration
   * pass was a full traversal of the value-origin subgraph -- repeated for
   * every node of every component -- to rediscover the single domain the
   * search was about to walk anyway.
   *
   * Dropping it is answer-preserving, not an approximation. A domain can only
   * enter the result by being witnessed on a path of its OWN edges from the
   * root, so the domains the enumeration pass added from a node's
   * `groundingRequirements`, or from an edge of some other domain, could never
   * survive the search: the search would walk no edge of such a domain out of
   * the root and would find nothing but the root's own seeds -- which are
   * admitted here unconditionally, before any edge is walked.
   */
  const NO_DOMAINS: ReadonlySet<DependencyGroundingDomain> = new Set()
  // A node's published grounding is kept for the life of its answer and is
  // nearly always one domain (this compiler has one): one shared set per
  // domain, not one per grounded node.
  const singleDomains = new Map<DependencyGroundingDomain, ReadonlySet<DependencyGroundingDomain>>()
  const onlyDomain = (domain: DependencyGroundingDomain): ReadonlySet<DependencyGroundingDomain> => {
    let set = singleDomains.get(domain)
    if (set === undefined) singleDomains.set(domain, (set = new Set([domain])))
    return set
  }
  const NO_MEMBERS: readonly K[] = []
  /**
   * Only the components `explain` has something to say about -- an unseeded
   * cycle or an unmet grounding domain -- which is nearly none of them:
   * `explain` reads a component for those two facts alone, so a members list
   * kept for every component was ~190K arrays for nothing.
   */
  const explained = new Map<K, Component<K>>()
  /**
   * Whether a node reaches a witness of `domain` over edges labelled with
   * `domain`, for every node any walk has settled. A node's own seed counts.
   *
   * This is what makes the walk below linear in the graph rather than in
   * (nodes asked x nodes reached). A per-root search that remembered only
   * its root's answer re-walked the same region from every member of a
   * cyclic component; on a large program the component is most of the graph
   * and a region with no witness in it is walked whole, once per member --
   * quadratic, and the reason a solve that had already converged never
   * finished. One walk settles every node it reaches: the region it visits is
   * closed under the domain's edges (an edge leaving it ends at a node already
   * settled), so each visited node's answer is exactly "a witness is reachable
   * inside the region or through a settled node", which a backward pass from
   * the witnesses decides for all of them at once.
   *
   * Invalidated with everything else: a domain edge is also a required edge
   * (checked in `nodeOf`), so a node whose answer could have read a changed
   * node is one of the required dependents `invalidate` already evicts.
   */
  let firstDomain: DependencyGroundingDomain | undefined
  const groundedIn = new Map<DependencyGroundingDomain, Map<K, boolean>>()
  // A settled node is one a walk visited, so it has a slot (`nodeOf`).
  const settledIn = (
    domain: DependencyGroundingDomain
  ): { readonly get: (key: K) => boolean | undefined; readonly set: (key: K, grounded: boolean) => void } => {
    firstDomain ??= domain
    if (domain === firstDomain)
      return {
        get: (key) => {
          const code = existingSlotOf(key)?.groundedInFirstDomain ?? UNSETTLED
          return code === UNSETTLED ? undefined : code === GROUNDED
        },
        set: (key, grounded) => {
          existingSlotOf(key)!.groundedInFirstDomain = grounded ? GROUNDED : UNGROUNDED
        }
      }
    let table = groundedIn.get(domain)
    if (table === undefined) groundedIn.set(domain, (table = new Map<K, boolean>()))
    const settled = table
    return { get: (key) => settled.get(key), set: (key, grounded) => void settled.set(key, grounded) }
  }
  const groundedFor = (domain: DependencyGroundingDomain, start: K): boolean => {
    const settled = settledIn(domain)
    const known = settled.get(start)
    if (known !== undefined) return known
    // Forward over the domain's edges, stopping at settled nodes.
    const region: K[] = [start]
    const inRegion = new Set<K>(region)
    const predecessors = new Map<K, K[]>()
    const witnesses: K[] = []
    // One grounding edge of `key` in this domain: true when it reaches a settled witness, which ends `key`'s edges.
    const follow = (key: K, dependency: K): boolean => {
      const answer = settled.get(dependency)
      if (answer === true) {
        witnesses.push(key)
        return true
      }
      if (answer === false) return false
      let incoming = predecessors.get(dependency)
      if (incoming === undefined) predecessors.set(dependency, (incoming = []))
      incoming.push(key)
      if (!inRegion.has(dependency)) {
        inRegion.add(dependency)
        region.push(dependency)
      }
      return false
    }
    for (let cursor = 0; cursor < region.length; cursor++) {
      const key = region[cursor]!
      const local = localOf(nodeOf(key))
      if (local.groundingSeeds?.includes(domain)) {
        witnesses.push(key)
        continue
      }
      let witnessed = false
      for (const edge of local.groundingDependencies ?? []) if (edge.domain === domain && (witnessed = follow(key, edge.dependency))) break
      if (!witnessed && local.groundingDomain === domain)
        for (const dependency of groundingKeysOf(local)) if (follow(key, dependency)) break
    }
    // Backward from the witnesses: everything that reaches one is grounded.
    const grounded = new Set<K>(witnesses)
    for (let cursor = 0; cursor < witnesses.length; cursor++)
      for (const predecessor of predecessors.get(witnesses[cursor]!) ?? [])
        if (!grounded.has(predecessor)) {
          grounded.add(predecessor)
          witnesses.push(predecessor)
        }
    for (const key of region) settled.set(key, grounded.has(key))
    return grounded.has(start)
  }
  const groundingDomainsFrom = (root: K): ReadonlySet<DependencyGroundingDomain> => {
    const rootSlot = nodeOf(root)
    if (rootSlot.groundedInNoDomain) return NO_DOMAINS
    const known = domainsByRoot.get(root)
    if (known !== undefined) return known
    const rootNode = localOf(rootSlot)
    // A node that neither witnesses a domain nor labels an edge with one can
    // only ever answer the empty set, and that is most of them: `seeded-origin`
    // clients (`seeded-origins.ts`) never set a grounding field at all, and a
    // solver is built per query there. Answering without allocating a walk is
    // what keeps this off that path entirely.
    if (!rootNode.groundingSeeds?.length && !rootNode.groundingDependencies?.length && groundingKeysOf(rootNode).length === 0) {
      rootSlot.groundedInNoDomain = true
      return NO_DOMAINS
    }
    // The root's own seeds, whatever their domain, and each domain one of its
    // edges is labelled with when that edge leads to a witness of it.
    const found = new Set<DependencyGroundingDomain>(rootNode.groundingSeeds ?? [])
    for (const edge of rootNode.groundingDependencies ?? [])
      if (!found.has(edge.domain) && groundedFor(edge.domain, edge.dependency)) found.add(edge.domain)
    const keyedDomain = rootNode.groundingDomain
    for (const dependency of groundingKeysOf(rootNode))
      if (!found.has(keyedDomain!) && groundedFor(keyedDomain!, dependency)) found.add(keyedDomain!)
    const answer = found.size === 0 ? NO_DOMAINS : found.size === 1 ? onlyDomain(firstMemberOf(found)!) : found
    if (answer === NO_DOMAINS) rootSlot.groundedInNoDomain = true
    else domainsByRoot.set(root, answer)
    return answer
  }

  const explainFrom = (root: K): readonly DependencyRootCause<K, R>[] => {
    const paths = new Map<K, readonly K[]>([[root, [root]]])
    const queue = [root]
    const emittedOpaque = new Map<K, Set<R>>()
    const emittedIncomplete = new Set<K>()
    const emittedCycles = new Set<Component<K>>()
    const emittedDomainCycles = new Map<Component<K>, Set<DependencyGroundingDomain>>()
    const causes: DependencyRootCause<K, R>[] = []
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const key = queue[cursor]!
      const slot = nodeOf(key)
      const node = localOf(slot)
      const path = paths.get(key)!
      const reasons = node.causes ?? []
      if (!node.locallyComplete && reasons.length === 0 && !emittedIncomplete.has(key)) {
        emittedIncomplete.add(key)
        causes.push({ kind: 'incomplete-node', root: key, path })
      }
      if (!node.locallyComplete) {
        let emitted = emittedOpaque.get(key)
        if (!emitted) emittedOpaque.set(key, (emitted = new Set<R>()))
        for (const cause of reasons) {
          if (emitted.has(cause)) continue
          emitted.add(cause)
          causes.push({ kind: 'opaque', root: key, cause, path })
        }
      }
      const component = explained.get(key)
      if (component?.unseededCycle && !emittedCycles.has(component)) {
        emittedCycles.add(component)
        causes.push({ kind: 'unseeded-cycle', members: component.members, path })
      }
      if (component?.unseededDomains.size) {
        let emitted = emittedDomainCycles.get(component)
        if (!emitted) emittedDomainCycles.set(component, (emitted = new Set<DependencyGroundingDomain>()))
        for (const domain of component.unseededDomains) {
          if (emitted.has(domain)) continue
          emitted.add(domain)
          causes.push({ kind: 'unseeded-cycle', domain, members: component.members, unmet: component.unmet, path })
        }
      }
      for (const dependency of dependenciesOf(slot)) {
        if (paths.has(dependency)) continue
        paths.set(dependency, [...path, dependency])
        queue.push(dependency)
      }
    }
    return causes
  }

  /**
   * A node's published grounding, computed when someone asks for it rather than
   * when its component closed. Same function, same memo, same answer: the walk
   * reads only nodes whose facts cannot change while the memo stands, so when
   * it runs cannot change what it returns. In `grounding-domains` mode the
   * legacy aggregate flag is the domain set's emptiness, exactly as the
   * component loop used to record it; in the other modes it stays the seed
   * witness that loop computes.
   *
   * A plain object, not one with accessors. Deferring these two fields behind
   * getters was tried and cost 4.7% of a whole compile in this one function:
   * a result is built for every top-level query, a solver is built per query,
   * and an object literal carrying accessors is far more expensive to create
   * than one carrying values. The walk itself is memoized and answers the
   * no-grounding case without allocating, which is the cheap half anyway.
   */
  const publish = (root: K, known: ComponentAnswer): DependencyComponentResult<K, R> => {
    const groundedDomains = groundingDomainsFrom(root)
    return {
      status: known.status,
      grounded: mode === 'grounding-domains' ? groundedDomains.size > 0 : known.grounded,
      groundedDomains,
      explain: () => explainFrom(root)
    }
  }

  const answerOf = (key: K): ComponentAnswer | null => existingSlotOf(key)?.componentAnswer ?? null

  const solve = (root: K): DependencyComponentResult<K, R> => {
    const known = answerOf(root)
    if (known !== null) return publish(root, known)

    const indices = new Map<K, number>()
    const low = new Map<K, number>()
    const stack: K[] = []
    const active = new Set<K>()
    let next = 0

    // The low-link is kept in a local for the length of the loop and written to
    // `low` once, on the way out. Nothing reads a node's low-link while its own
    // visit is running -- a back edge reads `indices`, and a tree edge reads the
    // child's low-link only after that child's visit has returned -- so the
    // read-modify-write through the map on every edge was three map operations
    // per edge to maintain a number only this frame could see.
    const visit = (key: K): void => {
      const index = next++
      indices.set(key, index)
      let lowest = index
      stack.push(key)
      active.add(key)
      for (const dependency of dependenciesOf(nodeOf(key))) {
        if (answerOf(dependency) !== null) continue
        const seen = indices.get(dependency)
        if (seen === undefined) {
          visit(dependency)
          // Absent when expanding the dependency re-entered a solve, whose end
          // resets these tables: the edge then lowers nothing, as an
          // `undefined` comparison always answered here before.
          const reached = low.get(dependency)
          if (reached !== undefined && reached < lowest) lowest = reached
        } else if (seen < lowest && active.has(dependency)) lowest = seen
      }
      low.set(key, lowest)
      if (lowest !== index) return

      const members: K[] = []
      let member: K
      do {
        member = stack.pop()!
        active.delete(member)
        members.push(member)
      } while (member !== key)
      // A singleton component's only member is `key` itself, so membership is
      // an identity test. Most components are singletons, and building a Set to
      // ask one question about one element is the allocation that shows up.
      const memberSet = members.length === 1 ? null : new Set(members)
      let complete = true
      let grounded = false
      let cyclic = members.length > 1
      const unseededDomains = new Set<DependencyGroundingDomain>()
      const unmet: K[] = []
      for (const current of members) {
        const slot = nodeOf(current)
        const node = localOf(slot)
        complete &&= node.locallyComplete
        grounded ||= node.seed === true
        for (const dependency of dependenciesOf(slot)) {
          if (memberSet === null ? dependency === key : memberSet.has(dependency)) {
            cyclic = true
            continue
          }
          const dependencyResult = answerOf(dependency)
          complete &&= dependencyResult?.status === 'complete'
          grounded ||= dependencyResult?.grounded === true
        }
      }
      const unseededCycle = mode === 'seeded-origin' && complete && cyclic && !grounded
      if (unseededCycle) complete = false
      // Only a cyclic component can fail a grounding requirement -- an acyclic
      // node's requirement is discharged by the ordinary completeness rule --
      // so this is the one place the walk has to run before an answer is
      // published, and the members of one cycle are all it has to run for.
      if (mode === 'grounding-domains' && complete && cyclic) {
        for (const current of members) {
          const groundedForNode = groundingDomainsFrom(current)
          for (const domain of localOf(nodeOf(current)).groundingRequirements ?? []) {
            if (groundedForNode.has(domain)) continue
            unseededDomains.add(domain)
            unmet.push(current)
          }
        }
        if (unseededDomains.size > 0) complete = false
      }
      const component: Component<K> | null =
        unseededDomains.size > 0
          ? { members, unseededCycle, unseededDomains, unmet }
          : unseededCycle
            ? { members, unseededCycle, unseededDomains: NO_DOMAINS, unmet: NO_MEMBERS }
            : null
      const answer = componentAnswer(complete, grounded)
      for (const current of members) {
        nodeOf(current).componentAnswer = answer
        if (component !== null) explained.set(current, component)
      }
    }

    visit(root)
    return publish(root, answerOf(root)!)
  }

  const invalidate = (changed: ReadonlySet<K>, requiredDependentsOf: (key: K) => readonly K[]): void => {
    const queue = [...changed]
    const seen = new Set<K>()
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const key = queue[cursor]!
      if (seen.has(key)) continue
      seen.add(key)
      const slot = existingSlotOf(key)
      if (slot === undefined || !slot.componentRead) continue
      slot.componentRead = false
      slot.componentAnswer = null
      slot.groundedInNoDomain = false
      domainsByRoot.delete(key)
      slot.groundedInFirstDomain = UNSETTLED
      explained.delete(key)
      for (const settled of groundedIn.values()) settled.delete(key)
      for (const dependent of requiredDependentsOf(key)) queue.push(dependent)
    }
  }

  return { solve, invalidate }
}

/** A node whose fact set is transferred monotonically from discovered dependencies. */
export type DependencyFactRead<K, V> = (dependency: K) => FactSet<V>

/** A discovery edge whose facts are visible but whose completeness is not required. */
export type DependencyFactObserve<K, V> = (dependency: K) => FactSet<V>

/**
 * The reverse of `read`/`observe`: given a fact VALUE, the keys of every node
 * that holds it so far. `read`/`observe` name the dependency up front; this is
 * for the shape where the dependency is not knowable up front -- "which of an
 * unbounded candidate set holds this" -- which a per-key whole-program scan
 * inside a transfer is the usual symptom of. `unknownReadsOf` in
 * `source-value-session.ts` used to `observe` every computed-key read in a
 * large program from every one of its hundreds of containers, to ask a question that
 * does not depend on the key: whether the read's RECEIVER can be this
 * container. Asked in reverse, each container asks once, "who holds me",
 * instead of every container asking the same receivers again.
 *
 * Calling this still makes the caller a dependent, exactly as `observe`
 * would -- a node that comes to hold this fact LATER still wakes every past
 * caller, via a value-keyed subscription rather than a per-dependency edge.
 * Skipping that would mean a container that gains a holder only after this
 * ran publishes an incomplete answer forever: a silently wrong result, not a
 * slow one.
 *
 * Never becomes a required edge, and cannot: there is no dependency `K` here
 * to require -- the very thing being asked is which nodes hold this fact, not
 * whether one named node is complete. A consumer that needs this fact's
 * completeness must `read` a query that owns it directly.
 *
 * Only finds SEEDED nodes (`DependencyFactSolver.seed`), and only once they
 * have transferred. The candidate set is the caller's to name: a candidate
 * nothing else depends on would otherwise never be created, and a node that
 * merely happens to hold the same value is not a candidate. Indexing every
 * state instead made each call enumerate every holder in the program -- on
 * a large program, thousands of value queries holding one shared object, walked per
 * root per re-evaluation, a third of the whole first solve -- only for every
 * consumer to discard all but the seeded receivers it actually asked about.
 */
// An array, not an `Iterable`: callers count it (`length`) and a native build
// iterates an array directly.
export type DependencyFactHoldersOf<K, V> = (fact: V) => readonly K[]

/**
 * Both callbacks are handed the node's own key, so one definition object can
 * serve every node: a definition per node, closing over its key, was an object,
 * two closures and their context for the life of every node -- ~350 bytes a
 * node, ~80 MB on a 48K-line app.
 */
export interface DependencyFactDefinition<K, V, R> {
  /**
   * Add facts derivable now. `read` registers a required dependency, even when
   * its current fact set is empty. `observe` registers a discovery-only edge:
   * its facts are visible and it is revisited when they grow, but its local
   * completeness does not become a requirement of this node. Transfers must
   * be monotone: later reads may add facts, never retract them. If a transfer
   * relies on an observed node being complete, it must also call `read` for it.
   *
   * Declared `ReadonlySet<V>`, not `Iterable<V>`, on purpose. `propagate`
   * iterates this return value while it is still mutating the node's own
   * `facts` -- adding each yielded value before pulling the next one -- and
   * `read`/`observe` hand a dependency's `facts` out LIVE, with no defensive
   * copy (a copy per edge read was quadratic and unfinishable on a large
   * class; a copy per node doubled a large program's peak memory into a 4 GB
   * OOM -- see `factsFrom`). An `Iterable` return invites a generator, and a
   * generator's continuation runs interleaved with that iteration: for a
   * self- or mutually-cyclic node, a `read`/`observe` call made partway
   * through would see a partially-filled `facts` Set from the transfer pass
   * CURRENTLY IN PROGRESS instead of the stable snapshot taken when transfer
   * started, silently breaking the "transfers must be monotone" contract
   * above and making the answer depend on iteration order. Every
   * implementation already returns a materialised Set built before it
   * returns; this type makes that the only legal shape.
   */
  readonly transfer: (
    read: DependencyFactRead<K, V>,
    observe: DependencyFactObserve<K, V>,
    holdersOf: DependencyFactHoldersOf<K, V>,
    key: K
  ) => ReadonlySet<V>
  /**
   * Called only after transfer propagation reaches a fixed point. Calling
   * `read` or `observe` here registers that edge and causes propagation/sealing
   * to repeat. `read` makes the dependency closure-required; `observe` only
   * discovers it. This is where a domain decides whether all local alternatives
   * were accounted for and supplies terminal causes or a grounding witness.
   * A grounding dependency must be closure-required via `read`; observation
   * alone can never carry a grounding witness. `holdersOf` behaves like
   * `observe` here too: it can only ever grow what is locally complete, never
   * shrink it, and it cannot supply a grounding witness either.
   */
  readonly seal: (
    read: DependencyFactRead<K, V>,
    observe: DependencyFactObserve<K, V>,
    holdersOf: DependencyFactHoldersOf<K, V>,
    key: K
  ) => {
    readonly locallyComplete: boolean
    readonly causes?: readonly R[]
    readonly seed?: boolean
    readonly groundingRequirements?: readonly DependencyGroundingDomain[]
    readonly groundingSeeds?: readonly DependencyGroundingDomain[]
    readonly groundingDependencies?: readonly {
      readonly domain: DependencyGroundingDomain
      readonly dependency: K
    }[]
    readonly groundingDomain?: DependencyGroundingDomain
    readonly groundingKeys?: DependencyGroundingKeys<K>
  }
}

export type DependencyFactResult<K, V, R> =
  | {
      readonly status: 'complete'
      readonly grounded: boolean
      readonly groundedDomains: ReadonlySet<DependencyGroundingDomain>
      readonly facts: ReadonlySet<V>
      readonly explain: () => readonly DependencyRootCause<K, R>[]
    }
  | {
      readonly status: 'refused'
      readonly grounded: boolean
      readonly groundedDomains: ReadonlySet<DependencyGroundingDomain>
      readonly explain: () => readonly DependencyRootCause<K, R>[]
    }

/**
 * Demand-discover and monotonically propagate generic fact sets, then seal the
 * discovered graph with `dependencyComponentSolver`. Empty reads during
 * propagation are pending values, not refusals; only `seal` can mark a node
 * locally incomplete. Public facts are exposed only for a complete result.
 *
 * Keys and fact values must have stable identity/equality for the lifetime of
 * the solver. A consumer must ensure its transfer reaches a finite fixed point.
 */
/**
 * A solve, plus the proof graph it already holds.
 *
 * A consumer that walks "what did this node read" must not keep its own copy
 * of the answer: the solver records every required edge anyway, and the second
 * copy is a whole duplicate dependency graph -- on a large program, ~115,000
 * nodes per solve, enough to exhaust the heap a few solves in.
 */
export interface DependencyFactSolver<K, V, R> {
  readonly solve: (key: K) => DependencyFactResult<K, V, R>
  readonly requiredDependenciesOf: (key: K) => Iterable<K>
  /**
   * Materialise a node and schedule its transfer, without creating any edge
   * to it from anywhere.
   *
   * `holdersOf` only ever finds nodes that already exist, because it has
   * nothing to expand from -- it is handed a fact value, not a key. A caller
   * that builds a fixed candidate list up front (every computed-key receiver in the
   * program) used to force each candidate into existence as a SIDE EFFECT
   * of subscribing to it with `observe`; inverting the question removes the
   * subscription but does not remove the need for the candidate to exist and
   * have run at least once. This is that need, named: create-and-schedule
   * with no subscriber, so `seed`ing a whole candidate list costs one
   * scheduling operation per candidate and stores zero edges, instead of one
   * stored edge per (candidate, asker) pair. Seeding is also what makes a
   * node a candidate: `holdersOf` answers over seeded nodes only.
   */
  readonly seed: (key: K) => void
}

/**
 * A small edge collection of states: none, a lone state, or an exactly sized
 * array (grown by `concat`; `push` onto a one-element array reserves 17 slots).
 * A state is a `FactState`, never an array, Map or Set, so the forms are told
 * apart by those tests alone.
 */
type EdgeStates<S extends object> = S | readonly S[] | null
/** Past this many entries an edge collection becomes a hash table: a lookup is a linear scan below it. */
const SMALL_EDGES = 8
/** How far ahead of its last edge read `observedState` looks before asking the dependency. */
const CURSOR_WINDOW = 4
/**
 * Whether two equally sized fact lists hold the same facts in the same order.
 * Indexed rather than stepped by iterator: an iterator stepped by hand
 * allocated a result object per fact on each side.
 */
const sameOrder = <V>(mine: readonly V[], theirs: readonly V[]): boolean => {
  for (let index = 0; index < mine.length; index++) if (mine[index] !== theirs[index]) return false
  return true
}

// `Array.isArray` narrows a generic `S | readonly S[]` to `S & any[]`, which a
// monomorphized copy reads as the lone state; this guard narrows to the list arm.
const isEdgeList = <S extends object>(edges: EdgeStates<S> | Set<S>): edges is readonly S[] => Array.isArray(edges)
const edgeCount = <S extends object>(edges: EdgeStates<S> | Set<S>): number =>
  edges === null ? 0 : edges instanceof Set ? edges.size : isEdgeList(edges) ? edges.length : 1
const edgeStates = <S extends object>(edges: EdgeStates<S> | Set<S>): Iterable<S> =>
  edges === null ? [] : edges instanceof Set || isEdgeList(edges) ? (edges as Iterable<S>) : [edges as S]
const withDependent = <S extends object>(edges: EdgeStates<S> | Set<S>, state: S): EdgeStates<S> | Set<S> => {
  if (edges === null) return state
  if (edges instanceof Set) return edges.add(state)
  const small = isEdgeList(edges) ? (edges as readonly S[]) : [edges as S]
  return small.length < SMALL_EDGES ? small.concat([state]) : new Set(small).add(state)
}

const edgeHas = <S extends object>(edges: EdgeStates<S> | Set<S>, state: S): boolean =>
  edges === null
    ? false
    : edges instanceof Set
      ? edges.has(state)
      : isEdgeList(edges)
        ? (edges as readonly S[]).includes(state)
        : edges === state
/** `withDependent` for a collection that may already hold `state`. */
const withMember = <S extends object>(edges: EdgeStates<S> | Set<S>, state: S): EdgeStates<S> | Set<S> =>
  edgeHas(edges, state) ? edges : withDependent(edges, state)

type FactSeal<K, R> = ReturnType<DependencyFactDefinition<K, never, R>['seal']>

const NO_FACT: unique symbol = Symbol('no fact')
const NO_FACT_LIST: readonly never[] = []
const INDEXED = 1
const COMPONENT_READ = 2
/**
 * Every observed edge is required, in the order observed. ~151K of a
 * 48K-line app's ~155K states that require anything require exactly what
 * they observe: a second copy of the edge list, as keys, for each of them.
 */
const REQUIRES_OBSERVED = 4
/**
 * A state's component answer is one of the four shared `componentAnswers` or
 * none, so it is three bits of `flags` rather than a field: a field is 8 bytes
 * on each of a 48K-line app's ~224K states.
 */
const ANSWER_SHIFT = 3
const ANSWER_MASK = 7 << ANSWER_SHIFT
const answerCodes: readonly (ComponentAnswer | null)[] = [
  null,
  componentAnswers.completeGrounded,
  componentAnswers.complete,
  componentAnswers.refusedGrounded,
  componentAnswers.refused
]
/**
 * This state's fact collection may also be another state's, so it is copied
 * before it is written. ~23K of a 48K-line app's ~28K multi-fact states hold
 * the same facts, in the same order, as some other state -- 300K of 335K
 * entries -- mostly because a node forwards what it reads.
 */
const SHARED_FACTS = 64
/**
 * The required edges are some other list, kept by the solver beside its
 * states (`explicitRequired`) rather than in a field every state pays for:
 * ~4K states of ~224K.
 */
const EXPLICIT_REQUIRED = 128
/** `groundedInFirstDomain`, two bits of `flags`. */
const GROUNDED_SHIFT = 8
const GROUNDED_MASK = 3 << GROUNDED_SHIFT
/** `groundedInNoDomain`. */
const NO_GROUNDING_DOMAIN = 1 << 10
/** A key that is its own state (`keysAreStates`) has been made a node of the solver: `stateOf` has run for it. */
const MINTED = 1 << 11
/** In the solver's seal-dirty list: its transfer has been queued since its last seal. */
const SEAL_DIRTY = 1 << 12
/** In the solver's propagation queue and not yet drained. */
const QUEUED = 1 << 13
/**
 * One of the facts a state holds when it holds exactly one, told apart from
 * the collection forms (see `FactSet.facts`). An array is the only one a fact
 * could be mistaken for: `FactTable` is private to this module, so no caller's
 * fact or key is ever one.
 */
const isLoneFact = (value: unknown): boolean => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * A collection past `SMALL_EDGES`: its entries in insertion order, and a hash
 * index for membership. A list beside the index rather than a `Set` alone,
 * because readers take a state's facts as a plain array (`FactSet.list`): a
 * native build iterates an array directly, and has neither a receiver
 * protocol for a `Set` cursor nor a conversion from a class implementing
 * `ReadonlySet` to the keyed collection a caller expects. The list costs a
 * pointer per entry on the few thousand collections this large.
 */
class FactTable<T> {
  constructor(
    readonly list: T[],
    readonly index: Set<T>
  ) {}
}
/** A table owning `list`, which the caller hands over. */
const tableOf = <T>(list: T[]): FactTable<T> => new FactTable<T>(list, new Set<T>(list))

/**
 * The fact set of one node of a `dependencyFactSolver`: `read`/`observe` hand
 * the node's state out as this live view. A consumer may keep it to compare
 * its size later (the own-key stamps in `source-value-session.ts`), so it has
 * to be one object for the node's life -- and the state already is.
 *
 * Not a `ReadonlySet`: a native build has no conversion from a class to the
 * keyed collection that interface names, nor an iterator protocol for a
 * cursor that is an array's in one form and a `Set`'s in another. Readers
 * iterate `list()`, a plain array in insertion order, and test `has`, which
 * is SameValueZero as for a `Set`.
 *
 * The facts are held inline while there is at most one, in an exactly sized
 * array up to `SMALL_EDGES`, and in a `FactTable` past it. Half the nodes of a
 * 48K-line app's solve hold no fact and a third hold exactly one, and the
 * smallest `Set` is a 152-byte hash table: ~30 MB of tables for ~200K sets of
 * at most one element.
 */
export abstract class FactSet<V> {
  protected flags = 0
  /**
   * No fact, one fact held as itself, two to `SMALL_EDGES` facts in an
   * exactly sized array, more in a `FactTable`: ~22K of a 48K-line app's ~28K
   * multi-fact states hold at most eight, and the smallest `Set` holding two
   * is ~180 bytes of hash table. One field for all four forms rather than one
   * for the lone fact and one for the collection: a lone fact that could be
   * mistaken for a collection (`isLoneFact`) is held as a one-element array.
   */
  private facts: V | readonly V[] | FactTable<V> | typeof NO_FACT = NO_FACT
  get size(): number {
    const facts = this.facts
    if (facts === NO_FACT) return 0
    if (facts instanceof FactTable) return facts.list.length
    if (isList<V>(facts)) return facts.length
    return 1
  }
  has(value: V): boolean {
    const facts = this.facts
    if (facts === NO_FACT) return false
    if (facts instanceof FactTable) return facts.index.has(value)
    // `includes` is SameValueZero, as `Set.prototype.has` is.
    if (isList<V>(facts)) return facts.includes(value)
    // A lone fact is an object (`isLoneFact`), so identity is SameValueZero here.
    return facts === value
  }
  add(added: V): void {
    // Held as a `Set` holds it: `-0` is the same fact as `+0`, and is listed as `+0`.
    const value = Object.is(added, -0) ? (0 as V) : added
    const facts = this.facts
    if (facts === NO_FACT) {
      // Two writes rather than one conditional: each converts into the field on its own.
      if (isLoneFact(value)) this.facts = value
      else this.facts = [value]
      return
    }
    if (facts instanceof FactTable) {
      if (facts.index.has(value)) return
      if ((this.flags & SHARED_FACTS) === 0) {
        facts.list.push(value)
        facts.index.add(value)
        return
      }
      this.facts = tableOf(facts.list.concat([value]))
      this.flags &= ~SHARED_FACTS
      return
    }
    if (this.has(value)) return
    // A new array rather than a push: a pushed array keeps growth slack,
    // and no reader iterates a state's facts while they are added
    // (`factsFrom`), so a replaced array is never mid-iteration.
    const small: readonly V[] = isList<V>(facts) ? facts : [facts]
    const grown = small.concat([value])
    if (small.length < SMALL_EDGES) this.facts = grown
    else this.facts = tableOf(grown)
    this.flags &= ~SHARED_FACTS
  }
  /**
   * Holds `other`'s fact collection when it is the same facts in the same
   * order, so iteration is unchanged; both are marked shared, and `add`
   * copies a shared table before writing it (an array is never written: it is
   * replaced). Only collections are shared: none or a lone fact costs nothing.
   */
  shareFactsOf(other: FactSet<V>): boolean {
    const mine = this.facts
    const theirs = other.facts
    if (mine === theirs) return true
    if (this.size !== other.size) return false
    const mineList = collectionList(mine)
    const theirList = collectionList(theirs)
    if (mineList === null || theirList === null || !sameOrder(mineList, theirList)) return false
    this.facts = theirs
    this.flags |= SHARED_FACTS
    other.flags |= SHARED_FACTS
    return true
  }
  /**
   * The facts added from the `start`-th on, in insertion order: a reader
   * that saw the first `start` takes only what came after (a delta cursor).
   */
  factsFrom(start: number): readonly V[] {
    const list = this.list()
    return start >= list.length ? NO_FACT_LIST : list.slice(start)
  }
  /**
   * The facts in insertion order. Live for a table, which grows in place, and
   * a snapshot otherwise (a small array is replaced, never written), exactly
   * as iterating the `Set` or array they were held in was.
   */
  list(): readonly V[] {
    const facts = this.facts
    if (facts === NO_FACT) return NO_FACT_LIST
    if (facts instanceof FactTable) return facts.list
    if (isList<V>(facts)) return facts
    return [facts]
  }
}

/**
 * The entries of a collection form, or null for none or a lone fact. Each form
 * told apart by its own test, never by a cast, and an array by `isList`: a bare
 * `Array.isArray` narrows to `V & any[]`, which reads through the lone fact's
 * carrier in a native build.
 */
const collectionList = <V>(facts: V | readonly V[] | FactTable<V> | typeof NO_FACT): readonly V[] | null => {
  if (facts === NO_FACT) return null
  if (facts instanceof FactTable) return facts.list
  if (isList<V>(facts)) return facts
  return null
}

/**
 * One node of a `dependencyFactSolver`, which is also its own fact set
 * (`FactSet`).
 *
 * A class, so ~224K instances share one shape and one copy of the methods,
 * and so its booleans can share one field with the fact set's. Abstract over
 * where the key lives: a caller that interns one record per key can make that
 * record the state itself (`keysAreStates`), and a key record and a state per
 * node were two headers and a pointer each way -- ~9 MB on a 48K-line app.
 */
export abstract class FactState<K, V, R> extends FactSet<V> implements ComponentSlot {
  /**
   * Every scheduled edge, holding the dependency's STATE and not just its
   * key. A transfer re-reads the same edges on every re-evaluation, so
   * resolving the key through the global state map each time was a lookup
   * per edge read across the whole solve -- the single largest self-time
   * entry in a large program's profile. The owner already has to touch this
   * collection to know the edge exists; carrying the state in it makes the
   * repeat read free.
   *
   * This and the two edge collections below are null until the first edge
   * that would go in them, a lone state or an exactly sized array while they
   * are small, and a hash table only past `SMALL_EDGES`. A 48K-line app's
   * solve holds ~224K states; three quarters of them have at most one edge
   * of each kind, and a one-entry Map or Set is ~180 bytes of hash table:
   * ~90 MB of tables for edges a field holds in 8. Insertion order, which
   * `propagate`'s wake-ups and `explain`'s paths follow, is the same in
   * every form.
   *
   * Observed edges never become a table: past `SMALL_EDGES` they are an
   * array of this state's own, grown by `push`, and whether an edge exists is
   * asked of the dependency's `dependents` instead (`observedState`). A
   * key-to-state Map was ~1.3 KB a state for the ~4K states that observe
   * more than eight.
   */
  observedDependencies: EdgeStates<FactState<K, V, R>> = null
  /**
   * Dependents, held as states for the same reason `key` is: `propagate`
   * fires an edge by re-enqueuing its owner, and it already holds that
   * owner's state from the moment the edge was recorded.
   */
  dependents: EdgeStates<FactState<K, V, R>> | Set<FactState<K, V, R>> = null
  /** The last seal, which the component solve reads as this node's local facts. */
  sealed: FactSeal<K, R> | undefined = undefined
  /**
   * Carried on the state so `dependents` and the propagation queue can hold
   * states directly instead of keys. Both used to hold `K`, and every drain
   * re-resolved `states.get(key)` per edge fire -- on a large program's
   * millions of observe edges, a Map lookup the caller already had the answer
   * to, since the state is in hand at both the point an edge is created
   * (`factsFrom`'s `dependencyState`) and the point it fires (`propagate`'s
   * queue).
   */
  abstract readonly solverKey: K
  /** Seeded: this state's facts are visible to `holdersOf`. */
  get indexed(): boolean {
    return (this.flags & INDEXED) !== 0
  }
  set indexed(value: boolean) {
    this.flags = value ? this.flags | INDEXED : this.flags & ~INDEXED
  }
  get requiresObserved(): boolean {
    return (this.flags & REQUIRES_OBSERVED) !== 0
  }
  set requiresObserved(value: boolean) {
    this.flags = value ? this.flags | REQUIRES_OBSERVED : this.flags & ~REQUIRES_OBSERVED
  }
  get groundedInFirstDomain(): GroundedIn {
    return ((this.flags & GROUNDED_MASK) >> GROUNDED_SHIFT) as GroundedIn
  }
  set groundedInFirstDomain(value: GroundedIn) {
    this.flags = (this.flags & ~GROUNDED_MASK) | (value << GROUNDED_SHIFT)
  }
  get groundedInNoDomain(): boolean {
    return (this.flags & NO_GROUNDING_DOMAIN) !== 0
  }
  set groundedInNoDomain(value: boolean) {
    this.flags = value ? this.flags | NO_GROUNDING_DOMAIN : this.flags & ~NO_GROUNDING_DOMAIN
  }
  get minted(): boolean {
    return (this.flags & MINTED) !== 0
  }
  set minted(value: boolean) {
    this.flags = value ? this.flags | MINTED : this.flags & ~MINTED
  }
  get queued(): boolean {
    return (this.flags & QUEUED) !== 0
  }
  set queued(value: boolean) {
    this.flags = value ? this.flags | QUEUED : this.flags & ~QUEUED
  }
  get sealDirty(): boolean {
    return (this.flags & SEAL_DIRTY) !== 0
  }
  set sealDirty(value: boolean) {
    this.flags = value ? this.flags | SEAL_DIRTY : this.flags & ~SEAL_DIRTY
  }
  get explicitRequired(): boolean {
    return (this.flags & EXPLICIT_REQUIRED) !== 0
  }
  set explicitRequired(value: boolean) {
    this.flags = value ? this.flags | EXPLICIT_REQUIRED : this.flags & ~EXPLICIT_REQUIRED
  }
  get componentAnswer(): ComponentAnswer | null {
    return answerCodes[(this.flags & ANSWER_MASK) >> ANSWER_SHIFT]!
  }
  set componentAnswer(answer: ComponentAnswer | null) {
    const code = answerCodes.indexOf(answer)
    // Fail closed: only the shared answers have a code.
    if (code < 0) throw new Error('component answer is not one of the shared answers')
    this.flags = (this.flags & ~ANSWER_MASK) | (code << ANSWER_SHIFT)
  }
  get componentRead(): boolean {
    return (this.flags & COMPONENT_READ) !== 0
  }
  set componentRead(value: boolean) {
    this.flags = value ? this.flags | COMPONENT_READ : this.flags & ~COMPONENT_READ
  }
}

/** A state for a key that cannot hold one, kept in the solver's own table. */
class KeyedFactState<K, V, R> extends FactState<K, V, R> {
  constructor(readonly solverKey: K) {
    super()
  }
}

interface SolverTally {
  roots: number
  states: number
  transfers: number
  seals: number
  componentNodes: number
}

const tallyLine = (counts: SolverTally): string =>
  `[SOLVER] roots=${counts.roots} states=${counts.states} transfers=${counts.transfers} seals=${counts.seals} component-expansions=${counts.componentNodes}`

/** `GEA_SOLVER_COUNTS` exit reports: each solver's tally, the numbers alone. */
const exitReports = new Set<SolverTally>()
if (process.env['GEA_SOLVER_COUNTS'] !== undefined)
  process.on('exit', () => {
    for (const counts of exitReports) console.error(tallyLine(counts))
  })

/**
 * `expand` is either one definition for every node (its callbacks are handed
 * the node's key) or a function minting one per node, called once as the node
 * is created.
 *
 * With `keysAreStates`, every key is a `FactState` subclass instance the
 * caller interned once per question, and the key is the node's state: a table
 * keyed by key costs a hash entry per node -- ~7 MB of table for a 48K-line
 * app's ~224K nodes -- and a separate state per key a header and two pointers.
 * Such keys must be private to one solver. Otherwise states are kept in a
 * table keyed by key.
 */
export const dependencyFactSolver = <K, V, R>(
  expand: DependencyFactDefinition<K, V, R> | ((key: K) => DependencyFactDefinition<K, V, R>),
  mode: DependencyComponentMode,
  keyState: ((key: K) => FactState<K, V, R>) | null = null
): DependencyFactSolver<K, V, R> => {
  type Seal = FactSeal<K, R>
  type State = FactState<K, V, R>
  const table = keyState === null ? new Map<K, State>() : null
  // A key that is its own state, through the caller's typed upcast: a cast
  // through `unknown` is a box and unbox a native build loses the class over.
  const ownStateOf = (key: K): State => {
    if (keyState === null) throw new Error('dependencyFactSolver: a keyed solver has no state of its own keys')
    return keyState(key)
  }
  const existingStateOf = (key: K): State | undefined => {
    if (table !== null) return table.get(key)
    const state = ownStateOf(key)
    return state.minted ? state : undefined
  }
  // Every state, for the `GEA_SOLVER_SIZES` report alone: keys that are states have no iteration.
  const everyState: State[] | null = process.env['GEA_SOLVER_SIZES'] === undefined ? null : []
  // A definition per key is kept beside the states only for a caller that
  // supplies one; a shared definition is not stored per state at all.
  const definitions = typeof expand === 'function' ? new Map<K, DependencyFactDefinition<K, V, R>>() : null
  const definitionOf = (state: State): DependencyFactDefinition<K, V, R> =>
    definitions === null ? (expand as DependencyFactDefinition<K, V, R>) : definitions.get(state.solverKey)!
  const observedState = (owner: State, dependency: K): State | undefined => {
    const observed = owner.observedDependencies
    if (observed === null) return undefined
    if (!isEdgeList(observed)) return (observed as State).solverKey === dependency ? (observed as State) : undefined
    if (observed.length <= SMALL_EDGES) {
      for (const candidate of observed as readonly State[]) if (candidate.solverKey === dependency) return candidate
      return undefined
    }
    // A transfer re-reads its edges in the order it first read them, so the
    // running owner's next edge is nearly always the one asked for: checked
    // first, a few places ahead for a read the transfer skipped this time.
    // The test below asks a dependency's dependents, which for a node read
    // from everywhere is a table of hundreds of thousands of states; on a
    // large three.js program it was a tenth of the session's time.
    if (owner === cursorOwner) {
      const end = Math.min(observed.length, readCursor + CURSOR_WINDOW)
      for (let at = readCursor; at < end; at++) {
        const candidate = (observed as readonly State[])[at]!
        if (candidate.solverKey === dependency) {
          readCursor = at + 1
          return candidate
        }
      }
    }
    // An owner is among a dependency's dependents exactly when it observes
    // it: the two edges are only ever added together (`factsFrom`).
    const state = existingStateOf(dependency)
    return state !== undefined && edgeHas(state.dependents, owner) ? state : undefined
  }
  // The state whose transfer or seal is running and where its edge reads have
  // reached (`observedState`). Only a hint: every hit is checked against the
  // dependency's key, so a stale cursor costs a miss, never a wrong edge.
  let cursorOwner: State | null = null
  let readCursor = 0
  const withObserved = (observed: State['observedDependencies'], dependencyState: State): State['observedDependencies'] => {
    if (observed === null) return dependencyState
    if (!isEdgeList(observed)) return [observed as State, dependencyState]
    const list = observed as readonly State[]
    if (list.length < SMALL_EDGES) return list.concat([dependencyState])
    // Past `SMALL_EDGES` the array is this state's own (copied once, here) and grows in place.
    if (list.length === SMALL_EDGES) return [...list, dependencyState]
    ;(observed as State[]).push(dependencyState)
    return observed
  }
  // A key is held alone only when it cannot be mistaken for a collection of
  // keys. Any other key (none in this solver's one caller) takes the
  // one-element array it always had. A collection of keys is
  // keys: an object that is not an array (`FactTable` is private, so no key is one).
  const loneRequired = (dependency: K): boolean => typeof dependency === 'object' && dependency !== null && !Array.isArray(dependency)
  /**
   * Edges whose completeness contributes to the published answer, as keys:
   * the component solve and `requiredDependenciesOf` iterate them as given.
   * Only for a state whose required edges are not simply its observed ones
   * (`requiresObserved`): filled from those the first time an edge is
   * observed without being required. A lone key is held as itself
   * (`loneRequired`).
   */
  type Required = K | readonly K[] | FactTable<K>
  const explicitRequired = new Map<State, Required>()
  const explicitRequiredOf = (state: State): Required | null => (state.explicitRequired ? explicitRequired.get(state)! : null)
  const setExplicitRequired = (state: State, required: Required | null): void => {
    if (required === null) return
    explicitRequired.set(state, required)
    state.explicitRequired = true
  }
  const keysHave = (keys: Required | null, key: K): boolean => {
    if (keys === null) return false
    if (keys instanceof FactTable) return keys.index.has(key)
    if (isList<K>(keys)) return keys.includes(key)
    return keys === key
  }
  // A dependent of `dependency` observes it, so under `requiresObserved` it also requires it.
  const isRequired = (state: State, dependency: K): boolean => {
    if (state.requiresObserved) return observedState(state, dependency) !== undefined
    return keysHave(explicitRequiredOf(state), dependency)
  }
  const withRequired = (required: Required | null, dependency: K): Required => {
    if (required === null) return loneRequired(dependency) ? dependency : [dependency]
    if (required instanceof FactTable) {
      if (!required.index.has(dependency)) {
        required.list.push(dependency)
        required.index.add(dependency)
      }
      return required
    }
    const small: readonly K[] = isList<K>(required) ? required : [required]
    const grown = small.concat([dependency])
    if (small.length < SMALL_EDGES) return grown
    return tableOf(grown)
  }
  // A copy for an array: a long one grows in place while its owner runs.
  const observedKeys = (observed: State['observedDependencies']): readonly K[] =>
    observed === null
      ? NO_DEPENDENCIES
      : isEdgeList(observed)
        ? (observed as readonly State[]).map((state) => state.solverKey)
        : [(observed as State).solverKey]
  // Counted per form rather than by spreading `requiredOf`: its answer is
  // one of three carriers, and a native build has no range copy for that.
  const requiredCountOf = (state: State): number => {
    if (state.requiresObserved) return observedKeys(state.observedDependencies).length
    const required = explicitRequiredOf(state)
    return requiredList(required).length
  }
  // Each form told apart by its own test, never by a cast.
  const requiredList = (required: Required | null): readonly K[] => {
    if (required === null) return NO_DEPENDENCIES
    if (required instanceof FactTable) return required.list
    if (isList<K>(required)) return required
    return [required]
  }
  const requiredOf = (state: State | undefined): readonly K[] => {
    if (state === undefined) return NO_DEPENDENCIES
    if (state.requiresObserved) return observedKeys(state.observedDependencies)
    return requiredList(explicitRequiredOf(state))
  }
  // States, not keys: `propagate` used to hold keys and call `stateOf(key)`
  // on every drain, a Map lookup per edge fire across a large program's millions
  // of observe edges. The State is already in hand wherever an edge fires or is
  // created, so the queue (and `dependents`, on State above) carry it
  // directly and dedupe on State identity, which is 1:1 with key identity
  // because `states` is the only minter. The dedupe is a flag on the state
  // (`queued`), not a set: a hash per enqueue on a large program's millions.
  const queue: State[] = []
  let dependencyRevision = 0

  // Every reason a node's TRANSFER must run again is a reason its SEAL must run
  // again: the seal is the same transfer with `sealing` set, so it reads the
  // same dependencies and answers differently only when they do. `queue` is
  // drained by `propagate`; this set outlives it, because a seal pass happens
  // after the drain and needs to know what the drain touched.
  //
  // A list and a flag on the state rather than a set of keys: the flag dedupes
  // as the set did and the list keeps its first-insertion order, without
  // hashing a key on every one of a large program's millions of enqueues.
  let sealDirty: State[] = []
  const enqueue = (state: State): void => {
    if (!state.sealDirty) {
      state.sealDirty = true
      sealDirty.push(state)
    }
    if (state.queued) return
    state.queued = true
    queue.push(state)
  }

  const stateOf = (key: K): State => {
    let state = existingStateOf(key)
    if (state === undefined) {
      // No edge readers kept on the state: three closures and their context
      // for the life of every state, when only a running transfer or seal ever
      // calls them. `transferOf`/`sealOf` mint them for that call.
      const built: State = table !== null ? new KeyedFactState<K, V, R>(key) : ownStateOf(key)
      if (definitions !== null) definitions.set(key, (expand as (key: K) => DependencyFactDefinition<K, V, R>)(key))
      state = built
      if (table !== null) table.set(key, built)
      else built.minted = true
      counts.states++
      everyState?.push(built)
      enqueue(built)
    }
    return state
  }

  /**
   * `seed` is exactly this, exposed: create the state (a no-op if it already
   * exists) and let `stateOf`'s own `enqueue` schedule its first transfer.
   * No edge is recorded anywhere -- nothing subscribes and nothing is
   * subscribed to -- because the only purpose is to make the node exist and
   * run, not to make anyone depend on it.
   */
  const seed = (key: K): void => {
    const state = stateOf(key)
    if (state.indexed) return
    state.indexed = true
    // Facts it published before it was seeded never reached the index.
    for (const fact of state.list()) index(state, fact)
  }

  // The reverse of `observedDependencies`/`dependents`: every state that has
  // published a given fact VALUE, and every state that has ever asked
  // `holdersOf` about it. Only seeded states publish here (see
  // `DependencyFactHoldersOf`), so its size is bounded by the candidates'
  // facts, not by every (state, fact) pair in the program.
  // Each in the small edge forms (`EdgeStates`): ~12K of these sets on a
  // 48K-line app, most holding a few states, at ~200 bytes of table apiece.
  // Held as keys, in the forms the required edges use (`Required`), so
  // `holdersOfFrom` hands out the list it answers with no copy and no
  // conversion: an array of states is not an array of keys to a native build,
  // even where each state is its own key (`keysAreStates`).
  const holders = new Map<V, Required>()
  const valueSubscribers = new Map<V, EdgeStates<State> | Set<State>>()
  // A node that asked `holdersOf(fact)` before this state held it named no
  // `K` to depend on, so an ordinary dependent edge cannot wake it; this is
  // the other half of that subscription. Without it, a container whose holder
  // shows up only after `unknown-reads` first ran would publish an incomplete
  // answer forever and never be asked again, which is the silently-wrong
  // result SEMANTIC-AUTHORITY ranks below a slow one.
  const index = (state: State, fact: V): void => {
    const holding = holders.get(fact) ?? null
    if (!keysHave(holding, state.solverKey)) {
      const held = withRequired(holding, state.solverKey)
      if (held !== holding) holders.set(fact, held)
    }
    const subscribers = valueSubscribers.get(fact)
    if (subscribers !== undefined) for (const subscriber of edgeStates(subscribers)) enqueue(subscriber)
  }
  const holdersOfFrom = (ownerState: State, fact: V): readonly K[] => {
    const subscribers = valueSubscribers.get(fact) ?? null
    const subscribed = withMember(subscribers, ownerState)
    if (subscribed !== subscribers) valueSubscribers.set(fact, subscribed)
    // Idempotent by construction (a membership test), so re-asking on every re-evaluation
    // of the same node costs a lookup and nothing else -- no revision to bump,
    // no queue entry to make, because registering the subscription changes
    // nothing about what THIS transfer already computed with the holders it
    // just read below. It only matters for facts published AFTER this call,
    // which `propagate` below wakes through this same set.
    // No copy: the collection only grows in `index`, which runs after the
    // transfer asking has returned.
    return requiredList(holders.get(fact) ?? null)
  }

  // The owner's state is handed in rather than looked up: every transfer and
  // every seal reads its dependencies through this, so a map lookup per edge
  // for a state the caller is already holding was, on a large program, a quarter
  // of the whole compile.
  const factsFrom = (ownerState: State, dependency: K, required: boolean): FactSet<V> => {
    let dependencyState = observedState(ownerState, dependency)
    let changed = false
    // While every edge so far was required (a first edge that is required
    // starts it), a required new edge keeps `requiresObserved`. The first new
    // edge that is only observed ends it: the required edges are then exactly
    // the ones observed so far, in that order, and from here on are kept in
    // `explicitRequired`.
    let joinsObserved = false
    if (dependencyState === undefined) {
      if (required) joinsObserved = ownerState.requiresObserved || ownerState.observedDependencies === null
      else if (ownerState.requiresObserved) {
        let materialized: Required | null = null
        for (const key of observedKeys(ownerState.observedDependencies)) materialized = withRequired(materialized, key)
        setExplicitRequired(ownerState, materialized)
        ownerState.requiresObserved = false
      }
      dependencyState = stateOf(dependency)
      ownerState.observedDependencies = withObserved(ownerState.observedDependencies, dependencyState)
      // Appended without a membership test: an owner joins a dependency's
      // dependents exactly when its observed edge to it is new, and observed
      // edges are never removed, so it cannot already be there.
      dependencyState.dependents = withDependent(dependencyState.dependents, ownerState)
      dependencyRevision++
      changed = true
    }
    if (joinsObserved) {
      ownerState.requiresObserved = true
      componentDirty.add(ownerState.solverKey)
      dependencyRevision++
    } else if (required && !ownerState.requiresObserved && !isRequired(ownerState, dependency)) {
      setExplicitRequired(ownerState, withRequired(explicitRequiredOf(ownerState), dependency))
      componentDirty.add(ownerState.solverKey)
      dependencyRevision++
      changed = true
    }
    // A new observation may expose facts on the next pass. An upgrade also
    // invalidates the current seal even though the fact edge already existed.
    if (changed) enqueue(ownerState)
    // The fact set is handed over live, not as a copy. Copying per
    // edge read was quadratic and made a large class unfinishable;
    // copying per (node, size) fixed the time and doubled the memory, which is
    // what put a large program's later solves into a 4 GB OOM. Neither is necessary:
    // `propagate` adds a node's facts only AFTER its transfer has returned --
    // `evaluate` builds its result eagerly and hands back a set of its own --
    // so no reader is ever iterating a set that is being written.
    return dependencyState
  }

  const readFrom = (ownerState: State, dependency: K): FactSet<V> => factsFrom(ownerState, dependency, true)
  const observeFrom = (ownerState: State, dependency: K): FactSet<V> => factsFrom(ownerState, dependency, false)
  // A state's edge readers, minted per transfer or seal call rather than kept
  // on every state (see `stateOf`).
  const transferOf = (state: State): ReadonlySet<V> => {
    cursorOwner = state
    readCursor = 0
    return definitionOf(state).transfer(
      (dependency) => readFrom(state, dependency),
      (dependency) => observeFrom(state, dependency),
      (fact) => holdersOfFrom(state, fact),
      state.solverKey
    )
  }
  const sealOf = (state: State): Seal => {
    cursorOwner = state
    readCursor = 0
    return definitionOf(state).seal(
      (dependency) => readFrom(state, dependency),
      (dependency) => observeFrom(state, dependency),
      (fact) => holdersOfFrom(state, fact),
      state.solverKey
    )
  }

  const propagate = (): void => {
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const state = queue[cursor]!
      state.queued = false
      counts.transfers++
      if (countsEnabled && counts.transfers % 200000 === 0) report()
      // Dependents are woken once per transfer, not once per new fact: nothing
      // is dequeued while this loop runs, so a repeat wake-up finds each
      // dependent already queued. The set can still grow mid-transfer (a state
      // that reads itself), and then the newcomer must be woken too.
      let wokenSize = -1
      let added = false
      for (const fact of transferOf(state)) {
        if (state.has(fact)) continue
        added = true
        state.add(fact)
        const dependents = state.dependents
        const size = edgeCount(dependents)
        if (wokenSize !== size) {
          wokenSize = size
          if (dependents instanceof Set) for (const dependent of dependents) enqueue(dependent)
          else if (isEdgeList(dependents)) for (const dependent of dependents as readonly State[]) enqueue(dependent)
          else if (dependents !== null) enqueue(dependents as State)
        }
        // Recorded at the exact point a fact is genuinely NEW, so `holders`
        // never grows for a re-observed fact.
        if (state.indexed) index(state, fact)
      }
      // A node forwarding what it reads ends up with the same facts as that
      // dependency: share its collection (`shareFactsOf`). Only a short edge
      // list is searched, and only a dependency of the same size compared.
      const observed = state.observedDependencies
      if (added && state.size > 1 && observed !== null && (!isEdgeList(observed) || observed.length <= SMALL_EDGES))
        for (const dependency of edgeStates<State>(observed)) if (dependency.size === state.size && state.shareFactsOf(dependency)) break
    }
    queue.length = 0
  }

  // Seals survive between roots. A solved node whose facts and dependencies
  // have not moved seals to the same answer, and re-deriving it is the cost
  // that made this solver quadratic in (top-level queries x nodes discovered):
  // every query re-sealed the whole graph it had explored so far, so the last
  // query of a large program paid for all of it. Only what `enqueue` marked is
  // re-sealed, which is exactly what could have changed.
  // Nodes whose seal or required-edge set moved since the component solve last
  // ran: the only facts a component answer reads.
  const componentDirty = new Set<K>()
  // A list rather than a generator: `invalidate` drains it whole into its own
  // queue, and a native build has no conversion from a generator to the
  // `Iterable` it would be passed as.
  const requiredDependentsOf = (key: K): readonly K[] => {
    const state = existingStateOf(key)
    if (state === undefined) return NO_DEPENDENCIES
    const found: K[] = []
    for (const dependent of edgeStates(state.dependents))
      if (dependent.requiresObserved || isRequired(dependent, key)) found.push(dependent.solverKey)
    return found
  }
  // A changed seal evicts every cached component answer that reaches it, so
  // reporting a change for a re-seal that reproduces the same answer evicts
  // those answers for nothing -- on a large program nearly every seal was doing
  // exactly that. The grounding fields compare soundly by
  // value: `DependencyGroundingDomain` is `string | symbol`, and a grounding
  // edge's `dependency` is a `K`, which this solver's own contract already
  // requires to have stable identity. `causes` is `R`, a type this solver
  // never gives an equality contract to, so `===` per element is the only
  // sound comparison available here. A client that mints a fresh cause per
  // seal over-invalidates (safe, never wrong) and pays a full component
  // rebuild for every unchanged refusal; source-value-session interns its
  // `Cause` per (node, reason) for exactly that reason.
  const domainsEqual = (a: readonly DependencyGroundingDomain[], b: readonly DependencyGroundingDomain[]): boolean =>
    a.length === b.length && a.every((domain, index) => domain === b[index])
  const groundingEdgesEqual = (
    a: readonly { readonly domain: DependencyGroundingDomain; readonly dependency: K }[],
    b: readonly { readonly domain: DependencyGroundingDomain; readonly dependency: K }[]
  ): boolean =>
    a.length === b.length && a.every((edge, index) => edge.domain === b[index]!.domain && edge.dependency === b[index]!.dependency)
  const keysEqual = (a: readonly K[], b: readonly K[]): boolean => a.length === b.length && a.every((key, index) => key === b[index])
  const causesEqual = (a: readonly R[], b: readonly R[]): boolean => a.length === b.length && a.every((cause, index) => cause === b[index])
  const sealChanged = (previous: Seal | undefined, next: Seal): boolean =>
    previous === undefined ||
    previous.locallyComplete !== next.locallyComplete ||
    previous.seed !== next.seed ||
    !causesEqual(previous.causes ?? [], next.causes ?? []) ||
    !domainsEqual(previous.groundingRequirements ?? [], next.groundingRequirements ?? []) ||
    !domainsEqual(previous.groundingSeeds ?? [], next.groundingSeeds ?? []) ||
    !groundingEdgesEqual(previous.groundingDependencies ?? [], next.groundingDependencies ?? []) ||
    previous.groundingDomain !== next.groundingDomain ||
    !keysEqual(groundingKeysOf(previous), groundingKeysOf(next))
  const counts: SolverTally = { roots: 0, states: 0, transfers: 0, seals: 0, componentNodes: 0 }
  // What the heap is actually holding, for the runs where memory is the wall
  // rather than time. Counted only when asked for: it walks every state.
  const sizes = (): string => {
    if (process.env['GEA_SOLVER_SIZES'] === undefined) return ''
    let observed = 0
    let required = 0
    let dependents = 0
    let facts = 0
    // This solver is generic over K by design -- SEMANTIC-AUTHORITY section 3
    // requires one solved graph, not a solver bespoke to one key shape -- so
    // nothing outside this debug path may assume a key has a `kind`. But
    // attributing a large program's millions of observe edges to a fix means knowing which
    // caller's loop owns them, and the one real caller's key (`Query` in
    // source-value-session.ts) is a `{ kind: ... }` discriminated union. This
    // reflects into that shape defensively, only inside the
    // GEA_SOLVER_SIZES-gated path that prints nothing in production, and
    // falls back to a single 'unknown' bucket for any key not shaped this way.
    const perKind = new Map<string, { states: number; observed: number; required: number; facts: number }>()
    for (const state of everyState ?? []) {
      observed += edgeCount(state.observedDependencies)
      required += requiredCountOf(state)
      dependents += edgeCount(state.dependents)
      facts += state.size
      const kind = (state.solverKey as { readonly kind?: unknown }).kind
      const bucketKey = typeof kind === 'string' ? kind : 'unknown'
      let bucket = perKind.get(bucketKey)
      if (bucket === undefined) perKind.set(bucketKey, (bucket = { states: 0, observed: 0, required: 0, facts: 0 }))
      bucket.states++
      bucket.observed += edgeCount(state.observedDependencies)
      bucket.required += requiredCountOf(state)
      bucket.facts += state.size
    }
    const byKind = [...perKind]
      .sort(([, a], [, b]) => b.observed - a.observed)
      .map(
        ([kind, kindSizes]) =>
          `\n[SOLVER-KIND] kind=${kind} states=${kindSizes.states} observed=${kindSizes.observed} required=${kindSizes.required} facts=${kindSizes.facts}`
      )
      .join('')
    return ` observed=${observed} required=${required} dependents=${dependents} facts=${facts}${byKind}`
  }
  let componentSolver: ReturnType<typeof componentEngine<K, R, State>> | null = null
  const countsEnabled = process.env['GEA_SOLVER_COUNTS'] !== undefined
  // Which question is being answered when the graph grows, and who asked it.
  // Reflective for the same reason `sizes` is: generic K, debug path only.
  let currentRoot: K | undefined
  let reportedRoot: K | undefined
  const describeRoot = (): string => {
    if (currentRoot === undefined || currentRoot === reportedRoot) return ''
    reportedRoot = currentRoot
    const key = currentRoot as { readonly kind?: unknown; readonly node?: unknown; readonly key?: unknown }
    const node = key.node as
      | {
          getSourceFile?: () => { fileName: string; getLineAndCharacterOfPosition: (p: number) => { line: number } }
          getStart?: () => number
          getText?: () => string
        }
      | undefined
    let where = ''
    if (node?.getSourceFile && node.getStart) {
      const file = node.getSourceFile()
      where = ` ${file.fileName}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1} ${(node.getText?.() ?? '').slice(0, 80).replace(/\s+/g, ' ')}`
    }
    const stack = (new Error().stack ?? '').split('\n').slice(3, 40).join('\n')
    return `\n[SOLVER-ROOT] kind=${String(key.kind)}${key.key === undefined ? '' : ` key=${String(key.key)}`}${where}\n${stack}`
  }
  const report = (): void => {
    if (!countsEnabled) return
    console.error(`${tallyLine(counts)}${sizes()}${describeRoot()}`)
  }
  // The tally alone, not `report`: an exit listener closing over `report` kept
  // every solver's whole graph alive for the rest of the process, so a run
  // measured with counts on held each retired census round's session (~3 GB
  // apiece on a large program) and ran out of heap where the same run without
  // counts did not.
  if (countsEnabled) exitReports.add(counts)

  const NO_DEPENDENCIES: readonly K[] = []
  const solve = (root: K): DependencyFactResult<K, V, R> => {
    counts.roots++
    if (countsEnabled) currentRoot = root
    // Reported as it goes, not only at exit: a run that has to be killed to be
    // observed reports nothing, which is how a 20-minute compile stayed
    // unattributed for two profiling attempts.
    stateOf(root)

    // Sealing may itself discover a dependency. In that case its transfer and
    // every affected dependent must run again before any status is published.
    while (true) {
      propagate()
      const revisionBeforeSeal = dependencyRevision
      const dirty = sealDirty
      sealDirty = []
      for (const dirtied of dirty) dirtied.sealDirty = false
      for (const dirtied of dirty) {
        const key = dirtied.solverKey
        const state = existingStateOf(key)
        if (state === undefined) continue
        counts.seals++
        if (countsEnabled && counts.seals % 200000 === 0) report()
        const next = sealOf(state)
        if (sealChanged(state.sealed, next)) componentDirty.add(key)
        state.sealed = next
      }
      if (queue.length === 0 && sealDirty.length === 0 && dependencyRevision === revisionBeforeSeal) break
    }

    // The component solve reads the SEALED graph, so an answer stands for
    // exactly as long as no node it reached has changed its seal or its
    // required edges. Built inside this per-root call it was thrown away for
    // every root: on a large program the graph stopped growing after a handful
    // of roots and the next tens of thousands each re-expanded hundreds of its
    // nodes. Rebuilt whole on any revision instead, it still re-expanded every
    // one of hundreds of thousands of sealed nodes whenever a later root added one state or one
    // observe edge -- neither of which any component answer reads. Only the
    // answers that could have read a changed node are evicted.
    if (componentSolver === null)
      componentSolver = componentEngine<K, R, State>(
        {
          slotOf: (key) => {
            const state = existingStateOf(key)
            if (state === undefined || state.sealed === undefined) throw new Error('unsealed dependency fact node')
            if (!state.componentRead) {
              counts.componentNodes++
              if (countsEnabled && counts.componentNodes % 200000 === 0) report()
            }
            return state
          },
          existingSlotOf: existingStateOf,
          localOf: (state) => state.sealed!,
          dependenciesOf: (state) => requiredOf(state)
        },
        mode
      )
    else if (componentDirty.size > 0) componentSolver.invalidate(componentDirty, requiredDependentsOf)
    componentDirty.clear()
    const result = componentSolver.solve(root)
    if (result.status === 'complete')
      return {
        status: 'complete',
        grounded: result.grounded,
        groundedDomains: result.groundedDomains,
        facts: new Set(stateOf(root).list()),
        explain: result.explain
      }
    return {
      status: 'refused',
      grounded: result.grounded,
      groundedDomains: result.groundedDomains,
      explain: result.explain
    }
  }

  return { solve, requiredDependenciesOf: (key) => requiredOf(existingStateOf(key)), seed }
}
