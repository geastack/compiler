// OPEN DEFECT, certification-level only. `Array.isArray(item)` narrows `U` to
// `U & readonly any[]` in the taken branch; the copy `U := number` substitutes
// it structurally and the deriver rightly finds `number & readonly any[]`
// uninhabited (`isUninhabitedPrimitiveIntersection`). This certifies. Emission
// still lowers the dead branch, though: the read of `item` there keeps its
// declared scalar carrier, `item.length` is asked of a number, and the C++
// emitter refuses `scalar-property` for the copy. The branch is unreachable
// and should not be emitted at all -- a guard on an uninhabited narrowing is a
// constant, and nothing yet folds it before lowering.
function count<U>(item: U): number {
  return Array.isArray(item) ? item.length : 1
}
console.log(count(7), count('s'), count([1, 2]))
