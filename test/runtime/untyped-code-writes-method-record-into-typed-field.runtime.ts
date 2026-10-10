// A 3D scene-graph library's renderer keeps `state` and `properties` as records whose
// fields are functions (`{ enable, disable, ... }` from a factory). Once the
// renderer reaches code the program cannot see, that code may replace the
// record wholesale -- `renderer.state = { ... }` -- and the typed renderer then
// calls through the fields it was handed. The record must be read through the
// incoming value: each function field becomes a native callable that calls
// the held function with its typed arguments and converts its result back.
function makeState() {
  let enabled = 0
  function enable(flag: number): void {
    enabled += flag
  }
  function count(): number {
    return enabled
  }
  return { enable, count }
}

class Renderer {
  state = makeState()
  draw(): number {
    this.state.enable(2)
    this.state.enable(3)
    return this.state.count()
  }
}

const renderer = new Renderer()
console.log(renderer.draw())

let calls = 0
const unknown: any = renderer
unknown.state = {
  enable(flag: number) {
    calls += flag * 10
  },
  count() {
    return calls + 1
  }
}
console.log(renderer.draw())

//! expect: 5
//! expect: 51
