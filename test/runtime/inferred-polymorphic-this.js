// @ts-nocheck
// The compiler infers this JavaScript helper from its callers.
class Renderer {
  constructor() {
    this.value = 7
    inspect(this)
  }
  again() {
    inspect(this)
  }
}
function inspect(renderer) {
  console.log(renderer.value)
}
const renderer = new Renderer()
renderer.again()
