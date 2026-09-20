//! expect: stepped=7
//! expect: total=15
//! emitted-lacks: long long gea_body_fn_decl
// An `async` body's terminator carries the `number` it returns; its CONVENTION
// returns a promise, because the emitter wraps that value on the way out. The
// integer-storage census may not narrow the result slot from the terminator
// alone (`ir/integer-storage.ts`'s `excludedSignatureSlots`): doing so spelled
// `long long f(long long)` around `return gea::Promise<double>(v0);`, which
// certifies clean and which clang refuses.
const stepped = async (n: number): Promise<number> => {
  const next = (n + 3) % 1000
  return next
}
const main = async (): Promise<void> => {
  const one = await stepped(4)
  console.log(`stepped=${one}`)
  let total = 0
  for (let i = 0; i < 3; i += 1) total += await stepped(i * 2)
  console.log(`total=${total}`)
}
void main()
