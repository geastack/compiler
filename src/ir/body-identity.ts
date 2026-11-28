import type { PhysicalBodyId } from '../identity/ids.js'
import type { IrBody } from './model.js'

/**
 * `#body-identity` for the JavaScript compiler. The IR passes rebuild every
 * body, block and operation they walk, even where they change nothing, so
 * each generation of the program is new objects throughout. Everything keyed
 * by identity downstream -- the callable flow's remembered answers above all,
 * a whole-program solve each -- then starts over, or pairs two programs
 * object by object to prove them the same data.
 *
 * This hands back the previous generation's object wherever the new one is
 * the same data one level down: the same own keys in the same order, each
 * value the very same, or an array, Map or Set of the very same members.
 * Operations first, then the blocks holding only kept operations, then the
 * bodies holding only kept blocks. An object replaced this way is
 * indistinguishable from its replacement to anything reading its data, and
 * the IR is never written after it is built. Comparing walks objects by
 * reflection, which a native build cannot certify, so a natively compiled
 * compiler links `body-identity-native.ts`, which keeps every new object.
 */

const sameMembers = (left: unknown, right: unknown): boolean => {
  if (left === right) return true
  if (typeof left !== 'object' || typeof right !== 'object' || left === null || right === null) return false
  if (Array.isArray(left)) {
    if (!Array.isArray(right) || left.length !== right.length) return false
    for (let index = 0; index < left.length; index++) if (left[index] !== right[index]) return false
    return true
  }
  if (left instanceof Map) {
    if (!(right instanceof Map) || left.size !== right.size) return false
    const theirs = right.entries()
    for (const [key, value] of left) {
      const step = theirs.next()
      if (step.done === true || step.value[0] !== key || step.value[1] !== value) return false
    }
    return true
  }
  if (left instanceof Set) {
    if (!(right instanceof Set) || left.size !== right.size) return false
    const theirs = right.values()
    for (const value of left) {
      const step = theirs.next()
      if (step.done === true || step.value !== value) return false
    }
    return true
  }
  return false
}

/** Whether two plain objects hold the same keys, in order, with the same members. */
const sameShallow = (left: object, right: object): boolean => {
  if (left === right) return true
  if (Object.getPrototypeOf(left) !== Object.getPrototypeOf(right)) return false
  const keys = Object.keys(left)
  const theirs = Object.keys(right)
  if (keys.length !== theirs.length) return false
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]!
    if (theirs[index] !== key) return false
    if (!sameMembers((left as Record<string, unknown>)[key], (right as Record<string, unknown>)[key])) return false
  }
  return true
}

const keptOperations = <T extends object>(previous: readonly T[], next: readonly T[]): readonly T[] => {
  if (previous === next) return next
  let kept: T[] | null = null
  const sameLength = previous.length === next.length
  for (let index = 0; index < next.length; index++) {
    const candidate = next[index]!
    const old = sameLength ? previous[index]! : undefined
    const chosen = old !== undefined && old !== candidate && sameShallow(old, candidate) ? old : candidate
    if (chosen !== candidate) (kept ??= next.slice())[index] = chosen
  }
  const result = kept ?? next
  return sameLength && sameMembers(previous, result) ? previous : result
}

const keptBody = (previous: IrBody, next: IrBody): IrBody => {
  if (previous === next) return next
  let blocks: Map<unknown, unknown> | null = null
  const oldBlocks = previous.blocks as ReadonlyMap<unknown, unknown>
  for (const [blockId, block] of next.blocks as ReadonlyMap<unknown, object>) {
    const old = oldBlocks.get(blockId) as Record<string, unknown> | undefined
    if (old === undefined || old === block) continue
    const fresh = block as Record<string, unknown>
    const operations =
      Array.isArray(fresh['operations']) && Array.isArray(old['operations'])
        ? keptOperations(old['operations'], fresh['operations'])
        : fresh['operations']
    const terminator =
      typeof fresh['terminator'] === 'object' &&
      fresh['terminator'] !== null &&
      typeof old['terminator'] === 'object' &&
      old['terminator'] !== null
        ? sameShallow(old['terminator'], fresh['terminator'])
          ? old['terminator']
          : fresh['terminator']
        : fresh['terminator']
    const rebuilt = operations === fresh['operations'] && terminator === fresh['terminator'] ? fresh : { ...fresh, operations, terminator }
    const chosen = sameShallow(old, rebuilt) ? old : rebuilt
    if (chosen !== block) (blocks ??= new Map(next.blocks as ReadonlyMap<unknown, unknown>)).set(blockId, chosen)
  }
  const candidate = blocks === null ? next : ({ ...next, blocks } as IrBody)
  return sameShallow(previous, candidate) ? previous : candidate
}

/** `next` with every body, block and operation that is the same data as `previous`'s replaced by `previous`'s own object. */
export const keepUnchangedBodies = (
  previous: ReadonlyMap<PhysicalBodyId, IrBody>,
  next: ReadonlyMap<PhysicalBodyId, IrBody>
): ReadonlyMap<PhysicalBodyId, IrBody> => {
  if (previous === next) return next
  let kept: Map<PhysicalBodyId, IrBody> | null = null
  for (const [id, body] of next) {
    const old = previous.get(id)
    if (old === undefined || old === body) continue
    const chosen = keptBody(old, body)
    if (chosen !== body) (kept ??= new Map(next)).set(id, chosen)
  }
  const result = kept ?? next
  return sameMembers(previous, result) ? previous : result
}
