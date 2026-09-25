import type { IrValueId } from '../identity/ids.js'
import type { CallOperation, IrBody, IrOperand } from './model.js'
import type { Representation } from '../representation/model.js'
import { observesNativeCarrierOnly, operandsOfIrOperation } from './queries.js'
import { symbolPropertyKeyDeclarationOf } from '../semantics/model/structural-types.js'
import { booleanConstantsOf, stringConstantsOf } from './dead-values.js'

/**
 * Which native objects the program can make non-writable or non-extensible.
 *
 * Every native field store guards against exactly that -- `Object.freeze(o)`
 * followed by `o.x = 1` must throw -- and the guard is a presence bit, an
 * attribute bit, the process-wide restriction counter and, when that counter
 * is nonzero, a registry lookup in a call the C++ compiler has to assume can
 * write anything. In a loop that is the difference between a field living in
 * a register and a field living in memory: `method_calls` reloaded
 * `this.value` through the guard on every turn, 25.6 ms against 18.6 for the
 * same loop with the field in a register.
 *
 * So the emitter asks the whole unit first. Integrity is restricted only by
 * `Object.freeze` / `seal` / `preventExtensions` and by a descriptor
 * definition (`defineProperty`, `defineProperties`, their `Reflect` twins),
 * every one of which is a member read the IR shows -- through a host method
 * binding, or as a constant key on whatever receiver -- plus two implicit
 * sources: a tagged template's strings object is born frozen, and an IR
 * `define-own-property` with a non-default attribute states a restriction of
 * its own (an object literal's definitions all carry the defaults). Nothing
 * else in the runtime freezes a user object.
 *
 * The answer is per CARRIER, because the object a restriction reaches is the
 * one its call's first argument holds, and that argument's carrier says which
 * struct it can be. The mongodb driver freezes 41 things -- its option
 * constants, a handful of description objects, some string arrays -- and a
 * program-wide answer put the guard, an inline throw path and the counter
 * load on every field store of every one of its hundreds of structs. A class
 * restriction covers the whole hierarchy it shares an ancestor with (a
 * `Base`-typed argument may hold any subclass); a record covers its shape.
 * Fail-closed on everything this cannot see through: an argument whose
 * carrier could be any struct (dynamic, a callable, a host object), a
 * restricting member read whose value goes anywhere but a call's callee, and
 * a computed key read off a dynamic, host or unresolved receiver
 * (`(Object as any)[name]`) all restrict every carrier.
 */
export interface IntegrityRestrictions {
  /** Whether anything in the program restricts anything at all. */
  readonly any: boolean
  /** Whether a native object held as `representation` may have been restricted. */
  readonly restricts: (representation: Representation, key?: string) => boolean
  /**
   * `restricts` for a record struct named by its shape id alone -- the struct
   * renderer has the shape, never a representation. When this is false no
   * `freeze`/`seal`/`defineProperty` can reach an object of the shape, so
   * every attribute triple it holds is its default for the object's whole
   * life and `records.ts` states those once per struct (`static inline`)
   * rather than once per field per instance.
   */
  readonly restrictsRecordShape: (shapeId: string, hasSymbolField?: boolean) => boolean
  /** Whether any array may have been: a dense window's element stores ask this, holding no array carrier of their own. */
  readonly arrays: boolean
  /**
   * Whether a declared field of a native object held as `representation` that
   * every instance is born with (a required one) is present, and keeps its
   * default attributes, for the object's whole life: nothing restricts the
   * carrier and nothing deletes from it. A store into such a field has no
   * presence bit to re-set and no key to report as created.
   */
  readonly fixedFieldState: (representation: Representation, key: string) => boolean
}

const unrestricted: IntegrityRestrictions = {
  any: false,
  restricts: () => false,
  restrictsRecordShape: () => false,
  arrays: false,
  fixedFieldState: () => false
}
export const restrictsEveryCarrier: IntegrityRestrictions = {
  any: true,
  restricts: () => true,
  restrictsRecordShape: () => true,
  arrays: true,
  fixedFieldState: () => false
}

