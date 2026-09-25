// @ts-nocheck
//! expect: get flat 7 function true
//! expect: accessor label:other label:flat
//! expect: set true smooth
//! expect: on-receiver true 5 false
//! expect: setter true other!
//! expect: apply 6 19
// `Reflect.get(T, k, R)` and `Reflect.set(T, k, v, R)` on a native class
// instance -- the forwarding in three's TSL proxy traps. OrdinaryGet over the
// target with an inherited accessor entered with `R`; OrdinarySet that
// creates a data property on `R`, not on the target. And `Reflect.apply`.
class ExtBuilder {
  constructor(name) {
    this.name = name
    this.context = { id: 7 }
  }
  isFlatShading() {
    return this.name === 'flat'
  }
}
const descriptors = {}
for (const key of ['label']) {
  descriptors[key] = {
    get() {
      return 'label:' + this.name
    },
    set(value) {
      this.name = value + '!'
    }
  }
}
Object.defineProperties(ExtBuilder.prototype, descriptors)
const target = new ExtBuilder('flat')
const other = new ExtBuilder('other')
const key = (k) => k
const method = Reflect.get(target, key('isFlatShading'), target)
console.log(
  'get',
  Reflect.get(target, key('name'), other),
  Reflect.get(target, key('context'), other).id,
  typeof method,
  method.call(target)
)
console.log('accessor', Reflect.get(target, key('label'), other), Reflect.get(target, key('label'), target))
console.log('set', Reflect.set(target, key('name'), 'smooth', target), target.name)
const fresh = JSON.parse('{}')
console.log('on-receiver', Reflect.set(target, key('extra'), 5, fresh), fresh.extra, 'extra' in target)
console.log('setter', Reflect.set(target, key('label'), 'other', other), other.name)

class ExtCounter {
  constructor(start) {
    this.count = start
  }
  /** @param {number} a @param {number} b */
  add(a, b) {
    return this.count + a + b
  }
}
/** @param {number} a @param {number} b @param {number} c */
function sum(a, b, c) {
  return a + b + c
}
const counter = new ExtCounter(10)
console.log('apply', Reflect.apply(sum, undefined, [1, 2, 3]), Reflect.apply(counter.add, counter, [4, 5]))
