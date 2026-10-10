/** One native entry-storage component, preserving every fresh allocation's identity. */
export interface FreshIndexedStorageComponent<K, V> {
  readonly origins: readonly K[]
  readonly nodes: ReadonlySet<K>
  readonly values: readonly V[]
}

/**
 * Complete dictionary-identity flows and writes from the shared flow inventory.
 * Nodes name storage/source identities, never a type shared by unrelated values.
 * Alias edges must have compatible native index signatures and exact closed
 * frames; an unsupported signature or unaccounted consumer is a blocked node.
 * Non-dictionary alternatives do not enter this identity channel.
 */
export interface FreshIndexedStorageInput<K, V> {
  readonly origins: readonly { readonly node: K; readonly entries: readonly V[] }[]
  readonly aliases: readonly { readonly from: K; readonly to: K }[]
  readonly writes: readonly { readonly node: K; readonly value: V }[]
  /** Every possible incoming dictionary allocation; null means an open/unknown source. */
  readonly inputs: readonly { readonly node: K; readonly origin: K | null }[]
  readonly blocked: readonly K[]
  readonly nodes?: readonly K[]
}

/**
 * Close fresh allocation storage under its actual aliases and entry writes.
 * The adapter joins the returned value identities; this graph makes no type
 * union or admission decision and cannot promote an arbitrary dictionary.
 * @semanticCategory generic-primitive
 */
export const createFreshIndexedStorageAuthority = <K, V>(input: FreshIndexedStorageInput<K, V>) => {
  const parents = new Map<K, K>()
  const add = (node: K): void => {
    if (!parents.has(node)) parents.set(node, node)
  }
  const representativeOf = (node: K): K => {
    add(node)
    let root = node
    const path: K[] = []
    for (;;) {
      const parent = parents.get(root)!
      if (parent === root || Object.is(parent, root)) break
      path.push(root)
      root = parent
    }
    for (const alias of path) parents.set(alias, root)
    return root
  }
  const connect = (left: K, right: K): void => {
    const from = representativeOf(left)
    const into = representativeOf(right)
    if (from !== into && !Object.is(from, into)) parents.set(into, from)
  }
  for (const origin of input.origins) add(origin.node)
  for (const node of input.nodes ?? []) add(node)
  for (const alias of input.aliases) connect(alias.from, alias.to)
  for (const write of input.writes) add(write.node)
  for (const incoming of input.inputs) {
    add(incoming.node)
    if (incoming.origin !== null) connect(incoming.origin, incoming.node)
  }
  for (const node of input.blocked) add(node)

  const fresh = new Set<K>()
  const invalid = new Set<K>()
  for (const origin of input.origins) {
    if (fresh.has(origin.node)) invalid.add(representativeOf(origin.node))
    fresh.add(origin.node)
  }
  for (const incoming of input.inputs)
    if (incoming.origin === null || !fresh.has(incoming.origin)) invalid.add(representativeOf(incoming.node))
  for (const node of input.blocked) invalid.add(representativeOf(node))

  const groups = new Map<K, { readonly origins: K[]; readonly nodes: Set<K>; readonly values: Set<V> }>()
  for (const node of parents.keys()) {
    const root = representativeOf(node)
    let group = groups.get(root)
    if (group === undefined) {
      group = { origins: [], nodes: new Set(), values: new Set() }
      groups.set(root, group)
    }
    group.nodes.add(node)
  }
  for (const origin of input.origins) {
    const group = groups.get(representativeOf(origin.node))!
    group.origins.push(origin.node)
    for (const value of origin.entries) group.values.add(value)
  }
  for (const write of input.writes) groups.get(representativeOf(write.node))!.values.add(write.value)

  const components = new Map<K, FreshIndexedStorageComponent<K, V>>()
  for (const [root, group] of groups) {
    if (invalid.has(root) || group.origins.length === 0) continue
    const component = { origins: group.origins, nodes: group.nodes, values: [...group.values] }
    for (const node of group.nodes) components.set(node, component)
  }
  return { componentOf: (node: K): FreshIndexedStorageComponent<K, V> | null => components.get(node) ?? null }
}
