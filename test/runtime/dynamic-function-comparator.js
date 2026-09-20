/** @param {number} left @param {number} right @returns {number} */
function descending(left, right) {
  return right - left
}

/** @type {Function} */
const customComparator = descending

/**
 * @param {(left: any, right: any) => number} comparator
 * @returns {number}
 */
function compare(comparator) {
  return comparator(2, 7)
}

/**
 * @param {(left: any, right: any) => number} comparator
 * @returns {(left: any, right: any) => number}
 */
function retain(comparator) {
  return comparator
}

// @ts-expect-error A bare Function deliberately crosses the checked dynamic-call boundary.
console.log(compare(customComparator))
// The dynamic-to-native ABI adapter is a view of this Function, not a fresh
// Function allocation. Equality crosses the two representations directly.
console.log(retain(customComparator) === customComparator)
//! expect: true
