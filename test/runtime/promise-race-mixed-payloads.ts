//! expect: ready
//! expect: literal
//! expect: gave up

// The shape `@hono/node-server`'s `readWithoutBlocking` actually writes:
// `Promise.race([readPromise, Promise.resolve().then(() => undefined)])`, whose
// elements carry DIFFERENT payloads -- so the argument is a two-field TUPLE,
// not an Array -- and whose result carries their union. The settled value has
// to enter the result's own carrier on the way in, which is an ordinary
// cross-carrier conversion rather than anything a race invents for itself.
//
// The second case is the other half of 27.2.4.7.1: an element that is not a
// thenable is already its own resolution. The third is the reason the function
// is called `readWithoutBlocking` at all -- a first element that never settles
// must not stall the race, which is exactly what reading its value would do.
const readOrGiveUp = async (read: Promise<string>, giveUp: Promise<undefined>): Promise<string | undefined> => Promise.race([read, giveUp])

const raceWithPlainValue = async (read: Promise<string>): Promise<string> => Promise.race([read, 'literal'])

const main = async (): Promise<void> => {
  console.log((await readOrGiveUp(Promise.resolve('ready'), Promise.resolve(undefined))) ?? 'absent')
  console.log(await raceWithPlainValue(Promise.resolve('read')))
  const neverSettles = new Promise<string>(() => {})
  console.log((await readOrGiveUp(neverSettles, Promise.resolve(undefined))) === undefined ? 'gave up' : 'read won')
}

void main()
