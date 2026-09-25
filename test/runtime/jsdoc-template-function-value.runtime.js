//! dynamic-fallback
//! expect: function a
// fast-uri's `normalize`: a JavaScript function generic through JSDoc
// `@template`, stored in the module's exports object and called directly. The
// declaration is generic for the specialization census as its TypeScript
// spelling is, so its body exists only as the copies its calls instantiate.
/**
 * @template {string | number} T
 * @param {T} x
 * @returns {T}
 */
function identity(x) {
  return x
}
const api = { identity }
console.log(typeof api.identity, identity('a'))
