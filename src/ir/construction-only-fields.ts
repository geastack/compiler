import type { DeclarationId, FunctionId, IrValueId } from '../identity/ids.js'
import type { Representation } from '../representation/model.js'
import { stringConstantsOf } from './dead-values.js'
import type { ClassConstruction } from './instantiation.js'
import type { IrBlockId, IrBody, IrOperation } from './model.js'
import { operandsOfIrOperation, resultOfIrOperation } from './queries.js'
import type { ReflectionDemand, ReflectionFieldOperation } from './reflection-demand.js'

/**
 * Class fields the program writes only while constructing the object that
 * holds them.
 *
 * `this.socket = stream` in a constructor, read by every method after: once
 * the constructor has returned, the field holds one value for the object's
 * whole life, so a method's `const socket = this.socket` names the same value
 * at every use and needs no copy of its own. The copy was a retain/release
 * pair per read, and reads of `this`'s own fields into temporaries were a
 * twentieth of every retain the mongodb driver made.
 *
 * A write is a construction write when a class's constructor or one of its
 * field initializers (`ClassConstruction`) stores the key on its own
 * receiver. Anything else that can reach the key poisons it for every class
 * the receiver's carrier can be, per hierarchy -- a `Base`-typed store can
 * land on any subclass, and a subclass store on the base's field:
 *
 * - a `set`, `define-own-property` or `delete` of the key outside those
 *   bodies, or on any other receiver inside them;
 * - a computed-key write or a spread copy into the carrier, which could name
 *   any key;
 * - a write through a receiver whose carrier could be any object (dynamic,
 *   unresolved, a host handle, a proxy), which poisons the key everywhere, or
 *   every key when the key is computed too.
 *
 * Reflective writes -- `Reflect.set`, `Object.assign`, a boxed instance's
 * `obj[k] = v` -- never appear as a `set` on the class carrier; the caller
 * answers them from the reflection census (`reflectiveWrites`, per class).
 *
 * A construction write can still interleave with a read in one way: a method
 * the constructor calls reads the field, suspends, and the constructor runs on
 * and writes it. Readers therefore treat a suspension between the read and a
 * use as a write (`targets/cpp`'s alias decision).
 */
export interface ConstructionOnlyFields {
  /** Whether `key` on an object held as `receiver` is written only by that object's construction. */
  readonly holds: (receiver: Representation, key: string) => boolean
  /** The bodies that construct: a read in one of them may precede the write. */
  readonly constructing: ReadonlySet<FunctionId>
  /**
   * Whether `key` on an instance of `declaration` is construction-only AND every
   * construction write stores a value the constructor was handed -- one of its
   * own arguments, or `null`/`undefined`. An argument is evaluated before the
   * object exists, so such a field can only ever point at an OLDER object: no
   * edge through it can close a cycle back to its holder (`records.ts`'s
   * acyclic classes).
   */
  readonly holdsOlder: (declaration: DeclarationId, key: string) => boolean
}

const everyKey = Symbol('every key')

const unkeyableKinds: ReadonlySet<string> = new Set(['dynamic', 'unresolved', 'native-handle', 'proxy-object', 'carrier'])

