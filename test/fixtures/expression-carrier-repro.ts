// Repro for expression-carrier:selected / "... (class-instance) is not a
// record shape": a generic type parameter narrowed via `instanceof` against a
// SIBLING class (not an ancestor/descendant of the parameter's own bound
// class) produces, once monomorphized, an intersection of two unrelated
// nominal classes. `deriveIntersection`'s `onlyNominal` fast path
// (representation/derive.ts) only accepts exactly one nominal class member,
// so this falls through to the generic record-merge loop, which refuses a
// class instance for not being a record shape.
class Animal {
  sound(): string {
    return 'generic'
  }
}

class Dog extends Animal {
  bark(): string {
    return 'woof'
  }
}

class Cat extends Animal {
  meow(): string {
    return 'meow'
  }
}

function handle<T extends Animal>(pet: T): string {
  if (pet instanceof Dog) {
    // For the T = Cat monomorphized copy, `pet` narrows to `Cat & Dog` --
    // two disjoint sibling classes -- and this read is the expression whose
    // carrier `deriveIntersection` refuses to select.
    return pet.bark()
  }
  return pet.sound()
}

const dog = new Dog()
console.log(handle(dog))

const cat = new Cat()
console.log(handle(cat))
