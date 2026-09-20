//! expect: devices=a:front b:back
//! expect: modes=hours|days
//! emitted-has: ArrayObject<gea_record_type_
//! emitted-lacks: ArrayObject<gea::Ref<gea_record_type_

// A record whose fields are a string and a union of string LITERALS, held in an
// array.
//
// It qualifies to be carried by value -- nothing writes a field of it, nothing
// compares it by identity, and every field holds one primitive -- so the array
// is a contiguous `std::vector` of structs with no per-element allocation. The
// second field is the whole point: `'front' | 'back'` is not a `primitive`
// SHAPE, and reading only the shape kind judged it a reference, so a two-string
// struct paid a `gea::Ref` per element. The deriver carries that field as one
// `std::string`, and `representation/primitive-domain.ts` is now the single
// authority both it and the value-record proof ask.
//
// `modes` is the same shape one level simpler -- a bare literal union in an
// array -- so the fix is pinned at the field AND at the element.

type Facing = 'front' | 'back'
type Mode = 'hours' | 'days'

interface Device {
  readonly id: string
  readonly facing: Facing
}

const devices: Device[] = [
  { id: 'a', facing: 'front' },
  { id: 'b', facing: 'back' }
]

let out = ''
for (const device of devices) out += `${device.id}:${device.facing} `
console.log(`devices=${out.trim()}`)

const modes: Mode[] = ['hours', 'days']
console.log(`modes=${modes[0]}|${modes[1]}`)
