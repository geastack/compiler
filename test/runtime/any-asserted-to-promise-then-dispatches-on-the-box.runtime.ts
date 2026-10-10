// A value read out of an `any` cache and asserted to a promise, then chained:
// an HTTP framework's `AppRequest#cachedBody` does
// `(bodyCache[anyCachedKey] as Promise<BodyInit>).then(...)`. The box holds a
// `Promise<string>`, which is not the carrier the assertion names, so the
// receiver is the boxed promise ADOPTED into that carrier -- the recipe an
// async `return` of an `any` promise already runs. It was refused outright
// ("promise assimilation is an effectful semantic protocol").
//
// `await` of the function's `any` result must then adopt the boxed promise
// too; it read the box as its own value and printed the promise object.
type BodyCache = Record<string, any>

const cache: BodyCache = {}
cache['text'] = Promise.resolve('hello')

// Unannotated, like the framework's: one arm returns the cache's own `any`.
const reread = (key: string, fresh: boolean) => {
  if (fresh) return cache[key]
  return (cache[key] as Promise<string>).then((body) => body.toUpperCase())
}

const main = async (): Promise<void> => {
  console.log(`cached:${String(await reread('text', false))}`)
  console.log(`fresh:${String(await reread('text', true))}`)
}
void main()

//! expect: cached:HELLO
//! expect: fresh:hello
