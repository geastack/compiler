//! expect: gain 1
//! expect: wrong TypeError
//! expect: held 1
// The sibling of `class-arm-without-view-into-interface-slot-refused.ts` with
// the store written the way hono's `Context.executionCtx` writes it: `return
// this.#ctx as ContextLike` off a `NativeContext | ContextLike` field. The
// class arm still has no view as the interface, so the census has no sound
// per-arm answer -- but the author has stated the arm, and the store is that
// arm's checked projection: the record when the record is held, a `TypeError`
// the program can catch when the assertion was false. Never the class
// instance's bytes read as the record.
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
class Holder {
  #ctx: NativeContext | ContextLike | undefined
  constructor(ctx: NativeContext | ContextLike | undefined) {
    this.#ctx = ctx
  }
  get context(): ContextLike {
    if (this.#ctx) {
      return this.#ctx as ContextLike
    } else {
      throw Error('no context')
    }
  }
}
const web: ContextLike = { param: { value: 1 }, createGain: () => 1 }
const pick = (native: boolean): NativeContext | ContextLike => (native ? new NativeContext() : web)
console.log('gain', new Holder(pick(false)).context.createGain())
try {
  new Holder(pick(true)).context.createGain()
  console.log('wrong reached')
} catch (error) {
  console.log('wrong', error instanceof TypeError ? 'TypeError' : String(error))
}
const held = pick(false) as ContextLike
console.log('held', held.createGain())
