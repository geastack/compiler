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

const capabilityReachesMaterializer = (capability: ConversionCapability, resolved: ReadonlyMap<ConversionNodeId, boolean>): boolean => {
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
      return resolved.get(capability.node) ?? false
  }
}

/**
 * Least fixed point over "does this node's capability reach a materializer".
 * The relation only ever flips a node from `false` to `true`, so it is
 * monotone and converges in at most `nodes.length` passes.
 */
const resolveMaterializability = (nodes: readonly ConversionNode[]): ReadonlyMap<ConversionNodeId, boolean> => {
  const resolved = new Map<ConversionNodeId, boolean>(nodes.map((node) => [node.id, false]))
  let changed = true
  while (changed) {
    changed = false
    for (const node of nodes) {
      if (resolved.get(node.id)) continue
      if (capabilityReachesMaterializer(node.capability, resolved)) {
        resolved.set(node.id, true)
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
 */
export const validateConversionGraph = (nodes: readonly ConversionNode[]): void => {
  const nodeIds = new Set(nodes.map((node) => node.id))
  for (const node of nodes) validateCapability(node.capability, nodeIds, node.id)

  const resolved = resolveMaterializability(nodes)
  for (const node of nodes) {
    for (const ref of collectRecursiveRefs(node.capability)) {
      if (!resolved.get(ref)) {
        throw new Error(`conversion node "${node.id}": recursive reference to "${ref}" never reaches a materializer (unclosed cycle)`)
      }
    }
  }
}
