import type { DeclarationId } from '../identity/ids.js'
import type { PhysicalClassLayout } from '../projection/classes.js'
import { representationKey } from '../representation/model.js'
import type { ReflectionDemand, ReflectionExposure, ReflectionFieldOperation } from './reflection-demand.js'

/** A derived field protocol calls and overrides the protocol of its physical
 * base. Type-only layouts participate in that contract even when no class
 * lifecycle survives. Retain ancestor hooks without inventing a publication
 * of their fields' payloads or exposing sibling classes.
 */
export const closePhysicalClassReflection = (
  exposure: ReflectionExposure,
  layouts: ReadonlyMap<DeclarationId, PhysicalClassLayout>
): ReflectionExposure => {
  if (!exposure.complete) return exposure
  const classes = new Map(exposure.classes)
  const byRepresentation = new Map(exposure.byRepresentation)
  const joinSupport = (existing: ReflectionDemand | undefined, demand: ReflectionDemand): ReflectionDemand => {
    const fieldOperations = new Map<string, Set<ReflectionFieldOperation>>()
    const restricted = existing?.fieldOperations !== undefined && demand.fieldOperations !== undefined
    if (restricted)
      for (const source of [existing.fieldOperations!, demand.fieldOperations!])
        for (const [key, uses] of source) {
          const merged = fieldOperations.get(key) ?? new Set<ReflectionFieldOperation>()
          for (const use of uses) merged.add(use)
          fieldOperations.set(key, merged)
        }
    return {
      level: 'full',
      ...(restricted ? { fieldOperations } : {}),
      reasons: new Set([...(existing?.reasons ?? []), ...demand.reasons, 'inherited-physical-protocol']),
      representations: new Set([...(existing?.representations ?? []), ...demand.representations])
    }
  }
  for (const layout of layouts.values()) {
    // Missing demand already means full protocol to every consumer. Publish
    // that fail-closed default explicitly so its ancestors cannot prune it.
    const demand = exposure.classes.get(layout.declaration) ?? {
      level: 'full' as const,
      reasons: new Set(['uncensused-physical-layout']),
      representations: new Set([representationKey(layout.instance)])
    }
    if (demand.level !== 'full') continue
    classes.set(layout.declaration, joinSupport(classes.get(layout.declaration), demand))
    const seen = new Set<DeclarationId>([layout.declaration])
    for (let base = layout.base; base !== null && !seen.has(base);) {
      seen.add(base)
      const ancestor = layouts.get(base)
      if (!ancestor) break // Missing physical ancestry is refused by its publication.
      classes.set(base, joinSupport(classes.get(base), demand))
      base = ancestor.base
    }
  }
  for (const [declaration, demand] of classes) {
    const layout = layouts.get(declaration)
    if (layout) byRepresentation.set(representationKey(layout.instance), demand)
  }
  return { ...exposure, classes, byRepresentation }
}
