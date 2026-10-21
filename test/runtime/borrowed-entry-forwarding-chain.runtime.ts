//! expect: cleared=5 kept=-1
//! expect: chain=228 calls=12
//! emitted-has: & gea_arg_0, double gea_arg_1, long long gea_arg_2) {
//! emitted-has: , static_cast<
//! emitted-has: _stable_borrow(gea_arg_0.get<0>(), gea_arg_1, gea_arg_2);
// A union or handle forwarded through a chain of read-only bodies is passed by
// reference at every level (`borrowed-call-entry.ts`): a body whose only use of
// a formal is handing it to a borrowed position of its callee borrows it too,
// a body whose integer formal the census narrowed still has a borrowed entry,
// and an argument read from a field is copied by itself while its siblings are
// still bound in place. The copy is what keeps `clear` correct: it drops the
// field's last reference before reading its own formal.
class Item {
  n: number
  constructor(n: number) {
    this.n = n
  }
}

class Holder {
  item: Item | null = new Item(5)
}

function clear(holder: Holder, item: Item | null): number {
  holder.item = null
  return item === null ? -1 : item.n
}

const holder = new Holder()
const first = clear(holder, holder.item)
const second = clear(holder, holder.item)
console.log(`cleared=${first} kept=${second}`)

type Value = number | number[] | Float32Array | Item

class Sink {
  total = 0
  calls = 0
  take(n: number): void {
    this.total += n
    this.calls++
  }
}

function sum(value: Value, count: number, stride: number): number {
  if (typeof value === 'number') return value * stride
  if (value instanceof Item) return value.n * stride
  let total = 0
  for (let i = 0; i < count; i++) total += value[i] ?? 0
  return total * stride
}

class Scalar {
  apply(sink: Sink, value: Value): void {
    sink.take(sum(value, 1, 1))
  }
}

class Vector {
  size: number
  constructor(size: number) {
    this.size = size
  }
  apply(sink: Sink, value: Value): void {
    sink.take(sum(value, this.size, 4))
  }
}

function dispatch(setter: Scalar | Vector, sink: Sink, value: Value): void {
  setter.apply(sink, value)
}

class Slot {
  value: Value
  constructor(value: Value) {
    this.value = value
  }
}

const sink = new Sink()
const setters: (Scalar | Vector)[] = [new Scalar(), new Vector(3), new Scalar(), new Vector(2)]
const slots = [new Slot(7), new Slot([1, 2, 3]), new Slot(new Item(9)), new Slot(new Float32Array([4, 5]))]
for (let round = 0; round < 3; round++) for (let i = 0; i < setters.length; i++) dispatch(setters[i]!, sink, slots[i]!.value)
console.log(`chain=${sink.total} calls=${sink.calls}`)
