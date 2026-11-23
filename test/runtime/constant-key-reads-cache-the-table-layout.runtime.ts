//! expect: clones 1 1 1 2 2 2
//! expect: other 7 absent
//! expect: deleted absent 2
//! expect: appended 5 9
//! expect: reordered 3 4
//! expect: missing absent absent
//! expect: loop 9000
// A constant key read off a string-keyed table asks the site's cache first:
// tables holding the same keys in the same order -- tables cloned from one
// template, the way three builds a material's uniforms -- share a layout, and a
// site that read one reads the same slot of any other without hashing the key.
// Every change of a table's keys gives it a new layout, so a site never reads a
// slot a deletion, an insertion or a different order moved.

type Table = Record<string, number>
const template: Table = { diffuse: 1, opacity: 2, map: 3 }
const clone = (source: Table): Table => {
  const out: Table = {}
  for (const key of Object.keys(source)) out[key] = source[key]!
  return out
}
const show = (value: number | undefined): string => (value === undefined ? 'absent' : String(value))
const diffuseOf = (table: Table): string => show(table['diffuse'])
const opacityOf = (table: Table): string => show(table['opacity'])

const clones = [clone(template), clone(template), clone(template)]
console.log('clones ' + clones.map(diffuseOf).join(' ') + ' ' + clones.map(opacityOf).join(' '))

const other: Table = { roughness: 5, diffuse: 7 }
console.log('other ' + diffuseOf(other) + ' ' + show(other['map']))

const shrunk = clone(template)
delete shrunk['diffuse']
console.log('deleted ' + diffuseOf(shrunk) + ' ' + opacityOf(shrunk))

const grown = clone(template)
grown['emissive'] = 9
grown['diffuse'] = 5
console.log('appended ' + diffuseOf(grown) + ' ' + show(grown['emissive']))

const reordered: Table = {}
reordered['map'] = 1
reordered['opacity'] = 4
reordered['diffuse'] = 3
console.log('reordered ' + diffuseOf(reordered) + ' ' + opacityOf(reordered))

const empty: Table = {}
console.log('missing ' + diffuseOf(empty) + ' ' + diffuseOf(shrunk))

let sum = 0
for (let i = 0; i < 1000; i++) for (const table of clones) sum += table['diffuse']! + table['opacity']!
console.log('loop ' + sum)
