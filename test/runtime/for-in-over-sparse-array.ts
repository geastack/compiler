//! expect: 1
//! expect: 3
//! expect: 2 keys

// hono's regexp router builds a SPARSE index map and walks it with `for`-`in`
// precisely so the holes are skipped ("using `in` because indexReplacementMap
// is a sparse array", its own comment). A values walk would visit them.
const sparse: number[] = []
sparse[1] = 10
sparse[3] = 30

let seen = 0
for (const index in sparse) {
  console.log(index)
  seen += 1
}
console.log(`${seen} keys`)
