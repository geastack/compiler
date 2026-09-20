// An inferred local must still carry the absence an unchecked Array index can
// produce. This project deliberately disables noUncheckedIndexedAccess, so the
// checker reports Row at the initializer and comparison; the semantic census
// connects the direct undefined observation back to the read and binding.

interface InferredArrayRow {
  value: number
}

const inferredArrayRows: InferredArrayRow[] = [{ value: 2 }]

const inferredArrayValueAt = (index: number): number => {
  let row = inferredArrayRows[index]
  if (row === undefined) {
    row = { value: 40 + index }
    inferredArrayRows[index] = row
  }
  // This post-assignment read remains the native Row carrier.
  return row.value
}

//! expect: inferred-array-absence=2,43,43
console.log(`inferred-array-absence=${inferredArrayValueAt(0)},${inferredArrayValueAt(3)},${inferredArrayValueAt(3)}`)
