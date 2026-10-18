//! expect: stage backdrop none
//! expect: stage backdrop sky
//! expect: prop TypeError Value is not an instance of the class this assertion names
//! emitted-has: gea::host::assertedDowncastClassRef<
// three's WebGLRenderer renders any Object3D (Sakura's post pass renders a
// Mesh) and hands it to `background.render( scene )`. `background` is untyped,
// so the checker never matches that call, and the body value flow finds for it
// was annotated `@param {Scene}`. The base handle entered the parameter through
// the downcast an `instanceof` guard licenses, with no guard, and the body read
// the Mesh's bytes as a Scene. The argument is now checked: a Scene enters as
// itself, anything else is a TypeError at the call.
//
// Node prints `prop backdrop none` for the last line: JavaScript never checks
// the annotation. Matching it needs the parameter to state what callers pass.

class StageNode {
  constructor() {
    this.name = ''
  }
}

class StageScene extends StageNode {
  constructor() {
    super()
    this.isStageScene = true
    /** @type {string | null} */
    this.backdrop = null
  }
}

class StageProp extends StageNode {
  constructor() {
    super()
    this.isStageProp = true
  }
}

function makeBackdropPass() {
  /** @param {StageScene} scene */
  function render(scene) {
    return scene.isStageScene === true && scene.backdrop !== null ? scene.backdrop : 'none'
  }
  return { render }
}

/** @type {any} */
let pass
pass = makeBackdropPass()

/** @param {StageNode} node */
function draw(node) {
  try {
    console.log(node.name, 'backdrop', pass.render(node))
  } catch (error) {
    console.log(node.name, error instanceof TypeError ? 'TypeError' : 'other', error instanceof Error ? error.message : '')
  }
}

const scene = new StageScene()
scene.name = 'stage'
draw(scene)
scene.backdrop = 'sky'
draw(scene)
const prop = new StageProp()
prop.name = 'prop'
draw(prop)
