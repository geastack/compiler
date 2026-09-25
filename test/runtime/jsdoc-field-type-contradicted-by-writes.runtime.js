// @ts-nocheck
//! expect: highp vec2 ab; vec1 c;
//! expect: lowp vec3 def;
//! expect: []
//! expect: render,render,frame 3
// three's node builders: the tag says each group name maps to a dictionary of
// groups, and every write stores one group. The writes win over the tag, so
// `shared.uniforms` is the group's array getter and iterates.
class Inner {
  constructor(precision) {
    this.precision = precision
  }
}
class Uniform {
  constructor(name, precision) {
    this._name = name
    this.nodeUniform = { node: new Inner(precision) }
  }
  get name() {
    return this._name
  }
  getType() {
    return 'vec' + this._name.length
  }
}
class Group {
  constructor(name) {
    this.name = name
    this.visibility = 0
    this._uniforms = []
  }
  get uniforms() {
    return this._uniforms
  }
  setVisibility(v) {
    this.visibility = v
  }
  addUniform(u) {
    this._uniforms.push(u)
    return this
  }
}

class Builder {
  constructor() {
    /**
     * @type {Object<string,Object<string,Group>>}
     */
    this.uniformGroups = {}
  }
  getUniformFromNode(groupName, uniformName, precision, bindings) {
    let uniformsGroup = this.uniformGroups[groupName]
    if (uniformsGroup === undefined) {
      uniformsGroup = new Group(groupName)
      uniformsGroup.setVisibility(3)
      this.uniformGroups[groupName] = uniformsGroup
    }
    bindings.push(uniformsGroup.name)
    uniformsGroup.addUniform(new Uniform(uniformName, precision))
  }
  getUniforms(groupName) {
    const snippets = []
    const sharedUniformGroup = this.uniformGroups[groupName]
    if (sharedUniformGroup !== undefined) {
      for (const sharedUniform of sharedUniformGroup.uniforms) {
        const type = sharedUniform.getType()
        const precision = sharedUniform.nodeUniform.node.precision
        let snippet = `${type} ${sharedUniform.name};`
        if (precision !== null) snippet = precision + ' ' + snippet
        snippets.push(snippet)
      }
    }
    return snippets.join(' ')
  }
}

const b = new Builder()
const bindings = []
b.getUniformFromNode('render', 'ab', 'highp', bindings)
b.getUniformFromNode('render', 'c', null, bindings)
b.getUniformFromNode('frame', 'def', 'lowp', bindings)
console.log(b.getUniforms('render'))
console.log(b.getUniforms('frame'))
console.log('[' + b.getUniforms('none') + ']')
console.log(bindings.join(',') + ' ' + b.uniformGroups['render'].visibility)
