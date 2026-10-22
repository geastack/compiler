// An annotated class field is the program's statement about what it holds,
// but an `any` value reaches it unchecked: a document read off an
// `any`-valued record stores whatever the document held. Node stores it; the
// native field was laid out from the annotation and the store aborted in its
// checked unbox on the first value of another type. A typed field every
// write of which is typed (`Tally.total`) keeps its native carrier.
const show = (value: unknown): string => `${typeof value}:${String(value)}`

class Description {
  label: string = 'none'
  count: number
  constructor(document: Record<string, any>) {
    this.label = document.label
    this.count = document.count
  }
}

class Tally {
  total: number = 0
  add(entry: { amount: number }): this {
    this.total += entry.amount
    return this
  }
}

for (const text of ['{"label":"a","count":1}', '{"label":7}', '{"count":"x","label":null}']) {
  const description = new Description(JSON.parse(text))
  console.log(show(description.label), show(description.count))
}
console.log(new Tally().add({ amount: 2 }).add({ amount: 3 }).total)
//! expect: string:a number:1
//! expect: number:7 undefined:undefined
//! expect: object:null string:x
//! expect: 5
//! emitted-lacks: gea::Value total;
export {}
