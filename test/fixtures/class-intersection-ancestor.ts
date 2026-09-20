// `instanceof` narrowing a value already typed as a DESCENDANT of the class
// being tested produces an intersection of two nominal classes, and the
// intersection IS the more-derived one: an object can only pass the test if it
// is a `Dog`, and it can only have reached the parameter if it is a `Dog`.
//
// The deriver's intersection reduction used to require exactly ONE nominal
// member and refused every pair, so the narrowed read carried `unresolved` and
// every property access off it refused in cascade. Ancestry is the fact that
// makes the pair reducible, and it is the same fact the single-member branch
// already relies on ("the class carrier is the only inhabited one").
//
// Two UNRELATED classes intersected deliberately still refuse -- no C++ object
// is both -- which is why `Cat` exists here only as a sibling the reduction
// must not touch.
class Animal {
  legs(): number {
    return 4
  }
}

class Dog extends Animal {
  override legs(): number {
    return 4
  }
  bark(): number {
    return 7
  }
}

class Cat extends Animal {
  override legs(): number {
    return 4
  }
}

const loudness = (pet: Dog): number => (pet instanceof Animal ? pet.bark() : 0)

export const probe = loudness(new Dog()) + new Cat().legs()

if (probe !== 11) throw new Error('ancestor intersection reduction computed the wrong result')
