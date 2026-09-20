let events = ''
class Source {
  get a(): number {
    events += 'get-a;'
    return 11
  }
  get b(): number {
    events += 'get-b;'
    return 22
  }
}
class Sink {
  stored = 0
  set value(value: number) {
    events += 'set;'
    this.stored = value
  }
}
const left = new Sink()
const right = new Sink()
function makeSource(): Source {
  events += 'rhs;'
  return new Source()
}
function target(which: boolean): Sink {
  events += 'target;'
  return which ? left : right
}

;({ a: target(true).value, b: target(false).value } = makeSource())
//! expect: rhs;target;get-a;set;target;get-b;set;
console.log(events)
//! expect: 11 22
console.log(left.stored, right.stored)

let a = 0
let b = 0
const input = { a: 3, b: 4 }
const returned = ({ a, b } = input)
returned.a = 9
//! expect: 3 4 9
console.log(a, b, input.a)

function nullable(): Source | null {
  return null
}
events = ''
try {
  // ECMA-262 13.15.5.2 checks RequireObjectCoercible before target evaluation.
  // https://tc39.es/ecma262/#sec-runtime-semantics-destructuringassignmentevaluation
  // Node/V8 currently disagrees for this case; it is not the semantic oracle.
  // @ts-expect-error Valid JavaScript: nullish sources throw before target evaluation.
  ;({ a: target(true).value } = nullable())
  console.log('missed-null')
} catch {
  //! expect: null-before-target:
  console.log('null-before-target:' + events)
}
try {
  // @ts-expect-error Exercise the runtime throw for a null source with no fields.
  ;({} = null)
  console.log('missed-empty-null')
} catch {
  //! expect: empty-null
  console.log('empty-null')
}
// RequireObjectCoercible accepts falsy primitives and is not ToBoolean.
;({} = 0)
;({} = false)
;({} = '')
//! expect: primitives-ok
console.log('primitives-ok')

class InheritedSource extends Source {}
events = ''
let discarded = 0
;({ a: discarded } = new InheritedSource())
//! expect: unused:get-a;
console.log('unused:' + events)
