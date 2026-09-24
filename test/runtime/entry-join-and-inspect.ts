//! expect: joined w,1
//! expect: record w,1;x,y;on,true w,1,x,y,on,true
//! expect: nullish n,;m,2 s,text
//! expect: tuple 1,a 1,a!
//! expect: Logged { logged: 12 }
//! expect: Mixed {
//! expect:   label: "it's",
//! expect:   nothing: null,
//! expect:   negative: -0
//! expect: Assigned { later: 9 }
//! expect: empty Empty {} after
//! expect:   third: 'cccccccccccccccccccc'
//! expect: Quoted { plain: 'a\nb\t"c"', both: `'"` }
//! expect: Expando { base: 1, extra: 2 }
//! known-wrong: base [object Object] -- a class something derives from; node prints Base { b: 1 }
// An `Object.entries` element converted to a string, and a class instance
// handed to `console.log`.
//
// An entry is a `[key, value]` tuple, which is an Array: its ToString is
// `join(",")`. The backend carries a tuple as a positional record and
// converted it as an ordinary object, so `Object.entries(o).join(';')`
// printed `[object Object]` for each entry.
//
// `console.log` does not ToString an object at all; node inspects it. A class
// instance with primitive fields printed `[object Object]` where node prints
// `Logged { logged: 12 }`.
const o: Record<string, number> = { w: 1 }
console.log('joined', Object.entries(o).join(';'))
const p = { w: 1, x: 'y', on: true }
console.log('record', Object.entries(p).join(';'), Object.entries(p).join())
const nullable: [string, number | null][] = [
  ['n', null],
  ['m', 2]
]
console.log('nullish', nullable.join(';'), String(Object.entries({ s: 'text' })[0]))
const pair: [number, string] = [1, 'a']
console.log('tuple', `${pair}`, pair + '!')

class Logged {
  logged = 12
}
console.log(new Logged())
class Mixed {
  count = 2
  label = "it's"
  on = true
  nothing: null = null
  negative = -0
}
console.log(new Mixed())
class Assigned {
  later: number
  constructor() {
    this.later = 9
  }
}
console.log(new Assigned())
class Empty {}
console.log('empty', new Empty(), 'after')
class Wide {
  first = 'aaaaaaaaaaaaaaaaaaaa'
  second = 'bbbbbbbbbbbbbbbbbbbb'
  third = 'cccccccccccccccccccc'
}
console.log(new Wide())
class Quoted {
  plain = 'a\nb\t"c"'
  both = `'"`
}
console.log(new Quoted())
// A key a computed write created, printed from its box.
const key = (t: string) => t + ''
class Expando {
  base = 1
}
const expando = new Expando()
;(expando as object as Record<string, number>)[key('extra')] = 2
console.log(expando)

// A handle to a class something derives from may hold the subclass, whose
// name node prints; that one still converts to the ToString tag.
class Base {
  b = 1
}
class Derived extends Base {
  d = 2
}
console.log('base', new Base(), new Derived().d)
export {}
