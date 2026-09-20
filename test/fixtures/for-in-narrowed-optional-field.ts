// A `for`-`in` over an optional record FIELD behind its own `!== undefined`
// guard -- three's `WebGLPrograms.getProgramCacheKey` over
// `parameters.defines`, once `Material.defines` is typed `Record | undefined`.
// ECMA-262 14.7.5.5 runs the loop zero times for an absent source, and the
// checker narrows the guarded read to the record; the loop must key on that
// narrowed carrier, not on the field's optional storage.
class Material {
  defines: Record<string, string | number | boolean> | undefined = undefined
}
class ShaderMaterial extends Material {
  constructor() {
    super()
    this.defines = {}
  }
}
function getParameters(material: Material) {
  return { defines: material.defines, precision: 'highp' }
}
function getProgramCacheKey(parameters: ReturnType<typeof getParameters>): string {
  const array: (string | number | boolean)[] = []
  array.push(parameters.precision)
  if (parameters.defines !== undefined) {
    for (const name in parameters.defines) {
      array.push(name)
      const value = parameters.defines[name]
      if (value !== undefined) array.push(value)
    }
  }
  return array.join(',')
}
const shader = new ShaderMaterial()
const defines = shader.defines
if (defines !== undefined) {
  defines['VSM_SAMPLES'] = 8
  defines['USE_FOG'] = true
}
console.log(getProgramCacheKey(getParameters(shader)))
console.log(getProgramCacheKey(getParameters(new Material())))
// And the same loop with no guard at all, over a union the checker cannot
// narrow: the language runs it zero times for an absent table.
function countKeys(table: Record<string, number> | undefined): number {
  let count = 0
  for (const key in table) {
    count = count + 1
    console.log(key)
  }
  return count
}
console.log(countKeys(undefined))
console.log(countKeys({ a: 1, b: 2 }))
