// A Promise constructed through its executor owns shared mutable state. The
// executor settles one copy while `then` observes another, and the fulfillment
// reaction runs from the Promise job queue when the result is awaited.

let settleSource!: (value: number) => void
const source = new Promise<number>((resolve) => {
  settleSource = resolve
})
const copy = source
const identity = Promise.resolve(copy)
const mapped = identity.then((value: number) => value * 6)
settleSource(7)

//! expect: pending=42
console.log('pending=' + (await mapped))

const failed = new Promise<number>((_resolve, reject) => {
  reject('planned')
})

//! expect: rejected=planned
console.log('rejected=' + (await failed.catch((reason: unknown) => String(reason))))
