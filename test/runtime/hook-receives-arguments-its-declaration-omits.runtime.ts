// ECMA-262 13.3.8.1: a call passes every argument it spells, and the function
// a method slot holds when the call runs binds them, however few parameters
// the class's own declaration of that method names. A hook declared with no
// parameters, called with two and replaced through an `any` write, used to
// receive `undefined`: the call bound to the declared zero-parameter frame
// and dropped both arguments before the stored replacement could bind them.
//! expect: replaced time renderer
//! expect: default ran
//! expect: done

class Material {
  name = 'm'
  onBeforeCompile(/* shader, renderer */) {
    console.log('default ran')
  }
}
class Renderer {
  tag = 'renderer'
  compile(material: Material) {
    const parameters = { uniforms: { time: 1 } }
    // @ts-expect-error -- the declaration documents its parameters in a comment only
    material.onBeforeCompile(parameters, this)
  }
}
type Shader = any

const renderer = new Renderer()
const material = new Material()
;(material as any).onBeforeCompile = (shader: Shader, by: Renderer) => {
  console.log('replaced ' + Object.keys(shader.uniforms).join(',') + ' ' + by.tag)
}
renderer.compile(material)
renderer.compile(new Material())
console.log('done')
