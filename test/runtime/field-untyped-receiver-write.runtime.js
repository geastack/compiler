//! expect: none
//! expect: observer 7
//! expect: again 8
// three's `NodeBuilder.observer`: a field initialized to `null` in the
// constructor and filled only through a receiver the checker cannot type --
// `builder.observer = this.setupObserver( builder )` in `NodeMaterial.build`,
// under a `@param {NodeBuilder}` tag its file cannot resolve, so `builder` is
// typed by its call sites alone. That write is still a write into the field.
import { ShaderBuilder } from './_field-untyped-receiver-builder.js'
import { Material } from './_field-untyped-receiver-material.js'

const builder = new ShaderBuilder()
console.log(builder.observer === null ? 'none' : 'early')
const material = new Material()
material.build(builder)
console.log(builder.observer === null ? 'none' : 'observer ' + builder.observer.id)
material.build(builder)
console.log(builder.observer === null ? 'none' : 'again ' + builder.observer.id)
