// A database client's `Connection.writeCommand` races
// `once<void>(socket, 'drain')` against a socket-write timeout. A
// `Promise<void>` fulfills with `undefined` and its native observer takes no
// argument, so the race's element step cannot name a settled carrier for it:
// it converts `undefined` into the race's own result instead.
let drainNow: () => void = () => {}
let timeoutNow: (reason: string) => void = () => {}
const drain = (): Promise<void> => new Promise<void>((resolve) => (drainNow = () => resolve()))
const timeout = (): Promise<string> => new Promise<string>((resolve) => (timeoutNow = resolve))

async function main(): Promise<void> {
  const first = Promise.race([drain(), timeout()])
  drainNow()
  timeoutNow('timeout')
  const second = Promise.race([drain(), timeout()])
  timeoutNow('timeout')
  drainNow()
  console.log(String(await first), String(await second))
}
//! expect: undefined timeout
main()
