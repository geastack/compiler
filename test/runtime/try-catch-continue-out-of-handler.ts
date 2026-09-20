// A `continue` written INSIDE a catch handler, which hono's
// `SmartRouter.match` uses to skip a router that rejected the route set.
//
// The jump leaves the handler for the enclosing loop's latch, and that latch
// used to be swept into the handler's own block set by a plain reachability
// walk -- which then walked on through the loop header and back into the try
// body, so the handler "owned" the try body's blocks and emission refused with
// `a catch handler contains a block reached by a jump from outside it`. The
// block set is now cut at entry-dominance, so only blocks that cannot be
// reached except through the handler are rendered inside its braces.
//! expect: 20
//! expect: 3
const attempt = (n: number): number => {
  if (n < 2) {
    throw new Error('too small')
  }
  return n * 10
}

let found = 0
let tried = 0
for (let i = 0; i < 4; i++) {
  tried++
  try {
    found = attempt(i)
  } catch (e) {
    continue
  }
  break
}
console.log(found)
console.log(tried)
