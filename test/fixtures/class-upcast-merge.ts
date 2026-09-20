// A derived class stored where its base is declared.
//
// TypeScript reduces `previous ?? new Dog(...)` to the base `Animal` -- the
// derived arm is assignable to it -- so the merge's own carrier is
// `class-ref(Animal)` while the freshly constructed arm's is
// `class-ref(Dog)`. Nothing proposed the pair before `ClassHeritagePolicy`
// existed: `wideningSourcesOf` (conversion/build.ts) reads valid sources off
// the TARGET's shape, and a base class-ref states nothing about which classes
// descend from it, so the registry was never even asked. mongodb's
// `execute_operation.ts` throws exactly this expression 29 monomorphized ways.
//
// The C++ side needed nothing new: `records.ts` already emits `struct Dog :
// Animal`, and `gea::Ref<T>`'s converting constructor is gated on precisely
// that subobject existing.
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

const pick = (previous: Animal | undefined): Animal => previous ?? new Dog()

export const probe = pick(undefined).legs() + pick(new Animal()).legs() + new Dog().bark()

if (probe !== 15) throw new Error('class upcast merge computed the wrong result')
