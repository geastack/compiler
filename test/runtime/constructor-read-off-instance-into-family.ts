// `x.constructor` handed to a `typeof Base` slot.
//
// `lib.es5.d.ts` types the read `Function`, so a program passes it on through
// `as any`: a connection-string parser gives
// `this.searchParams.constructor as any` to its mixin factory's `typeof
// URLSearchParams` parameter. The value is whichever class the instance was
// allocated as -- here the base or its subclass -- and `new` through the
// slot must build that class.
class Shape {
  constructor(public size: number = 1) {}

  area(): number {
    return 0
  }

  name(): string {
    return 'shape'
  }
}

class Square extends Shape {
  area(): number {
    return this.size * this.size
  }

  name(): string {
    return 'square'
  }
}

//! emitted-has: a constructor read off an instance is not a class its constructor family names
function rebuild(Ctor: typeof Shape, size: number): Shape {
  return new Ctor(size)
}

const shapes: Shape[] = [new Shape(2), new Square(3)]
for (const shape of shapes) {
  const copy = rebuild(shape.constructor as any, shape.size + 1)
  //! expect: shape 0 false
  //! expect: square 16 true
  console.log(copy.name() + ' ' + copy.area() + ' ' + (copy instanceof Square))
}
