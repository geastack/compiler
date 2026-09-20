import type { IrBody } from './model.js'
import { stringConstantsOf } from './dead-values.js'

/**
 * Whether ANYTHING in the program can make a native object's own data
 * properties non-writable or the object itself non-extensible.
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
 * Fail-closed on the shapes this cannot see through: a computed key read off
 * a dynamic, host or unresolved receiver could name any of those members
 * (`(Object as any)[name]`), and so counts as restricting. A program whose
 * typed code never touches integrity keeps the fast stores; a program that
 * reaches for it anywhere -- or that reads computed members off `any` --
 * keeps every guard.
 */
export const integrityRestrictionsOf = (bodies: readonly IrBody[]): boolean => {
  for (const body of bodies) {
    const keys = stringConstantsOf(body)
    for (const block of body.blocks.values()) {
      for (const operation of block.operations) {
        if (operation.kind === 'allocate-template-object') return true
        // An object literal defines each of its properties this way, with the
        // three attributes at their defaults; only a definition that turns one
        // OFF restricts anything.
        if (operation.kind === 'define-own-property') {
          const { writable, enumerable, configurable } = operation.attributes
          if (!writable || !enumerable || !configurable) return true
          continue
        }
        if (operation.kind !== 'get') continue
        if (operation.hostMethod !== undefined && restrictingMembers.has(operation.hostMethod.member)) return true
        const key = keys.get(operation.key.value)
        if (key !== undefined) {
          if (restrictingMembers.has(key)) return true
          continue
        }
        const receiver = operation.receiver.representation
        if (receiver.kind === 'dynamic' || receiver.kind === 'unresolved' || receiver.kind === 'native-handle') return true
      }
    }
  }
  return false
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
      }
    }
  }
  return false
}
