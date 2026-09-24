/**
 * @param {number} frames
 * @returns {number}
 */
export function frameCount(frames) {
  /** @type {string} */
  const label = frames * 2
  return label.length + (typeof self !== 'undefined' ? 1 : 0)
}
