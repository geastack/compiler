// `flag && image` keeps `flag` on the branch where it tested falsy, and a
// `boolean`'s falsy state is the single value `false`. The merge publishes the
// right operand's optional carrier -- there is no boolean arm left in it -- so
// the kept operand contributes an absence and nothing else. three's
// `WebGLEnvironments` is where this idiom comes from:
// `( isEquirectMap && image && image.height > 0 )`.
//
// `Img` is self-referential on purpose: a cyclic record is what derives
// `optional(native-record-ref)`, the carrier three's `texture.image` gets. A
// class would collapse the null into the reference itself and never reach the
// merge at all.
interface Img {
  height: number
  next: Img | null
}

function tall(flag: boolean, image: Img | null): boolean {
  if (flag && image && image.height > 0) return true
  return false
}

const big: Img = { height: 12, next: null }
const flat: Img = { height: 0, next: big }
console.log(`${tall(true, big)},${tall(true, flat)},${tall(false, big)},${tall(true, null)}`)
