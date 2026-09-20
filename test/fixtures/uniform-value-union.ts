// three's uniform value model, stated natively: one disjoint union of every
// value a shader uniform can hold, a `{ value, needsUpdate? }` slot around it,
// and a string-keyed table of slots. `cloneUniforms` is the generic `for`-`in`
// copy three writes, and every consumer narrows the union with `instanceof`,
// `typeof`, `Array.isArray` or a type-guard function -- never a box.
class Vector3 {
  constructor(public x = 0) {}
  clone(): Vector3 {
    return new Vector3(this.x)
  }
}
class Matrix4 {
  elements: number[] = [1, 0]
  clone(): Matrix4 {
    const m = new Matrix4()
    m.elements = this.elements.slice()
    return m
  }
}
class LightUniform {
  intensity = 1
  direction = new Vector3(2)
}
type UniformValue = number | boolean | null | Vector3 | Matrix4 | LightUniform | number[] | Vector3[] | Matrix4[] | LightUniform[]
interface UniformSlot {
  value: UniformValue
  needsUpdate?: boolean
}
type Uniforms = Record<string, UniformSlot>

const isVector3Array = (value: UniformValue): value is Vector3[] => Array.isArray(value) && value.length > 0 && value[0] instanceof Vector3
const isNumberArray = (value: UniformValue): value is number[] => Array.isArray(value) && value.length > 0 && typeof value[0] === 'number'

function cloneValue(value: UniformValue): UniformValue {
  if (value instanceof Vector3) return value.clone()
  if (value instanceof Matrix4) return value.clone()
  if (isVector3Array(value)) return value.map((element) => element.clone())
  if (isNumberArray(value)) return value.slice()
  // An empty array has no arm of its own -- no guard above claims it -- and a
  // light array is replaced wholesale by its producer, so both are shared.
  return value
}

function cloneUniforms(src: Uniforms): Uniforms {
  const dst: Uniforms = {}
  for (const name in src) {
    const uniform = src[name]
    const cloned: UniformSlot = { value: cloneValue(uniform.value) }
    if (uniform.needsUpdate !== undefined) cloned.needsUpdate = uniform.needsUpdate
    dst[name] = cloned
  }
  return dst
}

function structuredMember(value: UniformValue, id: string | number): UniformValue {
  if (value instanceof LightUniform) {
    if (id === 'intensity') return value.intensity
    if (id === 'direction') return value.direction
  }
  if (Array.isArray(value)) return value[Number(id)]
  throw new Error('no structured member ' + String(id))
}

function describe(value: UniformValue): string {
  if (typeof value === 'number') return 'number ' + String(value)
  if (typeof value === 'boolean') return 'boolean ' + String(value)
  if (value === null) return 'null'
  if (value instanceof Vector3) return 'vector3 ' + String(value.x)
  if (value instanceof Matrix4) return 'matrix4 ' + value.elements.join('/')
  if (value instanceof LightUniform) return 'light ' + String(value.intensity)
  if (isNumberArray(value)) return 'numbers ' + value.join(',')
  if (isVector3Array(value)) return 'vectors ' + String(value.length)
  return 'array ' + String(value.length)
}

const template: Uniforms = {
  opacity: { value: 1 },
  flip: { value: true },
  map: { value: null },
  position: { value: new Vector3(3) },
  model: { value: new Matrix4() },
  ambient: { value: [0.5, 0.25, 0.125] },
  probe: { value: [new Vector3(7), new Vector3(8)] },
  matrices: { value: [new Matrix4()] },
  lights: { value: [new LightUniform()], needsUpdate: false }
}
const copy = cloneUniforms(template)
const position = copy['position'].value
if (position instanceof Vector3) position.x = 30
copy['opacity'].value = 0.5
copy['lights'].needsUpdate = true
for (const name in copy) {
  const slot = copy[name]
  console.log(name, describe(slot.value), slot.needsUpdate === undefined ? 'always' : String(slot.needsUpdate))
}
console.log(describe(template['position'].value), describe(template['opacity'].value))
console.log(describe(structuredMember(structuredMember(template['lights'].value, 0), 'direction')))
console.log(describe(structuredMember(template['probe'].value, 1)))
