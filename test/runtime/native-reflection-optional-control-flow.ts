//! expect: 7
//! expect: 0
//! emitted-lacks: bool gea_readOwnField(
//! emitted-lacks: bool gea_ownFieldDescriptor(

type Payload = { label: string; values: number[] }

function maybePayload(ready: boolean): Payload | undefined {
  return ready ? { label: 'sample', values: [7] } : undefined
}

function readPayload(ready: boolean): number {
  const value = maybePayload(ready)
  if (!value) return 0
  void value
  return value.values[0]!
}

console.log(readPayload(true))
console.log(readPayload(false))
