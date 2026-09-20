// The factory's body creates Box<T>; only its caller supplies the closed T.
// Its resolved return spelling must survive until the specialization fixpoint
// creates Box<number>, so member reads can consult the instantiated type.
class Box<T> {
  value: T

  constructor(value: T) {
    this.value = value
  }

  read(): T {
    return this.value
  }
}

function make<T>(value: T): Box<T> {
  return new Box<T>(value)
}

//! expect: value=7
console.log('value=' + make(7).read())
