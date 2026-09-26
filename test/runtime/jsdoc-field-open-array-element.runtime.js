// @ts-nocheck
// three's `NodeFunction` stores its `@param {Array<NodeFunctionInput>}` into a
// field tagged `@type {Array<NodeFunctionInput>}`, a name neither file can
// bind, and each subclass passes the array its parser built through `super`.
// The field's tag states the container and nothing about the element, so it is
// narrowed like the parameter it is filled from: one array, shared by the
// field and by the caller that built it.
class Input {
  constructor(name) {
    this.name = name
  }
}

class NodeFunction {
  /**
   * @param {string} type - The return type.
   * @param {Array<NodeFunctionInput>} inputs - The function's inputs.
   */
  constructor(type, inputs) {
    /** @type {string} */
    this.type = type
    /**
     * The function's inputs.
     * @type {Array<NodeFunctionInput>}
     */
    this.inputs = inputs
  }
}

const parse = (source) => {
  const inputs = []
  for (const part of source.split(',')) inputs.push(new Input(part))
  return { type: 'void', inputs }
}

class GLSLFunction extends NodeFunction {
  constructor(source) {
    const { type, inputs } = parse(source)
    super(type, inputs)
    inputs.push(new Input('glsl'))
  }
}

class WGSLFunction extends NodeFunction {
  constructor(source) {
    const { type, inputs } = parse(source)
    super(type, inputs)
  }
}

const glsl = new GLSLFunction('x,y')
const wgsl = new WGSLFunction('z')
console.log(glsl.inputs.length, glsl.inputs.map((input) => input.name).join(''), wgsl.inputs[0].name, wgsl.type)
//! expect: 3 xyglsl z void
