// @ts-nocheck
//! expect: k1,k2,k3 z
// The checker leaves `pick` returning `any`, so the `map` call's result is
// published as dynamic elements, while the callback's body is typed and
// returns a string. Each mapped string is converted into the published element.
const pick = (x) => x
/**
 * @param {Array<number>} ids
 * @return {string}
 */
const names = (ids) => ids.map((id) => pick('k' + id)).join(',')
console.log(names([1, 2, 3]) + ' ' + pick('z'))
