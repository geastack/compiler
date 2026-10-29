//! expect-refusal: "window" is a host namespace used as a value
// A DOM library's `getWindow(el)` returns `window` to callers that only read
// members off it (chakra-ui/zag `@zag-js/dom-query/src/node.ts`). The host
// mutation census must not read that as the global object escaping into
// data: no write here can reach a host global through it, so the bare reads
// of `window` are not refused by the census. What refuses this program is the
// next layer, by name: `window` is a host namespace with no run-time object
// in this runtime. Before the fix the census refused first, with
// "an authenticated host global may be mutated through globalThis".
export {}
type Global = typeof globalThis
function getWindow(el: { nodeType?: number } | null) {
  if (el && el.nodeType === 9) return window
  return window
}
const win = getWindow(null)
const text: string = JSON.parse('" x "') as any
console.log(typeof win, text.normalize('NFC').trim())
