// A class static block runs once, when the class definition is evaluated,
// interleaved with the static field initializers in source order and with
// `this` bound to the class (ECMA-262 15.7.14 ClassDefinitionEvaluation).
// The block's body was lowered and emitted and then never called: this
// program printed nothing for the block and `0` for `A.y`.
//! expect: in block 4
//! expect: A.y 4
//! expect: order a=1, block1 a=1, c=2, block2 d=20, e=21
//! expect: total 6
//! expect: before-use 3

class A {
  static x = 1
  static y: number
  static {
    A.y = A.x + 3
    console.log('in block', A.y)
  }
}
console.log('A.y', A.y)

class B {
  static trace: string[] = []
  static d: number = 0
  static a: number = B.note('a', 1)
  static {
    B.trace.push(`block1 a=${this.a}`)
  }
  static c: number = B.note('c', B.a + 1)
  static {
    this.d = this.c * 10
    B.trace.push(`block2 d=${this.d}`)
  }
  static e: number = B.note('e', B.d + 1)
  static note(name: string, value: number): number {
    B.trace.push(`${name}=${value}`)
    return value
  }
}
console.log('order', B.trace.join(', '))

class C {
  static total = 0
  static {
    let sum = 0
    for (let i = 1; i <= 3; i++) sum += i
    C.total = sum
  }
}
console.log('total', C.total)

// A block runs when its class is defined, before any later statement.
let seen = 0
class D {
  static {
    seen = 3
  }
}
console.log('before-use', seen)