/** The carrier identities an object held as `representation` can have, or `null` when it could be any struct. */
const restrictionKeysOf = (representation: Representation, into: Set<string>): boolean => {
  switch (representation.kind) {
    case 'scalar':
    case 'string':
    case 'symbol':
    case 'null':
    case 'undefined':
    case 'void':
      return true
    case 'class-ref':
      for (const declaration of [representation.declaration, ...representation.ancestors]) into.add(`class:${declaration}`)
      // An instance of a class over a native object may be held as that
      // object's own carrier (the upcast `nativeBase` describes), so it shares
      // the base carrier's identity as well as its hierarchy's.
      return representation.nativeBase === undefined || restrictionKeysOf(representation.nativeBase, into)
    case 'record':
    case 'record-with-index':
    case 'native-record-ref':
      into.add(`record:${representation.shapeId}`)
      return true
    case 'array-object':
      into.add('array')
      return true
    // A class object's own properties (`defineAspects` makes `aspects` read-only):
    // no generated struct is ever held under this carrier.
    // An open native dictionary is its own runtime object: a restriction
    // placed on one lives in that object's state, which no generated struct
    // shares, and a record converted to a dictionary is copied into one.
    case 'dictionary':
      into.add('dictionary')
      return true
    case 'constructor-family':
      into.add('constructor-family')
      return true
    case 'optional':
      return restrictionKeysOf(representation.payload, into)
    case 'borrowed-ref':
      return restrictionKeysOf(representation.referent, into)
    case 'tagged-union':
      return representation.arms.every((arm) => restrictionKeysOf(arm.value, into))
    default:
      return false
  }
}

/**
 * Whether `Object`, `Reflect` or the global object can be held as a value
 * anywhere but as the receiver of a member read.
 *
 * A read of `freeze` with a constant key is already seen above wherever it
 * happens, whatever its receiver. What no constant shows is `target[name]`
 * with a runtime `name` on a receiver typed only dynamically: it yields
 * `Object.freeze` only if the receiver is `Object`. That namespace is a value
 * solely as a native-handle carrier (`Object`, `Reflect`) or the global
 * object, and the runtime's dynamic read never conjures either out of a plain
 * value (`Object.prototype`'s members are answered absent). So the namespace
 * can reach a dynamic receiver only by being USED as an operand of something
 * that is not a read of its own member -- passed, stored, returned, converted,
 * jumped with -- and any such use, or a read of the global object by a
 * computed or `Object`/`Reflect`-named key, keeps the fail-closed answer.
 */
const restrictingNamespaceEscapes = (bodies: readonly IrBody[]): boolean => {
  for (const body of bodies) {
    const constants = stringConstantsOf(body)
    const globals = new Set<IrValueId>()
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) {
        if (operation.kind !== 'global-this') continue
        globals.add(operation.result.id)
      }
    }
    const memberReadsOf = new Map<IrValueId, IrValueId>()
    for (const block of body.blocks.values())
      for (const operation of block.operations)
        if (operation.kind === 'get') memberReadsOf.set(operation.result.id, operation.receiver.value)
    for (const block of body.blocks.values()) {
      for (const operation of [...block.operations, block.terminator]) {
        for (const operand of operandsOfIrOperation(operation)) {
          const namespace = isRestrictingNamespace(operand.representation)
          if (!namespace && !globals.has(operand.value)) continue
          // `Object.keys(x)` is a call whose receiver is `Object` and whose
          // callee is a member read of that same receiver; calling `Object(x)`
          // names it as the callee. Neither hands the namespace to anything.
          if (
            operation.kind === 'call' &&
            !operation.arguments.some((argument) => argument.value === operand.value) &&
            ((operation.callee.value === operand.value && operation.receiver?.value !== operand.value) ||
              (operation.receiver?.value === operand.value && memberReadsOf.get(operation.callee.value) === operand.value))
          )
            continue
          // A test of the value (`typeof`, `=== null`, `'x' in Object`) reads it and keeps nothing.
          if (observesNativeCarrierOnly(operation) || operation.kind === 'has-property' || operation.kind === 'own-property-keys') continue
          if (operation.kind !== 'get' || operation.receiver.value !== operand.value || operation.key.value === operand.value) {
            return true
          }
          if (namespace) continue
          const key = operation.hostMethod?.member ?? constants.get(operation.key.value)
          if (key === undefined || key === 'Object' || key === 'Reflect' || key === 'globalThis') {
            return true
          }
        }
      }
    }
  }
  return false
}

const isRestrictingNamespace = (representation: Representation): boolean => {
  if (representation.kind !== 'native-handle') return false
  const name = representation.native ?? representation.protocol
  return name.includes('ObjectConstructor') || name.includes('Reflect')
}

const descriptorKeys: ReadonlySet<string> = new Set(['value', 'writable', 'enumerable', 'configurable'])

/**
 * Whether this `defineProperty` call's descriptor is an object literal this
 * body built whose only members are `value` and the three attributes, each
 * attribute the literal `true`, and which nothing else touches: no spread, no
 * later store that could add a `get`/`set`, no other reader.
 */
