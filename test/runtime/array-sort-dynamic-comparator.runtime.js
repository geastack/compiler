// @ts-nocheck
//! expect: 1,2,3 | 3,2,1 | a,b,c
// `list.sort( custom || fallback )` with an untyped `custom`: the comparator
// is whichever function the `||` picked, so it is boxed. three's
// `RenderList.sort( customOpaqueSort, customTransparentSort )` sorts this way
// (`this.opaque.sort( customOpaqueSort || painterSortStable )`). An
// `undefined` comparator is the default ToString order.
function painterSortStable(a, b) {
  return a.z - b.z
}
class RenderList {
  constructor() {
    this.opaque = [{ z: 3 }, { z: 1 }, { z: 2 }]
  }
  sort(customOpaqueSort) {
    if (this.opaque.length > 1) this.opaque.sort(customOpaqueSort || painterSortStable)
    return this.opaque.map((item) => item.z).join(',')
  }
}
const list = new RenderList()
const ascending = list.sort(null)
const descending = list.sort((a, b) => b.z - a.z)
const names = ['c', 'a', 'b']
const comparator = JSON.parse('null') ?? undefined
names.sort(comparator)
console.log(ascending, '|', descending, '|', names.join(','))
