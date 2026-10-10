// THE DEADLOCK SHAPE: A TIMER CALLBACK STARTS A LONG-WAITING ASYNC LOOP.
//
// `main` awaits a promise a 20ms timer resolves. A 5ms timer callback starts
// `background()`, an async loop whose awaits settle only after 200ms each,
// and `heartbeat()`, an async loop whose await NEVER settles. Under real
// suspension both return to the timer callback at their first await; the
// event loop keeps running, the 20ms timer resolves `main`, and `main` prints
// first. The program ends when no timer is left, with `heartbeat` still
// suspended -- a monitor's awaiting heartbeat when the client is finished.
//
// This is a database client's monitor shape: the streaming heartbeat is an async loop
// started from a timer that awaits a server reply held open for the heartbeat
// interval, while the user's operation awaits its own reply.
//
// The blocking model lowered `await` to `.awaited()`, a nested pump on the C++
// stack that returns only once its promise settles. `main`'s await blocks at
// the top level before a single timer can run; and were the timers running,
// `background`'s pump would sit ABOVE `main`'s frame, so `main` could resume
// only after the whole background loop -- and never, behind `heartbeat`.
// Observed on the blocking build: nothing printed, then
//   gea: pending promise has no host work capable of settling it
//   CRASHED: SIGABRT
//
// This suite's target has no `setTimeout`, so the timers are a program-owned
// queue in virtual time, drained by an async driver that lets the job queue
// settle after each callback -- the event loop, in miniature. The real-timer
// version is node-compat's `correctness/native/async-await-timers.ts`.
interface Timer {
  due: number
  order: number
  run: () => void
}

const timers: Timer[] = []
let now = 0
let scheduled = 0

function setVirtualTimeout(run: () => void, ms: number): void {
  timers.push({ due: now + ms, order: scheduled, run })
  scheduled += 1
}

function takeNextTimer(): Timer | undefined {
  let best = -1
  for (let i = 0; i < timers.length; i++) {
    const candidate = timers[i]!
    const current = best < 0 ? undefined : timers[best]!
    if (current === undefined || candidate.due < current.due || (candidate.due === current.due && candidate.order < current.order)) best = i
  }
  if (best < 0) return undefined
  return timers.splice(best, 1)[0]
}

async function settleJobs(): Promise<void> {
  for (let i = 0; i < 64; i++) await null
}

async function runTimers(): Promise<void> {
  await settleJobs()
  for (;;) {
    const timer = takeNextTimer()
    if (timer === undefined) break
    now = timer.due
    timer.run()
    await settleJobs()
  }
  log.push(`timers-drained@${now}`)
  console.log(`order:${log.join(' ')}`)
}

const log: string[] = []

function delay(ms: number, value: string): Promise<string> {
  return new Promise<string>((resolve) => {
    setVirtualTimeout(() => resolve(value), ms)
  })
}

function never(): Promise<string> {
  return new Promise<string>(() => {})
}

async function background(): Promise<void> {
  log.push('bg:start')
  for (let round = 1; round <= 2; round++) {
    const value = await delay(200, `late${round}`)
    log.push(`bg:${value}@${now}`)
  }
  log.push('bg:end')
}

async function heartbeat(): Promise<void> {
  for (;;) {
    log.push('hb:await')
    const reply = await never()
    log.push(`hb:${reply}`)
  }
}

setVirtualTimeout(() => {
  background()
  heartbeat()
  log.push('timer5:returned')
}, 5)

async function main(): Promise<void> {
  const result = await delay(20, 'main-value')
  log.push(`main:${result}@${now}`)
  console.log(`main:${result}`)
}

main()
log.push('main:returned')
runTimers()
//! expect: main:main-value
//! expect: order:main:returned bg:start hb:await timer5:returned main:main-value@20 bg:late1@205 bg:late2@405 bg:end timers-drained@405
