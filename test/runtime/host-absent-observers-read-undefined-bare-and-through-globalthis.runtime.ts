// A library feature-detects a host observer and falls back to a no-op where
// the host has none. No native host implements MutationObserver or
// ResizeObserver: `typeof` answers "undefined", a read off the global object is
// undefined, and a bare read throws a ReferenceError, as on any host without them.
const observeChildren = (): string => (typeof globalThis.MutationObserver !== 'function' ? 'no-op' : 'observing')
const observeSize = (): string => (typeof ResizeObserver !== 'function' ? 'no-op' : 'observing')
console.log(typeof MutationObserver, typeof ResizeObserver, typeof globalThis.MutationObserver, typeof globalThis.ResizeObserver)
console.log(observeChildren(), observeSize(), globalThis.ResizeObserver === undefined)
let bare = 'read'
try {
  bare = String(MutationObserver)
} catch (error) {
  bare = (error as Error).name
}
console.log(bare)
//! expect: undefined undefined undefined undefined
//! expect: no-op no-op true
//! expect: ReferenceError