export const constructionOnlyFieldsOf = (
  bodies: readonly IrBody[],
  classes: ReadonlyMap<DeclarationId, ClassConstruction>,
  reflectiveWrites: Iterable<readonly [DeclarationId, ReadonlySet<string> | 'all']>
): ConstructionOnlyFields => {
  const constructing = new Set<FunctionId>()
  for (const construction of classes.values()) {
    if (construction.constructor !== null) constructing.add(construction.constructor)
    for (const initializer of construction.initializers) constructing.add(initializer)
  }
  const roots = new Map<DeclarationId, DeclarationId>()
  const rootOf = (declaration: DeclarationId): DeclarationId => {
    const known = roots.get(declaration)
    if (known !== undefined) return known
    let current = declaration
    const seen = new Set<DeclarationId>()
    while (!seen.has(current)) {
      seen.add(current)
      const base = classes.get(current)?.base ?? null
      if (base === null) break
      current = base
    }
    roots.set(declaration, current)
    return current
  }
  /** The hierarchies an object held as `representation` can belong to, or `null` when it could be any object. */
  const hierarchiesOf = (representation: Representation, into: Set<DeclarationId>): boolean => {
    if (unkeyableKinds.has(representation.kind)) return false
    if (representation.kind === 'class-ref') {
      // A class over a native object may be held as that object's carrier,
      // which the walk below does not tie back to the class.
      if (representation.nativeBase !== undefined) return false
      for (const declaration of [representation.declaration, ...representation.ancestors]) into.add(rootOf(declaration))
      return true
    }
    if (representation.kind === 'optional') return hierarchiesOf(representation.payload, into)
    if (representation.kind === 'borrowed-ref') return hierarchiesOf(representation.referent, into)
    if (representation.kind === 'tagged-union') return representation.arms.every((arm) => hierarchiesOf(arm.value, into))
    return true
  }

  // Cells every write of which -- in any body -- stores a constructor's own
  // argument: reading one in a constructor reads an argument.
  const argumentCells = new Map<DeclarationId, boolean>()
  for (const body of bodies) {
    const constructs = constructing.has(body.sourceOwner as FunctionId)
    const parameters = new Set<IrValueId>()
    for (const block of body.blocks.values())
      for (const operation of block.operations) if (operation.kind === 'parameter') parameters.add(operation.result.id)
    for (const block of body.blocks.values())
      for (const operation of block.operations)
        if (operation.kind === 'binding-write')
          argumentCells.set(
            operation.declaration,
            (argumentCells.get(operation.declaration) ?? true) && constructs && parameters.has(operation.value.value)
          )
  }
  /** The hierarchy keys some construction write stores anything but an argument or a nullish constant into. */
  const derived = new Map<DeclarationId, Set<string>>()

  const poisoned = new Map<DeclarationId, Set<string | typeof everyKey>>()
  const poisonedEverywhere = new Set<string>()
  let everything = false
  const poison = (hierarchy: DeclarationId, key: string | typeof everyKey): void => {
    const keys = poisoned.get(hierarchy) ?? new Set<string | typeof everyKey>()
    keys.add(key)
    poisoned.set(hierarchy, keys)
  }
  const write = (receiver: Representation, key: string | null): void => {
    const hierarchies = new Set<DeclarationId>()
    if (!hierarchiesOf(receiver, hierarchies)) {
      if (key === null) everything = true
      else poisonedEverywhere.add(key)
      return
    }
    for (const hierarchy of hierarchies) poison(hierarchy, key ?? everyKey)
  }

  for (const body of bodies) {
    const keys = stringConstantsOf(body)
    const own = new Set<IrValueId>()
    const definitions = new Map<IrValueId, IrOperation>()
    if (constructing.has(body.sourceOwner as FunctionId)) {
      for (const block of body.blocks.values())
        for (const operation of block.operations) {
          if (operation.kind === 'receiver') own.add(operation.result.id)
          const result = resultOfIrOperation(operation)
          if (result !== null) definitions.set(result.id, operation)
        }
    }
    const handed = (value: IrValueId): boolean => {
      const definition = definitions.get(value)
      if (definition === undefined) return false
      if (definition.kind === 'parameter') return true
      if (definition.kind === 'constant') return definition.literal === 'null' || definition.literal === 'undefined'
      if (definition.kind === 'convert') return handed(definition.source.value)
      if (definition.kind === 'binding-read') return argumentCells.get(definition.declaration) === true
      return false
    }
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) {
        if (operation.kind === 'set' || operation.kind === 'define-own-property' || operation.kind === 'delete') {
          const key = keys.get(operation.key.value) ?? null
          if (key !== null && own.has(operation.receiver.value)) {
            if (operation.kind !== 'set' || !handed(operation.value.value)) {
              const hierarchies = new Set<DeclarationId>()
              hierarchiesOf(operation.receiver.representation, hierarchies)
              for (const hierarchy of hierarchies) {
                const keysOf = derived.get(hierarchy) ?? new Set<string>()
                keysOf.add(key)
                derived.set(hierarchy, keysOf)
              }
            }
            continue
          }
          write(operation.receiver.representation, key)
        } else if (operation.kind === 'spread-copy') {
          if (own.has(operation.receiver.value)) continue
          write(operation.receiver.representation, null)
        }
      }
    }
    if (everything) return { holds: () => false, constructing, holdsOlder: () => false }
  }

  for (const [declaration, writes] of reflectiveWrites) {
    if (writes === 'all') poison(rootOf(declaration), everyKey)
    else for (const key of writes) poison(rootOf(declaration), key)
  }

  const unpoisoned = (hierarchy: DeclarationId, key: string): boolean => {
    const keys = poisoned.get(hierarchy)
    return !poisonedEverywhere.has(key) && !keys?.has(everyKey) && !keys?.has(key)
  }
  return {
    constructing,
    holds: (receiver, key) => {
      if (receiver.kind !== 'class-ref' || poisonedEverywhere.has(key)) return false
      const hierarchies = new Set<DeclarationId>()
      if (!hierarchiesOf(receiver, hierarchies)) return false
      for (const hierarchy of hierarchies) if (!unpoisoned(hierarchy, key)) return false
      return true
    },
    holdsOlder: (declaration, key) => {
      const hierarchy = rootOf(declaration)
      return unpoisoned(hierarchy, key) && !derived.get(hierarchy)?.has(key)
    }
  }
}

