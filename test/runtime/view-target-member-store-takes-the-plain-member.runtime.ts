//! expect: plain=2,12,3
//! expect: viewed=6,7,dyn=7
//! expect: keys=value,label
//! expect: table=4,9,b
//! emitted-has: gea::record::writeLiveField
// A record type that some dynamic writer may store a view into is a
// program-wide view target: three's uniform `{ value }` records are, because
// a fully reflected uniforms table can be assigned from untyped code. A store
// into such a record still asks first whether the receiver is a live view; a
// plain allocation then takes its own member store, exactly as a record that
// is no view target does, instead of the string-keyed own-field protocol.
// Both answers must stay the language's: the plain records, a viewed record
// written through its view, and the original the view reads.

interface Uniform {
  value: number
  label: string
}

class Holder {
  list: Uniform[] = []
}

const holder = new Holder()
holder.list.push({ value: 1, label: 'a' })
holder.list.push({ value: 11, label: 'b' })
for (const uniform of holder.list) uniform.value = uniform.value + 1
const extra: Uniform = { value: 2, label: 'c' }
extra.value += 1
console.log(`plain=${holder.list.map((uniform) => uniform.value).join(',')},${extra.value}`)

const untyped: any = new Holder()
const original = { value: 5, label: 'x' }
untyped.list = [original, { value: 6, label: 'y' }]
const viewed: Holder = untyped
for (const uniform of viewed.list) uniform.value = uniform.value + 1
console.log(`viewed=${viewed.list[0]!.value},${viewed.list[1]!.value},dyn=${untyped.list[1].value}`)
console.log(`keys=${Object.keys(holder.list[0]!).join(',')}`)

// A table entry is read as `Uniform | undefined`: the store's receiver is the
// optional, and its present payload takes the same plain member store.
const table: Record<string, Uniform> = { first: { value: 1, label: 'a' }, second: { value: 2, label: 'b' } }
table['first']!.value = 4
const second = table['second']
second!.value = second!.value + 7
console.log(`table=${table['first']!.value},${table['second']!.value},${second!.label}`)
