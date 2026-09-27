// @ts-nocheck
//! expect: frame 16
//! expect: frame 32
// three's `yieldToMain` (`renderers/common/utils.js`) states
// `@return {Promise<void>}` and returns `new Promise( resolve => {
// requestAnimationFrame( resolve ) } )`: the callee calls `resolve` with the
// frame time, a number, so the promise resolves with that number. Read at the
// tag, `resolve` took nothing and had no conversion into the callee's
// `( time: number ) => void` callback. The tag loses to what reaches
// `resolve`, and the promise keeps the number.
let clock = 0
/** @param {function(number): void} callback - Called with the frame time. */
function onFrame(callback) {
  clock += 16
  callback(clock)
}
/** @return {Promise<void>} */
function yieldToMain() {
  return new Promise((resolve) => {
    onFrame(resolve)
  })
}
/** @return {Promise<void>} */
const yieldArrow = () => new Promise((resolve) => onFrame(resolve))
yieldToMain()
  .then((time) => console.log('frame', time))
  .then(() => yieldArrow())
  .then((time) => console.log('frame', time))
