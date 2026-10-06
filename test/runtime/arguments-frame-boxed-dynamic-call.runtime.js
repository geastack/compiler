// @ts-nocheck
//! expect: method none 0 undefined []
//! expect: method one 1 a [a]
//! expect: method equal 2 a [a,b]
//! expect: method more 4 a [a,b,c,d]
//! expect: method explicit 1 undefined [undefined]
//! expect: method keyed 3 k [k,l,m]
//! expect: method call 2 c [c,d]
//! expect: group 4 [x,y,z,w]
//! expect: plain none 0 undefined []
//! expect: plain one 1 1 [1]
//! expect: plain more 3 1 [1,2,3]
//! expect: plain explicit 2 undefined [undefined,undefined]
// A body that reads `arguments` behind a declared formal packs every argument
// its caller passed into its `arguments` frame, so `arguments.length` is that
// count. The same must hold when the function is reached as a dynamic value:
// a method read off an instance the program holds only as `any` (three's
// `Object3D.add` and `remove`), a member read by computed key, `.call`, and a
// plain function stored into an `any` table and called from it. Each is called
// with fewer, as many, and more arguments than it declares, and with an
// explicit `undefined`, which counts where an omitted argument does not. The
// boxes state the frame's packing start beside its slot.
//! emitted-has: boxMethod<2, 1>
//! emitted-has: boxCallable<1, 0>
class Probe {
  report(first) {
    const seen = []
    for (let i = 0; i < arguments.length; i++) seen.push(String(arguments[i]))
    return arguments.length + ' ' + String(first) + ' [' + seen.join(',') + ']'
  }
}

class Group {
  constructor() {
    this.children = []
  }
  add(object) {
    if (arguments.length > 1) {
      for (let i = 0; i < arguments.length; i++) this.add(arguments[i])
      return this
    }
    this.children.push(object)
    return this
  }
}

function count(first) {
  const seen = []
  for (let i = 0; i < arguments.length; i++) seen.push(String(arguments[i]))
  return arguments.length + ' ' + String(first) + ' [' + seen.join(',') + ']'
}

/** @param {any} target */
function viaMember(target) {
  console.log('method none', target.report())
  console.log('method one', target.report('a'))
  console.log('method equal', target.report('a', 'b'))
  console.log('method more', target.report('a', 'b', 'c', 'd'))
  console.log('method explicit', target.report(undefined))
}

/**
 * @param {any} target
 * @param {string} key
 */
function viaKey(target, key) {
  console.log('method keyed', target[key]('k', 'l', 'm'))
}

/** @param {any} target */
function viaCall(target) {
  const method = target.report
  console.log('method call', method.call(target, 'c', 'd'))
}

/** @param {any} group */
function viaGroup(group) {
  group.add('x', 'y', 'z')
  group.add('w')
}

/** @param {any} fn */
function viaPlain(fn) {
  console.log('plain none', fn())
  console.log('plain one', fn(1))
  console.log('plain more', fn(1, 2, 3))
  console.log('plain explicit', fn(undefined, undefined))
}

const probe = new Probe()
viaMember(probe)
viaKey(probe, 'report')
viaCall(probe)
const group = new Group()
viaGroup(group)
console.log('group', group.children.length, '[' + group.children.join(',') + ']')
/** @type {Record<string, any>} */
const registry = {}
registry['count'] = count
viaPlain(registry['count'])
