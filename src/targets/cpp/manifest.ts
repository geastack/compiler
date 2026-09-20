import { objectTagExpression, objectTagCapability } from './emit-object-tag.js'
import type { SealedRepresentationPlan } from '../../representation/plan.js'
import type { Representation } from '../../representation/model.js'
import { representationKey } from '../../representation/model.js'
import type { TargetRuntimeManifest } from '../../preflight/obligations.js'
import { cppTypeOf } from './types.js'
import { presenceIsAnswerable } from './emit-presence.js'
import { typeofIsAnswerable } from './emit-typeof.js'
import type { CppRuntimeCapabilities } from './manifest/capabilities.js'
import { currentCppRuntimeCapabilities } from './manifest/capabilities.js'
import type { HostMemberTable } from './host/host-members.js'
import { coreHostMembers } from './host/host-members.js'
import { cppNativeProtocolsOf } from './host/native-protocols.js'
import { cppInstanceofLeftKinds } from './emit-instanceof.js'

/**
 * What the C++ backend can actually do, stated as a manifest preflight censuses
 * against.
 *
 * The manifest is computed, not declared. A hand-written list of capabilities
 * drifts from the emitter the moment either changes, and a manifest that claims
 * more than the emitter implements turns a preflight pass into a crash during
 * rendering -- which is precisely the failure preflight exists to prevent.
 *
 * So the physical-type rows are derived by asking the one authoritative type
 * mapping whether it can spell each carrier the plan actually selected. Every
 * other row reports what the emitter has been written to render, and the sets
 * are small on purpose: reporting empty where nothing is built is the honest
 * answer, and it makes each gap measurable instead of invisible.
 */

// Re-exported so `capabilities.ts` stays an implementation detail of this
// module's own contract: every consumer already asks the manifest what the
// backend can do, and a second import path for the same answer is a second
// place for the two to be read out of step.
export type { CppRuntimeCapabilities } from './manifest/capabilities.js'
export { currentCppRuntimeCapabilities } from './manifest/capabilities.js'

/** Whether the one authoritative type mapping can spell this carrier. */
const isSpellable = (representation: Representation): boolean => {
  // `void` is spellable even though it has no storage: a result that occupies
  // nothing still lowers, as an absent slot or a `void` return.
  if (representation.kind === 'void') return true
  try {
    cppTypeOf(representation)
    return true
  } catch {
    // The mapping throws for exactly the carriers it cannot spell. Treating the
    // throw as the answer keeps one authority instead of a second predicate
    // that could disagree with it.
    return false
  }
}

export const createCppTargetManifest = (
  plan: SealedRepresentationPlan,
  capabilities: CppRuntimeCapabilities = currentCppRuntimeCapabilities,
  typeofOperandRepresentations: Iterable<Representation> = [],
  // The host member table this compilation's native-boundary claims are
  // derived from -- defaulted to the core, plugin-independent table so every
  // existing caller (tests included) keeps computing the same answer
  // `capabilities.nativeProtocols` already states, without having to learn
  // about this parameter. `compiler.ts`'s own call passes `coreHostMembers`
  // explicitly, from the one place in that file it is already imported,
  // which is what lets this manifest's claim stay tied to the same table the
  // emitter renders from rather than to a frozen capabilities snapshot taken
  // before any host tables for THIS compilation existed.
  hostMembers: HostMemberTable = coreHostMembers,
  objectTagOperands: Iterable<Representation> = [],
  // The installed hosts' own `[[HasInstance]]` predicates, keyed by the native
  // type the right-hand operand of `instanceof` carries -- see
  // `PluginCapabilities.hostInstanceTests`. A row here is a claim for EVERY
  // left carrier kind, which is what that capability's contract states the
  // spelling must accept; `emit-instanceof.ts`'s `hostInstanceTestText`
  // unwraps an optional or a union first and calls the predicate on each leaf.
  hostInstanceTests: ReadonlyMap<string, string> = new Map()
): TargetRuntimeManifest => {
  const spellable = new Set<string>()
  for (const representation of plan.selected.values()) {
    if (isSpellable(representation)) spellable.add(representationKey(representation))
  }

  // `typeof` is answerable over a complete carrier, not its outer kind. An
  // optional and a tagged union recurse into their payloads and arms, so two
  // values with the same outer kind may have different answers. Keying the
  // claim by kind made one unsupported union withdraw the capability for every
  // other union in the program, including unions this emitter could render.
  // The representation key is the same complete carrier the emitter receives;
  // an unsupported shape remains absent without vetoing an unrelated one.
  const typeofRepresentations = new Set<string>()
  // This is deliberately NOT every selected carrier: a target capability
  // claim is evidence that this particular compilation has an emitted
  // `typeof` over that carrier. Results, constants, and null all arrive here
  // through the same operand resolver in `runtime-helper-key.ts`, so the
  // manifest and obligation census have exactly one set to compare.
  for (const representation of typeofOperandRepresentations) {
    if (typeofIsAnswerable(representation)) typeofRepresentations.add(representationKey(representation))
  }
  const runtimeHelpers = new Set<string>(capabilities.runtimeHelpers)
  for (const key of typeofRepresentations) runtimeHelpers.add(`computation:typeof:${key}`)

  // Tag lookup support is keyed by the complete carrier, including constants
  // that publish no result in the selected representation plan.
  for (const representation of objectTagOperands) {
    if (objectTagExpression(representation, 'value') !== null) runtimeHelpers.add(objectTagCapability(representation))
  }

  // The nullish test is likewise derived from the actual carrier contents.
  const presenceKinds = new Map<string, boolean>()
  for (const representation of plan.selected.values()) {
    const answerable = presenceIsAnswerable(representation)
    presenceKinds.set(representation.kind, (presenceKinds.get(representation.kind) ?? true) && answerable)
  }
  for (const [kind, answerable] of presenceKinds) if (answerable) runtimeHelpers.add(`conversion:is-present:${kind}`)

  for (const native of hostInstanceTests.keys()) {
    for (const left of cppInstanceofLeftKinds) runtimeHelpers.add(`computation:instanceof:${left}:native-record-ref(${native})`)
  }

  return {
    hasGenericCallPath: capabilities.hasGenericCallPath,
    hasDynamicCallPath: capabilities.hasDynamicCallPath,
    // No devirtualization fast path is registered: without one, preflight takes
    // the mandatory generic path, which is a slower answer and not a wrong one.
    functionAbis: new Set(),
    implicitConstructorAbis: new Set(),
    propertyRecipes: capabilities.propertyRecipes,
    captureOwnershipSupport: capabilities.captureOwnershipSupport,
    nativeProtocols: cppNativeProtocolsOf(hostMembers),
    hostMembers: new Set(hostMembers.keys()),
    dynamicArgumentHostParameters: capabilities.dynamicArgumentHostParameters,
    runtimeHelpers,
    unsupportedRuntimeHelpers: capabilities.unsupportedRuntimeHelpers,
    physicalTypes: spellable,
    spellable: isSpellable,
    // A carrier this backend can spell is one it can verify and emit: all three
    // come from the same mapping, so publishing different sets would claim a
    // distinction that does not exist.
    verifierRecipes: spellable,
    emitterRecipes: spellable,
    abruptEdgeHandlers: capabilities.abruptEdgeHandlers
  }
}
