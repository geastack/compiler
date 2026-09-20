// A call with MORE arguments than the callee declares.
//
// three.js's `Object3D.onAfterRender( /* renderer, scene, camera, geometry,
// material, group */ ) {}` names its six formals entirely inside a comment and
// is called with all six -- ordinary JavaScript, and 10.2.1.1 binds only the
// declared formals, so no body can observe the rest. C++ has no such
// tolerance, so the extras are dropped from the frame rather than converted
// into slots that do not exist.
//
// Dropping the ARGUMENT is not dropping its EVALUATION: each one is a result
// some earlier operation already computed, and `effects` below is what proves
// the difference.
let effects = ''
const mark = (tag: string): number => {
  effects += tag
  return tag.length
}

class Renderer {
  frames = 0
  onAfterRender(): void {
    this.frames += 1
  }
}

const renderer = new Renderer()
// @ts-expect-error TS2554 -- TypeScript rejects the arity JavaScript accepts.
renderer.onAfterRender(mark('a'), mark('b'), mark('c'))

console.log(`frames=${renderer.frames}`)
console.log(`effects=${effects}`)

//! expect: frames=1
//! expect: effects=abc
