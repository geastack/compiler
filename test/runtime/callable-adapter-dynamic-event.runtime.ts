//! expect: target 42
//! emitted-has: adaptSource
type NativeEvent = { target: { code: number } }
function listener(event: any): void {
  console.log('target', event.target.code)
}
const listeners: Array<(event: NativeEvent) => unknown> = [listener]
const payload: NativeEvent = { target: { code: 42 } }
listeners[0]!(payload)
