/**
 * A `&&` whose merged type is a plain `boolean`, kept over an operand that is
 * not one.
 *
 * three's `object && object.isObject3D` and `renderTarget &&
 * renderTarget.isWebGLRenderTarget`: the checker collapses the whole
 * expression to `boolean` because a class instance has no falsy part, so no
 * VALUE of the kept operand survives -- only its `ToBoolean`, which is the
 * question `&&` asked of it in the first place. The carrier does not collapse
 * with it: a `class-ref(shared-refcount)` is a `gea::Ref<T>` that
 * `representation/optional.ts` folds `T | null` onto, and its truthiness is
 * exactly its presence.
 *
 * `emit-merge-live-arm.ts` already rendered that `ToBoolean` for ONE LIVE ARM
 * of a partially-dead tagged union. A whole operand that is not a union
 * reached neither that path nor the whole-dead bypass beside it, and raised
 * `merge-narrowing:class-ref(...)->scalar(boolean)` --  an obligation nothing
 * could satisfy, for a merge whose own published type states the answer.
 */
class Node {
  constructor(
    readonly isNode: boolean,
    readonly items: number[]
  ) {}
}

function flagged(node: Node): boolean {
  return node && node.isNode
}

function filled(items: number[]): boolean {
  return items && items.length > 0
}

const on = new Node(true, [1, 2])
const off = new Node(false, [])

console.log(`${flagged(on)},${flagged(off)},${filled(on.items)},${filled(off.items)}`)
