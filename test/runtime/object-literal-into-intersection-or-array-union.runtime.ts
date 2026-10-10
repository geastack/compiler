// An object literal handed to `Filter & Document | Document[]` (a database client's
// `updateOne(filter, update: UpdateFilter<TSchema> | Document[])`) is the
// object arm, never the array arm -- whatever keys it carries.

interface Doc {
  [key: string]: any
}

type NumericType = number | bigint
type UpdateFilter = {
  $inc?: { readonly [key: string]: NumericType | undefined }
  $set?: { readonly [key: string]: any }
  $unset?: { readonly [key: string]: '' | true | 1 }
} & Doc

function describe(update: UpdateFilter | Doc[]): string {
  if (Array.isArray(update)) return `pipeline:${update.length}`
  return Object.keys(update)
    .map((operator) => {
      const fields = update[operator] as Doc
      return `${operator}(${Object.keys(fields)
        .map((key) => `${key}=${String(fields[key])}`)
        .join(',')})`
    })
    .join(' ')
}

//! expect: $set(name=alpha2,meta.level=9) $inc(qty=3)
console.log(describe({ $set: { name: 'alpha2', 'meta.level': 9 }, $inc: { qty: 3 } }))
//! expect: $set(checked=true)
console.log(describe({ $set: { checked: true } }))
//! expect: pipeline:1
console.log(describe([{ $set: { a: 1 } }]))
