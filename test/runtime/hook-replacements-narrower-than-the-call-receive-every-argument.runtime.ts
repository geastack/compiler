// A method slot replaced three ways -- through an `any` write, through a typed
// write whose replacement declares fewer parameters than the call passes, and
// from untyped JavaScript -- carries every argument the call spells. The
// typed replacement used to set the slot's frame on its own, so the call
// dropped the argument past it before a wider replacement could bind it.
//! expect: dynamic time renderer
//! expect: typed time
//! expect: untyped time object
//! expect: done
import { installUntyped } from './_hook-arguments-untyped-writer.js'

class Material {
  name = 'm'
  onBeforeCompile(/* shader, renderer */) {}
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
const dynamic = new Material()
;(dynamic as any).onBeforeCompile = (shader: Shader, by: Renderer) => {
  console.log('dynamic ' + Object.keys(shader.uniforms).join(',') + ' ' + by.tag)
}
renderer.compile(dynamic)

const typed = new Material()
typed.onBeforeCompile = (shader?: Shader) => {
  console.log('typed ' + Object.keys(shader.uniforms).join(','))
}
renderer.compile(typed)

const untyped = new Material()
installUntyped(untyped, (line: string) => console.log(line))
renderer.compile(untyped)
console.log('done')
