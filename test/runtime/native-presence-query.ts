class NativePresenceCell {
  value = 9
}

function hasNativeValue(cell: NativePresenceCell): boolean {
  return 'value' in cell
}

function hasRecordValue(record: { value: number }): boolean {
  return 'value' in record
}

const cell = new NativePresenceCell()
const record = { value: 5 }
console.log(hasNativeValue(cell))
console.log(hasRecordValue(record), 'toString' in record)
