import {
  classifierDomainsOverlap,
  type ClassifierContract,
  type ConversionCapability,
  type ConversionNode,
  type ConversionNodeResolver
} from './algebra.js'
import { recipeIsMaterializableWithoutPriorSourceGuard } from './recipe-closure.js'
import { representationKey, type Representation } from '../representation/model.js'

export type DynamicWrapperPlan =
  | {
      readonly kind: 'optional'
      readonly source: Extract<Representation, { kind: 'dynamic' }>
      readonly target: Extract<Representation, { kind: 'optional' }>
      readonly payload: ConversionNode
    }
  | {
      readonly kind: 'promise'
      readonly source: Extract<Representation, { kind: 'dynamic' }>
      readonly target: Extract<Representation, { kind: 'promise' }>
      readonly payload: ConversionNode
    }
  | {
      readonly kind: 'union'
      readonly source: Extract<Representation, { kind: 'dynamic' }>
      readonly target: Extract<Representation, { kind: 'tagged-union' }>
      readonly arms: readonly {
        readonly index: number
        readonly classifier: ClassifierContract
        readonly conversion: ConversionNode
        /** The arm's payload is a live view of any object holding the arm's
         * required keys, so an object the exact classifier misses -- another
         * layout of the same interface, a Document -- is selected by shape
         * after every exact test, in arm order. */
        readonly byShape?: true
        /** One of several Array arms: a native Array of the arm's own carrier
         * selects it exactly; a dynamic Array is selected by its elements,
         * after every exact test, in arm order (`nativeArrayViewElementsAccept`). */
        readonly byElements?: true
      }[]
    }

/** The installed wrapper owns its selection protocol; every future payload
 * has the exact census reader, independent of the value creating the wrapper.
 */
export const dynamicWrapperPlanOf = (
  source: Representation,
  target: Representation,
  installed: ConversionCapability,
  nodeFor: (source: Representation, target: Representation) => ConversionNode,
  resolve: ConversionNodeResolver
): DynamicWrapperPlan | null => {
  if (source.kind !== 'dynamic' || source.reason === 'untyped-callable') return null
  const read = (value: Representation): ConversionNode | null => {
    const conversion = nodeFor(source, value)
    return recipeIsMaterializableWithoutPriorSourceGuard(conversion, resolve) ? conversion : null
  }
  if (target.kind === 'optional' && installed.kind === 'optional') {
    const payload = read(target.payload)
    return payload === null ? null : { kind: 'optional', source, target, payload }
  }
  if (
    target.kind === 'promise' &&
    (installed.kind === 'atom' || installed.kind === 'static') &&
    installed.materializer.wrapperKind === 'promise-from-dynamic'
  ) {
    const payload = read(target.value)
    return payload === null ? null : { kind: 'promise', source, target, payload }
  }
  if (target.kind !== 'tagged-union' || installed.kind !== 'sum') return null
  const arms: Array<Extract<DynamicWrapperPlan, { kind: 'union' }>['arms'][number]> = []
  // Every Array arm's classifier admits a dynamic Array, so several Array arms
  // always overlap on that one domain; their exact native payloads never do.
  // The dynamic Array is then told apart by its elements at runtime instead.
  const arrayArms = installed.arms.filter((arm) => {
    const index = target.arms.findIndex((value) => value.tag === arm.tag)
    return index >= 0 && arrayViewArm(nodeFor(source, target.arms[index]!.value))
  }).length
  for (const arm of installed.arms) {
    const index = target.arms.findIndex((value) => value.tag === arm.tag)
    if (index < 0 || arms.some((value) => value.index === index)) return null
    const conversion = read(target.arms[index]!.value)
    if (conversion === null) return null
    const classifier =
      conversion.capability.kind === 'atom' && conversion.capability.materializer.nativeArrayView
        ? conversion.capability.classifier
        : arm.classifier
    const byElements = arrayArms > 1 && arrayViewArm(conversion)
    if (arms.some((entry) => !(byElements && entry.byElements) && classifierDomainsOverlap(entry.classifier, classifier))) return null
    const armValue = target.arms[index]!.value
    // A literal-discriminated arm already classifies any object by its own
    // discriminant; only an exact-payload classifier needs the shape fallback.
    const byShape =
      classifier.recordDiscriminator === undefined &&
      conversion.capability.kind === 'static' &&
      conversion.capability.materializer.documentRecordView !== undefined &&
      (armValue.kind === 'record' || armValue.kind === 'record-with-index' || armValue.kind === 'native-record-ref')
    arms.push(
      byShape
        ? { index, classifier, conversion, byShape }
        : byElements
          ? { index, classifier, conversion, byElements }
          : { index, classifier, conversion }
    )
  }
  return arms.length === 0 ? null : { kind: 'union', source, target, arms }
}

const arrayViewArm = (conversion: ConversionNode): boolean =>
  conversion.capability.kind === 'atom' && conversion.capability.materializer.nativeArrayView !== undefined

export const dynamicWrapperDependenciesOf = (plan: DynamicWrapperPlan): readonly ConversionNode[] =>
  plan.kind === 'union' ? plan.arms.map((arm) => arm.conversion) : [plan.payload]

/** A wrapper cannot replace the selected child by an equivalent-looking node
 * or borrow the reader of another destination field.
 */
export const dynamicWrapperPlanMatches = (
  plan: DynamicWrapperPlan,
  source: Representation,
  target: Representation,
  resolve: ConversionNodeResolver
): boolean => {
  if (representationKey(plan.source) !== representationKey(source) || representationKey(plan.target) !== representationKey(target))
    return false
  const matches = (conversion: ConversionNode, value: Representation): boolean =>
    resolve(conversion.id) === conversion &&
    representationKey(conversion.source) === representationKey(source) &&
    representationKey(conversion.target) === representationKey(value)
  return plan.kind === 'union'
    ? plan.arms.every((arm) => {
        const value = plan.target.arms[arm.index]
        return (
          value !== undefined &&
          matches(arm.conversion, value.value) &&
          (!(arm.conversion.capability.kind === 'atom' && arm.conversion.capability.materializer.nativeArrayView) ||
            arm.classifier === arm.conversion.capability.classifier)
        )
      })
    : matches(plan.payload, plan.kind === 'optional' ? plan.target.payload : plan.target.value)
}
