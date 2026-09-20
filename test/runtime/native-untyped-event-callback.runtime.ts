// @ts-nocheck
//! expect: released 7 1
//! emitted-lacks: gea_cpp_value
//! emitted-lacks: gea::Value::box

class EventOwner {
  id = 7
  releases = 0
  release(): void {
    this.releases++
  }
}
type NativeEvent = { type: string; target?: EventOwner | null }
type NativeListener = (event: NativeEvent) => void
const listeners: NativeListener[] = []
function subscribe(listener: NativeListener): void {
  listeners.push(listener)
}
function releaseObject(object): void {
  object.release()
}
// This is a named, unannotated JavaScript-style callback, not an explicit any
// boundary. Its only use passes it to the typed event-listener protocol.
function onDispose(event): void {
  const owner = event.target
  releaseObject(owner)
  console.log('released', owner.id, owner.releases)
}
subscribe(onDispose)
const owner = new EventOwner()
for (const listener of listeners) listener({ type: 'dispose', target: owner })
