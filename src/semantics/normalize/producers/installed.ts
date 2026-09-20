import type { FamilyProducer } from '../contribution.js'
import type { ProducerContext } from '../producer-context.js'
import { createAllocationProducer } from './allocations.js'
import { createBindingProducer } from './bindings.js'
import { createBoundaryProducer } from './boundary.js'
import { createClassLifecycleProducer } from './class-lifecycle.js'
import { createComputationProducer } from './computations.js'
import { createControlProducer } from './control.js'
import { createDeclarationLifecycleProducer } from './declaration-lifecycle.js'
import { createDestructuringProducer } from './destructuring.js'
import { createDynamicLanguageProducer } from './dynamic-language.js'
import { createElementProducer } from './jsx.js'
import { createInvocationProducer } from './invocations.js'
import { createPropertyProducer } from './properties.js'
import { createProtocolProducer } from './protocol.js'
import { createReferenceProducer } from './references.js'

/**
 * The producers this build installs.
 *
 * A family absent from this list is reported `not-installed` by the census with
 * its complete candidate set, which is the whole point of listing them in one
 * place: the difference between "this family publishes nothing" and "this
 * program contains none of it" stays measurable instead of being inferred from
 * an empty result.
 *
 * Every producer is built from the same context, so they share one ordinal
 * authority. Constructing one with its own counter would let two families mint
 * the same identity for two different operations.
 *
 * A plugin producer for a family the core also installs *replaces* it, and the
 * replacement is total rather than layered. Running both would publish the same
 * operation twice under the same identity; letting the plugin only annotate
 * what the core already decided would mean a library could never see a
 * construct differently, which is exactly what a library that gives it new
 * meaning needs to do.
 */
const coreProducers = (context: ProducerContext): readonly FamilyProducer[] => [
  createReferenceProducer(context),
  createPropertyProducer(context),
  createBindingProducer(context),
  createInvocationProducer(context),
  createAllocationProducer(context),
  createComputationProducer(context),
  createControlProducer(context),
  createProtocolProducer(context),
  createBoundaryProducer(context),
  createClassLifecycleProducer(context),
  createDeclarationLifecycleProducer(context),
  createDestructuringProducer(context),
  createDynamicLanguageProducer(context),
  createElementProducer(context)
]

export const installedProducers =
  (pluginProducers: (context: ProducerContext) => readonly FamilyProducer[]) =>
  (context: ProducerContext): readonly FamilyProducer[] => {
    const contributed = pluginProducers(context)
    const claimed = new Set(contributed.map((producer) => producer.family))
    return [...coreProducers(context).filter((producer) => !claimed.has(producer.family)), ...contributed]
  }