/**
 * The `candidates` whose every use no suspension can separate from the read.
 *
 * A body that never awaits or yields keeps every candidate: nothing but its
 * own operations runs between a read and its uses, and none of them writes a
 * construction-only field. A suspending body keeps a read only when each use
 * follows it in the same block with no `await` or `yield` between -- past a
 * suspension the constructor that called this body may have run on and
 * written the field.
 */
export const suspensionFreeReadsOf = (body: IrBody, candidates: ReadonlySet<IrValueId>): ReadonlySet<IrValueId> => {
  if (candidates.size === 0) return candidates
  const suspends = [...body.blocks.values()].some((block) =>
    block.operations.some((operation) => operation.kind === 'await' || operation.kind === 'yield')
  )
  if (!suspends) return candidates
  const kept = new Set<IrValueId>()
  const read = new Map<IrValueId, { readonly block: IrBlockId; readonly suspensions: number }>()
  const scan = (visit: (operation: IrOperation, block: IrBlockId, suspensions: number) => void): void => {
    for (const [blockId, block] of body.blocks) {
      let suspensions = 0
      for (const operation of [...block.operations, block.terminator]) {
        visit(operation, blockId, suspensions)
        if (operation.kind === 'await' || operation.kind === 'yield') suspensions += 1
      }
    }
  }
  scan((operation, block, suspensions) => {
    if (operation.kind === 'get' && candidates.has(operation.result.id)) {
      read.set(operation.result.id, { block, suspensions })
      kept.add(operation.result.id)
    }
  })
  const refused = new Set<IrValueId>()
  scan((operation, block, suspensions) => {
    for (const operand of operandsOfIrOperation(operation)) {
      const site = read.get(operand.value)
      if (site === undefined) continue
      if (operation.kind === 'phi' || site.block !== block || site.suspensions !== suspensions) refused.add(operand.value)
    }
  })
  for (const value of refused) kept.delete(value)
  return kept
}

const writingOperations: ReadonlySet<ReflectionFieldOperation> = new Set(['write', 'native-write', 'define', 'descriptor'])

