//! expect: 3
//! expect: a,b,c
// A RECORD PASSED TO AN `any` PARAMETER. Certified, emitted, clang-clean, and
// it exited 139 with no output.
//
// `renderStructDefinition` marked every `final && !base` struct
// `gea_ref_standalone`, which tells the runtime every `gea::Ref` naming the
// object names its exact allocated type -- so the block header can drop its
// operations pointer and halve. `gea::Value::box` holds its payload as a
// `Ref<void>`, and that breaks the contract in the block's ADDRESSING, not
// merely its destruction: `refCountsOf` subtracts `refStride<T>`, 8 for a
// standalone type and 16 for `void`, so an erased handle reads and writes the
// refcount 8 bytes outside the block and `release` then calls through an
// operations pointer that block never had.
//
// ⛔ `for...in` is NOT the trigger and the name of this file should not suggest
// it is. Isolated to one variable: the same program boxing WITHOUT any
// `for...in` exits 139; the same program with the box removed exits 0. Boxing
// alone was sufficient, so this reached every program that boxes a record.
//
// It is here because NOTHING ELSE SEES IT. The corpus compiles with
// `-fsyntax-only`, so it reported 118 of 118 clang-clean while every one of
// those programs that boxed a record would have crashed on execution. cert,
// emit, clang and boxed all read green. Only running it says otherwise.
function keysOf(o: any): string[] {
  const out: string[] = []
  for (const k in o) {
    out.push(k)
  }
  return out
}

// `join`, not `ks[0] + ',' + ks[1]`. Indexing would be the natural spelling and
// it does not compile under this harness's options: `noUncheckedIndexedAccess`
// makes `ks[ i ]` carry `optional(string, undefined)` while `ArrayObject::
// elementAt` returns `const Element&`, so the ToString path emits `.has_value()`
// on a `std::string`. That is a separate defect, reported separately; using it
// here would make this test fail for a reason that is not the one it pins.
const ks = keysOf({ a: 1, b: 2, c: 3 })
console.log(String(ks.length))
console.log(ks.join(','))
