//! expect: first=1,12,15,-
//! expect: second=15,1,12,-
//! expect: deleted=-,12,15,-,40
//! expect: loop=21,21,21
// A constant-key read of a string-keyed table remembers, per read site, the
// position it last found its key at -- three's uniform tables, cloned from one
// template, keep a key at one position. The answer must stay the table's own
// whatever the hint says: tables with other key orders, deleted keys that
// shift later entries, a key past a dozen entries (the hashed index), and a
// missing key.

interface Uniform {
  value: number
}

function build(order: readonly string[]): Record<string, Uniform> {
  const table: Record<string, Uniform> = {}
  for (const key of order) table[key] = { value: key.length + (key === 'opacity' ? -6 : 0) }
  return table
}

const keys = [
  'diffuse',
  'opacity',
  'map',
  'mapTransform',
  'alphaMap',
  'alphaTest',
  'specularMap',
  'envMap',
  'flipEnvMap',
  'reflectivity',
  'ior',
  'refractionRatio'
]
const first = build(keys)
const second = build([...keys].reverse())

function describe(table: Record<string, Uniform>, order: 'a' | 'b'): string {
  const opacity = table['opacity']
  const reflectivity = table['reflectivity']
  const refraction = table['refractionRatio']
  const missing = table['emissive']
  const values = [opacity, reflectivity, refraction, missing].map((u) => (u === undefined ? '-' : String(u.value)))
  return order === 'a' ? values.join(',') : [values[2], values[0], values[1], values[3]].join(',')
}

console.log(`first=${describe(first, 'a')}`)
console.log(`second=${describe(second, 'b')}`)
delete first['opacity']
first['extra'] = { value: 40 }
const extra = first['extra']
console.log(`deleted=${describe(first, 'a')},${extra === undefined ? '-' : extra.value}`)

let total = 0
const results: number[] = []
for (const table of [second, build(keys), second]) {
  total = 0
  for (let i = 0; i < 3; i++) {
    const r = table['refractionRatio']
    const f = table['flipEnvMap']
    total += (r === undefined ? 0 : r.value) - (f === undefined ? 0 : f.value) + 2
  }
  results.push(total)
}
console.log(`loop=${results.join(',')}`)
