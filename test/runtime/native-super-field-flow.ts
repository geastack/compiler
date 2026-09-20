//! expect: 7
//! emitted-lacks: gea::Value::box

class Base {
  run: () => number
  constructor(run: () => number) {
    this.run = run
  }
}

class Derived extends Base {
  constructor(value: number) {
    super(() => value)
  }
}

class ImplicitDerived extends Base {}

console.log(new Derived(3).run() + new ImplicitDerived(() => 4).run())
