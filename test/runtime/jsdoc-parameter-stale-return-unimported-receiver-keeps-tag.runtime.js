// @ts-nocheck
//! expect: 2 true
//! emitted-lacks: gea::Value::box
// A `@return` tag the same round blanks is no evidence against a parameter
// tag, also where the call's receiver is typed by a tag naming a class its
// file never imports. `Producer.getItem` states `@return {Plain}` and returns
// the `Packed` its source holds; the census round blanks that tag. Read at
// it, `backend.key( item )` passed a `Plain` and erased the correct `@param
// {Packed} item`, because the check for a blanked `@return` asked the
// checker for the callee, which resolves `producer.getItem()` through the
// unimported `@param {Producer}` to no declaration. With the census of
// `key`'s callers left open by `callback.bind( this )`, the parameter was
// refused. The callee is now resolved by the program-wide name, as the
// evidence itself was, and the tag stands: `item` is a native `Packed`.
// three's `WebGLBackend` reads `renderObject.getAttributes()` under such a
// `@param {RenderObject}`.
import Source from './_stale-return-source.js'
import Producer from './_stale-return-producer.js'
import { Backend, Drawer } from './_stale-return-backend.js'
console.log(new Drawer(new Backend()).draw(new Producer(new Source())))
