//! expect: steps=3
//! emitted-lacks: if (true) goto
//! emitted-lacks: if ((true)) goto
//! emitted-lacks: :\ngoto block
//! emitted-lacks: goto block1;\nblock1:
// A branch on a literal is the jump it is, and a block that renders nothing
// -- a `continue`'s target, a loop's latch -- is jumped over rather than
// rendered as a label and a `goto` (`emit.ts`'s `threadedFlowOf`).
const count = (limit: number): number => {
  let steps = 0
  for (let i = 0; i < limit; i++) {
    if (i === 1) continue
    steps++
  }
  while (true) {
    steps++
    if (steps >= 3) break
  }
  return steps
}
console.log(`steps=${count(3)}`)
