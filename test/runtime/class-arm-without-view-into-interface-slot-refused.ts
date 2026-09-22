//! expect-refusal: no runtime narrowing is installed from optional(tagged-union
// The sibling of `class-arm-into-declared-interface-slot.ts`: the class arm
// cannot be viewed as the interface (its `param` field is another class the
// view has no plan for), so the store has NO sound answer -- selecting the
// record arm read the class instance's bytes as the record (skytail's
// `NativeAudioContext`, SIGBUS at launch, certified). The census refuses the
// pair instead; the refusal is the correct outcome until an interface slot
// can hold a class instance by identity.
interface ParamLike {
  value: number
}
interface ContextLike {
  param: ParamLike
  createGain(): number
}
class NativeParam {
  code = 3
  get value(): number {
    return this.code * 2
  }
}
class NativeContext {
  param = new NativeParam()
  createGain(): number {
    return 2
  }
}
const makeNative = (): NativeContext | null => new NativeContext()
const webAvailable = Math.random() > 2
const web: ContextLike = { param: { value: 1 }, createGain: () => 1 }
const ctx: ContextLike | null = webAvailable ? web : makeNative()
console.log('gain', ctx ? ctx.createGain() : 'none')
