//! emitted-has: _stable_borrow(const std::string& gea_arg_0
//! expect: private:before global:before after before before:left after:right
// Unknown callbacks may mutate globals. A private, unboxed caller slot is
// still stable; a global/field/captured actual must keep its owning snapshot.
let shared = 'before'
function effectful(value: string, callback: () => void): string {
  callback()
  return value
}
function change(): void {
  shared = 'after'
}
function privateCaller(): string {
  const local = 'before'
  return 'private:' + effectful(local, change)
}
function globalCaller(): string {
  shared = 'before'
  return 'global:' + effectful(shared, change)
}
function twoArguments(left: string, right: string): string {
  right += ':right'
  return left + ':left ' + right
}
const first = privateCaller()
const second = globalCaller()
let captured = 'before'
const captureChange = (): void => {
  captured = 'after'
}
const snapshot = effectful(captured, captureChange)
const field = { value: 'before' }
const fieldSnapshot = effectful(field.value, () => {
  field.value = 'after'
})
const repeated = twoArguments(field.value, field.value)
console.log(first, second, shared, snapshot, fieldSnapshot + ':left', repeated.slice(repeated.indexOf(' ') + 1))

//! expect: before!:left before!:right before after
function repeatedPrivate(source: string): string {
  let local = source + '!'
  return twoArguments(local, local)
}
function capturedPrivate(): string {
  let local = 'before'
  const old = effectful(local, () => {
    local = 'after'
  })
  return old + ' ' + local
}
console.log(repeatedPrivate('before'), capturedPrivate())

//! expect: 3 7 5
function observeArray(value: Uint8Array, callback: () => void): number {
  callback()
  return value[0]!
}
function referenceSlots(): void {
  const holder = { bytes: new Uint8Array([3]) }
  const snapshot = observeArray(holder.bytes, () => {
    holder.bytes = new Uint8Array([7])
  })
  const privateBytes = new Uint8Array([3])
  // Borrowing the handle must not snapshot the referent's contents.
  const mutated = observeArray(privateBytes, () => {
    privateBytes[0] = 5
  })
  console.log(snapshot, holder.bytes[0], mutated)
}
referenceSlots()

//! expect: member member!
function memberCalls(): void {
  const slot = { run: effectful }
  const local = 'member'
  const first = slot.run(local, change)
  const suffix = '!'
  slot.run = (value: string, callback: () => void): string => {
    callback()
    return value + suffix
  }
  console.log(first, slot.run(local, change))
}
memberCalls()
