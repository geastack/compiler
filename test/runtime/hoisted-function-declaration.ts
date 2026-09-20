//! expect: dispatch:0
//! expect: dispatch:1
//! expect: done

// A hoisted FUNCTION DECLARATION inside a function body, called before its own
// declaration is reached, capturing a `let` cell of the enclosing frame -- the
// shape hono's `compose` returns (`return dispatch(0)` above `async function
// dispatch(i)`, both closing over `index`). The binding is a cell the nested
// function and the enclosing body BOTH read, so a body that never allocates it
// leaves the call site naming a declaration nothing wrote.
const run = (limit: number): string => {
  let index = -1

  return step(0)

  function step(i: number): string {
    if (i <= index) return 'reentered'
    index = i
    console.log('dispatch:' + i)
    return i + 1 < limit ? step(i + 1) : 'done'
  }
}

console.log(run(2))
