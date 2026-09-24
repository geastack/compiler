import type { DeclarationId, IrValueId } from '../identity/ids.js'
import type { ClassLayout } from '../projection/classes.js'
import { recordFieldsOfShape } from '../projection/fields.js'
import type { RepresentationDeriver } from '../representation/derive.js'
import type { RecordField, Representation } from '../representation/model.js'
import { representationKey } from '../representation/model.js'
import { stringConstantsOf } from './dead-values.js'
import type { IrBody, IrOperation } from './model.js'

/**
 * Which native objects keep a per-object record of when each own key was
 * created, and which declared keys an instance does not hold until stored.
 *
 * A generated struct lists its declared fields in layout order and treats a
 * required field as present from allocation. ECMA-262 10.1.11.1 lists string
 * keys in CREATION order instead, and a JavaScript object holds a key only
 * once something creates it. The two agree for most objects: a literal that
 * writes every required field in layout order, a class whose fields are all
 * class-field declarations, nothing deleted. They disagree when a literal
 * writes its keys in another order (`const p: P = { b, a }`), leaves a key for
 * later (`const o = {}; o.a = 1`), sets an optional key late, re-adds a
 * deleted key, or a class creates its keys by assignment (`this.lazy = 3` in
 * a method, which JavaScript does not hold before the call).
 *
 * Tracking costs a creation stamp per field and a stamp per store that
 * creates a key, so it is paid only where it can change an answer: the
 * object's key order is OBSERVED (enumerated, reflected, serialized, spread,
 * or boxed in a program that enumerates a dynamic value) and can DIVERGE
 * from its layout, or its presence is observed (`in`, `hasOwn`) and can
 * diverge. Every other struct keeps the layout it had and emits the same C++.
 *
 * A class is decided per family: base and derived structs share one own-key
 * walk (`gea_ownKeyOrders` chains to the base), so they are tracked together.
 */
export interface OwnKeyOrderTracking {
  /** Record shapes whose instances are tracked. */
  readonly records: ReadonlySet<string>
  /** Every class of a tracked family. */
  readonly classes: ReadonlySet<DeclarationId>
  /** Per tracked class, the instance keys no class field declares: created by a store, absent until one runs. */
  readonly lateKeys: ReadonlyMap<DeclarationId, ReadonlySet<string>>
}

export const noOwnKeyOrderTracking: OwnKeyOrderTracking = { records: new Set(), classes: new Set(), lateKeys: new Map() }

/** Whether a receiver's own struct is tracked -- the one question a store or an allocation asks. */
export const tracksOwnKeyOrder = (tracking: OwnKeyOrderTracking, representation: Representation): boolean => {
  switch (representation.kind) {
    case 'record':
    case 'record-with-index':
      return tracking.records.has(representation.shapeId)
    case 'native-record-ref':
      return representation.native === null && tracking.records.has(representation.shapeId)
    case 'class-ref':
      return tracking.classes.has(representation.declaration)
    default:
      return false
  }
}

const recordSurface = (shapeId: string): string => `record:${shapeId}`
const classSurface = (declaration: DeclarationId): string => `class:${declaration}`

/** The `Object`/`Reflect` members that read their arguments' keys: in order, or only whether one is present. */
const keyReadingMembers: ReadonlyMap<string, ReadonlyMap<string, 'order' | 'presence'>> = new Map([
  [
    'ObjectConstructor',
    new Map([
      ['keys', 'order'],
      ['values', 'order'],
      ['entries', 'order'],
      ['getOwnPropertyNames', 'order'],
      ['getOwnPropertySymbols', 'order'],
      ['getOwnPropertyDescriptors', 'order'],
      ['assign', 'order'],
      ['hasOwn', 'presence']
    ])
  ],
  [
    'Reflect',
    new Map([
      ['ownKeys', 'order'],
      ['has', 'presence']
    ])
  ]
])

