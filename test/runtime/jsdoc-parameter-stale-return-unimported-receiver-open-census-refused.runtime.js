// @ts-nocheck
//! expect-refusal: the @param type of parameter "item" of key was erased because its callers contradict it
//! expect-refusal: (function-escapes:uncounted-member-reference)
// A blanked `@return` tag is no evidence, but the function's own returns
// are. `Producer.getItem` states `@return {Plain}` and returns a `Packed`;
// the census round blanks that tag and reads nothing off it, though the call
// is resolved only through the unimported `@param {Producer}`. The program
// compiled next types the call by its return, a `Packed`, and the settled
// round finds that `Packed` passed to `@param {Other} item`: the tag is
// erased. With the census of `key`'s callers left open by `callback.bind(
// this )`, `item` cannot be typed from its complete callers, and as a
// dynamic parameter it would box the `Packed`. It is refused by name.
import Source from './_stale-return-source.js'
import Producer from './_stale-return-producer.js'
import { Backend, Drawer } from './_stale-return-other-backend.js'
console.log(new Drawer(new Backend()).draw(new Producer(new Source())))
