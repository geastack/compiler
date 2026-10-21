//! expect: two:1,2 three:1,2,3 three:1,2,undefined one:1 nine:45 label:x
//! expect: counts=1,2,3
//! emitted-has: gea_tupleLength()
//! emitted-lacks: gea::arrayOf<
// A forwarding shim that picks a call form by `arguments.length` keeps its
// positional frame (`implicit-arguments-tuple.ts`): each position is carried
// as its own joined type, the positions some call omits are optional, and the
// length is the frame's own -- an explicit `undefined` counts, an omitted
// argument does not. A runtime-sized Array of every position's union, built
// and unpacked per call, was what this used to be.

/** @param {string[]} sink */
function makeApi(sink) {
  function call() {
    if (arguments.length === 1) sink.push('one:' + arguments[0])
    else if (arguments.length === 2) sink.push('two:' + arguments[0] + ',' + arguments[1])
    else sink.push('three:' + arguments[0] + ',' + arguments[1] + ',' + String(arguments[2]))
  }
  function sum() {
    let total = 0
    if (arguments.length === 9)
      total = arguments[0] + arguments[1] + arguments[2] + arguments[3] + arguments[4] + arguments[5] + arguments[6] + arguments[7]
    return arguments.length === 9 ? total + ' label:' + arguments[8] : 'short'
  }
  function count() {
    return arguments.length + (arguments.length > 1 ? arguments[1] * 0 : 0)
  }
  return { call, sum, count }
}

/** @type {string[]} */
const out = []
const api = makeApi(out)
api.call(1, 2)
api.call(1, 2, 3)
api.call(1, 2, undefined)
api.call(1)
out.push('nine:' + api.sum(1, 2, 3, 4, 5, 6, 7, 17, 'x'))
console.log(out.join(' '))
console.log('counts=' + [api.count(4), api.count(4, 5), api.count(4, 5, 6)].join(','))
