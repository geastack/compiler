// three's TSL `Fn( jsFunc, layout = null )` forwards its layout to `new
// FnNode( jsFunc, layout )`, whose `setLayout` stores it into the shader node's
// `this.layout = null` placeholder -- a member `NodeBuilder.flowShaderNode`
// reads from outside the class. Three defects met here: the overlay restated
// the member as `@type {null}` off the constructor's placeholder alone (a
// `std::nullptr_t` field the record write aborted on), and the default-only
// `layout` reached `FnNode` as the checker's `null` -- both the forwarded read
// and the callee's binding -- so every passed layout and node type was lost.
//! emitted-lacks: std::nullptr_t layout;
//! expect: layout f 1 f
//! expect: typed void null
//! expect: stated vec3 fn0 float
export {}

class Node {
  constructor(nodeType = null) {
    this.nodeType = nodeType
  }
}

class ShaderNodeInternal extends Node {
  constructor(jsFunc, nodeType) {
    super(nodeType)
    this.jsFunc = jsFunc
    this.layout = null
  }
  setLayout(layout) {
    this.layout = layout
    return this
  }
  getLayout() {
    return this.layout
  }
}

function ShaderNode(jsFunc, nodeType) {
  return new ShaderNodeInternal(jsFunc, nodeType)
}

let fnId = 0

class FnNode extends Node {
  constructor(jsFunc, layout = null) {
    super()
    let nodeType = null
    if (layout !== null) {
      // @ts-ignore
      if (typeof layout === 'object') nodeType = layout.return
      else {
        if (typeof layout === 'string') nodeType = layout
        layout = null
      }
    }
    // @ts-ignore
    this.shaderNode = new ShaderNode(jsFunc, nodeType)
    if (layout !== null) this.setLayout(layout)
  }
  setLayout(layout) {
    const nodeType = this.shaderNode.nodeType
    if (typeof layout.inputs !== 'object') {
      const fullLayout = { name: 'fn' + fnId++, type: nodeType, inputs: [] }
      for (const name in layout) {
        if (name === 'return') continue
        // @ts-ignore
        fullLayout.inputs.push({ name: name, type: layout[name] })
      }
      layout = fullLayout
    }
    this.shaderNode.setLayout(layout)
    return this
  }
}

function Fn(jsFunc, layout = null) {
  const instance = new FnNode(jsFunc, layout)
  return new Proxy(() => {}, {
    get(target, prop, receiver) {
      return Reflect.get(instance, prop, receiver)
    }
  })
}

/** @param {ShaderNodeInternal} shaderNode */
function flowShaderNode(shaderNode) {
  const layout = shaderNode.layout
  shaderNode.layout = null
  // @ts-ignore
  const name = layout.name
  shaderNode.layout = layout
  return name
}

const shaderOf = (/** @type {any} */ fn) => fn.shaderNode

// @ts-ignore
const f = Fn(() => 1).setLayout({ name: 'f', type: 'float', inputs: [{ name: 'a', type: 'float' }] })
const layout = f.shaderNode.getLayout()
console.log('layout', layout.name, layout.inputs.length, flowShaderNode(f.shaderNode))
// @ts-ignore
const g = Fn(() => 2, 'void')
console.log('typed', shaderOf(g).nodeType, shaderOf(g).getLayout())
// @ts-ignore
const h = Fn(() => 3, { a: 'float', return: 'vec3' })
console.log('stated', shaderOf(h).nodeType, shaderOf(h).getLayout().name, shaderOf(h).getLayout().inputs[0].type)
