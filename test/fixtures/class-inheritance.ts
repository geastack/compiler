// Inheritance is one fact with five consequences, and they fail together: a
// derived class's fields, its inherited methods, the base's field
// initializers, the base's constructor body, and `super(...)` all depend on
// derived and base being *one* object rather than two unrelated structs. Each
// case below pins one consequence, and pins it on the value rather than on the
// compile: the whole hazard here is a lookup that resolves to storage nothing
// initialized, which compiles perfectly and answers wrongly.

// The base's field initializer runs for an instance of the derived class. A
// flattened derived struct with its own `name` member would read `""` here and
// still compile -- so this is the case that must be checked by value.
class Animal {
  name: string = 'anon'
  speak(): string {
    return this.name
  }
}

class Dog extends Animal {
  breed: string = 'husky'
  describe(): string {
    return this.name + '/' + this.breed
  }
}

export const inheritedFieldInitializer = (): string => new Dog().describe()

// An inherited *method* is reached through a receiver of the derived type. Its
// body takes the base's receiver, which is only sound because the emitted
// structs really derive.
export const inheritedMethod = (): string => new Dog().speak()

// An explicit `super(...)`: the base's constructor body runs against the object
// the derived construction already allocated, and the derived class's own field
// assignment happens after it returns.
class Named {
  label: string
  constructor(label: string) {
    this.label = label
  }
  describe(): string {
    return this.label
  }
}

class Tagged extends Named {
  tag: string
  constructor(label: string, tag: string) {
    super(label)
    this.tag = tag
  }
}

export const explicitSuper = (): string => new Tagged('a', 'b').describe()

// No written constructor on the derived class: the implicit one is
// `constructor(...args) { super(...args) }`, so the base's convention is the
// derived class's convention and every argument is forwarded unchanged.
class Sized extends Named {
  size: number = 4
}

export const implicitSuper = (): number => new Sized('box').size

// Three levels. The chain has to run base-first the whole way down, not just
// one step: a middle class's initializer that ran after its own derived class's
// would be invisible in a two-level test.
class Grandparent {
  a: string = 'a'
}

class Parent extends Grandparent {
  b: string = 'b'
}

class Child extends Parent {
  c: string = 'c'
  joined(): string {
    return this.a + this.b + this.c
  }
}

export const threeLevels = (): string => new Child().joined()

// An override. The prototype chain answers with the *nearest* declaration, so
// the lookup order is what makes this right; no separate override rule exists.
class Quiet extends Animal {
  speak(): string {
    return 'shh'
  }
}

export const overriddenMethod = (): string => new Quiet().speak() + new Animal().speak()

// An accessor declared on the base, read through the derived class: an
// accessor is reached by *calling* the getter, and the getter it finds must be
// the base's, with the derived instance as its receiver.
class Counter {
  private held: number = 2
  get value(): number {
    return this.held
  }
}

class Doubling extends Counter {
  factor: number = 2
}

export const inheritedAccessor = (): number => new Doubling().value * new Doubling().factor
