//! expect: string
//! expect: object
//! expect: never-source-ok

// An iteration over a source typed `never` never runs, and compiles.
//
// `typeof x !== 'string' && !Array.isArray(x)` over `string | number[]` leaves
// `x` as `never`, and three.js reaches the same shape through a JS default:
// `Fn( ( [ matrices, colors = null ] ) => ... )` types `colors` as `null`, so
// `if ( colors && ... ) target.push( ...colors.updateRanges )`
// (`nodes/accessors/Instance.js`) spreads a member of a `never`. There is no
// `@@iterator` chain to read an element type from, and there does not have
// to be: the statement cannot execute. So the source takes the native cursor
// path, the cursor is `unreachableValue` where a walk would be built, and a
// spread range-copies that same stand-in; nothing is refused and nothing runs.
//! emitted-has: gea::host::unreachableValue

const sink: number[] = []
function visit(x: number[] | string): void {
  if (typeof x !== 'string' && !Array.isArray(x)) {
    // @ts-expect-error TS2488: `never` declares no `[Symbol.iterator]()`
    for (const y of x) console.log('unreachable for-of', y)
    // @ts-expect-error TS2488
    sink.push(...x)
    const copy: number[] = [...x]
    console.log('unreachable spread', copy.length)
  }
  console.log(typeof x)
}
visit('a')
visit([1])
console.log(sink.length === 0 ? 'never-source-ok' : 'never-source-wrong')
export {}
