//! expect: native 2
//! expect: extra x 2
// A ternary whose arms are an interface-typed record and a class that
// satisfies the interface, stored into a slot declared as the interface:
// skytail's `const ctx: AudioContextLike | null = Ctor ? new Ctor() :
// createNativeAudioContext()`. On 2026-09-22 the store projected the union's
// record arm unchecked (`(*v).get<1>()`) while the class arm was the live one,
// so every method call read a callable out of the class instance's bytes
// (SIGBUS at launch on the native host, where no `AudioContext` exists).
interface GainLike {
  value: number
}
interface ContextLike {
  createGain(): GainLike
}
class NativeContext {
  extra = 'x'
  createGain(): GainLike {
    return { value: 2 }
  }
}
const makeNative = (): NativeContext | null => new NativeContext()
const webAvailable = Math.random() > 2
const web: ContextLike = { createGain: () => ({ value: 1 }) }
const ctx: ContextLike | null = webAvailable ? web : makeNative()
console.log('native', ctx ? ctx.createGain().value : 'none')
const held: NativeContext | null = makeNative()
const viewed: ContextLike | null = held
console.log('extra', held ? held.extra : 'none', viewed ? viewed.createGain().value : 'none')