export const ownKeyOrderTrackingOf = (
  bodies: readonly IrBody[],
  classes: ReadonlyMap<DeclarationId, ClassLayout>,
  deriver: RepresentationDeriver
): OwnKeyOrderTracking => {
  const rootOf = (declaration: DeclarationId): DeclarationId => {
    const seen = new Set<DeclarationId>()
    let cursor = declaration
    for (;;) {
      const base = classes.get(cursor)?.base ?? null
      if (base === null || seen.has(base)) return cursor
      seen.add(cursor)
      cursor = base
    }
  }
  const fieldsOf = (representation: Representation): readonly RecordField[] => {
    if (representation.kind === 'record' || representation.kind === 'record-with-index') return representation.fields
    if (representation.kind === 'native-record-ref' && representation.native === null)
      return recordFieldsOfShape(deriver, representation.shapeId) ?? []
    if (representation.kind === 'class-ref') return recordFieldsOfShape(deriver, representation.shapeId) ?? []
    return []
  }
  // The struct a receiver IS, through the wrappers a value of it can travel in.
  const shallow = (representation: Representation, out: Set<string>): void => {
    switch (representation.kind) {
      case 'optional':
        shallow(representation.payload, out)
        return
      case 'borrowed-ref':
        shallow(representation.referent, out)
        return
      case 'tagged-union':
        for (const arm of representation.arms) shallow(arm.value, out)
        return
      case 'record':
      case 'record-with-index':
        out.add(recordSurface(representation.shapeId))
        return
      case 'native-record-ref':
        if (representation.native === null) out.add(recordSurface(representation.shapeId))
        return
      case 'class-ref':
        out.add(classSurface(rootOf(representation.declaration)))
        return
      default:
        return
    }
  }
  // Everything a walk that follows fields can reach: `JSON.stringify` recurses
  // into every member, and a boxed object hands each member to dynamic code.
  const deep = (representation: Representation, out: Set<string>, seen = new Set<string>()): void => {
    const key = representationKey(representation)
    if (seen.has(key)) return
    seen.add(key)
    shallow(representation, out)
    switch (representation.kind) {
      case 'optional':
        deep(representation.payload, out, seen)
        return
      case 'borrowed-ref':
        deep(representation.referent, out, seen)
        return
      case 'tagged-union':
        for (const arm of representation.arms) deep(arm.value, out, seen)
        return
      case 'array-object':
        deep(representation.element, out, seen)
        return
      case 'dictionary':
        deep(representation.value, out, seen)
        return
      case 'record-with-index':
        for (const index of representation.indexes) deep(index.value, out, seen)
        break
      default:
        break
    }
    for (const field of fieldsOf(representation)) deep(field.value, out, seen)
  }
  const reachesDynamic = (representation: Representation): boolean => {
    if (representation.kind === 'dynamic') return true
    if (representation.kind === 'optional') return reachesDynamic(representation.payload)
    if (representation.kind === 'tagged-union') return representation.arms.some((arm) => reachesDynamic(arm.value))
    return false
  }

  // What a program can observe (an enumeration reads order AND presence;
  // `in` and `hasOwn` read presence alone), and what can make an instance
  // differ from its layout in either.
  const orderRead = new Set<string>()
  const presenceRead = new Set<string>()
  const orderDiverges = new Set<string>()
  const presenceDiverges = new Set<string>()
  // A struct boxed into a dynamic value is observed only by what reads a
  // DYNAMIC value's keys, so it counts once the program has such a read.
  const boxed = new Set<string>()
  let dynamicOrderRead = false
  let dynamicPresenceRead = false
  const read = (representation: Representation, reads: 'order' | 'presence'): void => {
    shallow(representation, reads === 'order' ? orderRead : presenceRead)
    if (!reachesDynamic(representation) && representation.kind !== 'unresolved') return
    if (reads === 'order') dynamicOrderRead = true
    else dynamicPresenceRead = true
  }
  for (const body of bodies) {
    const keys = stringConstantsOf(body)
    const hostMembers = new Map<IrValueId, { readonly protocol: string; readonly member: string }>()
    const operations: IrOperation[] = []
    for (const blockId of body.blockOrder) {
      const block = body.blocks.get(blockId)
      if (block) operations.push(...block.operations, block.terminator)
    }
    for (const operation of operations) {
      if (operation.kind !== 'get') continue
      if (operation.hostMethod !== undefined) {
        hostMembers.set(operation.result.id, operation.hostMethod)
        continue
      }
      const receiver = operation.receiver.representation
      const key = keys.get(operation.key.value)
      if (receiver.kind === 'native-handle' && key !== undefined)
        hostMembers.set(operation.result.id, { protocol: receiver.protocol, member: key })
    }
    for (const operation of operations) {
      switch (operation.kind) {
        case 'own-property-keys':
          read(operation.receiver.representation, 'order')
          break
        case 'has-property':
          read(operation.receiver.representation, 'presence')
          break
        case 'get-iterator':
          if (operation.protocol === 'enumerate') read(operation.receiver.representation, 'order')
          break
        case 'spread-copy':
          read(operation.source.representation, 'order')
          break
        case 'convert':
          if (reachesDynamic(operation.result.representation)) deep(operation.source.representation, boxed)
          break
        // A delete clears the presence bit every struct already has; what it
        // changes beyond that is where a re-added key goes.
        case 'delete':
          shallow(operation.receiver.representation, orderDiverges)
          break
        case 'call': {
          const member = hostMembers.get(operation.callee.value)
          const reads = member === undefined ? undefined : keyReadingMembers.get(member.protocol)?.get(member.member)
          if (operation.intrinsicOwnKeys) {
            const queried = operation.arguments[0]
            if (queried) read(queried.representation, reads ?? 'order')
            break
          }
          if (member === undefined) break
          if (member.protocol === 'JSON' && member.member === 'stringify') {
            const argument = operation.arguments[0]
            if (argument) {
              deep(argument.representation, orderRead)
              read(argument.representation, 'order')
            }
            break
          }
          if (reads !== undefined) for (const argument of operation.arguments) read(argument.representation, reads)
          break
        }
        default:
          break
      }
    }

    // A literal's own definitions: the stores that follow its allocation in
    // the same block and write into the allocation itself. They create its
    // keys, so their order is the object's order and a required key none of
    // them writes is one the object does not hold yet.
    const initializing = new Set<IrOperation>()
    for (const blockId of body.blockOrder) {
      const block = body.blocks.get(blockId)
      if (!block) continue
      block.operations.forEach((operation, position) => {
        if (operation.kind !== 'allocate-record') return
        const surfaces = new Set<string>()
        shallow(operation.result.representation, surfaces)
        const surface = [...surfaces][0]
        if (surfaces.size !== 1 || surface === undefined || !surface.startsWith('record:')) return
        const layout = fieldsOf(operation.result.representation)
        const written = operation.fields.map((field) => field.key)
        let opaque = false
        const aliases = new Set<IrValueId>([operation.result.id])
        for (const later of block.operations.slice(position + 1)) {
          if (later.kind === 'spread-copy' && aliases.has(later.receiver.value)) opaque = true
          if ((later.kind !== 'define-own-property' && later.kind !== 'set') || !aliases.has(later.receiver.value)) continue
          initializing.add(later)
          if (later.result) aliases.add(later.result.id)
          const key = keys.get(later.key.value)
          if (key === undefined) opaque = true
          else written.push(key)
        }
        // A key written twice keeps the position its first write created --
        // what a spread followed by the key it overrides writes.
        const order = new Map(layout.map((field, index) => [field.key, index]))
        const positions = [...new Set(written)].flatMap((key) => {
          const index = order.get(key)
          return index === undefined ? [] : [index]
        })
        const inLayoutOrder = positions.every((index, at) => at === 0 || (positions[at - 1] as number) < index)
        const holdsEveryRequired = layout.every((field) => !field.required || written.includes(field.key))
        if (opaque || !inLayoutOrder) orderDiverges.add(surface)
        if (!holdsEveryRequired) presenceDiverges.add(surface)
      })
    }
    // A later store that can CREATE a record key: an optional field, or any
    // field of a record with one through a key this walk cannot read.
    for (const operation of operations) {
      if ((operation.kind !== 'set' && operation.kind !== 'define-own-property') || initializing.has(operation)) continue
      const receiver = operation.receiver.representation
      const surfaces = new Set<string>()
      shallow(receiver, surfaces)
      const records = [...surfaces].filter((surface) => surface.startsWith('record:'))
      if (records.length === 0) continue
      const key = keys.get(operation.key.value)
      const creates = (fields: readonly RecordField[]): boolean =>
        key === undefined ? fields.some((field) => !field.required) : fields.some((field) => field.key === key && !field.required)
      const arms = receiver.kind === 'tagged-union' ? receiver.arms.map((arm) => arm.value) : [receiver]
      for (const arm of arms) {
        const armSurfaces = new Set<string>()
        shallow(arm, armSurfaces)
        const unwrapped = arm.kind === 'optional' ? arm.payload : arm.kind === 'borrowed-ref' ? arm.referent : arm
        if (creates(fieldsOf(unwrapped))) for (const surface of armSurfaces) if (surface.startsWith('record:')) orderDiverges.add(surface)
      }
    }
  }

  // A JavaScript class creates by assignment every member TypeScript inferred
  // from a `this.x =` store; a class field definition creates its key at
  // construction, in declaration order, which is the layout's order.
  //
  // Except where the constructor itself creates them the way the layout
  // lists them: stores into `this` in the constructor's entry block run on
  // every construction, after the base's constructor and before anything
  // later, so keys they create in the struct's own layout order are exactly
  // the keys present from allocation. Only a key created elsewhere -- later,
  // conditionally, or out of layout order -- is late.
  const bodyOf = new Map<string, IrBody>()
  for (const body of bodies) if (body.abi !== null) bodyOf.set(String(body.sourceOwner), body)
  const constructedKeys = (layout: ClassLayout): ReadonlySet<string> => {
    const body = layout.constructor === null ? undefined : bodyOf.get(String(layout.constructor))
    const entry = body === undefined || body.blockOrder[0] === undefined ? undefined : body.blocks.get(body.blockOrder[0])
    const instance = layout.instance
    if (body === undefined || entry === undefined || instance === null || instance.kind !== 'class-ref') return new Set()
    const keys = stringConstantsOf(body)
    const receivers = new Set<IrValueId>()
    const stored: string[] = []
    for (const operation of entry.operations) {
      if (operation.kind === 'receiver') receivers.add(operation.result.id)
      if (operation.kind !== 'set' || !receivers.has(operation.receiver.value)) continue
      if (operation.result) receivers.add(operation.result.id)
      const key = keys.get(operation.key.value)
      if (key !== undefined && !stored.includes(key)) stored.push(key)
    }
    const own = new Set(layout.fields.map((field) => field.key))
    const assigned = new Set(layout.fields.filter((field) => field.assignedMember === true).map((field) => field.key))
    // The struct's own fields in layout order: declared ones must all come
    // first, then the constructed ones in the order the constructor stores them.
    const ordered = (recordFieldsOfShape(deriver, instance.shapeId) ?? []).map((field) => field.key).filter((key) => own.has(key))
    const constructed = stored.filter((key) => assigned.has(key))
    const expected = [...ordered.filter((key) => !assigned.has(key)), ...constructed]
    const actual = ordered.filter((key) => !assigned.has(key) || constructed.includes(key))
    return expected.length === actual.length && expected.every((key, at) => actual[at] === key) ? new Set(constructed) : new Set()
  }
  const lateKeys = new Map<DeclarationId, ReadonlySet<string>>()
  for (const declaration of classes.keys()) {
    const late = new Set<string>()
    const seen = new Set<DeclarationId>()
    for (let cursor: DeclarationId | null = declaration; cursor !== null && !seen.has(cursor);) {
      seen.add(cursor)
      const layout: ClassLayout | undefined = classes.get(cursor)
      if (layout === undefined) break
      const constructed = constructedKeys(layout)
      for (const field of layout.fields) if (field.assignedMember === true && !constructed.has(field.key)) late.add(field.key)
      cursor = layout.base
    }
    if (late.size === 0) continue
    lateKeys.set(declaration, late)
    presenceDiverges.add(classSurface(rootOf(declaration)))
  }

  for (const surface of boxed) {
    if (dynamicOrderRead) orderRead.add(surface)
    if (dynamicPresenceRead) presenceRead.add(surface)
  }
  const tracked = new Set([
    ...[...orderRead].filter((surface) => orderDiverges.has(surface) || presenceDiverges.has(surface)),
    ...[...presenceRead].filter((surface) => presenceDiverges.has(surface))
  ])
  const records = new Set<string>()
  for (const surface of tracked) if (surface.startsWith('record:')) records.add(surface.slice('record:'.length))
  const trackedClasses = new Set<DeclarationId>()
  for (const declaration of classes.keys()) if (tracked.has(classSurface(rootOf(declaration)))) trackedClasses.add(declaration)
  const trackedLateKeys = new Map([...lateKeys].filter(([declaration]) => trackedClasses.has(declaration)))
  return { records, classes: trackedClasses, lateKeys: trackedLateKeys }
}
