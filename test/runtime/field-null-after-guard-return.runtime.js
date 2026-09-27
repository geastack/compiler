// @ts-nocheck
//
// A field read past `if ( this.x !== null ) { ...; return }` can only be
// `null` (three's Renderer._createObjectPipeline: `this._compilationPromises`
// handed to `getForRender( ..., this._compilationPromises )` after the guard
// that returns when it is set). The checker leaves the read of an unstated
// field open, so the read kept the field's array arm and the call into the
// `?Array<Promise>` parameter was refused. The forward walk over the method
// (`valuesReachingRead`) sees the guard's `return` and keeps only `null`.
//
// Open script scope, as `--dynamic-fallback` compiles it: there the
// parameter keeps its stated `?Array<Promise>`, as three's does. A closed
// script's census contradicts it to a dynamic value, which hides the pair.
//! dynamic-fallback
class Pipelines {
  /**
   * @param {number} id
   * @param {?Array<Promise>} [promises=null]
   */
  getForRender(id, promises = null) {
    if (promises !== null) promises.push(Promise.resolve(id))
    return id
  }
}

class Renderer {
  constructor() {
    this._pipelines = new Pipelines()
    this._compilationPromises = null
    this.done = 0
  }
  compile(n) {
    const previousCompilationPromises = this._compilationPromises
    const compilationPromises = []
    this._compilationPromises = compilationPromises
    for (let i = 0; i < n; i++) this._render(i)
    this._compilationPromises = previousCompilationPromises
    for (const item of compilationPromises) this.done += item.id
    return compilationPromises.length
  }
  _render(i) {
    if (this._compilationPromises !== null) {
      this._compilationPromises.push({ id: i, name: 'w' + i })
      return
    }
    this.done += this._pipelines.getForRender(i, this._compilationPromises)
  }
}

const r = new Renderer()
console.log(r.compile(3), r.done)
r._render(5)
console.log(r.done)
//! expect: 3 3
//! expect: 8
