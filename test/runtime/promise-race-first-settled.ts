//! expect: first
//! expect: value

// `@hono/node-server`'s `readWithoutBlocking` races a body read against an
// already-resolved promise so that a body which is not ready does not stall the
// response. `Promise.race` therefore may not READ any element: it registers
// each on the result and lets the first settlement win, which is the whole
// difference between it and `Promise.all`.
const firstOf = async (a: Promise<string>, b: Promise<string>): Promise<string> => Promise.race([a, b])

const raceAgainstReady = async (pending: Promise<string>): Promise<string> => Promise.race([pending, Promise.resolve('value')])

const main = async (): Promise<void> => {
  console.log(await firstOf(Promise.resolve('first'), Promise.resolve('second')))
  console.log(await raceAgainstReady(Promise.resolve('value')))
}

void main()
