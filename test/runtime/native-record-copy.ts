type NativeCopyItem = { amount: number; label: string }
type NativeCopySource = { child: NativeCopyItem; discarded: number }
type NativeCopyTarget = { child: NativeCopyItem }

function nativeCopyAmount(value: NativeCopyTarget): number {
  return value.child.amount
}

function nativeCopyOptional(value: NativeCopyTarget | undefined): number {
  return value === undefined ? -1 : value.child.amount
}

function nativeCopyMaybe(enabled: boolean): NativeCopySource | undefined {
  return enabled ? { child: { amount: 12, label: 'nested' }, discarded: 99 } : undefined
}

const nativeCopySource: NativeCopySource = { child: { amount: 7, label: 'held' }, discarded: 42 }
console.log(nativeCopyAmount(nativeCopySource))
nativeCopySource.child.amount = 9
console.log(nativeCopyAmount(nativeCopySource))
console.log(nativeCopyOptional(nativeCopyMaybe(true)), nativeCopyOptional(nativeCopyMaybe(false)))
