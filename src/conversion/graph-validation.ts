import type { ConversionCapability, ConversionNode, ConversionNodeId } from './algebra.js'
import { validateCapability } from './algebra.js'

/**
 * Whether a conversion graph's `recursive-ref` sites actually close.
 *
 * `isMaterializable` in algebra.ts treats every `recursive-ref` as trivially
 * materializable, because a single capability in isolation has no other node
 * to consult. That is correct for that question, but it means a set of nodes
 * that only ever refer to each other -- with no node in the cycle ever
 * reaching a real `Atom`, `Identity`, or a `Product`/`Collection`/`Sum` whose
 * every branch bottoms out -- would still read as materializable. This module
 * is the whole-graph check that catches that: it resolves every node's
 * materializability by consulting the nodes its `recursive-ref`s point to, and
 * rejects a reference into a cycle that never reaches a base case.
 */

/** Which nodes are known to reach a materializer, asked by the id a `recursive-ref` names. */
type Resolution = (id: ConversionNodeId) => boolean

const capabilityReachesMaterializer = (capability: ConversionCapability, resolved: Resolution): boolean => {
  switch (capability.kind) {
    case 'never':
      return false
    case 'identity':
    case 'atom':
    case 'coercion':
    case 'static':
    case 'class-family':
      return true
    case 'optional':
      return capabilityReachesMaterializer(capability.payload, resolved)
    case 'product':
      return capability.fields.every((field) => capabilityReachesMaterializer(field.capability, resolved))
    case 'collection':
      return capabilityReachesMaterializer(capability.element, resolved)
    case 'sum':
      return capability.arms.length > 0 && capability.arms.every((arm) => capabilityReachesMaterializer(arm.capability, resolved))
    case 'recursive-ref':
      return resolved(capability.node)
  }
}

/**
 * Least fixed point over "does this node's capability reach a materializer".
 * The relation only ever flips a node from `false` to `true`, so it is
 * monotone and converges in at most `nodes.length` passes.
 *
 * With `nodeOf`, the answers are kept per node object and a reference is
 * resolved through it, so no node's id is ever used as a key: keying a table
 * by every id flattened and internalized each one, which on a large
 * application left a flat copy of a quarter of a million ids alive after this
 * check returned. Without it, the ids themselves are the keys.
 */
const resolveMaterializability = (
  nodes: readonly ConversionNode[],
  nodeOf: ((id: ConversionNodeId) => ConversionNode | undefined) | undefined,
  atoms: Pick<ReadonlySet<ConversionNodeId>, 'has'> | undefined
): Resolution => {
  const resolvedNodes = new Set<ConversionNode>()
  const resolvedIds = new Set<ConversionNodeId>()
  const isResolved = (node: ConversionNode): boolean => (nodeOf ? resolvedNodes.has(node) : resolvedIds.has(node.id))
  const resolved: Resolution = nodeOf
    ? (id) => {
        if (atoms?.has(id)) return true
        const node = nodeOf(id)
        return node !== undefined && resolvedNodes.has(node)
      }
    : (id) => atoms?.has(id) === true || resolvedIds.has(id)
  let changed = true
  while (changed) {
    changed = false
    for (const node of nodes) {
      if (isResolved(node)) continue
      if (capabilityReachesMaterializer(node.capability, resolved)) {
        if (nodeOf) resolvedNodes.add(node)
        else resolvedIds.add(node.id)
        changed = true
      }
    }
  }
  return resolved
}

const collectRecursiveRefs = (capability: ConversionCapability): readonly ConversionNodeId[] => {
  switch (capability.kind) {
    case 'never':
    case 'identity':
    case 'atom':
    case 'coercion':
    case 'static':
    case 'class-family':
      return []
    case 'recursive-ref':
      return [capability.node]
    case 'optional':
      return collectRecursiveRefs(capability.payload)
    case 'product':
      return capability.fields.flatMap((field) => collectRecursiveRefs(field.capability))
    case 'collection':
      return collectRecursiveRefs(capability.element)
    case 'sum':
      return capability.arms.flatMap((arm) => collectRecursiveRefs(arm.capability))
  }
}

/**
 * Validates a whole conversion graph: every node's internal shape via
 * `validateCapability`, plus the one defect a single node can never see on its
 * own -- a `recursive-ref` chain that loops through other nodes forever
 * without ever reaching a materializer.
 *
 * `atoms` names further members of the graph, outside `nodes`, that the
 * caller knows to be plain `atom`s with agreeing domains: each passes
 * `validateCapability` and reaches a materializer by itself, and refers to no
 * other node, so they are members and resolved without being built.
 */
export const validateConversionGraph = (
  nodes: readonly ConversionNode[],
  nodeOf?: (id: ConversionNodeId) => ConversionNode | undefined,
  atoms?: Pick<ReadonlySet<ConversionNodeId>, 'has'>
): void => {
  const known: Pick<ReadonlySet<ConversionNodeId>, 'has'> = nodeOf
    ? { has: (id) => nodeOf(id) !== undefined }
    : new Set(nodes.map((node) => node.id))
  const nodeIds: Pick<ReadonlySet<ConversionNodeId>, 'has'> = atoms ? { has: (id) => known.has(id) || atoms.has(id) } : known
  for (const node of nodes) validateCapability(node.capability, nodeIds, node.id)

  const resolved = resolveMaterializability(nodes, nodeOf, atoms)
  for (const node of nodes) {
    for (const ref of collectRecursiveRefs(node.capability)) {
      if (!resolved(ref)) {
        throw new Error(`conversion node "${node.id}": recursive reference to "${ref}" never reaches a materializer (unclosed cycle)`)
      }
    }
  }
}
