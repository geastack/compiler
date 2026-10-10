import type { DeclarationId, FunctionId, IrValueId } from '../identity/ids.js'
import type { BindingPlacement } from '../projection/bindings.js'
import { representationKey, type Representation } from '../representation/model.js'
import type { IrBody } from './model.js'
import { stringConstantsOf } from './dead-values.js'

export const callableMemberSlot = (receiver: Representation, key: string): string => JSON.stringify([representationKey(receiver), key])

/**
 * The slot's second distinct candidate, kept in the same map so every consumer
 * of the candidates (the borrowable-body proof walks its values) sees it too.
 * `const ByteUtils = hasGlobalBuffer ? nodeByteUtils : webByteUtils` gives
 * every member two implementations behind one carrier; guarding only the
 * first-stored one (the web variant) missed on every call under Node and fell
 * to the owning `invoke`, copying each key string and buffer handle.
 */
export const callableMemberAlternateSlot = (slot: string): string => `${slot}#alternate`

/** A candidate for a guarded call, never a proof that a field is immutable.
 * The runtime compares the actual thunk before taking the direct path. A
 * different instance, later assignment, accessor, or alias therefore needs no
 * exclusion census: a mismatch executes the original callable unchanged. */
export const callableMemberCandidatesOf = (
  bodies: readonly IrBody[],
  directBindings: ReadonlyMap<DeclarationId, FunctionId>,
  placements: ReadonlyMap<DeclarationId, BindingPlacement>
): ReadonlyMap<string, FunctionId> => {
  const candidates = new Map<string, FunctionId>()
  const receiverReps = new Map<string, Representation>()
  for (const body of bodies) {
    const keys = stringConstantsOf(body)
    const functions = new Map<IrValueId, FunctionId>()
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) {
        if (operation.kind === 'allocate-callable') functions.set(operation.result.id, operation.functionId)
        if (operation.kind === 'binding-read') {
          const target = directBindings.get(operation.declaration)
          if (target !== undefined) functions.set(operation.result.id, target)
        }
      }
    }
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) {
        if (operation.kind !== 'set' && operation.kind !== 'define-own-property') continue
        const key = keys.get(operation.key.value)
        const target = functions.get(operation.value.value)
        if (key === undefined || target === undefined) continue
        const slot = callableMemberSlot(operation.receiver.representation, key)
        receiverReps.set(representationKey(operation.receiver.representation), operation.receiver.representation)
        addCandidate(candidates, slot, target)
      }
    }
  }
  // A record handed where another record shape is declared is a view: its callable members are the source's own callables, copied
  // (`emit-record-view.ts`). `ByteUtils = hasGlobalBuffer ? nodeByteUtils : webByteUtils` only ever allocates the web
  // literal at the declared shape, so under Node every member the program calls was a guard that always missed. The source's
  // candidates are the target's too: whichever literal a view came from, the callable it holds is one of the two. Shapes, not
  // representation keys, relate the two sides: the cell that holds the view and the literal that was allocated need not spell
  // one ownership.
  const views = new Map<string, Set<string>>()
  const noteView = (from: Representation, to: Representation): void => {
    const targets = recordArmsOf(to)
    for (const source of recordArmsOf(from)) {
      for (const target of targets) {
        if (source.shapeId === target.shapeId) continue
        const into = views.get(source.shapeId) ?? new Set<string>()
        into.add(target.shapeId)
        views.set(source.shapeId, into)
      }
    }
  }
  for (const body of bodies)
    for (const block of body.blocks.values())
      for (const operation of block.operations) {
        if (operation.kind === 'convert') noteView(operation.source.representation, operation.result.representation)
        else if (operation.kind === 'binding-write') {
          const held = placements.get(operation.declaration)?.representation
          if (held !== undefined && held !== null) noteView(operation.value.representation, held)
        }
      }
  if (views.size > 0) {
    const members = new Map<string, { readonly rep: Representation; readonly key: string; readonly callable: FunctionId }[]>()
    for (const [slot, callable] of candidates) {
      const parsed = JSON.parse(slot.endsWith(alternateSuffix) ? slot.slice(0, -alternateSuffix.length) : slot) as [string, string]
      const rep = receiverReps.get(parsed[0])
      if (rep === undefined || (rep.kind !== 'record' && rep.kind !== 'native-record-ref')) continue
      const list = members.get(rep.shapeId) ?? []
      list.push({ rep, key: parsed[1], callable })
      members.set(rep.shapeId, list)
    }
    for (const [sourceShape, targetShapes] of views)
      for (const { key, callable } of members.get(sourceShape) ?? [])
        for (const targetShape of targetShapes)
          for (const { rep, key: targetKey } of members.get(targetShape) ?? []) {
            // Only a slot a call is already guarded on: the source's callable joins the guard that was missing it, and no call
            // site that had none gains one.
            if (targetKey !== key) continue
            addCandidate(candidates, callableMemberSlot(rep, key), callable)
          }
  }
  return candidates
}

const alternateSuffix = '#alternate'

const addCandidate = (candidates: Map<string, FunctionId>, slot: string, target: FunctionId): void => {
  const first = candidates.get(slot)
  if (first === undefined) candidates.set(slot, target)
  else if (first !== target && !candidates.has(callableMemberAlternateSlot(slot))) candidates.set(callableMemberAlternateSlot(slot), target)
}

type RecordRepresentation = Extract<Representation, { readonly kind: 'record' | 'native-record-ref' }>

const recordArmsOf = (representation: Representation): readonly RecordRepresentation[] => {
  if (representation.kind === 'record' || representation.kind === 'native-record-ref') return [representation]
  if (representation.kind === 'optional') return recordArmsOf(representation.payload)
  if (representation.kind === 'tagged-union') return representation.arms.flatMap((arm) => recordArmsOf(arm.value))
  return []
}
