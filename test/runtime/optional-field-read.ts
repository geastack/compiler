class OptionalFieldBase {
  value?: number = 7
}

class OptionalFieldChild extends OptionalFieldBase {}

function readOptionalField(cell: OptionalFieldBase): number {
  if (cell.value !== undefined) return cell.value + 1
  return -1
}

function readOptionalRecord(cell: { value: string | undefined }): string {
  if (cell.value !== undefined) return cell.value.toUpperCase()
  return 'absent'
}

function readOptionalUnknown(cell: unknown): number | undefined {
  return (cell as OptionalFieldBase).value
}

const cell = new OptionalFieldChild()
//! expect: 8
console.log(readOptionalField(cell))
cell.value = undefined
//! expect: -1
console.log(readOptionalField(cell))
cell.value = 12
delete cell.value
//! expect: -1
console.log(readOptionalField(cell))
cell.value = 20
//! expect: 21
console.log(readOptionalField(cell))
//! expect: HELLO
console.log(readOptionalRecord({ value: 'hello' }))
//! expect: absent
console.log(readOptionalRecord({ value: undefined }))
//! expect: 20
console.log(readOptionalUnknown(cell))
