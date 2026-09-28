// @ts-nocheck
//! expect: settled 3 true
// avvio's `create-promise.js`: the `@typedef` sits in a JSDoc block above the
// next function's own `@returns` block, and the literal declared `@type
// {PromiseObject}` initializes its members with `null` before the executor
// fills them. The typedef's members hold that `null` as well.
/**
 * @callback PromiseResolve
 * @param {any} value
 * @returns {void}
 */
/**
 * @typedef PromiseObject
 * @property {Promise} promise
 * @property {PromiseResolve} resolve
 * @property {PromiseResolve} reject
 */
/** @returns {PromiseObject} */
function createPromise () {
  /** @type {PromiseObject} */
  const obj = { resolve: null, reject: null, promise: null }
  obj.promise = new Promise((resolve, reject) => {
    obj.resolve = resolve
    obj.reject = reject
  })
  return obj
}
const made = createPromise()
made.promise.then((value) => console.log('settled', value, typeof made.reject === 'function'))
made.resolve(3)
