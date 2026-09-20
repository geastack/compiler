//! expect: then:function 1
//! expect: then:function 2
// `@hono/node-server`'s `isPromise` reads `(res as Promise<Response>).then` as
// a VALUE, never calling it, in a program that instantiates `Promise` at more
// than one type. `then<TResult1 = T>`'s default was resolved from its
// declaration node, in `Promise`'s own scope, and handed the open `T` to
// representation: the function-value carrier `(...)->promise(unresolved)` had
// no emitter recipe. The default must be the INSTANTIATED one.
const isThenable = (value: Promise<number> | Promise<string>): boolean => typeof value.then === 'function'
const main = async (): Promise<void> => {
  const numbers: Promise<number> = Promise.resolve(1)
  const text: Promise<string> = Promise.resolve('2')
  console.log('then:function', isThenable(numbers) ? await numbers : 0)
  console.log('then:function', isThenable(text) ? Number(await text) : 0)
}
void main()
