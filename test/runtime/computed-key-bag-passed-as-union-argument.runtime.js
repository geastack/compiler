// @ts-nocheck
// An empty literal filled through computed keys is a typed table (a 3D
// scene-graph library's material uniforms keyed by name), and passed to an
// untyped parameter beside a class instance it is one arm of that parameter's
// union -- the library's per-object GPU property store,
// `update(object, key, value)`. The checker types the literal
// `{}`, which every object is assignable to; that must not make the empty
// literal the parameter's whole type (the class instance and the filled table
// would each need a conversion into an empty record). A read the checker
// narrowed by `instanceof` keeps its narrowed arm.
class Material {
  constructor(name) {
    this.name = name
  }
}

const log = []
const table = {}
function update(object, key, value) {
  log.push(object.name + ':' + key + ':' + (value instanceof Material ? value.name : 'table'))
  table[key] = value
}

const base = new Material('base')
const mesh = new Material('mesh')
update(base, 'next', mesh)
const uniforms = {}
for (const name of ['map', 'envMap']) uniforms[name] = new Material(name)
update(base, 'uniforms', uniforms)
console.log(log.join(' '))
console.log(table.next === mesh, table.uniforms === uniforms, uniforms.map.name + '+' + uniforms.envMap.name)

//! expect: base:next:mesh base:uniforms:table
//! expect: true true map+envMap

export {}
