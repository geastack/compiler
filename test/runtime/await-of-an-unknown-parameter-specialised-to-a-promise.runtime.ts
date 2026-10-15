// `await value` over an `unknown` parameter every caller passes a typed
// promise: the parameter is specialised to `Promise<number>` (and
// `Promise<string>`), so the await settles a native payload, while the
// checker's `unknown` keeps the result in a `gea::Value` cell. The settled
// payload is entered into that cell through the conversion census; it was
// assigned straight from `co_await`, which no C++ conversion accepts.
export {}

const settle = async (value: unknown): Promise<unknown> => {
  const settled = await value
  return settled
}

const describe = async (value: unknown): Promise<string> => {
  const settled = await value
  return typeof settled === 'string' ? `text ${settled.length}` : `other ${typeof settled}`
}

const run = async (): Promise<void> => {
  const pending: Promise<number> = Promise.resolve(42)
  const result = await settle(pending)
  console.log(typeof result, result)
  if (typeof result === 'number') console.log('doubled', result * 2)
  console.log(await describe(Promise.resolve('gea')))
}

void run()
//! expect: number 42
//! expect: doubled 84
//! expect: text 3
