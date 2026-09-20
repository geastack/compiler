// AN EXECUTOR WRITTEN AS A CONCISE ARROW BODY, SO IT RETURNS A VALUE.
//
// 27.2.3.1 step 11 calls the executor and discards its completion value, so
// `new Promise((resolve) => schedule(resolve))` is the same program as the
// braced spelling that returns nothing -- the arrow just happens to hand back
// whatever `schedule` returned.
//
// `@hono/node-server`'s `listener.ts` writes exactly this, over node's
// `setTimeout`, whose handle is an object: `new Promise((resolve) =>
// setTimeout(resolve, ms))`. The executor lowered to
// `CallableObject<Ref<Timeout>(CallableObject<void(Value)>)>` and the runtime's
// `ExecutorRunner` had specializations only for executors returning `void`, so
// the instantiation reached the undefined primary template and the unit failed
// to compile. Both the handle-returning and the plain-number-returning arrow
// body are covered here; so is the rejecting two-parameter form.

class Handle {
  private readonly id_: number

  constructor(id: number) {
    this.id_ = id
  }

  id(): number {
    return this.id_
  }
}

let pendingResolve: ((value: number) => void) | undefined
let pendingReject: ((reason: string) => void) | undefined

function schedule(settle: (value: number) => void): Handle {
  pendingResolve = settle
  return new Handle(11)
}

function scheduleFailure(settle: (reason: string) => void): number {
  pendingReject = settle
  return 5
}

const settled = new Promise<number>((resolve) => schedule(resolve))
pendingResolve?.(42)

//! expect: settled=42
console.log('settled=' + (await settled))

const failed = new Promise<number>((_resolve, reject) => scheduleFailure(reject))
pendingReject?.('planned')

//! expect: failed=planned
console.log('failed=' + (await failed.catch((reason: unknown) => String(reason))))
