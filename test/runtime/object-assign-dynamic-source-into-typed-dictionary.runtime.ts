// `Object.assign( table, extra )` where `table` is a string-keyed dictionary of
// typed values and `extra` is an `any` -- a 3D scene-graph library's
// color-management `define( colorSpaces )` merging definitions into `spaces`.
// Each enumerable own key of the dynamic source is stored through the checked
// unbox of the table's value type.
interface Space {
  readonly primaries: number
  readonly name: string
}

function define(spaces: Record<string, Space>, definitions: any): void {
  Object.assign(spaces, definitions)
}

const spaces: Record<string, Space> = { srgb: { primaries: 1, name: 'srgb' } }
define(spaces, JSON.parse('{"p3":{"primaries":2,"name":"p3"},"srgb":{"primaries":3,"name":"srgb-v2"}}') as any)
console.log(Object.keys(spaces).join(','), spaces.p3?.primaries, spaces.srgb?.name)

//! expect: srgb,p3 2 srgb-v2
