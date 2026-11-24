// An `Object.assign` source literal has no contextual type, so its array slot
// types `{ name: string; obj: null }[]` while every reader of the merged
// options reads `{ obj: unknown; name: string }[]`, pushes entries into it and
// stores arbitrary values into their `obj`. The array is one storage shared by
// the literal and its readers: it must be built at the readers' element, so
// the pushes and stores land in the very array every reader sees.

export {}
interface SerializeOptions {
  relaxed?: boolean
}
type InternalOptions = SerializeOptions & { seen: { obj: unknown; name: string }[] }
function walk(value: unknown, options: InternalOptions): void {
  options.seen.push({ name: 'child', obj: null })
  options.seen[options.seen.length - 1]!.obj = value
}
function describe(options: InternalOptions): string {
  return options.seen.map((entry) => entry.name + '=' + String(entry.obj)).join(',') + ' ' + options.relaxed
}
function serialize(options?: SerializeOptions): string {
  const merged = Object.assign({ relaxed: true }, options, { seen: [{ name: '(root)', obj: null }] })
  walk(7, merged)
  walk('s', merged)
  return describe(merged)
}
console.log(serialize({ relaxed: false }))
console.log(serialize())
//! expect: (root)=null,child=7,child=s false
//! expect: (root)=null,child=7,child=s true
