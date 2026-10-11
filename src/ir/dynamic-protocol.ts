import type { DeclarationId, StructuralTypeId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import { abiKey, representationKey, walkRepresentation, type Representation } from '../representation/model.js'
import type { ReflectionExposure } from './reflection-demand.js'

/**
 * The program carriers a box holds with no dynamic protocol at all: no
 * document table and no array table. The runtime builds both for every boxable
 * type unless told otherwise (`gea::detail::dynamicProtocolOmitted`), so this
 * is the one place that says which types nothing reads dynamically. The
 * reflection census is the evidence: a carrier is omitted only when it has a
 * row and the row is below `full`. No row, an incomplete census, or any
 * sharing carrier at `full` keeps the protocol.
 */
export interface DynamicProtocolOmissions {
  readonly classes: ReadonlySet<DeclarationId>
  readonly records: ReadonlySet<StructuralTypeId>
  /** Every array carrier of an omitted element identity. */
  readonly arrays: readonly Representation[]
}

const programRecordShapeOf = (representation: Representation): StructuralTypeId | null => {
  if (representation.kind === 'record' || representation.kind === 'record-with-index') return representation.shapeId as StructuralTypeId
  if (representation.kind === 'native-record-ref' && representation.native === null && representation.recursive === undefined)
    return representation.shapeId as StructuralTypeId
  return null
}

// One physical runtime type per identity: the carriers it groups are every
// carrier that can name the same `ArrayObject<E>`, so one of them read
// dynamically keeps the protocol for all of them. A plain `function` element
// takes the callable identity without ever being eligible -- it shares the
// spelling of the callable families and the census does not row it -- and an
// element with no identity here (a string, a number, a union, `any`) is an
// array the runtime also builds for itself, out of the census's sight.
const arrayElementIdentityOf = (element: Representation): { readonly identity: string; readonly eligible: boolean } | null => {
  switch (element.kind) {
    case 'class-ref':
      return { identity: JSON.stringify(['class', element.declaration]), eligible: true }
    case 'record':
    case 'record-with-index':
    case 'native-record-ref': {
      const shape = programRecordShapeOf(element)
      return shape === null ? null : { identity: JSON.stringify(['record', shape]), eligible: true }
    }
    case 'function':
      return { identity: JSON.stringify(['call', abiKey(element.abi)]), eligible: false }
    case 'function-family':
    case 'function-value-family':
      return { identity: JSON.stringify(['call', abiKey(element.abi)]), eligible: true }
    case 'function-value-dispatch':
      return element.recursive === undefined ? { identity: JSON.stringify(['call', abiKey(element.abi)]), eligible: true } : null
    case 'function-and-constructor':
      return { identity: JSON.stringify(['call-construct', abiKey(element.call), abiKey(element.construct)]), eligible: true }
    default:
      return null
  }
}

export const dynamicProtocolOmissionsOf = (
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  reflection: ReflectionExposure | undefined,
  representations: readonly Representation[]
): DynamicProtocolOmissions | null => {
  if (reflection === undefined || !reflection.complete) return null
  const unread = (representation: Representation): boolean => {
    const demand = reflection.byRepresentation.get(representationKey(representation))
    return demand !== undefined && demand.level !== 'full'
  }

  // A derived class reaches its dynamic protocol through its bases, so every
  // base of a class kept below keeps its own.
  const keptClasses = new Set<DeclarationId>()
  for (const declaration of classes.keys()) {
    const demand = reflection.classes.get(declaration)
    if (demand !== undefined && demand.level !== 'full') continue
    for (let base: DeclarationId | null = declaration; base !== null && !keptClasses.has(base); base = classes.get(base)?.base ?? null)
      keptClasses.add(base)
  }

  const recordRead = new Set<StructuralTypeId>()
  const recordSeen = new Set<StructuralTypeId>()
  const arrays = new Map<string, { readonly members: Representation[]; omitted: boolean }>()
  const seen = new Set<Representation>()
  for (const root of representations)
    for (const representation of walkRepresentation(root, seen)) {
      const shape = programRecordShapeOf(representation)
      if (shape !== null) {
        recordSeen.add(shape)
        if (!unread(representation)) recordRead.add(shape)
        continue
      }
      if (representation.kind !== 'array-object') continue
      const element = representation.recursive === undefined ? arrayElementIdentityOf(representation.element) : null
      if (element === null) continue
      const group = arrays.get(element.identity) ?? { members: [], omitted: true }
      group.members.push(representation)
      if (!element.eligible || !unread(representation)) group.omitted = false
      arrays.set(element.identity, group)
    }
  for (const [shape, demand] of reflection.records) if (demand.level === 'full') recordRead.add(shape)

  return {
    classes: new Set([...classes.keys()].filter((declaration) => !keptClasses.has(declaration))),
    records: new Set([...recordSeen].filter((shape) => !recordRead.has(shape))),
    arrays: [...arrays.values()].flatMap((group) => (group.omitted ? group.members : []))
  }
}
