//! expect: gain 2
//! expect: buffer 4
// A host package that implements a browser API natively hands its class
// instances to app code typed against the browser's own names; on the web the
// app's TypeScript needs `as unknown as AudioContext` to accept the native
// class, and under the native host a plugin realization respells the browser
// name to the native class -- so the cast is `T as unknown as T`. That cast
// is an identity, not a trip through the dynamic carrier: a class instance
// cast to its own type keeps its representation (skytail's audio engine).
class NativeParam {
  code = 1
  get value(): number {
    return this.code * 2
  }
}
class NativeContext {
  param = new NativeParam()
  createGain(): number {
    return this.param.value
  }
}
class NativeBuffer {
  readonly length: number
  constructor(length: number) {
    this.length = length
  }
}
const makeNative = (): NativeContext | null => (Math.random() > 2 ? null : new NativeContext())
const makeBuffer = (): NativeBuffer | null => (Math.random() > 2 ? null : new NativeBuffer(4))
const ctx: NativeContext | null = makeNative() as unknown as NativeContext | null
console.log('gain', ctx ? ctx.createGain() : 'none')
const onLoad = (buffer: NativeBuffer): void => console.log('buffer', buffer.length)
const native = makeBuffer()
if (native) onLoad(native as unknown as NativeBuffer)
