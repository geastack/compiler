// @ts-nocheck
// three's `Renderer._compilationPromises` (`renderers/common/Renderer.js`)
// states `?Array<Promise>`, and `_createObjectPipeline` pushes work items into
// it: object literals with no `then`, which no promise is. In an unchecked
// file the push contradicts the tag, so the tag is blanked and the field takes
// what the program writes, rather than allocating a record as a promise.
//
// The field's writes type it `any[] | null`, while the `[]` it is assigned
// takes its element from the records pushed through the field. The field's
// array arm now takes that same element (the member half of
// `inferredNullableArrayAt`), so the literal, the field and the local that
// reads it back are one array and the program runs.
class Renderer {
  constructor() {
    /**
     * @type {?Array<Promise>}
     * @default null
     */
    this._compilationPromises = null
  }
  compile(objects) {
    this._compilationPromises = []
    for (const object of objects) this._createObjectPipeline(object, 1)
    const compilationPromises = this._compilationPromises
    this._compilationPromises = null
    let names = ''
    let passes = 0
    for (const item of compilationPromises) {
      names += item.object
      passes += item.passId
    }
    return `${names} ${passes}`
  }
  _createObjectPipeline(object, passId) {
    if (this._compilationPromises !== null) {
      this._compilationPromises.push({ object, passId })
      return
    }
  }
}
console.log(new Renderer().compile(['a', 'b']))
//! expect: ab 2
