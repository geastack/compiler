// @ts-nocheck
//
// A field that is `null` until a method stores a fresh `[]` in it, pushes
// through the field, and restores the old value (three's Renderer
// `_compilationPromises`: `= null` in the constructor, `= compilationPromises`
// in `compileAsync`, `.push( {...} )` in `_createObjectPipeline`). The literal,
// the local and the field are one array, and the census gives the literal the
// pushed record as its element. The field was laid out off the checker's
// `never[] | null`, so its array arm held nothing: storing the literal into it
// and restoring the saved value both refused. The field's array arm now takes
// the component's element; the `null` arm stays.
class Renderer {
  constructor() {
    this._compilationPromises = null
    this.direct = 0
  }
  compile(n) {
    const previous = this._compilationPromises
    const compilationPromises = []
    this._compilationPromises = compilationPromises
    for (let i = 0; i < n; i++) this.render(i)
    this._compilationPromises = previous
    let sum = 0
    for (const item of compilationPromises) sum += item.id
    return compilationPromises.length + ' ' + sum + ' ' + compilationPromises[0].name
  }
  render(i) {
    if (this._compilationPromises !== null) {
      this._compilationPromises.push({ id: i, name: 'w' + i })
      return
    }
    this.direct += i
  }
}
const r = new Renderer()
console.log(r.compile(3))
r.render(5)
console.log(r.direct, r._compilationPromises === null)
//! expect: 3 3 w0
//! expect: 5 true
