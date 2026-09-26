// @ts-nocheck
//! expect: -1
//! expect: 2 true
// A JS field's `@type` naming a class its file never imports, where that class
// is its module's DEFAULT export: three's `Pipelines.js` declares
// `/** @type {?Bindings} */ this.bindings = null`, and `Bindings.js` (which
// `Pipelines.js` does not import) fills it `this.pipelines.bindings = this`.
// The field holds what the tag says -- a Bindings or null -- not only the
// `null` its own file writes.
import Pipelines from './_late-field-pipelines.js'
import Bindings from './_late-field-bindings.js'

const pipelines = new Pipelines('gpu')
console.log(pipelines.count())
const bindings = new Bindings(pipelines)
console.log(pipelines.count() + ' ' + (pipelines.bindings === bindings))