const definesWithDefaultAttributes = (body: IrBody, call: CallOperation): boolean => {
  const descriptor = call.arguments[2]
  if (call.arguments.length !== 3 || descriptor === undefined) return false
  const booleans = booleanConstantsOf(body)
  const constants = stringConstantsOf(body)
  // A literal threads its object through each definition: the result of one
  // `define-own-property` is the receiver the next one (or the consumer) names.
  const threaded = new Map<IrValueId, IrValueId>()
  for (const block of body.blocks.values())
    for (const operation of block.operations)
      if (operation.kind === 'define-own-property' && operation.result !== null) threaded.set(operation.result.id, operation.receiver.value)
  const rootOf = (value: IrValueId): IrValueId => {
    let current = value
    for (let hops = 0; threaded.has(current) && hops < 64; hops++) current = threaded.get(current) as IrValueId
    return current
  }
  const root = rootOf(descriptor.value)
  const stated = new Map<string, IrOperand | null>()
  let allocated = false
  for (const block of body.blocks.values()) {
    for (const operation of [...block.operations, block.terminator]) {
      if (operation.kind === 'allocate-record' || operation.kind === 'allocate-ordinary-object') {
        if (operation.result.id !== root) continue
        allocated = true
        if (operation.kind === 'allocate-record') for (const field of operation.fields) stated.set(field.key, field.value)
        continue
      }
      if (operation.kind === 'define-own-property' && rootOf(operation.receiver.value) === root) {
        const key = constants.get(operation.key.value)
        if (key === undefined || !descriptorKeys.has(key)) return false
        if (!operation.attributes.writable || !operation.attributes.enumerable || !operation.attributes.configurable) return false
        stated.set(key, operation.value)
        continue
      }
      if (operation === call) continue
      for (const operand of operandsOfIrOperation(operation)) if (rootOf(operand.value) === root) return false
    }
  }
  if (!allocated) return false
  for (const key of stated.keys()) if (!descriptorKeys.has(key)) return false
  for (const attribute of ['writable', 'enumerable', 'configurable']) {
    const operand = stated.get(attribute)
    if (operand === undefined || operand === null || booleans.get(operand.value) !== true) return false
  }
  return stated.has('value')
}

export const integrityRestrictionsOf = (bodies: readonly IrBody[]): IntegrityRestrictions => {
  const restrictions = restrictionsOf(bodies)
  const deletions = fieldDeletionKeysOf(bodies)
  if (deletions === null) return restrictions
  return {
    ...restrictions,
    fixedFieldState: (representation, key) => !deletions.has(key) && !restrictions.restricts(representation, key)
  }
}

const restrictionsOf = (bodies: readonly IrBody[]): IntegrityRestrictions => {
  const keys = new Set<string>()
  let any = false
  let dynamicComputedRead = false
  let symbolDefines = false
  for (const body of bodies) {
    const constants = stringConstantsOf(body)
    const restricting = new Map<IrValueId, string>()
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) {
        if (operation.kind === 'allocate-template-object') {
          any = true
          keys.add('array')
          continue
        }
        // An object literal defines each of its properties this way, with the
        // three attributes at their defaults; only a definition that turns one
        // OFF restricts anything.
        if (operation.kind === 'define-own-property') {
          const { writable, enumerable, configurable } = operation.attributes
          if (writable && enumerable && configurable) continue
          any = true
          if (!restrictionKeysOf(operation.receiver.representation, keys)) return restrictsEveryCarrier
          continue
        }
        if (operation.kind !== 'get') continue
        const member = operation.hostMethod?.member ?? constants.get(operation.key.value)
        if (member !== undefined) {
          if (!restrictingMembers.has(member)) continue
          if (member === 'eval' || member === 'Function') return restrictsEveryCarrier
          if (!operation.result) continue
          restricting.set(operation.result.id, member)
          continue
        }
        const receiver = operation.receiver.representation
        if (receiver.kind === 'unresolved' || receiver.kind === 'native-handle') return restrictsEveryCarrier
        // A computed read off a value the program only knows dynamically can
        // name `freeze` -- but only if that value IS `Object` or `Reflect`,
        // and those exist as values only in the native-handle carrier below.
        // `namespaceEscapes` decides whether one ever left it.
        if (receiver.kind === 'dynamic') dynamicComputedRead = true
      }
    }
    if (restricting.size === 0) continue
    any = true
    for (const block of body.blocks.values()) {
      for (const operation of [...block.operations, block.terminator]) {
        for (const operand of operandsOfIrOperation(operation)) {
          if (!restricting.has(operand.value)) continue
          if (operation.kind !== 'call' || operation.callee.value !== operand.value) return restrictsEveryCarrier
          if (operation.arguments.some((argument) => argument.value === operand.value)) return restrictsEveryCarrier
          // `defineProperty(target, key, { value, writable: true, enumerable:
          // true, configurable: true })` is an ordinary store spelled long:
          // the attributes it states are the defaults, so nothing it touches
          // can become read-only or non-extensible. Anything the descriptor
          // leaves unstated or computes defaults to OFF and still restricts.
          if (restricting.get(operand.value) === 'defineProperty' && definesWithDefaultAttributes(body, operation)) continue
          const target = operation.arguments[0]
          if (target !== undefined && !restrictionKeysOf(target.representation, keys)) {
            // A target only dynamically typed can hold any struct, but a
            // symbol-keyed definition reaches declared fields only through
            // symbol-keyed ones (see `restricts`).
            if (restricting.get(operand.value) === 'defineProperty' && operation.arguments[1]?.representation.kind === 'symbol') {
              symbolDefines = true
              continue
            }
            return restrictsEveryCarrier
          }
        }
      }
    }
  }
  if (dynamicComputedRead && restrictingNamespaceEscapes(bodies)) return restrictsEveryCarrier
  if (!any) return unrestricted
  return {
    any,
    fixedFieldState: () => false,
    arrays: keys.has('array'),
    restrictsRecordShape: (shapeId, hasSymbolField = true) => keys.has(`record:${shapeId}`) || (symbolDefines && hasSymbolField),
    restricts: (representation, key) => {
      const held = new Set<string>()
      if (!restrictionKeysOf(representation, held)) return true
      for (const carrier of held) if (keys.has(carrier)) return true
      // A symbol-keyed `defineProperty` whose target the census cannot key can
      // only change the attributes of a declared SYMBOL-keyed field: it sets
      // neither the frozen-fields bit nor extensibility, and a string-named
      // field is never the property it names.
      return symbolDefines && (key === undefined || symbolPropertyKeyDeclarationOf(key) !== null)
    }
  }
}