/** The fields a class's reflection demand can write: every one when the demand is unrestricted. */
export const reflectiveFieldWritesOf = (demand: ReflectionDemand): ReadonlySet<string> | 'all' => {
  if (demand.fieldOperations === undefined) return demand.level === 'full' ? 'all' : new Set()
  const writes = new Set<string>()
  for (const [key, operations] of demand.fieldOperations)
    if ([...operations].some((operation) => writingOperations.has(operation))) writes.add(key)
  return writes
}

/** No field is construction-only: the answer for a context built without the census. */
export const noConstructionOnlyFields: ConstructionOnlyFields = { holds: () => false, constructing: new Set(), holdsOlder: () => false }

/**
 * The values a stable field read may read through: the body's own receiver,
 * and each formal its signature borrows -- taken by reference, so the caller
 * keeps the object alive for the whole call and the body can neither move nor
 * rebind it -- read as the formal itself or through its cell, provided
 * nothing else writes the cell and no closure shares it. `count(node)`'s
 * `const left = node.left` is then the same alias `const socket = this.socket`
 * already was, instead of a retain and a release per node walked.
 */
export const stableReceiversOf = (
  body: IrBody,
  receivers: ReadonlySet<IrValueId>,
  borrowed: ReadonlySet<number>,
  bindingWrites: ReadonlyMap<DeclarationId, number>,
  isBoxed: (declaration: DeclarationId) => boolean
): ReadonlySet<IrValueId> => {
  if (borrowed.size === 0) return receivers
  const formals = new Set<IrValueId>()
  for (const block of body.blocks.values())
    for (const operation of block.operations)
      if (operation.kind === 'parameter' && borrowed.has(operation.ordinal)) formals.add(operation.result.id)
  if (formals.size === 0) return receivers
  const cells = new Set<DeclarationId>()
  for (const block of body.blocks.values())
    for (const operation of block.operations)
      if (
        operation.kind === 'binding-write' &&
        formals.has(operation.value.value) &&
        bindingWrites.get(operation.declaration) === 1 &&
        !isBoxed(operation.declaration)
      )
        cells.add(operation.declaration)
  const stable = new Set([...receivers, ...formals])
  for (const block of body.blocks.values())
    for (const operation of block.operations)
      if (operation.kind === 'binding-read' && cells.has(operation.declaration)) stable.add(operation.result.id)
  return stable
}

/**
 * The reads of this body that may name a field instead of copying it: a
 * string-keyed read of a construction-only field (`constructionOnlyFieldsOf`)
 * off the body's own receiver, in a body that is not itself a construction
 * (whose later statements may still write the field), of a carrier nothing
 * can freeze or redefine, where neither the read nor the receiver is ever
 * moved from (a move would empty the field, or the receiver the alias names),
 * and with no suspension before a use (`suspensionFreeReadsOf`).
 */
export const stableFieldReadsOf = (
  body: IrBody,
  receivers: ReadonlySet<IrValueId>,
  fields: ConstructionOnlyFields,
  integrity: { readonly restricts: (representation: Representation) => boolean },
  dying: ReadonlySet<IrValueId>
): ReadonlySet<IrValueId> => {
  if (fields.constructing.has(body.sourceOwner as FunctionId)) return new Set()
  const keys = stringConstantsOf(body)
  const candidates = new Set<IrValueId>()
  for (const block of body.blocks.values()) {
    for (const operation of block.operations) {
      if (operation.kind !== 'get' || !receivers.has(operation.receiver.value)) continue
      if (dying.has(operation.result.id) || dying.has(operation.receiver.value)) continue
      const key = keys.get(operation.key.value)
      const receiver = operation.receiver.representation
      if (key === undefined || !fields.holds(receiver, key) || integrity.restricts(receiver)) continue
      candidates.add(operation.result.id)
    }
  }
  return suspensionFreeReadsOf(body, candidates)
}
