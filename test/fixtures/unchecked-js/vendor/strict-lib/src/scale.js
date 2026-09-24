/**
 * @param {number} value
 * @returns {number}
 */
export function strictScale(value) {
  /** @type {string} */
  const label = value * 3
  return label.length
}
