//! emitted-lacks: gea::Task<
//! emitted-lacks: _task(
// Immediate awaits use the regular Promise body; no alternate body is emitted.
// AN AWAIT COSTS EXACTLY ONE MICROTASK, WHATEVER THE CALLEE DID.
//
// Any fusion of `await asyncCall()` (skipping the callee's promise state) must
// resume the caller at the same queue position the settle reaction would have
// taken: sync-completing callee, suspended callee, nested awaits, a callee
// whose promise is dropped, and a `then` registered beside the await.
const log: string[] = []

function microtask(job: () => void): void {
  Promise.resolve().then(job)
}

async function syncCallee(tag: string): Promise<number> {
  log.push(tag + ':callee')
  return 1
}

async function suspendedCallee(tag: string): Promise<number> {
  log.push(tag + ':callee-start')
  await undefined
  log.push(tag + ':callee-resumed')
  return 2
}

async function nested(tag: string): Promise<number> {
  const a = await syncCallee(tag + '.a')
  const b = await suspendedCallee(tag + '.b')
  return a + b
}

async function caller(tag: string): Promise<void> {
  log.push(tag + ':start')
  const v = await syncCallee(tag)
  log.push(tag + ':got' + v)
  const w = await suspendedCallee(tag)
  log.push(tag + ':got' + w)
  const n = await nested(tag)
  log.push(tag + ':nested' + n)
}

async function dropper(): Promise<void> {
  // The callee's promise is dropped while the callee is still suspended.
  void suspendedCallee('dropped')
  log.push('dropper:end')
}

microtask(() => log.push('m1'))
const c1 = caller('c1')
microtask(() => log.push('m2'))
const c2 = caller('c2')
const d = dropper()
const shared = syncCallee('shared')
shared.then(() => log.push('shared:then'))
void (async (): Promise<void> => {
  await shared
  log.push('shared:await')
})()
microtask(() => log.push('m3'))
log.push('sync-end')

Promise.all([c1, c2, d]).then(() => {
  microtask(() => console.log(log.join(' ')))
})
//! expect: c1:start c1:callee c2:start c2:callee dropped:callee-start dropper:end shared:callee sync-end m1 c1:got1 c1:callee-start m2 c2:got1 c2:callee-start dropped:callee-resumed shared:then shared:await m3 c1:callee-resumed c2:callee-resumed c1:got2 c1.a:callee c2:got2 c2.a:callee c1.b:callee-start c2.b:callee-start c1.b:callee-resumed c2.b:callee-resumed c1:nested3 c2:nested3
