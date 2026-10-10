// A 3D scene-graph library's render-output pass: a constructor function whose `this.begin = function (
// renderer, renderTarget ) { ... this.setSize( w, h ) ... return true }` is
// the one member that reads `this`, beside siblings that only close over
// locals. The member is called through its owner (`output.begin( r, t )`),
// so its slot must keep the receiver the function body reads.
function Output(width) {
  let size = width
  let compositing = false
  /** @param {any} next */
  this.setSize = function (next) {
    size = next
  }
  /**
   * @param {any} renderer
   * @param {any} target
   */
  this.begin = function (renderer, target) {
    if (compositing) return false
    if (target !== null && target.width !== size) this.setSize(target.width)
    renderer.calls++
    return true
  }
  this.isCompositing = function () {
    return compositing
  }
  this.size = function () {
    return size
  }
}

const output = new Output(4)
const renderer = { calls: 0 }
console.log(output.begin(renderer, { width: 9 }), output.size(), renderer.calls)
console.log(output.begin(renderer, null), output.size(), output.isCompositing())

//! expect: true 9 1
//! expect: true 9 false
