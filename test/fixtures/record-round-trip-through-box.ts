// A typed record boxed and read back must be the SAME object, not a rebuild.
//
// `conversion/derive.ts` refused `native-record-ref` out of a box outright,
// and the only other route -- `recordMaterializer`, the field-by-field product
// rebuild -- was never installed by the C++ registry at all, so every
// `conversion:dynamic->native-record-ref` (50 rows in the mongodb probe),
// `->dictionary`, `->optional(native-record-ref)` and the discriminated unions
// built out of them refused together.
//
// `Value::box` records the payload's own C++ type for whatever it stores, so
// the round trip was already built on both sides: the box records
// `gea::Ref<gea_record_type_N>`, `unboxValue<T>` checks the tag AND that
// address before handing the payload back, and `emit-narrowing.ts` already
// renders it through its generic fallback. What was missing was the registry
// entry saying so.
//
// Identity is the part worth a fixture rather than a claim: a rebuild would
// compile, certify and quietly hand back a DIFFERENT object, so this mutates
// through the unboxed reference and reads the mutation back through the
// original binding.
interface Cell {
  count: number
}

const cell: Cell = { count: 1 }
const boxed: unknown = cell
const back = boxed as Cell
back.count = 41

export const probe = cell.count + back.count

if (probe !== 82) throw new Error('a record round trip through the box lost identity')