/**
 * `eval` is here because evaluated source can do all of the above out of the
 * compiler's sight; `Function` for the same reason.
 */
const restrictingMembers: ReadonlySet<string> = new Set([
  'freeze',
  'seal',
  'preventExtensions',
  'defineProperty',
  'defineProperties',
  'eval',
  'Function'
])

/**
 * The field names a `delete` can remove, or `null` when it could remove any:
 * a computed key, `Reflect.deleteProperty`, and a `deleteProperty` read of any
 * other shape. By NAME and not by carrier, because a record converts between
 * shapes and `delete o.x` through a looser alias removes `x` from the shape
 * that required it. A dictionary has no fixed fields to delete.
 */
const fieldDeletionKeysOf = (bodies: readonly IrBody[]): ReadonlySet<string> | null => {
  const names = new Set<string>()
  for (const body of bodies) {
    const constants = stringConstantsOf(body)
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) {
        if (operation.kind === 'delete') {
          const receiver = operation.receiver.representation
          const carrier = receiver.kind === 'optional' ? receiver.payload : receiver
          if (carrier.kind === 'dictionary') continue
          const name = constants.get(operation.key.value)
          if (name === undefined) return null
          names.add(name)
          continue
        }
        if (operation.kind !== 'get') continue
        if (operation.hostMethod?.member === 'deleteProperty' || constants.get(operation.key.value) === 'deleteProperty') return null
      }
    }
  }
  return names
}

/**
 * Whether ANYTHING in the program can delete a declared field of a generated
 * struct.
 *
 * A required field's presence bit starts `true` and only `delete` ever clears
 * it; an attribute triple only the integrity operations above ever change. So
 * when neither can happen, both are program-wide constants for every struct,
 * and `records.ts` states them once per struct (`static inline` members)
 * instead of once per instance -- on `bench/comparison/fixtures/binary_trees.ts`
 * that is three presence bytes and three attribute bytes off every one of a
 * million nodes whose whole cost is cache misses.
 *
 * Fail-closed the same way `integrityRestrictionsOf` is: a `delete` whose
 * receiver is anything but a dictionary (the one carrier with no fixed
 * fields) counts, so does `Reflect.deleteProperty`, and a receiver the
 * program only knows dynamically counts because it could be any struct.
 *
 * So does a read of `C.prototype` as a native object: that object has C's
 * layout with every field absent (`nativeClassPrototype`), and a presence bit
 * shared by every instance would make each instance's fields absent too.
 */
export const fixedFieldDeletionsOf = (bodies: readonly IrBody[]): boolean => {
  for (const body of bodies) {
    const keys = stringConstantsOf(body)
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) {
        if (operation.kind === 'delete') {
          const receiver = operation.receiver.representation
          const carrier = receiver.kind === 'optional' ? receiver.payload : receiver
          if (carrier.kind !== 'dictionary') return true
          continue
        }
        if (operation.kind !== 'get') continue
        if (operation.hostMethod?.member === 'deleteProperty') return true
        if (keys.get(operation.key.value) === 'deleteProperty') return true
        // A compiled class's prototype object is a real instance of its layout that owns none of the
        // fields (`native-prototype.ts` clears every presence bit on it). A constant bit is shared by
        // every instance, so clearing one on the prototype would clear it on all of them.
        if (keys.get(operation.key.value) === 'prototype' && operation.receiver.representation.kind === 'constructor-family') return true
      }
    }
  }
  return false
}
