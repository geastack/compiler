// @ts-nocheck
// three's `NodeFunction` sets `NodeFunction.isNodeFunction = true` beside its
// class, and its `@param {Array<NodeFunctionInput>}` names a type its file
// cannot bind. A store on the static side or a primitive read from it hands
// nobody the constructor, so `super( inputs )` from each subclass is still
// every caller, and the typed array they pass is what the parameter holds.
class Input {
  constructor(name) {
    this.name = name
  }
}

class Base {
  /**
   * @param {Array<FunctionInput>} inputs - The inputs.
   */
  constructor(inputs) {
    /** @type {Array<FunctionInput>} */
    this.inputs = inputs
  }

  names() {
    let names = ''
    for (const input of this.inputs) names += input.name
    return names
  }
}

Base.isBase = true
Base.KIND = 'base'

class Left extends Base {
  constructor(source) {
    const inputs = []
    for (const name of source.split(' ')) inputs.push(new Input(name))
    super(inputs)
  }
}

class Right extends Base {
  constructor() {
    super([new Input('r')])
    this.inputs.push(new Input('s'))
  }
}

console.log(new Left('a b').names(), new Right().names(), Base.isBase, Base.KIND)
//! expect: ab rs true base
