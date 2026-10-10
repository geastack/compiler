// ECMA-262 23.1.3.2 concat: each item is spread when it is an array
// (IsConcatSpreadable) and appended whole otherwise. `(T | ConcatArray<T>)[]`
// mixes the two in one pack; a database client appends an `$out` stage to an
// aggregation pipeline with `pipeline.concat({ $out: target })`.

interface Doc {
  [key: string]: any
}
const pick = (n: number): string | undefined => (n > 100 ? undefined : 'target')
let pipeline: Doc[] = [{ $match: { a: 1 } }]
pipeline = pipeline.concat({ $out: pick(1) })
//! expect: 2 [{"$match":{"a":1}},{"$out":"target"}]
console.log(pipeline.length, JSON.stringify(pipeline))

const more: Doc[] = [{ $limit: 5 }, { $skip: 1 }]
const mixed = pipeline.concat(more, { $count: 'n' })
//! expect: 5 $match,$out,$limit,$skip,$count
console.log(mixed.length, mixed.map((stage) => Object.keys(stage)[0]).join(','))
//! expect: 2
console.log(pipeline.length)
