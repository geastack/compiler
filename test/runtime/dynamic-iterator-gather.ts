//! expect: true true undefined 3
//! expect: undefined true undefined 3
//! expect: undefined undefined 3
//! expect: []:next-failure
//! emitted-has: gea::runtime::iterator::appendGather

const source: any = [, undefined, 3]
const [first, ...tail] = source
console.log(first === undefined, 0 in tail, tail[0], tail[1])

const copied = [...source]
console.log(copied[0], 0 in copied, copied[1], copied[2])

const invoke = (...values: any[]) => console.log(...values)
invoke(...source)

// `closed` is a `lib.dom.d.ts` global (Window.closed), and this file is a
// SCRIPT, not a module -- a top-level `let closed` there is a redeclaration
// TS2451 refuses before geatsc ever runs. The name is the only thing that
// changes; `'close'` is still what the assertion below reads back.
let closeTag = ''
const abrupt: any = {
  [Symbol.iterator]() {
    return {
      next() {
        throw 'next-failure'
      },
      return() {
        closeTag = 'close'
        return {}
      }
    }
  }
}
try {
  ;[...abrupt]
} catch (error) {
  // Bracketed so the ABSENT close is a distinguishable string. `expect:` is a
  // substring test, and a bare `:next-failure` is contained in the wrong
  // answer `close:next-failure` -- it could never fail, which is the one thing
  // an assertion has to be able to do.
  console.log(`[${closeTag}]:${error}`)
}
