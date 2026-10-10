// A database client's Monitor.checkServer builds its heartbeat command as
// `{ [helloOk ? 'hello' : 'isMaster']: 1, ...(awaitable ? { maxAwaitTimeMS } : {}) }`.
// The command name must be the FIRST key (wire-format commands are ordered), so the
// computed key keeps its insertion position ahead of the spread's keys.
const LEGACY = 'isMaster'
const command = (helloOk: boolean, awaitable: boolean, maxAwaitTimeMS: number) => {
  const cmd = {
    [helloOk ? 'hello' : LEGACY]: 1,
    ...(awaitable ? { maxAwaitTimeMS } : {})
  }
  return cmd
}
console.log(JSON.stringify(command(true, true, 10000)))
console.log(JSON.stringify(command(false, true, 5)))
console.log(Object.keys(command(false, false, 5)).join(','))
//! expect: {"hello":1,"maxAwaitTimeMS":10000}
//! expect: {"isMaster":1,"maxAwaitTimeMS":5}
//! expect: isMaster
