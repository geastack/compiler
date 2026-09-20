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
}

export type DependencyGroundingDomain = string | symbol

export type DependencyComponentMode = 'all-dependencies' | 'seeded-origin' | 'grounding-domains'

export type DependencyRootCause<K, R> =
  | { readonly kind: 'opaque'; readonly root: K; readonly cause: R; readonly path: readonly K[] }
  | { readonly kind: 'incomplete-node'; readonly root: K; readonly path: readonly K[] }
  | { readonly kind: 'unseeded-cycle'; readonly members: readonly K[]; readonly path: readonly K[] }
  | {
      readonly kind: 'unseeded-cycle'
      readonly domain: DependencyGroundingDomain
      readonly members: readonly K[]
      /** The members whose own grounding requirement no walk witnessed: where to look. */
      readonly unmet: readonly K[]
      readonly path: readonly K[]
    }

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
  const nodes = new Map<K, DependencyComponentNode<K, R>>()
  // No `groundedDomains` here. It is a pure function of the expanded graph
  // (`groundingDomainsFrom`, memoized by key), never of how components closed,
  // so storing it per node only meant computing it for every node of every
  // component -- the whole value-origin subgraph walked ~115,000 times on
  // the three.js app -- when the only places it can change an answer are a cyclic
  // component's requirement check and the published result of a node someone
  // actually asks about.
  const results = new Map<
    K,
    {
      readonly status: 'complete' | 'refused'
      readonly grounded: boolean
    }
  >()
  const componentOf = new Map<K, Component<K>>()

  interface Component<T> {
    readonly members: readonly T[]
    readonly unseededCycle: boolean
    readonly unseededDomains: ReadonlySet<DependencyGroundingDomain>
    readonly unmet: readonly T[]
  }

  const nodeOf = (key: K): DependencyComponentNode<K, R> => {
    let node = nodes.get(key)
    if (node === undefined) {
      node = expand(key)
      nodes.set(key, node)
      // Checked here, once per node, rather than inside the grounding walk.
      // There it was `dependencies.includes(...)` per grounding edge, so a node
      // carrying g grounding edges over d required ones paid g*d comparisons --
      // and paid them again for every root whose walk reached it. One Set of
      // the node's own dependencies answers all g in O(d + g), and moving the
      // check to expansion makes it cover EVERY node the solver sees instead of
      // only the ones some grounding walk happened to reach.
      const grounding = node.groundingDependencies
      if (grounding !== undefined && grounding.length > 0) {
        const declared = new Set<K>(node.dependencies)
        for (const edge of grounding)
          if (!declared.has(edge.dependency)) throw new Error('grounding dependency must also be a closure dependency')
      }
    }
    return node
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
  const groundingCache = new Map<K, ReadonlySet<DependencyGroundingDomain>>()
  const groundingDomainsFrom = (root: K): ReadonlySet<DependencyGroundingDomain> => {
    const known = groundingCache.get(root)
    if (known !== undefined) return known
    const rootNode = nodeOf(root)
    // A node that neither witnesses a domain nor labels an edge with one can
    // only ever answer the empty set, and that is most of them: `seeded-origin`
    // clients (`seeded-origins.ts`) never set a grounding field at all, and a
    // solver is built per query there. Answering without allocating a walk is
    // what keeps this off that path entirely.
    if (!rootNode.groundingSeeds?.length && !rootNode.groundingDependencies?.length) {
      groundingCache.set(root, NO_DOMAINS)
      return NO_DOMAINS
    }
    const found = new Set<DependencyGroundingDomain>(rootNode.groundingSeeds ?? [])
    const seen = new Map<DependencyGroundingDomain, Set<K>>()
    const frontier: { readonly key: K; readonly domain: DependencyGroundingDomain }[] = []
    const follow = (node: DependencyComponentNode<K, R>, domain: DependencyGroundingDomain | null): void => {
      for (const edge of node.groundingDependencies ?? [])
        if (domain === null || edge.domain === domain) frontier.push({ key: edge.dependency, domain: edge.domain })
    }
    follow(rootNode, null)
    for (let cursor = 0; cursor < frontier.length; cursor++) {
      const { key, domain } = frontier[cursor]!
      if (found.has(domain)) continue
      let visited = seen.get(domain)
      if (visited === undefined) seen.set(domain, (visited = new Set()))
      if (visited.has(key)) continue
      visited.add(key)
      const node = nodeOf(key)
      if (node.groundingSeeds?.includes(domain)) {
        found.add(domain)
        continue
      }
      follow(node, domain)
    }
    groundingCache.set(root, found)
    return found
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
      const node = nodeOf(key)
      const path = paths.get(key)!
      const reasons = node.causes ?? []
      if (!node.locallyComplete && reasons.length === 0 && !emittedIncomplete.has(key)) {
        emittedIncomplete.add(key)
        causes.push({ kind: 'incomplete-node', root: key, path })
      }
      if (!node.locallyComplete) {
        let emitted = emittedOpaque.get(key)
        if (!emitted) emittedOpaque.set(key, (emitted = new Set()))
        for (const cause of reasons) {
          if (emitted.has(cause)) continue
          emitted.add(cause)
          causes.push({ kind: 'opaque', root: key, cause, path })
        }
      }
      const component = componentOf.get(key)
      if (component?.unseededCycle && !emittedCycles.has(component)) {
        emittedCycles.add(component)
        causes.push({ kind: 'unseeded-cycle', members: component.members, path })
      }
      if (component?.unseededDomains.size) {
        let emitted = emittedDomainCycles.get(component)
        if (!emitted) emittedDomainCycles.set(component, (emitted = new Set()))
        for (const domain of component.unseededDomains) {
          if (emitted.has(domain)) continue
          emitted.add(domain)
          causes.push({ kind: 'unseeded-cycle', domain, members: component.members, unmet: component.unmet, path })
        }
      }
      for (const dependency of node.dependencies) {
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
   * reads only `expand`ed nodes, which never change, so when it runs cannot
   * change what it returns. In `grounding-domains` mode the legacy aggregate
   * flag is the domain set's emptiness, exactly as the component loop used to
   * record it; in the other modes it stays the seed witness that loop computes.
   *
   * A plain object, not one with accessors. Deferring these two fields behind
   * getters was tried and cost 4.7% of a whole compile in this one function:
   * a result is built for every top-level query, a solver is built per query,
   * and an object literal carrying accessors is far more expensive to create
   * than one carrying values. The walk itself is memoized and answers the
   * no-grounding case without allocating, which is the cheap half anyway.
   */
  const publish = (
    root: K,
    known: { readonly status: 'complete' | 'refused'; readonly grounded: boolean }
  ): DependencyComponentResult<K, R> => {
    const groundedDomains = groundingDomainsFrom(root)
    return {
      status: known.status,
      grounded: mode === 'grounding-domains' ? groundedDomains.size > 0 : known.grounded,
      groundedDomains,
      explain: () => explainFrom(root)
    }
  }

  return (root) => {
    const known = results.get(root)
    if (known !== undefined) return publish(root, known)

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
      for (const dependency of nodeOf(key).dependencies) {
        if (results.has(dependency)) continue
        const seen = indices.get(dependency)
        if (seen === undefined) {
          visit(dependency)
          const reached = low.get(dependency)!
          if (reached < lowest) lowest = reached
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
        const node = nodeOf(current)
        complete &&= node.locallyComplete
        grounded ||= node.seed === true
        for (const dependency of node.dependencies) {
          if (memberSet === null ? dependency === key : memberSet.has(dependency)) {
            cyclic = true
            continue
          }
          const dependencyResult = results.get(dependency)
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
          for (const domain of nodeOf(current).groundingRequirements ?? []) {
            if (groundedForNode.has(domain)) continue
            unseededDomains.add(domain)
            unmet.push(current)
          }
        }
        if (unseededDomains.size > 0) complete = false
      }
      const component: Component<K> = { members, unseededCycle, unseededDomains, unmet }
      for (const current of members) {
        componentOf.set(current, component)
        results.set(current, { status: complete ? 'complete' : 'refused', grounded })
      }
    }

    visit(root)
    return publish(root, results.get(root)!)
  }
}

/** A node whose fact set is transferred monotonically from discovered dependencies. */
export type DependencyFactRead<K, V> = (dependency: K) => ReadonlySet<V>

/** A discovery edge whose facts are visible but whose completeness is not required. */
export type DependencyFactObserve<K, V> = (dependency: K) => ReadonlySet<V>

/**
 * The reverse of `read`/`observe`: given a fact VALUE, the keys of every node
 * that holds it so far. `read`/`observe` name the dependency up front; this is
 * for the shape where the dependency is not knowable up front -- "which of an
 * unbounded candidate set holds this" -- which a per-key whole-program scan
 * inside a transfer is the usual symptom of. `unknownReadsOf` in
 * `source-value-session.ts` used to `observe` all 968 of the three.js app's
 * computed-key reads from every one of 570 containers, to ask a question that
 * does not depend on the key: whether the read's RECEIVER can be this
 * container. Asked in reverse, each container asks once, "who holds me",
 * instead of 570 containers each asking the same 968 receivers.
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
 * Only finds nodes that already EXIST and have already transferred at least
 * once. A candidate nothing else in the program ever depends on is never
 * created and never runs, so its facts never reach here -- the caller must
 * materialise every candidate explicitly (`DependencyFactSolver.seed`) rather
 * than relying on this call to do it, the way the 968 `observe` calls it
 * replaces used to as a side effect of `read`/`observe`'s own `stateOf`.
 */
export type DependencyFactHoldersOf<K, V> = (fact: V) => Iterable<K>

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
   * copy (a copy per edge read was quadratic and unfinishable on three's
   * WebGLRenderer; a copy per node doubled the three.js app's peak memory into a 4 GB
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
    holdersOf: DependencyFactHoldersOf<K, V>
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
    holdersOf: DependencyFactHoldersOf<K, V>
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
 * copy is a whole duplicate dependency graph. The three.js app's was ~115,000 nodes per
 * solve and three solves deep when the heap ran out.
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
   * that builds a fixed candidate list up front (the three.js app's 968 computed-key
   * receivers) used to force each candidate into existence as a SIDE EFFECT
   * of subscribing to it with `observe`; inverting the question removes the
   * subscription but does not remove the need for the candidate to exist and
   * have run at least once. This is that need, named: create-and-schedule
   * with no subscriber, so `seed`ing a whole candidate list costs one
   * scheduling operation per candidate and stores zero edges, instead of one
   * stored edge per (candidate, asker) pair.
   */
  readonly seed: (key: K) => void
}

export const dependencyFactSolver = <K, V, R>(
  expand: (key: K) => DependencyFactDefinition<K, V, R>,
  mode: DependencyComponentMode
): DependencyFactSolver<K, V, R> => {
  interface State {
    /**
     * Carried on the state so `dependents` and the propagation queue (below)
     * can hold States directly instead of keys. Both used to hold `K`, and
     * every drain re-resolved `states.get(key)` per edge fire -- on
     * the three.js app's 14.7M observe edges, a Map lookup the caller already had the
     * answer to, since the State is in hand at both the point an edge is
     * created (`factsFrom`'s `dependencyState`) and the point it fires
     * (`propagate`'s queue). Added here, in the literal, so the shape is
     * still minted once.
     */
    readonly key: K
    readonly definition: DependencyFactDefinition<K, V, R>
    /**
     * Every scheduled edge, holding the dependency's STATE and not just its
     * key. A transfer re-reads the same edges on every re-evaluation, so
     * resolving the key through the global state map each time was a lookup
     * per edge read across the whole solve -- the single largest self-time
     * entry in the three.js app's profile. The owner already has to touch this map to
     * know the edge exists; carrying the state in it makes the repeat read
     * free.
     */
    readonly observedDependencies: Map<K, State>
    /** Edges whose completeness contributes to the published answer. */
    readonly requiredDependencies: Set<K>
    readonly facts: Set<V>
    /**
     * Dependents, held as States for the same reason `key` is above:
     * `propagate` fires an edge by re-enqueuing its owner, and it already
     * holds that owner's State from the moment the edge was recorded.
     */
    readonly dependents: Set<State>
    /**
     * This node's own edge readers. They close over the node and nothing else,
     * so they are minted with it -- once, and IN the object literal: attaching
     * them afterwards transitions the shape of the one object every transfer
     * and every edge read touches, which costs more than the allocations it
     * saves.
     */
    read: DependencyFactRead<K, V>
    observe: DependencyFactObserve<K, V>
    /**
     * Same reason as `read`/`observe` above, for the same failure mode: this
     * was tried as a method attached to `State` after construction, and it
     * transitioned the hidden class of the one object every transfer and
     * every edge read touches -- the exact defect that regressed a run from
     * 18.3s to 35s the first time it happened here. Minted in the literal
     * even though most states never call it.
     */
    holdersOf: DependencyFactHoldersOf<K, V>
  }

  const states = new Map<K, State>()
  // States, not keys: `propagate` used to hold keys and call `stateOf(key)`
  // on every drain, a Map lookup per edge fire across the three.js app's 14.7M
  // observe edges. The State is already in hand wherever an edge fires or is
  // created, so the queue (and `dependents`, on State above) carry it
  // directly and dedupe on State identity, which is 1:1 with key identity
  // because `states` is the only minter.
  const queue: State[] = []
  const queued = new Set<State>()
  let dependencyRevision = 0

  // Every reason a node's TRANSFER must run again is a reason its SEAL must run
  // again: the seal is the same transfer with `sealing` set, so it reads the
  // same dependencies and answers differently only when they do. `queue` is
  // drained by `propagate`; this set outlives it, because a seal pass happens
  // after the drain and needs to know what the drain touched.
  const sealDirty = new Set<K>()
  const enqueue = (state: State): void => {
    sealDirty.add(state.key)
    if (queued.has(state)) return
    queued.add(state)
    queue.push(state)
  }

  const stateOf = (key: K): State => {
    let state = states.get(key)
    if (state === undefined) {
      const built: State = {
        key,
        definition: expand(key),
        observedDependencies: new Map(),
        requiredDependencies: new Set(),
        facts: new Set(),
        dependents: new Set(),
        read: (dependency) => readFrom(built, dependency),
        observe: (dependency) => observeFrom(built, dependency),
        holdersOf: (fact) => holdersOfFrom(built, fact)
      }
      state = built
      states.set(key, state)
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
    stateOf(key)
  }

  // The reverse of `observedDependencies`/`dependents`: every state that has
  // published a given fact VALUE, and every state that has ever asked
  // `holdersOf` about it. Global across every query kind on purpose -- a fact
  // is a fact regardless of which kind of node published it, and the size
  // this costs is bounded by facts actually published (three.js app: ~205,000
  // (state, fact) pairs total), not by how many candidates asked about them
  // (the 456,000 edges this primitive exists to avoid storing).
  const holders = new Map<V, Set<State>>()
  const valueSubscribers = new Map<V, Set<State>>()
  const NO_HOLDERS: readonly K[] = []
  const holdersOfFrom = (ownerState: State, fact: V): Iterable<K> => {
    let subscribers = valueSubscribers.get(fact)
    if (subscribers === undefined) valueSubscribers.set(fact, (subscribers = new Set()))
    // Idempotent by construction (a Set), so re-asking on every re-evaluation
    // of the same node costs a lookup and nothing else -- no revision to bump,
    // no queue entry to make, because registering the subscription changes
    // nothing about what THIS transfer already computed with the holders it
    // just read below. It only matters for facts published AFTER this call,
    // which `propagate` below wakes through this same set.
    subscribers.add(ownerState)
    const holding = holders.get(fact)
    if (holding === undefined) return NO_HOLDERS
    const found: K[] = []
    for (const holder of holding) found.push(holder.key)
    return found
  }

  // The owner's state is handed in rather than looked up: every transfer and
  // every seal reads its dependencies through this, so a map lookup per edge
  // for a state the caller is already holding was, on the three.js app, a quarter of
  // the whole compile.
  const factsFrom = (ownerState: State, dependency: K, required: boolean): ReadonlySet<V> => {
    let dependencyState = ownerState.observedDependencies.get(dependency)
    let changed = false
    if (dependencyState === undefined) {
      dependencyState = stateOf(dependency)
      ownerState.observedDependencies.set(dependency, dependencyState)
      dependencyState.dependents.add(ownerState)
      dependencyRevision++
      changed = true
    }
    if (required && !ownerState.requiredDependencies.has(dependency)) {
      ownerState.requiredDependencies.add(dependency)
      dependencyRevision++
      changed = true
    }
    // A new observation may expose facts on the next pass. An upgrade also
    // invalidates the current seal even though the fact edge already existed.
    if (changed) enqueue(ownerState)
    // The fact set is handed over as `ReadonlySet`, not as a copy. Copying per
    // edge read was quadratic and made three's WebGLRenderer unfinishable;
    // copying per (node, size) fixed the time and doubled the memory, which is
    // what put the three.js app's third solve into a 4 GB OOM. Neither is necessary:
    // `propagate` adds a node's facts only AFTER its transfer has returned --
    // `evaluate` builds its result eagerly and hands back a set of its own --
    // so no reader is ever iterating a set that is being written.
    return dependencyState.facts
  }

  const readFrom = (ownerState: State, dependency: K): ReadonlySet<V> => factsFrom(ownerState, dependency, true)
  const observeFrom = (ownerState: State, dependency: K): ReadonlySet<V> => factsFrom(ownerState, dependency, false)

  const propagate = (): void => {
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const state = queue[cursor]!
      queued.delete(state)
      counts.transfers++
      if (countsEnabled && counts.transfers % 200000 === 0) report()
      for (const fact of state.definition.transfer(state.read, state.observe, state.holdersOf)) {
        if (state.facts.has(fact)) continue
        state.facts.add(fact)
        // This state is now a holder of `fact` -- recorded at the exact point
        // a fact is genuinely NEW, same as `state.facts.add` beside it, so
        // `holders` never grows for a re-observed fact.
        let holding = holders.get(fact)
        if (holding === undefined) holders.set(fact, (holding = new Set()))
        holding.add(state)
        for (const dependent of state.dependents) enqueue(dependent)
        // A node that asked `holdersOf(fact)` before this state held it named
        // no `K` to depend on -- there was nothing to name -- so an ordinary
        // dependent edge cannot wake it. This is the other half of that
        // subscription: without it, a container whose holder shows up only
        // after `unknown-reads` first ran would publish an incomplete answer
        // forever and never be asked again, which is the silently-wrong
        // result SEMANTIC-AUTHORITY ranks below a slow one.
        const subscribers = valueSubscribers.get(fact)
        if (subscribers !== undefined) for (const subscriber of subscribers) enqueue(subscriber)
      }
    }
    queue.length = 0
  }

  // Seals survive between roots. A solved node whose facts and dependencies
  // have not moved seals to the same answer, and re-deriving it is the cost
  // that made this solver quadratic in (top-level queries x nodes discovered):
  // every query re-sealed the whole graph it had explored so far, so the last
  // query of a large program paid for all of it. Only what `enqueue` marked is
  // re-sealed, which is exactly what could have changed.
  const sealed = new Map<K, ReturnType<DependencyFactDefinition<K, V, R>['seal']>>()
  // `sealRevision` invalidates the hoisted component-solve memo below, so
  // bumping it on a re-seal that reproduces the same answer throws that memo
  // away and forces a full component rebuild for nothing -- on the three.js app every
  // seal was doing exactly that. The grounding fields compare soundly by
  // value: `DependencyGroundingDomain` is `string | symbol`, and a grounding
  // edge's `dependency` is a `K`, which this solver's own contract already
  // requires to have stable identity. `causes` is `R`, a type this solver
  // never gives an equality contract to -- source-value-session's `Cause` is
  // a fresh `{reason, node}` object literal built on every seal call, so
  // `===` per element is the only sound comparison available here. That
  // reports "changed" for a content-identical-but-freshly-allocated cause
  // list, which only over-invalidates (safe, never wrong); the common case --
  // a node that resolves, whose `causes` is `[]` on every seal -- still
  // compares equal by length alone, which is where the savings are.
  const domainsEqual = (a: readonly DependencyGroundingDomain[], b: readonly DependencyGroundingDomain[]): boolean =>
    a.length === b.length && a.every((domain, index) => domain === b[index])
  const groundingEdgesEqual = (
    a: readonly { readonly domain: DependencyGroundingDomain; readonly dependency: K }[],
    b: readonly { readonly domain: DependencyGroundingDomain; readonly dependency: K }[]
  ): boolean =>
    a.length === b.length && a.every((edge, index) => edge.domain === b[index]!.domain && edge.dependency === b[index]!.dependency)
  const causesEqual = (a: readonly R[], b: readonly R[]): boolean => a.length === b.length && a.every((cause, index) => cause === b[index])
  const sealChanged = (
    previous: ReturnType<DependencyFactDefinition<K, V, R>['seal']> | undefined,
    next: ReturnType<DependencyFactDefinition<K, V, R>['seal']>
  ): boolean =>
    previous === undefined ||
    previous.locallyComplete !== next.locallyComplete ||
    previous.seed !== next.seed ||
    !causesEqual(previous.causes ?? [], next.causes ?? []) ||
    !domainsEqual(previous.groundingRequirements ?? [], next.groundingRequirements ?? []) ||
    !domainsEqual(previous.groundingSeeds ?? [], next.groundingSeeds ?? []) ||
    !groundingEdgesEqual(previous.groundingDependencies ?? [], next.groundingDependencies ?? [])
  const counts = { roots: 0, transfers: 0, seals: 0, componentNodes: 0 }
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
    // attributing the three.js app's 14.7M observe edges to a fix means knowing which
    // caller's loop owns them, and the one real caller's key (`Query` in
    // source-value-session.ts) is a `{ kind: ... }` discriminated union. This
    // reflects into that shape defensively, only inside the
    // GEA_SOLVER_SIZES-gated path that prints nothing in production, and
    // falls back to a single 'unknown' bucket for any key not shaped this way.
    const perKind = new Map<string, { states: number; observed: number; required: number; facts: number }>()
    for (const state of states.values()) {
      observed += state.observedDependencies.size
      required += state.requiredDependencies.size
      dependents += state.dependents.size
      facts += state.facts.size
      const kind = (state.key as { readonly kind?: unknown }).kind
      const bucketKey = typeof kind === 'string' ? kind : 'unknown'
      let bucket = perKind.get(bucketKey)
      if (bucket === undefined) perKind.set(bucketKey, (bucket = { states: 0, observed: 0, required: 0, facts: 0 }))
      bucket.states++
      bucket.observed += state.observedDependencies.size
      bucket.required += state.requiredDependencies.size
      bucket.facts += state.facts.size
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
  let sealRevision = 0
  let componentSolve: ((key: K) => DependencyComponentResult<K, R>) | null = null
  let componentDependencyRevision = -1
  let componentSealRevision = -1
  const countsEnabled = process.env['GEA_SOLVER_COUNTS'] !== undefined
  const report = (): void => {
    if (!countsEnabled) return
    console.error(
      `[SOLVER] roots=${counts.roots} states=${states.size} transfers=${counts.transfers} seals=${counts.seals} component-expansions=${counts.componentNodes}${sizes()}`
    )
  }
  if (countsEnabled) process.on('exit', report)

  const NO_DEPENDENCIES: readonly K[] = []
  const solve = (root: K): DependencyFactResult<K, V, R> => {
    counts.roots++
    // Reported as it goes, not only at exit: a run that has to be killed to be
    // observed reports nothing, which is how a 20-minute compile stayed
    // unattributed for two profiling attempts.
    stateOf(root)

    // Sealing may itself discover a dependency. In that case its transfer and
    // every affected dependent must run again before any status is published.
    while (true) {
      propagate()
      const revisionBeforeSeal = dependencyRevision
      const dirty = [...sealDirty]
      sealDirty.clear()
      for (const key of dirty) {
        const state = states.get(key)
        if (state === undefined) continue
        counts.seals++
        if (countsEnabled && counts.seals % 200000 === 0) report()
        const next = state.definition.seal(state.read, state.observe, state.holdersOf)
        if (sealChanged(sealed.get(key), next)) sealRevision++
        sealed.set(key, next)
      }
      if (queue.length === 0 && sealDirty.size === 0 && dependencyRevision === revisionBeforeSeal) break
    }

    // The component solve reads the SEALED graph, so its answer stands for
    // exactly as long as no node's seal and no node's dependency set has moved
    // -- and both of those are counted. Built inside this per-root call it was
    // thrown away and rebuilt for every root, taking its `results`, `nodes` and
    // `componentOf` caches with it: on the three.js app the graph stopped growing at the
    // eighth root and the next twenty-two thousand each re-expanded ~470 nodes
    // of it, 10.4M expansions of an answer that had not changed. Rebuilding on
    // a revision rather than on every call is the same walk, done once per
    // change instead of once per question.
    if (componentSolve === null || componentDependencyRevision !== dependencyRevision || componentSealRevision !== sealRevision) {
      componentSolve = dependencyComponentSolver<K, R>((key) => {
        counts.componentNodes++
        if (countsEnabled && counts.componentNodes % 200000 === 0) report()
        const state = states.get(key)
        const local = sealed.get(key)
        if (state === undefined || local === undefined) throw new Error('unsealed dependency fact node')
        return { ...local, dependencies: [...state.requiredDependencies] }
      }, mode)
      componentDependencyRevision = dependencyRevision
      componentSealRevision = sealRevision
    }
    const result = componentSolve(root)
    if (result.status === 'complete')
      return {
        status: 'complete',
        grounded: result.grounded,
        groundedDomains: result.groundedDomains,
        facts: new Set(stateOf(root).facts),
        explain: result.explain
      }
    return {
      status: 'refused',
      grounded: result.grounded,
      groundedDomains: result.groundedDomains,
      explain: result.explain
    }
  }

  return { solve, requiredDependenciesOf: (key) => states.get(key)?.requiredDependencies ?? NO_DEPENDENCIES, seed }
}
