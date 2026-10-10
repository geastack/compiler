import {
  conversionNeedsPriorSourceGuard,
  isMaterializable,
  transfersNativeStorage,
  type ConversionCapability,
  type ConversionNode,
  type ConversionNodeResolver
} from './algebra.js'

/** The cited nodes reachable from a sealed recipe; this walk never mints a conversion pair. */
export const recipeClosureOf = (roots: Iterable<ConversionNode>, resolve?: ConversionNodeResolver): ReadonlyMap<string, ConversionNode> => {
  const nodes = new Map<string, ConversionNode>()
  const capabilities = new Set<ConversionCapability>()
  const visitCapability = (capability: ConversionCapability): void => {
    if (capabilities.has(capability)) return
    capabilities.add(capability)
    if ('materializer' in capability) {
      const materializer = capability.materializer
      for (const dependency of materializer.dependencies ?? []) visit(dependency)
      for (const leaf of materializer.recordView?.leaves.values() ?? []) visit(leaf)
      for (const leaf of materializer.iteratorObjectView?.leaves.values() ?? []) visit(leaf)
      for (const leaf of materializer.iterableObjectView?.leaves.values() ?? []) visit(leaf)
      for (const leaf of materializer.protocolIterator?.leaves.values() ?? []) visit(leaf)
      for (const field of materializer.recordToArray?.fields ?? []) visit(field.conversion)
    }
    switch (capability.kind) {
      case 'optional':
        visitCapability(capability.payload)
        return
      case 'product':
        for (const field of capability.fields) visitCapability(field.capability)
        return
      case 'sum':
        for (const arm of capability.arms) visitCapability(arm.capability)
        return
      case 'collection':
        visitCapability(capability.element)
        return
      case 'recursive-ref': {
        const cited = resolve?.(capability.node)
        if (cited !== undefined && cited !== null) visit(cited)
      }
    }
  }
  const visit = (node: ConversionNode): void => {
    const known = nodes.get(node.id)
    if (known !== undefined) {
      if (known !== node) throw new Error(`conversion ${node.id} has conflicting recipe citations`)
      return
    }
    nodes.set(node.id, node)
    visitCapability(node.capability)
  }
  for (const node of roots) visit(node)
  return nodes
}

/** A future value has no control-flow proof from the operation that created its adapter. */
export const recipeIsMaterializableWithoutPriorSourceGuard = (node: ConversionNode, resolve?: ConversionNodeResolver): boolean =>
  [...recipeClosureOf([node], resolve).values()].every(
    (child) =>
      (resolve === undefined || resolve(child.id) === child) &&
      isMaterializable(child.capability) &&
      !conversionNeedsPriorSourceGuard(child.capability, resolve)
  )

/** A dead-arm throw remains renderable, but cannot carry a live stored value.
 * Composite capabilities and exact cited dependencies retain the same rule.
 */
export const recipeHasNormalResult = (node: ConversionNode, resolve?: ConversionNodeResolver): boolean => {
  const normal = (capability: ConversionCapability): boolean => {
    if (capability.kind === 'never' || ('materializer' in capability && capability.materializer.normalCompletion === 'never')) return false
    if ('materializer' in capability && capability.materializer.dependencies?.some((child) => !normal(child.capability))) return false
    switch (capability.kind) {
      case 'optional':
        return normal(capability.payload)
      case 'product':
        return capability.fields.every((field) => normal(field.capability))
      case 'sum':
        return capability.arms.some((arm) => normal(arm.capability))
      case 'collection':
        return normal(capability.element)
      case 'recursive-ref':
        return resolve?.(capability.node) != null
      default:
        return true
    }
  }
  return (
    [...recipeClosureOf([node], resolve).values()].every((child) => resolve === undefined || resolve(child.id) === child) &&
    normal(node.capability)
  )
}

/** Native storage is not permission to coerce or discard the source payload.
 * Only the selected recipe's own payload/identity contract can prove that
 * actual writers inhabit one physical slot without changing their JS value.
 */
export const recipePreservesNativePayload = (node: ConversionNode, resolve?: ConversionNodeResolver): boolean => {
  const normal = (capability: ConversionCapability): boolean => {
    if (capability.kind === 'never' || ('materializer' in capability && capability.materializer.normalCompletion === 'never')) return false
    if (capability.kind === 'sum') return capability.arms.some((arm) => normal(arm.capability))
    return true
  }
  const preserved = (capability: ConversionCapability): boolean => {
    if (!normal(capability)) return false
    if (capability.kind === 'sum') {
      const live = capability.arms.filter((arm) => normal(arm.capability))
      return live.length > 0 && live.every((arm) => preserved(arm.capability))
    }
    if (!transfersNativeStorage(capability)) return false
    if ('materializer' in capability) {
      const materializer = capability.materializer
      if (
        materializer.nativePayloadTransport !== 'preserved' &&
        materializer.callableIdentityTransport !== 'preserved' &&
        materializer.nativeFieldViewProtocol !== 'live'
      )
        return false
      if (materializer.dependencies?.some((child) => !preserved(child.capability))) return false
    }
    switch (capability.kind) {
      case 'optional':
        return preserved(capability.payload)
      case 'product':
        return capability.fields.every((field) => preserved(field.capability))
      case 'collection':
        return capability.domain.preservesIdentity && preserved(capability.element)
      default:
        return true
    }
  }
  return (
    [...recipeClosureOf([node], resolve).values()].every((child) => resolve === undefined || resolve(child.id) === child) &&
    preserved(node.capability)
  )
}
